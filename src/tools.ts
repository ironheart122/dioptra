// Zod input schemas for the three tools + dispatch to the GitHub executors.
// JSON Schema is derived with zod v4's native z.toJSONSchema() — no extra dep.

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { GitHubClient, ToolOutput } from "./github.js";

const getRepoTreeInput = z.object({
  path_prefix: z
    .string()
    .optional()
    .describe('Only list files under this path prefix, e.g. "src/". Use after a truncated listing to see deeper.'),
});

const searchCodeInput = z.object({
  query: z
    .string()
    .describe(
      "Search terms (whole tokens, no regex or substrings). Distinctive identifiers work best, e.g. a function or class name.",
    ),
});

const readFileInput = z.object({
  path: z.string().describe("File path from the repository root."),
  start_line: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line number to start reading from. Use to page through files longer than one read."),
});

function toInputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema["$schema"];
  return jsonSchema as unknown as Anthropic.Tool.InputSchema;
}

export const tools: Anthropic.Tool[] = [
  {
    name: "get_repo_tree",
    description:
      "List the repository's files with sizes. Call this first to orient yourself in an unfamiliar repository, and again with path_prefix when a listing was truncated.",
    input_schema: toInputSchema(getRepoTreeInput),
  },
  {
    name: "search_code",
    description:
      "Lexical code search across the repository's default branch (whole-token matching, rate-limited to ~10/min). Call it to locate a distinctive identifier. Returns matching files with fragments but no line numbers — read the file before citing it.",
    input_schema: toInputSchema(searchCodeInput),
  },
  {
    name: "read_file",
    description:
      "Read a file with line numbers prepended — cite line numbers from this output. Returns up to 1500 lines per call; pass start_line to continue a long file. Pointing it at a directory returns that directory's listing.",
    input_schema: toInputSchema(readFileInput),
  },
];

export async function executeTool(
  github: GitHubClient,
  name: string,
  input: unknown,
): Promise<ToolOutput> {
  switch (name) {
    case "get_repo_tree": {
      const args = getRepoTreeInput.parse(input);
      return github.getTree(args.path_prefix);
    }
    case "search_code": {
      const args = searchCodeInput.parse(input);
      return github.searchCode(args.query);
    }
    case "read_file": {
      const args = readFileInput.parse(input);
      return github.readFile(args.path, args.start_line);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
