# dioptra

> Point it at any public GitHub repo, ask a question in plain English, get a grounded answer with `file:line` citations. An agentic CLI built on the Anthropic SDK — no index, no ingestion step, no vector database.

Named for the [dioptra](https://en.wikipedia.org/wiki/Dioptra), the ancient Greek sighting instrument you looked *through* to survey terrain.

```bash
npx dioptra honojs/hono "how does middleware composition work?"
```

<!-- TODO: docs/demo.gif — ~45s run on honojs/hono, ending on the cost summary line -->

## Quick start

```bash
export GITHUB_TOKEN=...       # github.com/settings/tokens — public_repo scope is enough
export ANTHROPIC_API_KEY=...  # console.anthropic.com/settings/keys
npx dioptra sindresorhus/ky "how are retries implemented?"
```

The tail end of a real run:

```
Sources
  source/core/retry-timing.ts:L88-L173  https://github.com/sindresorhus/ky/blob/3419113/source/core/retry-timing.ts#L88-L173
  source/core/Ky.ts:L942-L1026          https://github.com/sindresorhus/ky/blob/3419113/source/core/Ky.ts#L942-L1026

~$0.0531 · 4 turns · 47.1K tokens (45.6K in / 1.5K out) · claude-haiku-4-5
```

Options: `-m, --model sonnet|haiku|opus|<any model id>` (default `sonnet`), `--max-turns <n>` (default 15). `<repo>` accepts a full GitHub URL or `owner/repo` shorthand.

## What you'd actually use it for

- **Vetting a dependency before adopting it.** `dioptra sindresorhus/ky "does retry respect the Retry-After header?"` — get the answer with the exact lines, instead of trusting a docs page that may lag the code.
- **Debugging through a dependency.** When the bug is in how a library behaves, ask the library's repo directly — `dioptra psf/requests "when does a redirect strip the Authorization header?"` — and land on the branch of code you're actually hitting.
- **First contribution to an unfamiliar project.** "Where is X implemented and what calls it?" turns an hour of cold navigation into a two-minute orientation with permalinks you can open.
- **Checking a claim about code you don't have checked out.** Security review, due diligence, "does this package phone home?" — grounded citations mean you verify the answer instead of taking the model's word.
- **Learning from good codebases.** How hono composes middleware, how commander parses options — the answer arrives as a guided tour of the real source, pinned to a commit.

## How it works

```
┌─────────────┐     ┌──────────────────────────────┐
│  CLI (node) │────▶│  Agent loop (runtime-free)   │
└─────────────┘     │  · system prompt             │
┌─────────────┐     │  · while (turns < MAX):      │
│ Worker/Hono │────▶│      call Claude w/ tools    │
│ (roadmap)   │     │      dispatch tool_use       │
└─────────────┘     │      append tool_result      │
                    └──────────┬───────────────────┘
                               │
                ┌──────────────┼──────────────┐
                ▼              ▼              ▼
          get_repo_tree   search_code     read_file
                └──────── GitHub REST API ───────┘
```

A run starts by resolving the repo's default branch to a **commit SHA** and pinning everything to it — every file read and every citation link (`blob/<sha>/path#L42`) points at that exact commit, so citations never rot. Then the agent answers the way a senior engineer would in an unfamiliar codebase: list the tree, search for distinctive identifiers, read the files that matter, and cite what it read.

The loop itself ([`src/agent.ts`](src/agent.ts)) is an async generator that emits typed events — text deltas, tool calls, tool results, notices — which the CLI renders as a terminal UI. The same event stream maps directly onto SSE for the planned Workers deployment, which is why the core is runtime-agnostic (fetch, `atob`, `TextDecoder`; zero `node:` imports outside `cli.ts`).

## Why there's no vector database in here

The obvious way to build "ask questions about a codebase" in 2026 is RAG: chunk the repo, embed it, retrieve. Dioptra deliberately doesn't, because for the target case — a question against a small-to-medium repo you haven't indexed — an agent with navigate/grep/read tools finds the answer the way an engineer does, with no ingestion step, no index staleness, and instant support for any public repo.

Being honest about where that trade-off loses:

- **Huge repos and monorepos.** The tree gets truncated, navigation burns turns, and lexical search over 50K files is a blunt instrument.
- **Cross-cutting questions.** "Find every place that touches X" wants exhaustive retrieval, not sampling by navigation.
- **Repeated queries against the same repo.** With no cache or index, every question re-pays the exploration cost; index amortization wins if you ask twenty questions.

That's why the roadmap has an *optional* indexing mode rather than the architecture having one mandatorily.

## Design decisions

- **Exactly three tools.** Every additional tool is loop-debugging surface. If the agent can't answer with navigate/grep/read, that's a finding for the limitations section, not a reason to add tools.
- **Runs pinned to a commit SHA.** Resolved once at startup; all reads and citation permalinks use it. `blob/main/...` links rot; `blob/<sha>/...` links don't.
- **Line-numbered reads.** `read_file` prepends line numbers, and the system prompt forbids citing a file the agent hasn't read — search fragments carry no line numbers, so the contract forces a read before a citation.
- **Errors are tool results, not crashes.** 404s and rate limits go back to the model as `is_error` tool results, with retry-after info so it pivots to tree+read instead of re-searching blindly.
- **Hard budgets, graceful exit.** 15 tool-use turns and a 200K input-token ceiling; on exhaustion the loop forces a final answer (`tool_choice: none`) with instructions to state what it couldn't verify. Every run ends with a cost line.
- **Anthropic only, Zod v4 native.** Multi-provider pluggability is a YAGNI trap at this size; tool schemas derive JSON Schema via `z.toJSONSchema()` — no extra dependency.

## Eval

A 12-question smoke set (`eval/questions.json`) across four repos — hono, ky, requests, commander — with one architecture, one "where is X", and one behavioral question each, scored against hand-written reference notes by a single Claude-as-judge pass:

```bash
pnpm eval              # run all 12 (defaults to sonnet), then judge
pnpm eval -m haiku     # cheaper answers
pnpm eval --only ky-where --skip-judge   # one question, no judging
pnpm eval --judge-only # re-judge saved results without re-running the agent
```

Answers are produced through the real agent loop (`ANTHROPIC_API_KEY`); the judge pass shells out to [`claude -p`](https://docs.anthropic.com/en/docs/claude-code), so judging bills a Claude subscription instead of the API key. Latest run:

<!-- EVAL_TABLE_START -->
2026-08-13 · `claude-sonnet-4-6`:

| question | repo | type | verdict | turns | tokens | cost |
| --- | --- | --- | --- | ---: | ---: | ---: |
| hono-arch | honojs/hono | architecture | grounded | 4 | 62.1K | $0.221 |
| hono-where | honojs/hono | where | grounded | 4 | 50.2K | $0.172 |
| hono-behavior | honojs/hono | behavioral | grounded | 4 | 60.3K | $0.197 |
| ky-arch | sindresorhus/ky | architecture | grounded | 3 | 31.0K | $0.117 |
| ky-where | sindresorhus/ky | where | partial | 5 | 58.5K | $0.196 |
| ky-behavior | sindresorhus/ky | behavioral | grounded | 6 | 73.1K | $0.244 |
| requests-arch | psf/requests | architecture | grounded | 4 | 74.2K | $0.261 |
| requests-where | psf/requests | where | grounded | 3 | 21.9K | $0.083 |
| requests-behavior | psf/requests | behavioral | grounded | 8 | 25.9K | $0.093 |
| commander-arch | tj/commander.js | architecture | grounded | 4 | 81.0K | $0.272 |
| commander-where | tj/commander.js | where | grounded | 10 | 189.2K | $0.594 |
| commander-behavior | tj/commander.js | behavioral | grounded | 10 | 132.6K | $0.424 |

**grounded 11 · partial 1 · wrong 0** (target: ≥9 grounded). The partial is the eval working as intended: the agent placed ky's backoff logic in different files than the hand-written reference notes assumed, and the judge flagged the mismatch instead of rubber-stamping it.
<!-- EVAL_TABLE_END -->

Twelve questions is not a benchmark; it's a smoke test that catches regressions in the prompt/tool contract before a release.

## Limitations

Honest ones, not humblebrags:

- **GitHub code search is the weakest tool.** Default branch only, whole-token matching (no substrings or regex), skips files over 384KB, ~10 searches/minute. The prompt teaches the agent these limits, but on obscure identifiers it falls back to navigate-and-read, which costs turns.
- **Big repos degrade.** Tree listings cap at 2K entries (plus GitHub's own truncation on huge repos); the agent must narrow with `path_prefix`, and on a sprawling monorepo it can run out of turns before it runs out of places to look.
- **One shot, no memory.** Nothing is cached between runs — asking the same repo ten questions costs ten explorations.
- **Public repos only.** Auth is a plain PAT; private repos and GitHub App auth are roadmap.
- **Citations are grounded, not guaranteed.** The contract (only cite what was read, exact lines from numbered output) makes fabrication hard, but the model can still misread code it cited correctly.
- **It costs real money per question** — typically a few cents on Sonnet; the cost line at the end of every run keeps that visible.

## Roadmap

- **v1 indexing mode (optional):** tree-sitter-aware chunking, embeddings, and hybrid retrieval for the large-repo/cross-cutting cases where agentic search loses (see above).
- **Cloudflare Worker:** the same agent core behind `POST /ask` with SSE streaming — the event stream is already shaped for it.
- **MCP endpoint:** the same three tools plus `ask_repo` exposed over MCP.
- **Private repos** via GitHub App auth.

## License

MIT
