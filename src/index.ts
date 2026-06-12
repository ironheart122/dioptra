import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
) as { name: string; version: string };

const HELP = `dioptra — agentic GitHub repository analyzer

Usage:
  dioptra <owner>/<repo> [options]

Options:
  -v, --version    Print the version number
  -h, --help       Show this help text
  --json           Output machine-readable JSON (planned)

Example:
  dioptra facebook/react

Status: early development — analysis is not yet implemented.
`;

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values.version) {
    console.log(pkg.version);
    return 0;
  }

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }

  const target = positionals[0]!;
  if (!/^[^/\s]+\/[^/\s]+$/.test(target)) {
    console.error(`error: expected <owner>/<repo>, got "${target}"`);
    return 1;
  }

  console.error(
    `dioptra v${pkg.version}: analysis of "${target}" is not yet implemented.`,
  );
  return 1;
}
