# dioptra

> Agentic GitHub repository analyzer. Point it at a repo, get a structured read of the codebase. **Early development — published builds are placeholders while the tool is built in public.**

Named for the [dioptra](https://en.wikipedia.org/wiki/Dioptra) — the ancient Greek sighting-and-surveying instrument you looked *through* to measure and map terrain. This does the same for code: an LLM-driven agent surveys a public GitHub repository and reports what it does, how it's organized, where the interesting parts are, and how the pieces fit together. The CLI is the first surface; a Cloudflare Workers backend follows.

## Status

Not yet functional. This release reserves the name and ships a stub binary. Watch the repo for the first working version.

## Planned install

```bash
npm install -g dioptra
# or
npx dioptra <owner>/<repo>
```

## Stack (planned)

TypeScript · Anthropic SDK · Zod tool schemas · RAG (Turbopuffer) · Cloudflare Workers

## License

MIT
