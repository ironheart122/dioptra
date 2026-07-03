// Tool executors for the agent. Runtime-agnostic by design (fetch, atob,
// TextDecoder — no node: imports) so the same code runs in the Phase 2 Worker.

const API = "https://api.github.com";
const MAX_TREE_ENTRIES = 2000;
const MAX_LINES_PER_READ = 1500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface ResolvedRepo {
  owner: string;
  repo: string;
  defaultBranch: string;
  commitSha: string;
}

export interface ToolOutput {
  /** Full text returned to the model as the tool_result. */
  output: string;
  /** One-line summary for the CLI status line / SSE events. */
  summary: string;
}

export class GitHubError extends Error {}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

export class GitHubClient {
  readonly #token: string;
  readonly #owner: string;
  readonly #repo: string;
  #resolved: ResolvedRepo | null = null;

  constructor(token: string, owner: string, repo: string) {
    this.#token = token;
    this.#owner = owner;
    this.#repo = repo;
  }

  get resolved(): ResolvedRepo {
    if (!this.#resolved) {
      throw new GitHubError("repository has not been resolved yet — call resolve() first");
    }
    return this.#resolved;
  }

  /** Resolve default branch → commit SHA. The whole run is pinned to that SHA. */
  async resolve(): Promise<ResolvedRepo> {
    const base = this.#repoBase();
    const info = await this.#json<{ default_branch: string }>(`${base}`);
    const branch = await this.#json<{ commit: { sha: string } }>(
      `${base}/branches/${encodeURIComponent(info.default_branch)}`,
    );
    this.#resolved = {
      owner: this.#owner,
      repo: this.#repo,
      defaultBranch: info.default_branch,
      commitSha: branch.commit.sha,
    };
    return this.#resolved;
  }

  async getTree(pathPrefix?: string): Promise<ToolOutput> {
    const { commitSha } = this.resolved;
    const data = await this.#json<{ tree: TreeEntry[]; truncated: boolean }>(
      `${this.#repoBase()}/git/trees/${commitSha}?recursive=1`,
    );
    let files = data.tree.filter((e) => e.type === "blob");
    const prefix = pathPrefix?.replace(/^\/+/, "");
    if (prefix) {
      // Match on path-segment boundaries so "src" doesn't also match "src2/".
      const dirPrefix = prefix.endsWith("/") ? prefix : `${prefix}/`;
      files = files.filter((e) => e.path === prefix || e.path.startsWith(dirPrefix));
    }

    const shown = files.slice(0, MAX_TREE_ENTRIES);
    const notes: string[] = [];
    if (data.truncated) {
      notes.push(
        "note: GitHub truncated the underlying tree listing — some files may be missing entirely. Narrow with path_prefix.",
      );
    }
    if (files.length > shown.length) {
      notes.push(
        `note: showing the first ${shown.length} of ${files.length} matching files. Call get_repo_tree with a path_prefix to narrow.`,
      );
    }
    if (prefix && files.length === 0) {
      notes.push(`note: no files under "${prefix}". Check the path against an unfiltered listing.`);
    }

    const lines = shown.map((e) => `${e.path} (${formatSize(e.size)})`);
    const output = [...notes, ...lines].join("\n") || "(empty repository)";
    const summary = prefix
      ? `${shown.length} of ${files.length} files under ${prefix}`
      : `${shown.length}${files.length > shown.length ? ` of ${files.length}` : ""} files`;
    return { output, summary };
  }

  async searchCode(query: string): Promise<ToolOutput> {
    const { owner, repo } = this.resolved;
    const q = encodeURIComponent(`${query} repo:${owner}/${repo}`);
    interface SearchItem {
      path: string;
      text_matches?: { fragment?: string }[];
    }
    const data = await this.#json<{ total_count: number; items: SearchItem[] }>(
      `/search/code?q=${q}&per_page=10`,
      "application/vnd.github.text-match+json",
    );

    if (data.total_count === 0) {
      return {
        output: `No matches for "${query}". Remember: whole-token matching on the default branch only — try a different identifier, or navigate the tree and read files instead.`,
        summary: "0 matches",
      };
    }

    const blocks = data.items.map((item) => {
      const fragments = (item.text_matches ?? [])
        .map((m) => m.fragment?.trim())
        .filter((f): f is string => Boolean(f))
        .slice(0, 3)
        .map((f) => f.split("\n").map((line) => `    ${line}`).join("\n"));
      return [item.path, ...fragments].join("\n");
    });
    const header = `${data.total_count} matching file(s)${
      data.total_count > data.items.length ? `, showing ${data.items.length}` : ""
    }. Fragments below carry NO line numbers — read_file before citing.`;
    return { output: [header, ...blocks].join("\n\n"), summary: `${data.total_count} matches` };
  }

  async readFile(path: string, startLine = 1): Promise<ToolOutput> {
    const { commitSha } = this.resolved;
    const cleanPath = path.replace(/^\/+/, "");
    const encoded = cleanPath.split("/").map(encodeURIComponent).join("/");
    const url = `${this.#repoBase()}/contents/${encoded}?ref=${commitSha}`;

    type ContentsResponse =
      | { type: string; size: number; encoding?: string; content?: string }
      | { name: string; type: string; size: number }[];
    const data = await this.#json<ContentsResponse>(url);

    if (Array.isArray(data)) {
      const entries = data.map((e) => `${e.name}${e.type === "dir" ? "/" : ` (${formatSize(e.size)})`}`);
      return {
        output: [`${cleanPath || "."} is a directory with ${data.length} entries:`, ...entries].join("\n"),
        summary: `${cleanPath}/ (${data.length} entries)`,
      };
    }
    if (data.type !== "file") {
      throw new GitHubError(`${cleanPath} is a ${data.type}, not a readable file.`);
    }
    if (data.size > MAX_FILE_BYTES) {
      throw new GitHubError(`${cleanPath} is ${formatSize(data.size)} — too large to read.`);
    }

    let text: string;
    if (data.encoding === "base64" && data.content) {
      text = decodeBase64(data.content, cleanPath);
    } else {
      // Files >1MB come back with encoding "none" and empty content — refetch raw.
      const raw = await this.#request(url, "application/vnd.github.raw+json");
      text = await raw.text();
      if (text.includes("\u0000")) throw new GitHubError(`${cleanPath} looks like a binary file.`);
    }
    return windowLines(text, cleanPath, startLine);
  }

  #repoBase(): string {
    return `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}`;
  }

  async #request(path: string, accept = "application/vnd.github+json"): Promise<Response> {
    const res = await fetch(`${API}${path}`, {
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept,
        "x-github-api-version": "2022-11-28",
        "user-agent": "dioptra-cli",
      },
    });
    if (res.ok) return res;
    throw await this.#toError(res, path);
  }

  async #json<T>(path: string, accept?: string): Promise<T> {
    const res = await this.#request(path, accept);
    return res.json() as Promise<T>;
  }

  async #toError(res: Response, path: string): Promise<GitHubError> {
    const endpoint = path.split("?")[0];
    const retryAfter = res.headers.get("retry-after");
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");

    if (res.status === 429 || (res.status === 403 && (retryAfter !== null || remaining === "0"))) {
      let wait: number | undefined;
      if (retryAfter !== null) wait = Number(retryAfter);
      else if (reset !== null) wait = Math.max(0, Math.round(Number(reset) - Date.now() / 1000));
      return new GitHubError(
        `GitHub rate limit hit on ${endpoint}${wait !== undefined ? ` — retry possible in ~${wait}s` : ""}. ` +
          "Do not retry this tool immediately; continue with get_repo_tree/read_file instead.",
      );
    }

    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) detail = `: ${body.message}`;
    } catch {
      // non-JSON error body
    }
    if (res.status === 404) return new GitHubError(`Not found (${endpoint})${detail}`);
    return new GitHubError(`GitHub API error ${res.status} (${endpoint})${detail}`);
  }
}

function decodeBase64(b64: string, path: string): string {
  const bytes = Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new GitHubError(`${path} looks like a binary file.`);
  }
  return new TextDecoder().decode(bytes);
}

function windowLines(text: string, path: string, startLine: number): ToolOutput {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const total = lines.length;
  if (total === 0) return { output: `${path} is empty.`, summary: `${path} (empty)` };

  const start = Math.min(Math.max(1, startLine), total);
  const end = Math.min(start + MAX_LINES_PER_READ - 1, total);
  const width = String(end).length;
  const body = lines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(width)}| ${line}`);
  const header = `${path} — lines ${start}-${end} of ${total}`;
  const footer =
    end < total
      ? [`(${total - end} more lines — call read_file with start_line=${end + 1} to continue)`]
      : [];
  return {
    output: [header, ...body, ...footer].join("\n"),
    summary: `${path} L${start}-${end} of ${total}`,
  };
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
