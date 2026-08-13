// The agent loop. Shared core: the CLI consumes these events to render a
// terminal UI; the Phase 2 Worker maps the same events onto an SSE stream.
// Runtime-agnostic — no node: imports.

import type Anthropic from "@anthropic-ai/sdk";
import type { GitHubClient, ResolvedRepo } from "./github.js";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool, tools } from "./tools.js";

export const DEFAULT_MAX_TURNS = 15;
const MAX_TOKENS_PER_TURN = 8192;
const WARN_INPUT_TOKENS = 100_000;
const ABORT_INPUT_TOKENS = 200_000;

export interface AgentConfig {
  client: Anthropic;
  github: GitHubClient;
  repo: ResolvedRepo;
  question: string;
  model: string;
  maxTurns?: number;
}

export interface AgentUsage {
  /** Total input tokens, cache reads and writes included. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  turns: number;
}

const CACHE_CONTROL: Anthropic.CacheControlEphemeral = { type: "ephemeral" };

type CacheableBlock = {
  type: string;
  cache_control?: Anthropic.CacheControlEphemeral | null;
};

// Move the conversation cache breakpoint to the last block of the last
// message, so each turn replays the previous turns as a cache read (0.1×
// price) instead of a full-price resend. The system prompt + tools carry
// their own breakpoint; the API allows 4 total.
function moveCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        delete (block as CacheableBlock).cache_control;
      }
    }
  }
  const last = messages.at(-1);
  if (!last) return;
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content }];
  }
  const lastBlock = last.content.at(-1);
  if (lastBlock) (lastBlock as CacheableBlock).cache_control = CACHE_CONTROL;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; summary: string; isError: boolean }
  | { type: "notice"; message: string }
  | { type: "done"; answer: string; usage: AgentUsage };

export async function* runAgent(
  config: AgentConfig,
): AsyncGenerator<AgentEvent> {
  const { client, github, repo, question, model } = config;
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: buildSystemPrompt(repo, maxTurns),
      cache_control: CACHE_CONTROL,
    },
  ];

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: question },
  ];
  const usage: AgentUsage = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    turns: 0,
  };
  let warned = false;
  let forceFinal = false;
  let answer = "";

  while (true) {
    usage.turns++;
    moveCacheBreakpoint(messages);
    const stream = client.messages.stream({
      model,
      max_tokens: MAX_TOKENS_PER_TURN,
      system,
      messages,
      tools,
      ...(forceFinal ? { tool_choice: { type: "none" as const } } : {}),
    });

    let turnText = "";
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        turnText += event.delta.text;
        yield { type: "text", text: event.delta.text };
      }
    }
    const message = await stream.finalMessage();
    const cacheWrite = message.usage.cache_creation_input_tokens ?? 0;
    const cacheRead = message.usage.cache_read_input_tokens ?? 0;
    usage.inputTokens += message.usage.input_tokens + cacheWrite + cacheRead;
    usage.cacheWriteTokens += cacheWrite;
    usage.cacheReadTokens += cacheRead;
    usage.outputTokens += message.usage.output_tokens;
    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "max_tokens") {
      yield {
        type: "notice",
        message: "answer truncated: per-turn max_tokens reached",
      };
    }
    if (message.stop_reason === "refusal") {
      yield {
        type: "notice",
        message: "the model refused to answer this request (stop_reason: refusal)",
      };
    }
    if (message.stop_reason !== "tool_use" || forceFinal) {
      answer = turnText;
      break;
    }

    const toolUses = message.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    const results: Anthropic.ContentBlockParam[] = [];
    for (const block of toolUses) {
      yield { type: "tool_call", name: block.name, input: block.input };
      try {
        const { output, summary } = await executeTool(
          github,
          block.name,
          block.input,
        );
        yield {
          type: "tool_result",
          name: block.name,
          summary,
          isError: false,
        };
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        yield {
          type: "tool_result",
          name: block.name,
          summary: detail,
          isError: true,
        };
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: detail,
          is_error: true,
        });
      }
    }

    if (!warned && usage.inputTokens >= WARN_INPUT_TOKENS) {
      warned = true;
      yield {
        type: "notice",
        message: `cumulative input is past ${WARN_INPUT_TOKENS / 1000}K tokens — will abort at ${ABORT_INPUT_TOKENS / 1000}K`,
      };
    }

    const outOfTurns = usage.turns >= maxTurns;
    const outOfTokens = usage.inputTokens >= ABORT_INPUT_TOKENS;
    if (outOfTurns || outOfTokens) {
      forceFinal = true;
      const reason = outOfTurns
        ? `all ${maxTurns} tool-use turns`
        : "the token budget";
      results.push({
        type: "text",
        text: `[dioptra] You have used ${reason}. Answer the question now using only what you have already gathered, and clearly note anything you could not verify.`,
      });
      yield {
        type: "notice",
        message: `${reason} exhausted — asking for a final answer`,
      };
    }
    messages.push({ role: "user", content: results });
  }

  yield { type: "done", answer, usage };
}
