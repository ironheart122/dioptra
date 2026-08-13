#!/usr/bin/env node
// Smoke eval (PRD §7): run the agent over the golden questions, then a single
// Claude-as-judge pass. Answers go through the real agent loop and bill the
// ANTHROPIC_API_KEY; judging shells out to `claude -p` (Claude Code headless
// mode) and bills the Claude subscription instead.
// Node-only tooling — the runtime-agnostic rule applies to src/ only.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import Anthropic from "@anthropic-ai/sdk";

import { runAgent, type AgentUsage } from "../src/agent.js";
import { GitHubClient } from "../src/github.js";

const here = dirname(fileURLToPath(import.meta.url));
const QUESTIONS_PATH = join(here, "questions.json");
const RESULTS_PATH = join(here, "results.json");

const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};
// Duplicated from cli.ts on purpose — importing cli.ts would execute its main().
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

type Verdict = "grounded" | "partial" | "wrong";

interface Question {
  id: string;
  repo: string;
  type: string;
  question: string;
  reference: string;
}

interface Result {
  id: string;
  repo: string;
  type: string;
  model: string;
  answer: string;
  usage: AgentUsage;
  verdict?: Verdict;
  note?: string;
}

function costOf(usage: AgentUsage, model: string): number | undefined {
  const price = PRICING[model];
  if (!price) return undefined;
  // Cache writes bill at 1.25× input price, cache reads at 0.1×. Old
  // results.json entries predate the cache fields — treat them as uncached.
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const uncached = usage.inputTokens - read - write;
  return (
    (uncached * price.input +
      write * price.input * 1.25 +
      read * price.input * 0.1 +
      usage.outputTokens * price.output) /
    1e6
  );
}

async function runQuestion(
  client: Anthropic,
  githubToken: string,
  q: Question,
  model: string,
): Promise<Result> {
  const [owner, repo] = q.repo.split("/") as [string, string];
  const github = new GitHubClient(githubToken, owner, repo);
  const resolved = await github.resolve();
  let answer = "";
  let usage: AgentUsage = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    turns: 0,
  };
  for await (const event of runAgent({ client, github, repo: resolved, question: q.question, model })) {
    if (event.type === "tool_call") process.stdout.write(".");
    if (event.type === "done") ({ answer, usage } = event);
  }
  return { id: q.id, repo: q.repo, type: q.type, model, answer, usage };
}

function judge(questions: Question[], results: Result[]): void {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const items = results.map((r) => ({
    id: r.id,
    question: byId.get(r.id)?.question ?? "",
    reference_notes: byId.get(r.id)?.reference ?? "",
    agent_answer: r.answer,
  }));

  const prompt = `You are grading answers from a code Q&A agent against hand-written reference notes.
The notes are concept-level and may be imprecise about exact paths or line numbers — grade substance, not phrasing.

Verdicts:
- "grounded": consistent with the notes AND backed by specific file/line citations.
- "partial": right direction, but incomplete, thinly cited, or partly inconsistent with the notes.
- "wrong": contradicts the notes, fails to answer, or cites files that don't plausibly exist.

Reply with ONLY a JSON array, no prose, one entry per item:
[{"id": "...", "verdict": "grounded" | "partial" | "wrong", "note": "<=15 words"}]

Items:
${JSON.stringify(items, null, 2)}`;

  // Strip the API key: if it leaks into `claude -p`, Claude Code silently
  // bills the key instead of the subscription.
  const env = { ...process.env };
  delete env["ANTHROPIC_API_KEY"];

  const proc = spawnSync("claude", ["-p"], {
    input: prompt,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.error) {
    throw new Error(`could not run \`claude -p\` (is Claude Code installed?): ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new Error(`\`claude -p\` exited with ${proc.status}: ${proc.stderr.trim()}`);
  }

  const raw = proc.stdout;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) {
    throw new Error(`judge did not return a JSON array. Raw output:\n${raw}`);
  }
  const verdicts = JSON.parse(raw.slice(start, end + 1)) as {
    id: string;
    verdict: Verdict;
    note?: string;
  }[];
  for (const v of verdicts) {
    const result = results.find((r) => r.id === v.id);
    if (result) {
      result.verdict = v.verdict;
      result.note = v.note;
    }
  }
}

