#!/usr/bin/env node
// CLI entry point. All node:-specific code (env, argv, stdout, exit codes)
// lives here; the agent core stays runtime-agnostic for the Phase 2 Worker.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import Anthropic from "@anthropic-ai/sdk";

import { DEFAULT_MAX_TURNS, runAgent, type AgentUsage } from "./agent.js";
import { GitHubClient, GitHubError, type ResolvedRepo } from "./github.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string };

const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  opus: "claude-opus-4-8",
};

// USD per million tokens, for the cost summary line. Estimates only.
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-4-8": { input: 5, output: 25 },
};

const HELP = `dioptra — ask questions about any public GitHub repo, get answers with file:line citations

Usage:
  dioptra <repo> "<question>" [options]

  <repo>    GitHub URL (https://github.com/honojs/hono) or shorthand (honojs/hono)

Options:
  -m, --model <model>   sonnet (default) | haiku | opus | any Anthropic model id
  --max-turns <n>       tool-use turn cap (default ${DEFAULT_MAX_TURNS})
  -v, --version         print the version number
  -h, --help            show this help text

Environment:
  GITHUB_TOKEN          required — create at github.com/settings/tokens (public_repo scope is enough)
  ANTHROPIC_API_KEY     required — create at console.anthropic.com/settings/keys

Example:
  dioptra honojs/hono "how does middleware composition work?"
`;

const useColor = process.stdout.isTTY === true;
const dim = (s: string): string => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

function fail(message: string): number {
  console.error(`error: ${message}`);
  return 1;
}

function parseRepoArg(arg: string): { owner: string; repo: string } | null {
  const url = arg.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+)/);
  const short = url ?? arg.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!short?.[1] || !short[2]) return null;
  return { owner: short[1], repo: short[2].replace(/\.git$/, "") };
}

function formatToolInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  return Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => (typeof value === "string" ? `"${value}"` : `${key}=${String(value)}`))
    .join(", ");
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

const CITATION_RE = /[A-Za-z0-9_.][A-Za-z0-9_./-]*:L\d+(?:-L?\d+)?/g;

function printSources(answer: string, repo: ResolvedRepo): void {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const citation of answer.match(CITATION_RE) ?? []) {
    if (seen.has(citation)) continue;
    seen.add(citation);
    const [path, range] = citation.split(":") as [string, string];
    const anchor = range.replace(/^L(\d+)-L?(\d+)$/, "L$1-L$2").replace(/^L(\d+)$/, "L$1");
    lines.push(
      `  ${citation}  https://github.com/${repo.owner}/${repo.repo}/blob/${repo.commitSha}/${path}#${anchor}`,
    );
  }
  if (lines.length === 0) return;
  console.log(dim("Sources"));
  for (const line of lines) console.log(dim(line));
  console.log();
}

function printCostSummary(usage: AgentUsage, model: string): void {
  const price = PRICING[model];
  // Cache writes bill at 1.25× input price, cache reads at 0.1×.
  const uncached = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  const cost = price
    ? `~$${(
        (uncached * price.input +
          usage.cacheWriteTokens * price.input * 1.25 +
          usage.cacheReadTokens * price.input * 0.1 +
          usage.outputTokens * price.output) /
        1e6
      ).toFixed(4)} · `
    : "";
  const cached =
    usage.cacheReadTokens > 0
      ? `, ${Math.round((usage.cacheReadTokens / usage.inputTokens) * 100)}% cached`
      : "";
  const total = usage.inputTokens + usage.outputTokens;
  console.log(
    dim(
      `${cost}${usage.turns} turn${usage.turns === 1 ? "" : "s"} · ${formatTokens(total)} tokens ` +
        `(${formatTokens(usage.inputTokens)} in${cached} / ${formatTokens(usage.outputTokens)} out) · ${model}`,
    ),
  );
}

async function main(argv: string[]): Promise<number> {
  let values: { model?: string; "max-turns"?: string; version?: boolean; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        model: { type: "string", short: "m" },
        "max-turns": { type: "string" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  if (values.version) {
    console.log(pkg.version);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }

  const repoArg = parseRepoArg(positionals[0]!);
  if (!repoArg) {
    return fail(`expected a GitHub URL or <owner>/<repo>, got "${positionals[0]}"`);
  }
  const question = positionals.slice(1).join(" ").trim();
  if (!question) {
    return fail('expected a question, e.g. dioptra honojs/hono "how does middleware composition work?"');
  }

  const modelArg = values.model ?? "sonnet";
  const model = MODEL_ALIASES[modelArg] ?? modelArg;
  let maxTurns = DEFAULT_MAX_TURNS;
  if (values["max-turns"] !== undefined) {
    maxTurns = Number(values["max-turns"]);
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 50) {
      return fail("--max-turns must be an integer between 1 and 50");
    }
  }

  const githubToken = process.env["GITHUB_TOKEN"];
  if (!githubToken) {
    return fail(
      "GITHUB_TOKEN is not set. Create a token at github.com/settings/tokens — public_repo scope is enough.",
    );
  }
  if (!process.env["ANTHROPIC_API_KEY"]) {
    return fail("ANTHROPIC_API_KEY is not set. Create a key at console.anthropic.com/settings/keys.");
  }

  const github = new GitHubClient(githubToken, repoArg.owner, repoArg.repo);
  process.stderr.write(dim(`→ resolving ${repoArg.owner}/${repoArg.repo}…`));
  let repo: ResolvedRepo;
  try {
    repo = await github.resolve();
  } catch (error) {
    process.stderr.write("\n");
    if (error instanceof GitHubError) return fail(error.message);
    throw error;
  }
  process.stderr.write(
    dim(` @ ${repo.commitSha.slice(0, 7)} (${repo.defaultBranch}) · ${model}`) + "\n\n",
  );

  const client = new Anthropic({ maxRetries: 1 });
  let needNewline = false;
  let result: { answer: string; usage: AgentUsage } | null = null;

  for await (const event of runAgent({ client, github, repo, question, model, maxTurns })) {
    switch (event.type) {
      case "text":
        process.stdout.write(event.text);
        needNewline = !event.text.endsWith("\n");
        break;
      case "tool_call":
        if (needNewline) {
          process.stdout.write("\n");
          needNewline = false;
        }
        process.stdout.write(dim(`→ ${event.name}(${formatToolInput(event.input)})`));
        break;
      case "tool_result":
        process.stdout.write(dim(event.isError ? `  ✗ ${event.summary}` : `  · ${event.summary}`) + "\n");
        break;
      case "notice":
        if (needNewline) {
          process.stdout.write("\n");
          needNewline = false;
        }
        console.log(dim(`! ${event.message}`));
        break;
      case "done":
        result = { answer: event.answer, usage: event.usage };
        break;
    }
  }

  if (needNewline) process.stdout.write("\n");
  console.log();
  if (result) {
    printSources(result.answer, repo);
    printCostSummary(result.usage, model);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error("error: Anthropic rejected the API key (check ANTHROPIC_API_KEY)");
    } else if (error instanceof Anthropic.APIError) {
      console.error(`error: Anthropic API error ${error.status ?? ""}: ${error.message}`);
    } else if (error instanceof GitHubError) {
      console.error(`error: ${error.message}`);
    } else {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  },
);