function printTable(questions: Question[], results: Result[]): void {
  const order = new Map(questions.map((q, i) => [q.id, i]));
  const sorted = [...results].sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));

  console.log("\n| question | repo | type | verdict | turns | tokens | cost |");
  console.log("| --- | --- | --- | --- | ---: | ---: | ---: |");
  for (const r of sorted) {
    const total = r.usage.inputTokens + r.usage.outputTokens;
    const cost = costOf(r.usage, r.model);
    console.log(
      `| ${r.id} | ${r.repo} | ${r.type} | ${r.verdict ?? "—"} | ${r.usage.turns} | ` +
        `${(total / 1000).toFixed(1)}K | ${cost !== undefined ? `$${cost.toFixed(3)}` : "—"} |`,
    );
  }

  const graded = sorted.filter((r) => r.verdict);
  if (graded.length > 0) {
    const count = (v: Verdict): number => graded.filter((r) => r.verdict === v).length;
    const totalCost = sorted.reduce((sum, r) => sum + (costOf(r.usage, r.model) ?? 0), 0);
    console.log(
      `\ngrounded ${count("grounded")} · partial ${count("partial")} · wrong ${count("wrong")}` +
        ` — target ≥9 grounded of ${questions.length} (PRD §7) · answers cost ~$${totalCost.toFixed(2)}`,
    );
    if (graded.length === questions.length && count("grounded") < 9) {
      process.exitCode = 1;
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      model: { type: "string", short: "m" },
      only: { type: "string" },
      "skip-judge": { type: "boolean" },
      "judge-only": { type: "boolean" },
    },
  });

  const questions = JSON.parse(readFileSync(QUESTIONS_PATH, "utf8")) as Question[];
  let results: Result[] = existsSync(RESULTS_PATH)
    ? (JSON.parse(readFileSync(RESULTS_PATH, "utf8")) as Result[])
    : [];

  if (!values["judge-only"]) {
    const modelArg = values.model ?? "sonnet";
    const model = MODEL_ALIASES[modelArg] ?? modelArg;
    const only = values.only?.split(",").map((s) => s.trim());
    const selected = only ? questions.filter((q) => only.includes(q.id)) : questions;
    if (only && selected.length !== only.length) {
      const known = new Set(questions.map((q) => q.id));
      throw new Error(`unknown question id(s): ${only.filter((id) => !known.has(id)).join(", ")}`);
    }
    const githubToken = process.env["GITHUB_TOKEN"];
    if (!githubToken) throw new Error("GITHUB_TOKEN is not set");
    if (!process.env["ANTHROPIC_API_KEY"]) throw new Error("ANTHROPIC_API_KEY is not set");

    const client = new Anthropic({ maxRetries: 1 });
    for (const [i, q] of selected.entries()) {
      process.stdout.write(`[${i + 1}/${selected.length}] ${q.id} `);
      try {
        const result = await runQuestion(client, githubToken, q, model);
        const cost = costOf(result.usage, model);
        console.log(
          ` ${result.usage.turns} turns · ${(result.usage.inputTokens / 1000).toFixed(0)}K in` +
            (cost !== undefined ? ` · $${cost.toFixed(3)}` : ""),
        );
        results = results.filter((r) => r.id !== q.id).concat(result);
      } catch (error) {
        console.log(` ✗ ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2) + "\n");
  }

  if (results.length === 0) throw new Error("no results to judge — run the eval first");

  if (!values["skip-judge"]) {
    console.log(`\njudging ${results.length} answer(s) via \`claude -p\` (subscription-billed)…`);
    judge(questions, results);
    writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2) + "\n");
  }

  printTable(questions, results);
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
