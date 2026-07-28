import {
  App, Editor, ItemView, MarkdownRenderer, MarkdownView, Modal, Notice, Plugin,
  PluginSettingTab, Setting, WorkspaceLeaf, requestUrl, setIcon,
} from "obsidian";

/* ------------------------------------------------------------------ settings */

/** Per-provider settings. Empty strings mean "use the provider's default". */
interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Running token/cost totals, kept for the session and for all time. */
interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
  unpriced: number;   // calls whose model has no known price
}

interface LMSSettings {
  activeProvider: string;            // which provider answers, e.g. "anthropic"
  providers: Record<string, ProviderConfig>;
  routeThroughBackend: boolean;      // send model calls via studyweb (keys stay server-side)
  maxTokens: number;                 // cap on a reply (Claude counts thinking against it)
  showUsage: boolean;                // per-answer token/cost line
  priceOverrides: Record<string, { in: number; out: number }>;  // "provider/model" -> $/1M
  lifetimeUsage: UsageTotals;        // persisted across restarts

  lmStudioUrl: string;   // legacy: migrated into providers.lmstudio on load
  studywebUrl: string;   // studyweb backend, e.g. http://localhost:8787
  studywebApiKey: string;
  model: string;         // legacy: migrated into providers.lmstudio on load
  temperature: number;
  maxToolSteps: number;
  hideThinking: boolean;
  systemPrompt: string;
  noteFolder: string;    // where "New note" writes; "" = vault root
  contextWindow: number; // context budget in tokens (drives trimming + the usage meter)
  appendSources: boolean;  // append a Sources list to saved answers
  selectionSearch: boolean; // show a floating web-search button on text selection
  selectionResults: number; // how many results to summarise (2–5)
  selectionUseLLM: boolean;  // summarise with the LLM (off = instant table, CPU-friendly)
  selectionSystemPrompt: string; // system prompt for the selection-search summariser
}

function blankUsage(): UsageTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0,
           costUsd: 0, unpriced: 0 };
}

/** The rules the model needs before it can use the web tools well — which tool
 * answers what, and what the results mean. This mirrors the backend's own
 * `studyweb.agent.SYSTEM_PROMPT` (served by `GET /tool-schema`) so the pane
 * behaves the same way as `studyweb ask` does. */
const BACKEND_SYSTEM_PROMPT = `You are a research assistant with live web tools. Every fact you report comes from a tool call, never from memory.

TOOLS
- find_prices(query, sites?, per_site?) — what a product costs, on several shopping sites at once. Use it for ANY "how much does X cost" question.
- web_search(query, max_results?, include_domains?) — current facts, news, explanations. Returns sources plus a locally-extracted answer.
- site_search(site, query, max_results?) — searches one site through its own search page. Returns links carrying little text; follow up with open_url or extract_data.
- open_url(url) — the cleaned main text of a page whose URL you already have.
- extract_data(url, fields?) — specific fields from one page, as JSON.
- collect_rag(query, max_results?) — a corpus of cleaned chunks for study. Not for answering a single question.

CALLING THEM
- Write a query the way a person types it into a search box: "AMD 라이젠5 9600X", not a sentence.
- Never put site: or OR operators in a query — they return nothing. Domains are arguments: find_prices' sites, web_search's include_domains, site_search's site.
- When the user names a shop, it goes in find_prices' sites. Do not write the shop name into the query text, and do not fall back to web_search.
- Query in the language of the sources: Korean products on Korean sites, Korean.
- One call per question. If it comes back empty, change the approach, not the wording; escalate at most one step, then answer with what you have.

READING find_prices
- summary = null means no price was found. It does not mean the product is free or unavailable: say so, and list the misses.
- quotes are cheapest first and each carries the seller's own URL. Report min, by_site and the individual quotes you have read the titles of.
- Do not report summary.max or summary.median at all unless you have checked that every quote is the same product. They usually are not: quotes follow each site's own ranking, so a query for a CPU also returns the whole PCs built around it, and their prices land in max and median. A 2,429,000원 "max" for a 260,000원 part is a desktop computer, not a price for the part.
- method says how exact a quote is. json-ld, microdata, opengraph and naver_api come from the page's own product markup and are exact. dom was read under the page's price label: exact, but it is the number the page displays, and a page showing both a cash and a card price may give either. listing is the price the search-results row showed, which can be a "from" price for a product with options. Mention method only when asked how sure you are, or when two sites disagree.
- Always report misses alongside a minimum — the real minimum may be on a site that failed. "no results … static fetch" means the shop builds its results with JavaScript and was never checked. "blocked by robots.txt" means the pages were found but may not be fetched: never report that as "there is no price". "no price in the page" means it sits behind a login, an option picker, or 가격 문의.
- Prices are what the site listed at that moment, before shipping, options and card discounts. Report them as such; do not call one "the cheapest in Korea".

READING extract_data
- method: structured:json-ld / :microdata / :opengraph — the site published the values itself, exact. dom — read under the page's own price label, exact, but only name and price are filled in. llm — a model inferred the fields from the page text, the least certain. llm+dom — a model filled the fields but the price came from the page's label because the two disagreed; read warnings, it names both numbers. none — nothing could be extracted.
- Always read warnings: a recovered URL, a missing browser or a price disagreement is reported there. open_url reports a recovered page as recovered_from — mention it when the page differs from the one asked for.

ANSWERING
- Never state a number a tool did not return. Say what you could not find instead of filling the gap.
- Every figure carries its source URL, so the user can check it.
- Report what failed. A partial answer presented as a complete one is wrong.
- Answer in the language the user asked in. The tools answer in English and their wording is not yours: a Korean question gets a Korean answer, misses included.
- Be direct and concise. Do not narrate your reasoning or announce the tool you are about to call.`;

/** What a fresh install starts with: the shared rules plus the one thing that is
 * true only here — the reply lands in a note, so it is rendered Markdown. */
const DEFAULT_SYSTEM_PROMPT = BACKEND_SYSTEM_PROMPT +
  "\n- Your answer is rendered as Markdown inside Obsidian: use tables for " +
  "several prices, and [title](url) for sources.";

/** Defaults we have shipped before. A user who never edited the prompt gets the
 * new one on upgrade; anyone who customised theirs keeps it. */
const SUPERSEDED_SYSTEM_PROMPTS = [
  "You are a research assistant inside Obsidian with live web tools. When the " +
  "user asks for facts, data, or prices, use the tools to look them up instead " +
  "of guessing. Cite the source URL for any figure. Answer in clean Markdown.",
];

const DEFAULT_SETTINGS: LMSSettings = {
  activeProvider: "lmstudio",
  providers: {},
  routeThroughBackend: false,
  maxTokens: 8192,
  showUsage: true,
  priceOverrides: {},
  lifetimeUsage: blankUsage(),

  lmStudioUrl: "http://localhost:1234/v1",
  studywebUrl: "http://localhost:8787",
  studywebApiKey: "",
  model: "auto",
  temperature: 0,
  maxToolSteps: 6,
  hideThinking: true,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  noteFolder: "",
  contextWindow: 8192,
  appendSources: true,
  selectionSearch: true,
  selectionResults: 3,
  selectionUseLLM: true,
  selectionSystemPrompt:
    "You summarise web search results into a concise Markdown table. " +
    "State only facts; never invent anything. Reply in the same language as the query. " +
    "Output only the table, nothing else.",
};

const VIEW_TYPE_LMS = "studyweb-lms-view";

/* --------------------------------------------------------------- tool schemas */

// Bundled fallback. The backend is the single source of truth — the plugin
// fetches GET /tool-schema at session start and only uses this copy if the
// backend is unreachable, so tool definitions can't silently drift.
const FALLBACK_TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live internet and return relevant sources with a short, " +
        "source-grounded answer. Use for current facts, prices, or anything " +
        'uncertain. include_domains restricts to sites, e.g. ["danawa.com"].',
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "integer", default: 5 },
          include_domains: { type: "array", items: { type: "string" } },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "site_search",
      description:
        "Search WITHIN a specific website via its own search page — no external " +
        "search engine, fully local. Best for shopping/price or reference sites " +
        "(danawa.com, coupang.com, amazon.com, github.com). Follow up with open_url.",
      parameters: {
        type: "object",
        properties: {
          site: { type: "string" },
          query: { type: "string" },
          max_results: { type: "integer", default: 5 },
        },
        required: ["site", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_prices",
      description:
        "Look up what a product costs across several shopping sites at once and " +
        "return every price found, cheapest first, with min/median/max. USE THIS " +
        "FOR ANY 'how much does X cost' question — do NOT use web_search with " +
        "site: operators, which returns snippets rather than prices. Sites that " +
        "could not be read come back in `misses`: report those, and never present " +
        "the remaining prices as if the whole market had been checked. " +
        "`summary: null` means no price was found, not that the item is free.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          sites: { type: "array", items: { type: "string" } },
          per_site: { type: "integer", default: 3 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_url",
      description: "Fetch one web page and return its cleaned main text (Markdown).",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "collect_rag",
      description:
        "Search + crawl the web on a topic and return cleaned, RAG-ready text " +
        "chunks with metadata for building a study dataset.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "integer", default: 4 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract_data",
      description:
        "Extract STRUCTURED data (product name, price, specs, options) from any " +
        "web page as JSON. Reads standard product markup when present, otherwise " +
        "reads the page content for the requested fields; falls back to a " +
        "headless browser for JavaScript-rendered pages.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
          fields: { type: "array", items: { type: "string" } },
          render: { type: "string", enum: ["auto", "always", "never"] },
        },
        required: ["url"],
      },
    },
  },
];

/* ---------------------------------------------------------------- providers */

type ProviderKind = "openai" | "anthropic" | "cli";

interface ProviderDef {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
  requiresKey: boolean;
  local: boolean;          // runs on this machine: no key, no bill, no network
  supportsTools: boolean;  // can it drive the web tools?
  keyEnv: string;          // the env var studyweb reads server-side
  docs: string;            // where to get a key
  note: string;
  fallbackModels: string[];  // shown until "Refresh" fetches the live list
}

/** Mirrors studyweb.providers on the Python side, so both halves offer the
 * same set and the same defaults. */
const PROVIDERS: ProviderDef[] = [
  {
    id: "lmstudio", label: "LM Studio (local)", kind: "openai",
    baseUrl: "http://localhost:1234/v1", defaultModel: "", requiresKey: false,
    local: true, supportsTools: true, keyEnv: "LMSTUDIO_API_KEY",
    docs: "https://lmstudio.ai/docs/app/api",
    note: "Whatever model is loaded in LM Studio. Free, private, works offline.",
    fallbackModels: [],
  },
  {
    id: "openai", label: "OpenAI", kind: "openai",
    baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini",
    requiresKey: true, local: false, supportsTools: true, keyEnv: "OPENAI_API_KEY",
    docs: "https://platform.openai.com/api-keys", note: "",
    fallbackModels: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"],
  },
  {
    id: "anthropic", label: "Claude (Anthropic API)", kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1", defaultModel: "claude-opus-5",
    requiresKey: true, local: false, supportsTools: true, keyEnv: "ANTHROPIC_API_KEY",
    docs: "https://console.anthropic.com/settings/keys", note: "",
    fallbackModels: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5",
                     "claude-opus-4-8", "claude-fable-5"],
  },
  {
    id: "nvidia", label: "NVIDIA NIM", kind: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "meta/llama-3.3-70b-instruct", requiresKey: true, local: false,
    supportsTools: true, keyEnv: "NVIDIA_API_KEY", docs: "https://build.nvidia.com/",
    note: "build.nvidia.com hosted NIM, or a self-hosted NIM container " +
          "(point the base URL at http://localhost:8000/v1).",
    fallbackModels: ["meta/llama-3.3-70b-instruct",
                     "nvidia/llama-3.1-nemotron-70b-instruct",
                     "deepseek-ai/deepseek-r1", "qwen/qwen2.5-coder-32b-instruct"],
  },
  {
    id: "claude-code", label: "Claude Code CLI", kind: "cli",
    baseUrl: "", defaultModel: "", requiresKey: false, local: true,
    supportsTools: false, keyEnv: "", docs: "https://claude.com/claude-code",
    note: "Runs the `claude` binary you're already signed in to and reports the " +
          "exact cost it charged. It brings its own tools, so studyweb's web " +
          "tools are not attached to it.",
    fallbackModels: [],
  },
  {
    id: "custom", label: "Custom OpenAI-compatible", kind: "openai",
    baseUrl: "http://localhost:11434/v1", defaultModel: "", requiresKey: false,
    local: false, supportsTools: true, keyEnv: "STUDYWEB_CUSTOM_API_KEY", docs: "",
    note: "Ollama, vLLM, llama.cpp, OpenRouter, Groq, Together — anything that " +
          "speaks /chat/completions.",
    fallbackModels: [],
  },
];

const PROVIDER_BY_ID: Record<string, ProviderDef> =
  Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

const ANTHROPIC_VERSION = "2023-06-01";

// Claude models that removed temperature/top_p/top_k — sending one is a 400.
const NO_SAMPLING = ["claude-opus-5", "claude-opus-4-7", "claude-opus-4-8",
                     "claude-sonnet-5", "claude-fable-5", "claude-mythos-5"];

/* ------------------------------------------------------- connection status */

/** Every state a provider can be in, so the UI can say precisely what's wrong
 * instead of a bare "failed". */
type ConnState =
  | "unknown"        // never checked
  | "checking"
  | "ok"             // reachable and ready
  | "no_key"         // needs an API key that isn't set
  | "no_model"       // reachable, nothing loaded/selected
  | "unauthorized"   // the key was rejected
  | "rate_limit"
  | "unreachable"    // nothing answered — server down, wrong URL, offline
  | "not_installed"  // CLI provider whose binary is missing
  | "error";

interface ProviderStatus {
  state: ConnState;
  detail: string;
  models: string[];
  model: string;
  latencyMs: number;
  checkedAt: number;
}

const STATE_LABEL: Record<ConnState, string> = {
  unknown: "Not checked", checking: "Checking…", ok: "Connected",
  no_key: "API key needed", no_model: "No model", unauthorized: "Key rejected",
  rate_limit: "Rate limited", unreachable: "Not reachable",
  not_installed: "Not installed", error: "Error",
};

/** Green = usable, amber = needs you to do something, red = broken. */
function stateTone(s: ConnState): "ok" | "warn" | "bad" | "idle" {
  if (s === "ok") return "ok";
  if (s === "checking" || s === "unknown") return "idle";
  if (s === "no_key" || s === "no_model" || s === "not_installed" || s === "rate_limit") return "warn";
  return "bad";
}

/** Classify an HTTP failure into a state the UI can act on. */
function stateForHttp(status: number): ConnState {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limit";
  if (status === 0) return "unreachable";
  return "error";
}

/* ------------------------------------------------------------------- usage */

interface Usage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  requests: number;
  latencyMs: number;
  costUsd: number | null;   // null = model has no known price
}

function blankCall(provider = "", model = ""): Usage {
  return { provider, model, promptTokens: 0, completionTokens: 0, cachedTokens: 0,
           requests: 0, latencyMs: 0, costUsd: 0 };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    provider: a.provider || b.provider,
    model: b.model || a.model,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    requests: a.requests + b.requests,
    latencyMs: a.latencyMs + b.latencyMs,
    costUsd: a.costUsd === null && b.costUsd === null
      ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

function accumulate(t: UsageTotals, u: Usage): UsageTotals {
  t.requests += u.requests;
  t.promptTokens += u.promptTokens;
  t.completionTokens += u.completionTokens;
  t.cachedTokens += u.cachedTokens;
  if (u.costUsd === null) t.unpriced += u.requests;
  else t.costUsd += u.costUsd;
  return t;
}

/** USD per 1M tokens. Same defaults as the Python side; the backend's
 * /pricing endpoint overrides these when it's reachable, and the user can
 * override any single model in settings. */
const DEFAULT_PRICING: Record<string, Record<string, { in: number; out: number; cached?: number }>> = {
  lmstudio: { "*": { in: 0, out: 0 } },
  custom: { "*": { in: 0, out: 0 } },
  openai: {
    "gpt-4o": { in: 2.5, out: 10, cached: 1.25 },
    "gpt-4o-mini": { in: 0.15, out: 0.6, cached: 0.075 },
    "gpt-4.1": { in: 2, out: 8, cached: 0.5 },
    "gpt-4.1-mini": { in: 0.4, out: 1.6, cached: 0.1 },
    "gpt-4.1-nano": { in: 0.1, out: 0.4, cached: 0.025 },
    "o3-mini": { in: 1.1, out: 4.4, cached: 0.55 },
  },
  anthropic: {
    "claude-fable-5": { in: 10, out: 50, cached: 1 },
    "claude-mythos-5": { in: 10, out: 50, cached: 1 },
    "claude-opus-5": { in: 5, out: 25, cached: 0.5 },
    "claude-opus-4*": { in: 5, out: 25, cached: 0.5 },
    "claude-sonnet-5": { in: 3, out: 15, cached: 0.3 },
    "claude-sonnet-4*": { in: 3, out: 15, cached: 0.3 },
    "claude-haiku-4*": { in: 1, out: 5, cached: 0.1 },
  },
  nvidia: {},        // credit-metered, not per-token — left unpriced on purpose
  "claude-code": {}, // the CLI reports its own exact cost
};

let pricingTable = DEFAULT_PRICING;

/** Look up a model's price: exact id first, then the longest "prefix*" match. */
function priceFor(provider: string, model: string, overrides: Record<string, { in: number; out: number }>):
  { in: number; out: number; cached?: number } | null {
  const override = overrides[`${provider}/${model}`];
  if (override) return override;
  const table = pricingTable[provider];
  if (!table) return null;
  if (table[model]) return table[model];
  let best: { in: number; out: number; cached?: number } | null = null;
  let bestLen = -1;
  for (const [key, val] of Object.entries(table)) {
    if (!key.endsWith("*")) continue;
    const stem = key.slice(0, -1);
    if (model.startsWith(stem) && stem.length > bestLen) { best = val; bestLen = stem.length; }
  }
  return best;
}

function costOf(u: Usage, overrides: Record<string, { in: number; out: number }>): number | null {
  const p = priceFor(u.provider, u.model, overrides);
  if (!p) return null;
  const billedPrompt = Math.max(0, u.promptTokens - u.cachedTokens);
  let cost = (billedPrompt / 1e6) * p.in + (u.completionTokens / 1e6) * p.out;
  if (u.cachedTokens) cost += (u.cachedTokens / 1e6) * (p.cached ?? p.in);
  return cost;
}

function fmtCost(cost: number | null): string {
  if (cost === null) return "cost unknown";
  if (cost === 0) return "free";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** The one-line receipt shown under an answer. */
function usageLine(u: Usage): string {
  const parts = [
    `${u.promptTokens.toLocaleString()} in`,
    `${u.completionTokens.toLocaleString()} out`,
  ];
  if (u.cachedTokens) parts.push(`${u.cachedTokens.toLocaleString()} cached`);
  parts.push(`${(u.promptTokens + u.completionTokens).toLocaleString()} tok`);
  parts.push(fmtCost(u.costUsd));
  if (u.latencyMs) parts.push(`${(u.latencyMs / 1000).toFixed(1)}s`);
  if (u.requests > 1) parts.push(`${u.requests} calls`);
  return parts.join(" · ");
}

/* ------------------------------------------------------- provider plumbing */

/** An HTTP failure that keeps its status code, so callers can tell "key
 * rejected" from "server down" instead of parsing a message. */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Providers all shape their errors differently — dig out whichever message
 * this one used, so the UI shows the real reason. */
function providerErrorText(res: { status: number; json?: any; text?: string }): string {
  let detail = "";
  const err = res.json?.error;
  if (typeof err === "string") detail = err;
  else if (err && typeof err === "object") detail = err.message || err.type || "";
  if (!detail) detail = res.json?.message || res.json?.detail || "";
  if (!detail) detail = (res.text ?? "").slice(0, 200);
  return `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
}

/** Run the local `claude` binary (desktop only — Obsidian mobile has no Node). */
function runClaudeCli(args: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let execFile: any;
    try {
      execFile = require("child_process").execFile;
    } catch {
      reject(new Error("The Claude Code provider needs Obsidian desktop."));
      return;
    }
    const child = execFile("claude", args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err: any, stdout: string, stderr: string) => {
        if (err) {
          const why = (stderr || stdout || err.message || "").trim().slice(0, 300);
          reject(new Error(err.code === "ENOENT"
            ? "`claude` is not on PATH — install Claude Code first."
            : why || "claude CLI failed"));
          return;
        }
        resolve(stdout);
      });
    if (input) { child.stdin?.write(input); child.stdin?.end(); }
  });
}

/** Collapse a conversation into one prompt for a text-in/text-out CLI. */
function flattenForCli(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages.filter((m) => m.role === "system")
    .map((m) => m.content ?? "").join("\n\n");
  const prompt = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content ?? ""}`)
    .join("\n\n");
  return { system, prompt };
}

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
}

/* ------------------- OpenAI message shape <-> Anthropic Messages API ------- */

/** Anthropic keeps the system prompt out of the message list, puts tool calls
 * in `tool_use` blocks on the assistant turn, and expects tool results as
 * `tool_result` blocks on a *user* turn (consecutive results merge into one). */
function toAnthropic(messages: ChatMessage[]): { system: string; msgs: any[] } {
  const systemParts: string[] = [];
  const msgs: any[] = [];
  for (const m of messages) {
    const content = m.content ?? "";
    if (m.role === "system") {
      if (content) systemParts.push(content);
      continue;
    }
    if (m.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: m.tool_call_id || m.name || "tool",
        content,
      };
      const last = msgs[msgs.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else msgs.push({ role: "user", content: [block] });
      continue;
    }
    if (m.role === "assistant") {
      const blocks: any[] = [];
      if (content) blocks.push({ type: "text", text: content });
      for (const tc of m.tool_calls ?? []) {
        let input: any = {};
        try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { /* keep {} */ }
        blocks.push({ type: "tool_use", id: tc.id ?? tc.function?.name ?? "call",
                      name: tc.function?.name ?? "", input });
      }
      if (!blocks.length) continue;   // an empty assistant turn is rejected
      msgs.push({ role: "assistant", content: blocks });
      continue;
    }
    msgs.push({ role: "user", content });
  }
  return { system: systemParts.join("\n\n"), msgs };
}

function toAnthropicTools(tools: unknown[] | null): any[] | null {
  if (!tools || !tools.length) return null;
  return tools.map((t: any) => {
    const fn = t.function ?? t;
    return { name: fn.name, description: fn.description ?? "",
             input_schema: fn.parameters ?? { type: "object", properties: {} } };
  });
}

/** Anthropic response -> an OpenAI-shaped assistant message. */
function fromAnthropic(body: any): any {
  const texts: string[] = [];
  const toolCalls: any[] = [];
  for (const block of body?.content ?? []) {
    if (block.type === "text") texts.push(block.text ?? "");
    else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id, type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const msg: any = { role: "assistant", content: texts.join("") };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return msg;
}

/* ------------------------------------------------------------------- helpers */

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
};

function stripThinking(text: string): string {
  // Remove reasoning blocks emitted by "thinking" models so notes stay clean.
  // Also strip an UNCLOSED opening tag to end-of-string, which happens when
  // generation is cut off (max tokens / manual stop) mid-reasoning.
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/◁think▷[\s\S]*?◁\/think▷/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*$/i, "")
    .replace(/◁think▷[\s\S]*$/i, "")
    .trim();
}

/** Render an element as a spinning glyph + text — a loading indicator. The
 * glyph (⏳/🔧/✍️) rotates via the `.lms-spin` CSS animation. */
function spinnerText(el: HTMLElement, glyph: string, text: string) {
  el.empty();
  el.createSpan({ cls: "lms-spin", text: glyph });
  el.appendText(" " + text);
}

/* ------------------------------------------------ hardware + token helpers */

const _CJK_RE = /[ᄀ-ᇿ぀-ヿ㐀-鿿가-힣豈-﫿]/;

/** Rough, script-aware token estimate (CJK packs more tokens per char than
 * Latin). Good enough to drive a usage meter; not exact. */
function estTokens(s: string): number {
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) if (_CJK_RE.test(ch)) cjk++;
  const other = s.length - cjk;
  return Math.ceil(cjk * 1.1 + other / 4);
}

interface HwInfo {
  cpuModel: string;
  cores: number;
  ramGB: number;
  gpu: string;
  gpuTier: "discrete" | "integrated" | "unknown";
  platform: string;
}

function detectGPU(): { gpu: string; tier: HwInfo["gpuTier"] } {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return { gpu: "?", tier: "unknown" };
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const raw = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
    const gpu = raw.replace(/^ANGLE\s*\(/i, "").replace(/\)\s*$/, "").trim() || "?";
    const low = gpu.toLowerCase();
    let tier: HwInfo["gpuTier"] = "unknown";
    if (/nvidia|geforce|\brtx\b|\bgtx\b|radeon rx|\brx\s?\d|\barc\b/.test(low)) tier = "discrete";
    else if (/intel|uhd|iris|apple|adreno|mali|integrated|llvmpipe|swiftshader/.test(low)) tier = "integrated";
    return { gpu, tier };
  } catch {
    return { gpu: "?", tier: "unknown" };
  }
}

function detectHardware(): HwInfo {
  let cpuModel = "?", cores = 0, ramGB = 0, platform = "";
  try {
    // Obsidian runs in Electron; Node builtins are available (desktop-only plugin).
    const os = require("os");
    const cpus = os.cpus?.() ?? [];
    cores = cpus.length;
    cpuModel = (cpus[0]?.model ?? "?").toString().replace(/\s+/g, " ").trim();
    ramGB = Math.round(os.totalmem() / 1024 ** 3);
    platform = `${os.platform()}/${os.arch()}`;
  } catch {
    /* not available (e.g. mobile) — leave defaults */
  }
  const { gpu, tier } = detectGPU();
  return { cpuModel, cores, ramGB, gpu, gpuTier: tier, platform };
}

interface CtxLimits {
  comfortable: number; // fits with headroom
  max: number;         // upper bound before it gets risky
}

/** Rough context capacity (tokens) for the detected hardware. Heuristic — it
 * assumes a ~7–8B Q4 model and treats RAM (or a discrete GPU) as the budget;
 * the real limit depends on the exact model/quantisation loaded in LM Studio. */
function contextLimits(hw: HwInfo): CtxLimits {
  const ram = hw.ramGB || 8;
  let comfortable: number, max: number;
  if (ram >= 64) { comfortable = 32768; max = 32768; }
  else if (ram >= 32) { comfortable = 16384; max = 32768; }
  else if (ram >= 16) { comfortable = 8192; max = 16384; }
  else if (ram >= 8) { comfortable = 4096; max = 8192; }
  else { comfortable = 2048; max = 4096; }
  if (hw.gpuTier === "discrete") {
    comfortable = Math.min(32768, comfortable * 2);
    max = Math.min(32768, max * 2);
  }
  return { comfortable, max };
}

function recommendContext(hw: HwInfo): number {
  return contextLimits(hw).comfortable;
}

/** Where a chosen context sits relative to the hardware's estimated capacity. */
function contextStatus(ctx: number, lim: CtxLimits): { label: string; cls: "ok" | "tight" | "risky" } {
  if (ctx <= lim.comfortable) return { label: "✓ Comfortable for this hardware", cls: "ok" };
  if (ctx <= lim.max) return { label: "⚠ Tight — expect higher memory use / slower replies", cls: "tight" };
  return { label: "✕ Likely too large for this hardware", cls: "risky" };
}

/** The editor of the note the user is working in — robust even when the chat
 * sidebar or a modal has focus (getActiveViewOfType returns null in that case,
 * which is why the old insert said "open a note first" even when one was open). */
function activeNoteEditor(app: App): Editor | null {
  const ae = app.workspace.activeEditor;
  if (ae?.editor && ae.file) return ae.editor;
  const leaf = app.workspace.getMostRecentLeaf();
  if (leaf?.view instanceof MarkdownView) return leaf.view.editor;
  return app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? null;
}

/** Insert markdown at the current cursor of the open note. Returns false if no
 * note is open. Adds blank lines so a table/block renders correctly. */
function insertAtCursor(app: App, md: string): boolean {
  const editor = activeNoteEditor(app);
  if (!editor) return false;
  const pos = editor.getCursor();          // where the caret currently is
  editor.replaceRange("\n\n" + md + "\n", pos);
  editor.focus();
  return true;
}

/** Rebuild a small model's (often malformed) Markdown table into canonical GFM:
 * strips code fences and prose, keeps only table rows, drops separator rows,
 * and pads every row to the header's column count. Returns null if no usable
 * table is found (caller then uses the deterministic table). */
function cleanTable(md: string): string | null {
  if (!md) return null;
  const text = md.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
  const rowlike = text.split("\n").filter((l) => (l.match(/\|/g)?.length ?? 0) >= 2);
  if (rowlike.length < 2) return null;

  const cells = (line: string): string[] => {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.replace(/\s+/g, " ").trim());
  };
  const isSep = (r: string[]) => r.every((c) => c === "" || /^:?-{1,}:?$/.test(c));

  const rows = rowlike.map(cells).filter((r) => !isSep(r) && r.some((c) => c !== ""));
  if (rows.length < 2) return null; // need a header + at least one data row

  const header = rows[0];
  const cols = header.length;
  const fit = (r: string[]) => {
    let c = r.slice();
    if (c.length > cols) c = c.slice(0, cols - 1).concat(c.slice(cols - 1).join(" "));
    while (c.length < cols) c.push("");
    return c;
  };
  const mk = (r: string[]) => "| " + r.join(" | ") + " |";
  const out = [mk(header), mk(header.map(() => "---")), ...rows.slice(1).map((r) => mk(fit(r)))];
  return out.join("\n");
}

/** Thin client over any model provider (local or cloud) + the studyweb backend. */
class Backend {
  constructor(private settings: LMSSettings) {}

  private swBase() { return this.settings.studywebUrl.replace(/\/+$/, ""); }

  /** The provider that answers, unless one is named explicitly. */
  provider(id?: string): ProviderDef {
    return PROVIDER_BY_ID[id ?? this.settings.activeProvider] ?? PROVIDER_BY_ID["lmstudio"];
  }

  /** A provider's settings with defaults filled in. */
  config(p: ProviderDef): ProviderConfig {
    const c = this.settings.providers[p.id] ?? { apiKey: "", baseUrl: "", model: "" };
    return {
      apiKey: (c.apiKey ?? "").trim(),
      baseUrl: ((c.baseUrl || p.baseUrl) ?? "").replace(/\/+$/, ""),
      model: (c.model ?? "").trim(),
    };
  }

  private authHeaders(p: ProviderDef, cfg: ProviderConfig): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (p.kind === "anthropic") {
      h["anthropic-version"] = ANTHROPIC_VERSION;
      // Obsidian's requestUrl is not subject to CORS, but this keeps the same
      // call working if it ever runs through fetch or a proxy.
      h["anthropic-dangerous-direct-browser-access"] = "true";
      if (cfg.apiKey) h["x-api-key"] = cfg.apiKey;
    } else if (cfg.apiKey) {
      h["Authorization"] = `Bearer ${cfg.apiKey}`;
    }
    return h;
  }

  /** List a provider's models. Falls back to the bundled list when the
   * catalogue needs a key we don't have. */
  async listModels(id?: string): Promise<string[]> {
    const p = this.provider(id);
    if (p.kind === "cli") return [];
    const cfg = this.config(p);
    let res;
    try {
      res = await requestUrl({ url: `${cfg.baseUrl}/models`, method: "GET",
                               headers: this.authHeaders(p, cfg), throw: false });
    } catch (e: any) {
      if (!cfg.apiKey && p.fallbackModels.length) return [...p.fallbackModels];
      throw new HttpError(0, `cannot reach ${p.label} at ${cfg.baseUrl}: ${e.message}`);
    }
    if (res.status !== 200) {
      if (!cfg.apiKey && p.fallbackModels.length) return [...p.fallbackModels];
      throw new HttpError(res.status, providerErrorText(res));
    }
    const ids = (res.json?.data ?? []).map((m: any) => m.id).filter(Boolean);
    return ids.length ? ids.sort() : [...p.fallbackModels];
  }

  /** A concrete model id — asking the server when none is configured, which is
   * the normal case for LM Studio ("use whatever is loaded"). */
  async resolveModel(id?: string): Promise<string> {
    const p = this.provider(id);
    const cfg = this.config(p);
    if (cfg.model) return cfg.model;
    if (p.defaultModel) return p.defaultModel;
    if (p.kind === "cli") return "";
    const ids = await this.listModels(p.id);
    if (!ids.length) {
      throw new Error(p.local
        ? "No model is loaded — load one in LM Studio."
        : `${p.label} listed no models.`);
    }
    return ids[0];
  }

  /** Probe a provider and classify the result for the status lights. */
  async checkProvider(id?: string): Promise<ProviderStatus> {
    const p = this.provider(id);
    const cfg = this.config(p);
    const t0 = Date.now();
    const done = (state: ConnState, detail: string, models: string[] = []): ProviderStatus =>
      ({ state, detail, models, model: cfg.model || p.defaultModel,
         latencyMs: Date.now() - t0, checkedAt: Date.now() });

    if (p.kind === "cli") {
      try {
        const out = await runClaudeCli(["--version"], "", 15000);
        return done("ok", out.trim().slice(0, 80) || "Claude Code found");
      } catch (e: any) {
        return done("not_installed",
          "`claude` is not on PATH. Install Claude Code, or use another provider.");
      }
    }
    if (p.requiresKey && !cfg.apiKey && !this.settings.routeThroughBackend) {
      return done("no_key", `Paste a key below, or set ${p.keyEnv} and route through studyweb.`);
    }
    try {
      const models = await this.listModels(p.id);
      const chosen = cfg.model || p.defaultModel;
      if (!models.length && !chosen) {
        return done("no_model", p.local
          ? "Connected, but no model is loaded. Load one in LM Studio."
          : "Connected, but the server listed no models.");
      }
      if (chosen && models.length && !models.includes(chosen)) {
        return done("ok", `Connected · ${models.length} models. Note: "${chosen}" isn't in the list.`, models);
      }
      return done("ok", `Connected · ${models.length} model(s) available`, models);
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 0;
      return done(stateForHttp(status), e.message ?? String(e));
    }
  }

  /** Confirm the studyweb backend is reachable; returns its reported version. */
  async studywebHealth(): Promise<string> {
    const res = await requestUrl({ url: `${this.swBase()}/health`, method: "GET", throw: false });
    if (res.status !== 200) throw new Error(`studyweb /health -> HTTP ${res.status}`);
    // Pick up the backend's price table so both halves agree on cost.
    void this.refreshPricing();
    return res.json?.version ?? "ok";
  }

  /** Adopt the backend's pricing table when it's available (best effort). */
  async refreshPricing(): Promise<void> {
    try {
      const res = await requestUrl({ url: `${this.swBase()}/pricing`, method: "GET",
                                     headers: this.swHeaders(), throw: false });
      if (res.status === 200 && res.json?.pricing) pricingTable = res.json.pricing;
    } catch {
      /* backend down — keep the bundled table */
    }
  }

  /** Tool definitions from the backend (single source of truth), or the bundled
   * fallback if the backend can't be reached. Cached per Backend instance. */
  private toolSchemas: unknown[] | null = null;
  async getToolSchemas(): Promise<unknown[]> {
    if (this.toolSchemas) return this.toolSchemas;
    try {
      const res = await requestUrl({ url: `${this.swBase()}/tool-schema`, method: "GET", throw: false });
      const tools = res.json?.tools;
      if (res.status === 200 && Array.isArray(tools) && tools.length) {
        this.toolSchemas = tools;
        return tools;
      }
    } catch {
      /* fall through to the bundled fallback */
    }
    this.toolSchemas = FALLBACK_TOOL_SCHEMAS;
    return this.toolSchemas;
  }

  /** One model turn against the active provider.
   *
   * Always resolves to the OpenAI message shape (`content` plus optional
   * `tool_calls`) whatever the provider speaks, so the agent loop above never
   * has to care — and always reports what the call cost. */
  async chat(messages: ChatMessage[], model: string, tools: unknown[] | null,
             providerId?: string): Promise<{ message: any; usage: Usage }> {
    const p = this.provider(providerId);
    const t0 = Date.now();
    let out: { message: any; usage: Usage };
    if (this.settings.routeThroughBackend) out = await this.chatViaBackend(p, messages, model, tools);
    else if (p.kind === "anthropic") out = await this.chatAnthropic(p, messages, model, tools);
    else if (p.kind === "cli") out = await this.chatCli(p, messages, model);
    else out = await this.chatOpenAI(p, messages, model, tools);
    out.usage.latencyMs = Date.now() - t0;
    if (out.usage.costUsd === 0 && p.kind !== "cli") {
      out.usage.costUsd = costOf(out.usage, this.settings.priceOverrides);
    }
    return out;
  }

  /** OpenAI-compatible: LM Studio, OpenAI, NVIDIA NIM, and anything custom. */
  private async chatOpenAI(p: ProviderDef, messages: ChatMessage[], model: string,
                           tools: unknown[] | null): Promise<{ message: any; usage: Usage }> {
    const cfg = this.config(p);
    const payload: any = {
      model, messages, temperature: this.settings.temperature, stream: false,
    };
    if (this.settings.maxTokens) payload.max_tokens = this.settings.maxTokens;
    if (tools && tools.length) { payload.tools = tools; payload.tool_choice = "auto"; }
    const res = await requestUrl({
      url: `${cfg.baseUrl}/chat/completions`, method: "POST",
      headers: this.authHeaders(p, cfg), body: JSON.stringify(payload), throw: false,
    });
    if (res.status !== 200) throw new HttpError(res.status, providerErrorText(res));
    const choice = res.json?.choices?.[0];
    if (!choice) throw new HttpError(res.status, `${p.label} returned no choices`);
    const u = res.json?.usage ?? {};
    return {
      message: { ...choice.message, content: choice.message?.content ?? "" },
      usage: {
        ...blankCall(p.id, model),
        promptTokens: u.prompt_tokens ?? 0,
        completionTokens: u.completion_tokens ?? 0,
        cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
        requests: 1,
      },
    };
  }

  /** Anthropic Messages API — translated to and from the OpenAI shape. */
  private async chatAnthropic(p: ProviderDef, messages: ChatMessage[], model: string,
                              tools: unknown[] | null): Promise<{ message: any; usage: Usage }> {
    const cfg = this.config(p);
    const { system, msgs } = toAnthropic(messages);
    const payload: any = { model, messages: msgs, max_tokens: this.settings.maxTokens || 4096 };
    if (system) payload.system = system;
    const atools = toAnthropicTools(tools);
    if (atools) { payload.tools = atools; payload.tool_choice = { type: "auto" }; }
    // Current Claude models reject `temperature` outright (HTTP 400), so it
    // only goes on the wire for the older ones that still accept it.
    if (!NO_SAMPLING.some((m) => model.startsWith(m))) {
      payload.temperature = this.settings.temperature;
    }
    const res = await requestUrl({
      url: `${cfg.baseUrl}/messages`, method: "POST",
      headers: this.authHeaders(p, cfg), body: JSON.stringify(payload), throw: false,
    });
    if (res.status !== 200) throw new HttpError(res.status, providerErrorText(res));
    const u = res.json?.usage ?? {};
    const cacheRead = u.cache_read_input_tokens ?? 0;
    return {
      message: fromAnthropic(res.json),
      usage: {
        ...blankCall(p.id, model),
        // input_tokens excludes cached reads; report the true prompt size
        promptTokens: (u.input_tokens ?? 0) + cacheRead + (u.cache_creation_input_tokens ?? 0),
        completionTokens: u.output_tokens ?? 0,
        cachedTokens: cacheRead,
        requests: 1,
      },
    };
  }

  /** The local `claude` binary. It reports the exact USD it charged, which we
   * trust over any price table. No tool-calling: it runs its own agent loop. */
  private async chatCli(p: ProviderDef, messages: ChatMessage[], model: string):
      Promise<{ message: any; usage: Usage }> {
    const { system, prompt } = flattenForCli(messages);
    const args = ["-p", "--output-format", "json"];
    if (model) args.push("--model", model);
    if (system) args.push("--append-system-prompt", system);
    const raw = await runClaudeCli(args, prompt, 300000);
    let body: any = {};
    try { body = JSON.parse(raw); } catch { throw new Error("claude CLI returned unparseable output"); }
    if (body.is_error) throw new Error(`claude CLI: ${body.result ?? "error"}`);
    const u = body.usage ?? {};
    const cacheRead = u.cache_read_input_tokens ?? 0;
    return {
      message: { role: "assistant", content: body.result ?? "" },
      usage: {
        ...blankCall(p.id, body.model ?? model ?? "claude-code"),
        promptTokens: (u.input_tokens ?? 0) + cacheRead + (u.cache_creation_input_tokens ?? 0),
        completionTokens: u.output_tokens ?? 0,
        cachedTokens: cacheRead,
        requests: 1,
        costUsd: typeof body.total_cost_usd === "number" ? body.total_cost_usd : null,
      },
    };
  }

  /** Let the studyweb backend make the call, so API keys live in its
   * environment instead of in this vault. */
  private async chatViaBackend(p: ProviderDef, messages: ChatMessage[], model: string,
                               tools: unknown[] | null): Promise<{ message: any; usage: Usage }> {
    const res = await requestUrl({
      url: `${this.swBase()}/chat`, method: "POST", headers: this.swHeaders(),
      body: JSON.stringify({
        messages, provider: p.id, model: model || undefined,
        tools: tools && tools.length ? tools : false,
        temperature: this.settings.temperature, max_tokens: this.settings.maxTokens,
      }),
      throw: false,
    });
    if (res.status !== 200) throw new HttpError(res.status, providerErrorText(res));
    const u = res.json?.usage ?? {};
    return {
      message: res.json?.message ?? { role: "assistant", content: "" },
      usage: {
        ...blankCall(res.json?.provider ?? p.id, res.json?.model ?? model),
        promptTokens: u.prompt_tokens ?? 0,
        completionTokens: u.completion_tokens ?? 0,
        cachedTokens: u.cached_tokens ?? 0,
        requests: u.requests ?? 1,
        costUsd: u.cost_usd ?? null,
      },
    };
  }

  /** Token-by-token streaming is only safe against a local OpenAI-compatible
   * server: `fetch` (the only streaming path) is subject to CORS, and cloud
   * APIs reject it from a renderer. Everything else answers in one shot. */
  canStream(providerId?: string): boolean {
    const p = this.provider(providerId);
    if (this.settings.routeThroughBackend || p.kind !== "openai") return false;
    return isLocalUrl(this.config(p).baseUrl);
  }

  /** Streaming chat against a local server (SSE). Calls onDelta for each token
   * and returns the full text; requestUrl cannot stream, hence fetch. */
  async chatStream(messages: ChatMessage[], model: string,
                   onDelta: (text: string) => void, signal?: AbortSignal,
                   temperature?: number): Promise<string> {
    const temp = temperature ?? this.settings.temperature;
    const cfg = this.config(this.provider());
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: temp, stream: true }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`chat/completions -> HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";     // keep the last partial line
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content ?? "";
          if (delta) { full += delta; onDelta(delta); }
        } catch {
          /* keepalive / partial JSON — ignore */
        }
      }
    }
    return full;
  }

  private swHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.settings.studywebApiKey) headers["Authorization"] = `Bearer ${this.settings.studywebApiKey}`;
    return headers;
  }

  private async swPost(path: string, body: unknown): Promise<any> {
    const headers = this.swHeaders();
    const res = await requestUrl({
      url: `${this.swBase()}${path}`, method: "POST", headers,
      body: JSON.stringify(body), throw: false,
    });
    if (res.status !== 200) throw new Error(`studyweb ${path} -> HTTP ${res.status}`);
    return res.json;
  }

  async dispatchTool(name: string, args: any): Promise<string> {
    try {
      if (name === "web_search") {
        const data = await this.swPost("/search", {
          query: args.query, max_results: args.max_results ?? 5,
          search_depth: "advanced", include_answer: true,
          ...(args.include_domains ? { include_domains: args.include_domains } : {}),
        });
        const results = (data.results ?? []).map((r: any) => ({
          title: r.title, url: r.url, content: (r.content ?? "").slice(0, 900), score: r.score,
        }));
        return JSON.stringify({ answer: data.answer ?? "", results });
      }
      if (name === "site_search") {
        const data = await this.swPost("/search", {
          query: args.query, site: args.site, max_results: args.max_results ?? 5,
          search_depth: "advanced", include_answer: true,
        });
        const results = (data.results ?? []).map((r: any) => ({
          title: r.title, url: r.url, content: (r.content ?? "").slice(0, 900), score: r.score,
        }));
        return JSON.stringify({ answer: data.answer ?? "", results });
      }
      if (name === "find_prices") {
        const data = await this.swPost("/prices", {
          query: args.query,
          ...(args.sites ? { sites: args.sites } : {}),
          ...(args.per_site ? { per_site: args.per_site } : {}),
        });
        // Trimmed to what an answer needs: the number, the name, the source,
        // and how the number was read — plus the misses, so a partial check
        // can't be reported as a full one.
        return JSON.stringify({
          summary: data.summary,
          quotes: (data.quotes ?? []).slice(0, 12).map((q: any) => ({
            site: q.site, price: q.price, title: q.title, url: q.url, method: q.method,
          })),
          misses: data.misses ?? [],
        });
      }
      if (name === "open_url") {
        const data = await this.swPost("/extract", { urls: [args.url], include_raw_content: false });
        const r = (data.results ?? [])[0];
        if (!r) {
          const f = (data.failed_results ?? [])[0];
          if (f?.suggestions?.length) {
            return JSON.stringify({ error: `Could not open ${args.url}.`, suggestions: f.suggestions,
              note: f.note ?? "Call open_url on one of these real URLs instead." });
          }
          return `Could not read ${args.url}: ${f?.error ?? "unknown error"}`;
        }
        const out: any = { url: r.url, title: r.title, content: (r.content ?? "").slice(0, 5000) };
        if (r.recovered_from) {
          out.recovered_from = r.recovered_from;
          out.note = r.note ?? "The requested URL failed; this is the closest real page on the same site.";
        }
        return JSON.stringify(out);
      }
      if (name === "collect_rag") {
        const data = await this.swPost("/rag", { query: args.query, max_results: args.max_results ?? 4 });
        const sample = (data.chunks ?? []).slice(0, 5).map((c: any) => ({
          source_url: c.metadata?.source_url, text: (c.text ?? "").slice(0, 300),
        }));
        return JSON.stringify({ n_documents: data.n_documents, n_chunks: data.n_chunks, sample_chunks: sample });
      }
      if (name === "extract_data") {
        const data = await this.swPost("/extract-data", {
          url: args.url,
          ...(args.fields ? { fields: args.fields } : {}),
          render: args.render ?? "auto",
        });
        return JSON.stringify({ method: data.method, data: data.data, warnings: data.warnings });
      }
      return `Unknown tool: ${name}`;
    } catch (e: any) {
      return `Error running ${name}: ${e.message}. Is 'studyweb serve' running at ${this.swBase()}?`;
    }
  }

  /** Web-search a query and summarise the top results into a Markdown table,
   * reporting progress live: onStatus for each step, onToken for the LLM's
   * streamed output (so the reasoning/generation is visible in real time).
   * Falls back to a deterministic table if the LLM is unavailable. */
  async searchSummaryStream(
    query: string, n: number,
    cb: { onStatus?: (t: string) => void; onToken?: (d: string) => void; signal?: AbortSignal } = {},
  ): Promise<{ markdown: string; sources: string[]; usage?: Usage }> {
    cb.onStatus?.(`Searching the web for "${query}"…`);
    const data = await this.swPost("/search", {
      query, max_results: n, search_depth: "advanced", include_answer: true,
    });
    const results: any[] = (data.results ?? []).slice(0, n);
    const sources = results.map((r) => r.url).filter(Boolean);
    if (!results.length) return { markdown: `_No results for "${query}"._`, sources };

    cb.onStatus?.(`Found ${results.length} results · summarising…`);

    // CPU-friendly path: skip the model entirely, build the table directly.
    if (!this.settings.selectionUseLLM) {
      return { markdown: this._directTable(query, data, results), sources };
    }

    // Preferred path: stream the local model as it organises the table.
    try {
      const model = await this.resolveModel();
      const ctx = results
        .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${(r.content ?? "").slice(0, 700)}`)
        .join("\n\n");
      const system = this.settings.selectionSystemPrompt ||
        DEFAULT_SETTINGS.selectionSystemPrompt;
      const user =
        `Summarise the search results below about "${query}" into a single Markdown ` +
        `table with up to ${Math.min(n, 3)} rows. Use exactly these columns: | Item | Description | Source |. ` +
        `Keep each description to 1–2 sentences and put [title](URL) in the Source column.` +
        `\n\nSearch summary: ${data.answer ?? ""}\n\nResults:\n${ctx}`;
      const messages: ChatMessage[] = [
        { role: "system", content: system }, { role: "user", content: user }];

      let raw = "";
      let usage: Usage | undefined;
      if (this.canStream()) {
        try {
          // temperature 0 → deterministic summaries regardless of the chat temp
          raw = await this.chatStream(messages, model, cb.onToken ?? (() => {}), cb.signal, 0);
        } catch (streamErr) {
          if (cb.signal?.aborted) throw streamErr;
          raw = "";     // streaming failed — fall through to the one-shot call
        }
      }
      if (!raw) {
        // Cloud providers (and a failed stream) answer in one shot: no token
        // stream, so show the whole reply at once when it lands.
        const out = await this.chat(messages, model, null);
        raw = out.message.content ?? "";
        usage = out.usage;
        cb.onToken?.(raw);
      }
      const out = this.settings.hideThinking ? stripThinking(raw) : raw;
      const cleaned = cleanTable(out);      // rebuild into valid GFM
      if (cleaned) return { markdown: cleaned, sources, usage };
      // model produced no usable table — fall through to the deterministic one
    } catch (e) {
      if (cb.signal?.aborted) throw e;
      /* LLM unavailable — fall back to a deterministic table below */
    }

    cb.onStatus?.("Building the table…");
    return { markdown: this._directTable(query, data, results), sources };
  }

  /** Deterministic table straight from the search results — no LLM, instant. */
  private _directTable(query: string, data: any, results: any[]): string {
    const esc = (s: string) => (s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
    const rows = results
      .map((r) => `| ${esc(r.title).slice(0, 80)} | ${esc(r.content).slice(0, 160)} | [open](${r.url}) |`)
      .join("\n");
    const table = `| Item | Description | Source |\n|---|---|---|\n${rows}`;
    const lead = data.answer ? `${esc(data.answer)}\n\n` : "";
    return lead + table;
  }
}

/* --------------------------------------------------------------------- view */

type DisplayEntry =
  | { kind: "plain"; role: "user" | "assistant" | "tool"; md: string; markdown: boolean }
  | { kind: "answer"; md: string; sources: string[]; usage?: Usage };

/** Collect source URLs a tool returned, so saved answers can cite them. */
function urlsFromToolResult(result: string): string[] {
  try {
    const data = JSON.parse(result);
    const out: string[] = [];
    if (typeof data.url === "string") out.push(data.url);
    for (const r of data.results ?? []) if (r?.url) out.push(r.url);
    return out;
  } catch {
    return [];
  }
}

export class LMSView extends ItemView {
  private plugin: StudywebLMSPlugin;
  private log!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private statusDot!: HTMLElement;
  private meterFill!: HTMLElement;
  private meterLabel!: HTMLElement;
  private meterEl!: HTMLElement;
  private usageEl!: HTMLElement;
  private busy = false;
  // Bumped on reset/stop; an in-flight turn checks it after every await so a
  // stale response can never render into a newer conversation.
  private gen = 0;
  // The transient "Working…/🔧…" bubble for the current turn, if any.
  private pendingEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: StudywebLMSPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  // Conversation state lives on the plugin so it survives the pane being closed
  // or the workspace switching (a new view replays it).
  private get messages(): ChatMessage[] { return this.plugin.messages; }
  private get history(): DisplayEntry[] { return this.plugin.displayLog; }

  getViewType() { return VIEW_TYPE_LMS; }
  getDisplayText() { return "studyweb chat"; }
  getIcon() { return "globe"; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("lms-view");

    const header = root.createDiv({ cls: "lms-header" });
    header.createSpan({ text: "studyweb chat", cls: "lms-title" });
    // Connection state: a coloured dot plus the provider/model it resolved to.
    // Click to re-probe; hover for the full reason when something is wrong.
    const statusWrap = header.createSpan({ cls: "lms-status-wrap" });
    this.statusDot = statusWrap.createSpan({ cls: "lms-dot lms-dot-idle" });
    this.statusEl = statusWrap.createSpan({ cls: "lms-status", text: "checking…" });
    statusWrap.onclick = () => void this.refreshStatus();
    statusWrap.setAttr("aria-label", "Click to re-check the connection");

    const clearBtn = header.createEl("button", { cls: "lms-icon-btn", title: "New conversation" });
    setIcon(clearBtn, "eraser");
    clearBtn.onclick = () => this.reset();

    // Context-usage meter: how much of the context window the conversation uses.
    this.meterEl = root.createDiv({ cls: "lms-meter" });
    const track = this.meterEl.createDiv({ cls: "lms-meter-track" });
    this.meterFill = track.createDiv({ cls: "lms-meter-fill" });
    this.meterLabel = this.meterEl.createDiv({ cls: "lms-meter-label" });

    // Session spend: what this conversation has cost so far.
    this.usageEl = root.createDiv({ cls: "lms-usage-bar" });

    this.log = root.createDiv({ cls: "lms-log" });

    const bar = root.createDiv({ cls: "lms-inputbar" });
    this.input = bar.createEl("textarea", { cls: "lms-input", attr: { rows: "2", placeholder: "Ask anything — I'll search the web…" } });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void this.send(); }
    });
    this.sendBtn = bar.createEl("button", { cls: "lms-send", text: "Send" });
    this.sendBtn.onclick = () => void this.send();
    this.stopBtn = bar.createEl("button", { cls: "lms-stop", text: "Stop" });
    this.stopBtn.onclick = () => this.stop();
    this.stopBtn.hide();

    if (this.messages.length) {
      this.replay();      // returning to an existing conversation
    } else {
      this.reset();
    }
    this.updateMeter();
    this.updateUsageBar();
    void this.refreshStatus();
  }

  async onClose() {}

  /** Probe the active provider and the studyweb backend, and reflect both in
   * the header: a dot for "can I answer at all", text for what's wrong. */
  private async refreshStatus() {
    const backend = new Backend(this.plugin.settings);
    const p = backend.provider();
    this.setStatus("checking", `${p.label} · checking…`, "");

    const [status, web] = await Promise.all([
      backend.checkProvider(),
      backend.studywebHealth().then(() => true).catch(() => false),
    ]);
    this.plugin.status[p.id] = status;

    const model = status.model || status.models[0] || "";
    const modelPart = model ? ` · ${model}` : "";
    const webPart = web ? "" : " · web tools offline";
    // The provider decides the dot; a missing backend only costs us the tools.
    const label = status.state === "ok"
      ? `${p.label}${modelPart}${webPart}`
      : `${p.label}: ${STATE_LABEL[status.state]}`;
    const tip = [status.detail,
                 web ? "studyweb backend: connected"
                     : `studyweb backend unreachable at ${this.plugin.settings.studywebUrl} — ` +
                       "run `studyweb serve` to restore web search."].join("\n");
    // The provider decides green vs red; a reachable model with no backend is
    // amber — you can still chat, just without web tools.
    const tone = !web && status.state === "ok" ? "warn" : stateTone(status.state);
    this.setStatus(status.state, label, tip, tone);
  }

  private setStatus(state: ConnState, text: string, tip: string,
                    toneOverride?: "ok" | "warn" | "bad" | "idle") {
    if (!this.statusDot) return;
    const tone = toneOverride ?? stateTone(state);
    for (const t of ["ok", "warn", "bad", "idle"]) {
      this.statusDot.toggleClass(`lms-dot-${t}`, t === tone);
    }
    this.statusEl.setText(text);
    this.statusEl.toggleClass("lms-status-bad", tone === "bad");
    this.statusEl.toggleClass("lms-status-warn", tone === "warn");
    this.statusEl.toggleClass("lms-status-ok", tone === "ok");
    if (tip) this.statusEl.parentElement?.setAttr("aria-label", tip);
  }

  /** Session spend line under the context meter. */
  private updateUsageBar() {
    if (!this.usageEl) return;
    const s = this.plugin.sessionUsage;
    if (!this.plugin.settings.showUsage || !s.requests) {
      this.usageEl.setText("");
      this.usageEl.hide();
      return;
    }
    this.usageEl.show();
    const total = s.promptTokens + s.completionTokens;
    const cost = s.unpriced && !s.costUsd ? "cost unknown" : fmtCost(s.costUsd);
    const life = this.plugin.settings.lifetimeUsage;
    this.usageEl.setText(
      `💸 this session: ${s.requests} call(s) · ${total.toLocaleString()} tokens · ${cost}`);
    this.usageEl.title =
      `Session · ${s.promptTokens.toLocaleString()} in / ${s.completionTokens.toLocaleString()} out` +
      (s.cachedTokens ? ` / ${s.cachedTokens.toLocaleString()} cached` : "") +
      `\nAll time · ${life.requests} call(s) · ` +
      `${(life.promptTokens + life.completionTokens).toLocaleString()} tokens · ${fmtCost(life.costUsd)}` +
      (life.unpriced ? ` (+${life.unpriced} unpriced)` : "");
  }

  private recordUsage(u: Usage) {
    this.plugin.recordUsage(u);
    this.updateUsageBar();
  }

  private reset() {
    this.gen++;                       // cancel any in-flight turn
    this.setBusy(false);
    this.plugin.messages = [{ role: "system", content: this.plugin.settings.systemPrompt }];
    this.plugin.displayLog = [];
    this.log.empty();
    const p = new Backend(this.plugin.settings).provider();
    this.pushBubble({ kind: "plain", role: "assistant",
      md: `_Using **${p.label}**. Ask me to look something up._`, markdown: true });
    this.updateMeter();
    this.updateUsageBar();
    void this.refreshStatus();
  }

  private stop() {
    if (!this.busy) return;
    this.gen++;                       // detach the running turn
    this.setBusy(false);
    this.pendingEl?.remove();
    this.pendingEl = null;
    this.pushBubble({ kind: "plain", role: "tool", md: "⏹ Stopped.", markdown: false });
  }

  /** Re-render the whole conversation from stored display history. */
  private replay() {
    this.log.empty();
    for (const e of this.history) {
      if (e.kind === "answer") this.renderAnswer(e.md, e.sources, false, e.usage);
      else this.bubble(e.role, e.md, e.markdown);
    }
  }

  private pushBubble(e: DisplayEntry): HTMLElement {
    this.history.push(e);
    if (e.kind === "answer") return this.renderAnswer(e.md, e.sources, false, e.usage);
    return this.bubble(e.role, e.md, e.markdown);
  }

  private bubble(role: "user" | "assistant" | "tool", md: string, markdown = false): HTMLElement {
    const el = this.log.createDiv({ cls: `lms-msg lms-${role}` });
    if (markdown) {
      MarkdownRenderer.render(this.app, md, el, "", this.plugin);
    } else {
      el.setText(md);
    }
    this.log.scrollTo({ top: this.log.scrollHeight });
    return el;
  }

  /** Refresh the context-usage meter from the current messages, broken down by
   * system prompt / conversation / search·tool results. */
  private updateMeter() {
    if (!this.meterFill) return;
    let sys = 0, conv = 0, tool = 0;
    for (const m of this.messages) {
      const t = estTokens(m.content ?? "");
      if (m.role === "system") sys += t;
      else if (m.role === "tool") tool += t;
      else conv += t;
    }
    const used = sys + conv + tool;
    const total = Math.max(1, this.plugin.settings.contextWindow);
    const pct = Math.min(100, Math.round((used / total) * 100));
    this.meterFill.style.width = pct + "%";
    this.meterFill.toggleClass("lms-meter-warn", pct >= 75 && pct < 90);
    this.meterFill.toggleClass("lms-meter-danger", pct >= 90);
    this.meterLabel.setText(`${used.toLocaleString()} / ${total.toLocaleString()} tokens (${pct}%)`);
    this.meterEl.title =
      `Estimated tokens · system prompt ${sys.toLocaleString()} · conversation ${conv.toLocaleString()} ` +
      `· search/tool results ${tool.toLocaleString()}`;
  }

  /** Drop oldest non-system turns so the running context can't overflow the
   * model. Reserves ~25% of the window for the model's reply. Never orphans a
   * `tool` message (which must follow its assistant). */
  private trimContext() {
    const budget = Math.floor(this.plugin.settings.contextWindow * 0.75);
    const size = () => this.messages.reduce((n, m) => n + estTokens(m.content ?? ""), 0);
    while (this.messages.length > 2 && size() > budget) {
      this.messages.splice(1, 1);
      while (this.messages.length > 1 && this.messages[1].role === "tool") {
        this.messages.splice(1, 1);
      }
    }
    this.updateMeter();
  }

  private async send() {
    if (this.busy) return;
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";
    const myGen = ++this.gen;
    this.setBusy(true);
    this.pushBubble({ kind: "plain", role: "user", md: text, markdown: false });
    this.messages.push({ role: "user", content: text });
    this.updateMeter();

    const working = this.bubble("tool", "", false);
    spinnerText(working, "⏳", "Working…");
    this.pendingEl = working;
    const backend = new Backend(this.plugin.settings);
    const provider = backend.provider();
    const sources = new Set<string>();
    // Everything this one question costs, summed across the tool-call rounds.
    let turnUsage = blankCall(provider.id);
    const bank = (u: Usage) => { turnUsage = addUsage(turnUsage, u); this.recordUsage(u); };
    try {
      const model = await backend.resolveModel();
      if (myGen !== this.gen) return;               // cancelled while resolving
      let answered = false;
      // A provider without tool-calling (the Claude Code CLI runs its own loop)
      // answers directly instead of driving studyweb's web tools.
      const tools = provider.supportsTools ? await backend.getToolSchemas() : null;
      for (let step = 0; step < this.plugin.settings.maxToolSteps; step++) {
        this.trimContext();
        const { message: msg, usage } = await backend.chat(this.messages, model, tools);
        if (myGen !== this.gen) return;             // cancelled during the call
        bank(usage);
        const toolCalls = msg.tool_calls ?? [];
        this.messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: toolCalls.length ? toolCalls : undefined });

        if (!toolCalls.length) {
          working.remove();
          const clean = this.plugin.settings.hideThinking ? stripThinking(msg.content ?? "") : (msg.content ?? "");
          this.pushBubble({ kind: "answer", md: clean, sources: [...sources], usage: turnUsage });
          answered = true;
          break;
        }
        for (const tc of toolCalls) {
          let args: any = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* ignore */ }
          spinnerText(working, "🔧", `${tc.function?.name}…`);
          this.pushBubble({ kind: "plain", role: "tool", md: `🔧 ${tc.function?.name}(${JSON.stringify(args)})`, markdown: false });
          const result = await backend.dispatchTool(tc.function?.name, args);
          if (myGen !== this.gen) return;           // cancelled during a tool call
          for (const u of urlsFromToolResult(result)) sources.add(u);
          this.messages.push({ role: "tool", tool_call_id: tc.id ?? tc.function?.name, name: tc.function?.name, content: result });
        }
      }
      if (!answered) {
        spinnerText(working, "✍️", "Writing answer…");
        this.trimContext();
        const { message: msg, usage } = await backend.chat(this.messages, model, null);
        if (myGen !== this.gen) return;
        bank(usage);
        working.remove();
        const clean = this.plugin.settings.hideThinking ? stripThinking(msg.content ?? "") : (msg.content ?? "");
        this.pushBubble({ kind: "answer", md: clean, sources: [...sources], usage: turnUsage });
      }
    } catch (e: any) {
      if (myGen !== this.gen) return;
      working.remove();
      this.pushBubble({ kind: "plain", role: "assistant",
                        md: this.explainFailure(e, provider), markdown: false });
      void this.refreshStatus();   // the header should agree with what just failed
    } finally {
      if (myGen === this.gen) { this.setBusy(false); this.pendingEl = null; }
    }
  }

  /** Turn an exception into something the user can act on: which provider
   * failed, and what to do about it. */
  private explainFailure(e: any, p: ProviderDef): string {
    const msg = e?.message ?? String(e);
    const status = e instanceof HttpError ? e.status : 0;
    if (status === 401 || status === 403) {
      return `⚠️ ${p.label} rejected the API key. Check it in Settings → studyweb LMS.\n${msg}`;
    }
    if (status === 429) {
      return `⚠️ ${p.label} is rate-limiting or out of quota. Wait a moment, or switch provider.\n${msg}`;
    }
    if (status === 0) {
      return `⚠️ Can't reach ${p.label}.` +
        (p.local ? " Is the local server running?" : " Check your connection and the base URL.") +
        `\n${msg}`;
    }
    if (status === 404) {
      return `⚠️ ${p.label} doesn't know that model. Pick another in settings ` +
        `(use Refresh to list what's available).\n${msg}`;
    }
    return `⚠️ ${msg}`;
  }

  private renderAnswer(md: string, sources: string[], record = true,
                       usage?: Usage): HTMLElement {
    if (record) this.history.push({ kind: "answer", md, sources, usage });
    const el = this.bubble("assistant", md || "_(empty response)_", true);
    if (usage && usage.requests && this.plugin.settings.showUsage) {
      const line = el.createDiv({ cls: "lms-usage" });
      line.setText(`${usage.provider}/${usage.model} · ${usageLine(usage)}`);
      line.title = usage.costUsd === null
        ? "This model has no price in the table — set one in settings to see cost."
        : "Tokens and cost for this answer, including every tool-call round.";
    }
    const actions = el.createDiv({ cls: "lms-actions" });
    const ins = actions.createEl("button", { cls: "lms-icon-btn", text: "Insert into note" });
    ins.onclick = () => this.insertIntoNote(this.withSources(md, sources));
    const nw = actions.createEl("button", { cls: "lms-icon-btn", text: "New note" });
    nw.onclick = () => void this.newNote(this.withSources(md, sources));
    return el;
  }

  /** Append a Sources list when enabled and any were captured this turn. */
  private withSources(md: string, sources: string[]): string {
    if (!this.plugin.settings.appendSources || !sources.length) return md;
    const list = sources.map((u) => `- ${u}`).join("\n");
    return `${md}\n\n## Sources\n${list}\n`;
  }

  private insertIntoNote(md: string) {
    try {
      if (insertAtCursor(this.app, md)) new Notice("Inserted at cursor.");
      else new Notice("Open a note first to insert into it.");
    } catch (e: any) {
      new Notice(`Could not insert: ${e.message}`);
    }
  }

  private async newNote(md: string) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const folder = this.plugin.settings.noteFolder.replace(/^\/+|\/+$/g, "");
      let base = folder ? `${folder}/studyweb Research ${stamp}` : `studyweb Research ${stamp}`;
      // Avoid clobbering an existing note (two answers within the same second).
      let path = `${base}.md`;
      let i = 2;
      while (this.app.vault.getAbstractFileByPath(path)) { path = `${base} (${i++}).md`; }
      const file = await this.app.vault.create(path, md + "\n");
      await this.app.workspace.getLeaf(true).openFile(file);
      new Notice(`Created ${path}`);
    } catch (e: any) {
      new Notice(`Could not create note: ${e.message}`);
    }
  }

  private setBusy(b: boolean) {
    this.busy = b;
    if (!this.sendBtn) return;
    this.sendBtn.disabled = b;
    this.sendBtn.toggle(!b);
    this.stopBtn.toggle(b);
  }
}

/* ------------------------------------------------ selection → web search UI */

/** Shows a small floating "search" button next to a text selection in a note.
 * Clicking it web-searches the selected text and opens a result table. */
class SelectionSearchController {
  private btn: HTMLElement;
  private query = "";
  private timer = 0;

  constructor(private plugin: StudywebLMSPlugin) {
    this.btn = document.body.createDiv({ cls: "lms-sel-search" });
    setIcon(this.btn, "search");
    this.btn.setAttr("aria-label", "Web search selection");
    this.btn.hide();
    // Keep the text selection when pressing the button.
    this.btn.addEventListener("mousedown", (e) => e.preventDefault());
    this.btn.addEventListener("click", () => this.run());

    this.plugin.registerDomEvent(document, "selectionchange", () => this.schedule());
    this.plugin.registerDomEvent(window, "scroll", () => this.hide(), true);
    // Remove the injected element when the plugin unloads.
    this.plugin.register(() => this.btn.remove());
  }

  private schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.update(), 120);
  }

  private update() {
    if (!this.plugin.settings.selectionSearch) return this.hide();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return this.hide();
    const text = sel.toString().trim();
    if (text.length < 2) return this.hide();
    // Only inside a Markdown editor (so we can also insert results back).
    const node = sel.anchorNode;
    const el = node instanceof HTMLElement ? node : node?.parentElement ?? null;
    if (!el || !el.closest(".cm-editor")) return this.hide();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return this.hide();

    this.query = text;
    this.btn.style.top = `${Math.max(4, rect.top - 34)}px`;
    this.btn.style.left = `${rect.left}px`;
    this.btn.show();
  }

  private hide() {
    this.btn.hide();
  }

  private run() {
    const q = this.query.trim();
    this.hide();
    if (q) new SearchResultModal(this.plugin, q).open();
  }
}

/** Modal that runs the search, streams progress + the LLM's live output, then
 * renders the summary table and can insert it. */
class SearchResultModal extends Modal {
  private abort = new AbortController();
  private closed = false;

  constructor(private plugin: StudywebLMSPlugin, private query: string) {
    super(plugin.app);
  }

  async onOpen() {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass("lms-search-modal");   // widen for a 3-column table
    titleEl.setText("Web search");
    const shown = this.query.length > 90 ? this.query.slice(0, 90) + "…" : this.query;
    contentEl.createDiv({ cls: "lms-searchmodal-q", text: `“${shown}”` });

    const status = contentEl.createDiv({ cls: "lms-searchmodal-status" });
    spinnerText(status, "⏳", "Preparing…");
    // Live raw stream of the model's generation (shows the reasoning process).
    const stream = contentEl.createEl("pre", { cls: "lms-searchmodal-stream" });
    stream.hide();
    const body = contentEl.createDiv({ cls: "lms-searchmodal-body" });

    let streamed = "";
    try {
      const backend = new Backend(this.plugin.settings);
      const n = this.plugin.settings.selectionResults;
      const { markdown, usage } = await backend.searchSummaryStream(this.query.slice(0, 300), n, {
        onStatus: (t) => { if (!this.closed) spinnerText(status, "⏳", t); },
        onToken: (d) => {
          if (this.closed) return;
          stream.show();
          spinnerText(status, "✍️", "Summarising…");
          streamed += d;
          stream.setText(streamed);
          stream.scrollTop = stream.scrollHeight;
        },
        signal: this.abort.signal,
      });
      if (this.closed) return;

      // Replace the live stream with the rendered final table.
      stream.hide();
      status.setText("✅ Done");
      await MarkdownRenderer.render(this.app, markdown, body, "", this.plugin);
      if (usage && usage.requests) {
        this.plugin.recordUsage(usage);
        if (this.plugin.settings.showUsage) {
          contentEl.createDiv({ cls: "lms-usage",
            text: `${usage.provider}/${usage.model} · ${usageLine(usage)}` });
        }
      }

      const bar = contentEl.createDiv({ cls: "lms-searchmodal-actions" });
      const insert = bar.createEl("button", { cls: "mod-cta", text: "Insert into note" });
      insert.onclick = () => { this.insert(markdown); this.close(); };
      const copy = bar.createEl("button", { text: "Copy" });
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(markdown); new Notice("Copied."); }
        catch { new Notice("Copy failed."); }
      };
    } catch (e: any) {
      if (this.closed || this.abort.signal.aborted) return;
      const p = new Backend(this.plugin.settings).provider();
      status.setText(`⚠️ Search failed: ${e.message} — check that 'studyweb serve' is running ` +
                     `and that ${p.label} is reachable.`);
    }
  }

  onClose() {
    this.closed = true;
    this.abort.abort();   // cancel any in-flight stream
    this.contentEl.empty();
  }

  private insert(md: string) {
    if (insertAtCursor(this.app, md)) new Notice("Inserted at cursor.");
    else new Notice("Open a note first to insert into it.");
  }
}

/* ------------------------------------------------------------------- plugin */

export default class StudywebLMSPlugin extends Plugin {
  settings!: LMSSettings;
  // Conversation state shared with the view so it survives the pane closing.
  messages: ChatMessage[] = [];
  displayLog: DisplayEntry[] = [];
  // Last known connection state per provider, so the settings tab and the chat
  // header show the same thing without re-probing.
  status: Record<string, ProviderStatus> = {};
  // Tokens/cost since Obsidian started (lifetime totals live in settings).
  sessionUsage: UsageTotals = blankUsage();

  /** Fold one call into the session and lifetime totals. */
  recordUsage(u: Usage) {
    accumulate(this.sessionUsage, u);
    accumulate(this.settings.lifetimeUsage, u);
    void this.saveSettings();
  }

  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE_LMS, (leaf) => new LMSView(leaf, this));
    this.addRibbonIcon("globe", "Open studyweb chat", () => this.activateView());
    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.activateView(),
    });
    this.addSettingTab(new LMSSettingTab(this.app, this));

    // Floating web-search button on text selection.
    new SelectionSearchController(this);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_LMS)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_LMS, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.providers = this.settings.providers ?? {};
    this.settings.priceOverrides = this.settings.priceOverrides ?? {};
    this.settings.lifetimeUsage = Object.assign(blankUsage(), this.settings.lifetimeUsage);
    // Pre-provider installs configured LM Studio with two top-level fields —
    // carry those over so an upgrade keeps working untouched.
    if (!this.settings.providers["lmstudio"]) {
      this.settings.providers["lmstudio"] = {
        apiKey: "",
        baseUrl: this.settings.lmStudioUrl || "",
        model: this.settings.model && this.settings.model !== "auto" ? this.settings.model : "",
      };
    }
    for (const p of PROVIDERS) {
      this.settings.providers[p.id] = Object.assign(
        { apiKey: "", baseUrl: "", model: "" }, this.settings.providers[p.id]);
    }
    if (!PROVIDER_BY_ID[this.settings.activeProvider]) this.settings.activeProvider = "lmstudio";
    // An old install carries the prompt we shipped then, and would keep asking
    // the model to work without the rules the tools since grew. Replace it —
    // but only if it is untouched, so a customised prompt is never overwritten.
    const prompt = (this.settings.systemPrompt ?? "").trim();
    if (!prompt || SUPERSEDED_SYSTEM_PROMPTS.includes(prompt)) {
      this.settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
    }
  }

  async saveSettings() { await this.saveData(this.settings); }
}

/* ------------------------------------------------------------- settings tab */

class LMSSettingTab extends PluginSettingTab {
  plugin: StudywebLMSPlugin;
  constructor(app: App, plugin: StudywebLMSPlugin) { super(app, plugin); this.plugin = plugin; }

  /* ------------------------------------------------------ model providers */

  /** One card per provider: a live status light, its key, endpoint and model,
   * and a Test button — plus the picker that says which one answers. */
  private renderProviders(root: HTMLElement) {
    new Setting(root).setName("Model providers").setHeading();

    const active = new Setting(root)
      .setName("Active provider")
      .setDesc("Which model answers in the chat pane and the selection search.");
    active.addDropdown((d) => {
      for (const p of PROVIDERS) d.addOption(p.id, p.label);
      d.setValue(this.plugin.settings.activeProvider);
      d.onChange(async (v) => {
        this.plugin.settings.activeProvider = v;
        await this.plugin.saveSettings();
        this.display();        // re-render so the active card moves to the top
      });
    });
    active.addExtraButton((b) => b.setIcon("refresh-cw")
      .setTooltip("Check every provider now")
      .onClick(() => void this.probeAll()));

    new Setting(root)
      .setName("Keep API keys on the server")
      .setDesc("On: model calls go through the studyweb backend, which uses the keys " +
               "in its own environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, NVIDIA_API_KEY) — " +
               "nothing secret is stored in this vault. Off: this plugin calls the " +
               "providers directly with the keys below.")
      .addToggle((t) => t.setValue(this.plugin.settings.routeThroughBackend)
        .onChange(async (v) => {
          this.plugin.settings.routeThroughBackend = v;
          await this.plugin.saveSettings();
          this.display();
        }));

    // Active provider first — that's the one being configured most of the time.
    const ordered = [...PROVIDERS].sort((a, b) =>
      Number(b.id === this.plugin.settings.activeProvider) -
      Number(a.id === this.plugin.settings.activeProvider));
    for (const p of ordered) this.renderProviderCard(root, p);
  }

  private renderProviderCard(root: HTMLElement, p: ProviderDef) {
    const cfg = this.plugin.settings.providers[p.id] ?? { apiKey: "", baseUrl: "", model: "" };
    const isActive = p.id === this.plugin.settings.activeProvider;
    const card = root.createDiv({ cls: "lms-prov" + (isActive ? " lms-prov-active" : "") });

    const head = card.createDiv({ cls: "lms-prov-head" });
    const dot = head.createSpan({ cls: "lms-dot lms-dot-idle" });
    head.createSpan({ cls: "lms-prov-name", text: p.label });
    if (isActive) head.createSpan({ cls: "lms-prov-badge", text: "active" });
    if (p.local) head.createSpan({ cls: "lms-prov-tag", text: "local · free" });
    if (!p.supportsTools) head.createSpan({ cls: "lms-prov-tag", text: "no web tools" });
    const stateEl = head.createSpan({ cls: "lms-prov-state", text: "Not checked" });

    const detail = card.createDiv({ cls: "lms-prov-detail" });
    if (p.note) card.createDiv({ cls: "lms-prov-note", text: p.note });

    const paint = (s: ProviderStatus | undefined) => {
      const state: ConnState = s?.state ?? "unknown";
      const tone = stateTone(state);
      for (const t of ["ok", "warn", "bad", "idle"]) dot.toggleClass(`lms-dot-${t}`, t === tone);
      stateEl.setText(STATE_LABEL[state] + (s?.latencyMs ? ` · ${s.latencyMs}ms` : ""));
      stateEl.className = `lms-prov-state lms-tone-${tone}`;
      detail.setText(s?.detail ?? "");
    };
    paint(this.plugin.status[p.id]);

    const check = async () => {
      paint({ state: "checking", detail: "", models: [], model: "", latencyMs: 0, checkedAt: 0 });
      const status = await new Backend(this.plugin.settings).checkProvider(p.id);
      this.plugin.status[p.id] = status;
      paint(status);
      if (status.models.length) fillModels(status.models);
    };
    this.probes.push(check);

    // --- API key (hidden unless the provider needs one) --------------------
    if (p.requiresKey || p.kind === "openai") {
      const keyRow = new Setting(card).setName("API key");
      if (this.plugin.settings.routeThroughBackend) {
        keyRow.setDesc(`Not used while keys stay on the server — studyweb reads ${p.keyEnv}.`);
        keyRow.addText((t) => { t.setDisabled(true); t.setPlaceholder(`${p.keyEnv} (server-side)`); });
      } else {
        keyRow.setDesc(p.requiresKey
          ? `Stored in this vault. Or set ${p.keyEnv} and turn on "Keep API keys on the server".`
          : "Optional — most local servers don't need one.");
        keyRow.addText((t) => {
          t.inputEl.type = "password";
          t.setPlaceholder(p.requiresKey ? "required" : "optional")
            .setValue(cfg.apiKey)
            .onChange(async (v) => {
              cfg.apiKey = v.trim();
              this.plugin.settings.providers[p.id] = cfg;
              await this.plugin.saveSettings();
            });
        });
      }
      if (p.docs) {
        keyRow.addExtraButton((b) => b.setIcon("external-link").setTooltip("Get a key")
          .onClick(() => window.open(p.docs)));
      }
    }

    // --- endpoint ---------------------------------------------------------
    if (p.kind !== "cli") {
      new Setting(card)
        .setName("Base URL")
        .setDesc(`OpenAI-style endpoint. Empty = ${p.baseUrl}`)
        .addText((t) => t.setPlaceholder(p.baseUrl).setValue(cfg.baseUrl)
          .onChange(async (v) => {
            cfg.baseUrl = v.trim();
            this.plugin.settings.providers[p.id] = cfg;
            await this.plugin.saveSettings();
          }));
    }

    // --- model + refresh --------------------------------------------------
    const modelSetting = new Setting(card)
      .setName("Model")
      .setDesc(p.local && !p.defaultModel
        ? "Empty = whatever is currently loaded."
        : `Empty = ${p.defaultModel || "the provider's default"}.`);
    let dd: any = null;
    const fillModels = (ids: string[]) => {
      if (!dd) return;
      dd.selectEl.empty();
      dd.addOption("", p.local && !p.defaultModel ? "(currently loaded)" : `(default: ${p.defaultModel || "auto"})`);
      const all = [...new Set([...ids, ...(cfg.model ? [cfg.model] : [])])];
      for (const id of all) dd.addOption(id, id);
      dd.setValue(cfg.model);
    };
    modelSetting.addDropdown((d) => {
      dd = d;
      fillModels(this.plugin.status[p.id]?.models ?? p.fallbackModels);
      d.onChange(async (v) => {
        cfg.model = v;
        this.plugin.settings.providers[p.id] = cfg;
        await this.plugin.saveSettings();
        const price = priceFor(p.id, v, this.plugin.settings.priceOverrides);
        if (v && !price) {
          new Notice(`No price known for ${v} — usage will show tokens but not cost.`);
        }
      });
    });
    modelSetting.addExtraButton((b) => b.setIcon("refresh-cw").setTooltip("List available models")
      .onClick(async () => {
        try {
          const ids = await new Backend(this.plugin.settings).listModels(p.id);
          fillModels(ids);
          new Notice(`${p.label}: ${ids.length} model(s).`);
        } catch (e: any) {
          new Notice(`Could not list ${p.label} models: ${e.message}`);
        }
      }));

    const actions = card.createDiv({ cls: "lms-prov-actions" });
    const testBtn = actions.createEl("button", { text: "Test connection" });
    testBtn.onclick = () => void check();
    if (!isActive) {
      const useBtn = actions.createEl("button", { cls: "mod-cta", text: "Use this provider" });
      useBtn.onclick = async () => {
        this.plugin.settings.activeProvider = p.id;
        await this.plugin.saveSettings();
        this.display();
      };
    }
  }

  /** Every card's check function, so one button can probe them all. */
  private probes: Array<() => Promise<void>> = [];

  private async probeAll() {
    await Promise.all(this.probes.map((fn) => fn().catch(() => {})));
  }

  /* --------------------------------------------------------------- usage */

  private renderUsage(root: HTMLElement) {
    new Setting(root).setName("Usage & cost").setHeading();

    new Setting(root)
      .setName("Show usage after each answer")
      .setDesc("Tokens in/out, cost, and elapsed time for every reply, plus a running " +
               "total for the session above the chat.")
      .addToggle((t) => t.setValue(this.plugin.settings.showUsage)
        .onChange(async (v) => {
          this.plugin.settings.showUsage = v;
          await this.plugin.saveSettings();
        }));

    const s = this.plugin.sessionUsage;
    const life = this.plugin.settings.lifetimeUsage;
    const box = root.createDiv({ cls: "lms-usage-panel" });
    const row = (label: string, t: UsageTotals) => {
      const total = t.promptTokens + t.completionTokens;
      box.createDiv({ text:
        `${label}: ${t.requests} call(s) · ${t.promptTokens.toLocaleString()} in / ` +
        `${t.completionTokens.toLocaleString()} out = ${total.toLocaleString()} tokens · ` +
        fmtCost(t.costUsd) + (t.unpriced ? ` (+${t.unpriced} unpriced)` : "") });
    };
    row("This session", s);
    row("All time", life);
    box.createDiv({ cls: "lms-prov-note", text:
      "Prices come from a built-in table (matched to the studyweb backend when it's " +
      "running). Models with no entry report tokens only — override a price below." });

    new Setting(root)
      .setName("Price override")
      .setDesc('For a model the table doesn\'t know. Format: "provider/model in out" ' +
               'in USD per 1M tokens — e.g. "nvidia/meta/llama-3.3-70b-instruct 0.2 0.2".')
      .addText((t) => {
        t.setPlaceholder("provider/model in out");
        t.inputEl.addEventListener("keydown", async (e) => {
          if (e.key !== "Enter") return;
          const m = t.getValue().trim().match(/^(\S+)\s+([\d.]+)\s+([\d.]+)$/);
          if (!m) { new Notice('Expected: "provider/model in out"'); return; }
          this.plugin.settings.priceOverrides[m[1]] = { in: Number(m[2]), out: Number(m[3]) };
          await this.plugin.saveSettings();
          new Notice(`Priced ${m[1]} at $${m[2]}/$${m[3]} per 1M tokens.`);
          t.setValue("");
          this.display();
        });
      });

    const overrides = Object.entries(this.plugin.settings.priceOverrides);
    if (overrides.length) {
      for (const [key, val] of overrides) {
        new Setting(root)
          .setName(key)
          .setDesc(`$${val.in} in / $${val.out} out per 1M tokens`)
          .addExtraButton((b) => b.setIcon("trash-2").setTooltip("Remove").onClick(async () => {
            delete this.plugin.settings.priceOverrides[key];
            await this.plugin.saveSettings();
            this.display();
          }));
      }
    }

    new Setting(root)
      .setName("Reset counters")
      .setDesc("Clears the session and all-time totals shown above.")
      .addButton((b) => b.setButtonText("Reset session").onClick(async () => {
        this.plugin.sessionUsage = blankUsage();
        await this.plugin.saveSettings();
        this.display();
      }))
      .addButton((b) => b.setButtonText("Reset all time").setWarning().onClick(async () => {
        this.plugin.sessionUsage = blankUsage();
        this.plugin.settings.lifetimeUsage = blankUsage();
        await this.plugin.saveSettings();
        this.display();
      }));
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    this.probes = [];

    this.renderProviders(containerEl);
    this.renderUsage(containerEl);

    // Show the active provider's real state straight away (its card sorts
    // first); the rest are probed on demand, so opening settings never waits
    // on a dead endpoint.
    if (this.probes.length) void this.probes[0]().catch(() => {});

    new Setting(containerEl).setName("Connections").setHeading();

    new Setting(containerEl)
      .setName("studyweb backend URL")
      .setDesc("Where `studyweb serve` is running.")
      .addText((t) => t.setPlaceholder("http://localhost:8787")
        .setValue(this.plugin.settings.studywebUrl)
        .onChange(async (v) => { this.plugin.settings.studywebUrl = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("studyweb API key (optional)")
      .setDesc("Only if the backend was started with STUDYWEB_API_KEY.")
      .addText((t) => { t.setValue(this.plugin.settings.studywebApiKey)
        .onChange(async (v) => { this.plugin.settings.studywebApiKey = v.trim(); await this.plugin.saveSettings(); });
        t.inputEl.type = "password"; });

    new Setting(containerEl).setName("Generation").setHeading();

    new Setting(containerEl)
      .setName("Max reply tokens")
      .setDesc("Upper bound on one reply. Claude counts its thinking against this " +
               "budget, so don't set it too low or answers get cut off.")
      .addSlider((s) => s.setLimits(1024, 32768, 1024).setDynamicTooltip()
        .setValue(this.plugin.settings.maxTokens)
        .onChange(async (v) => { this.plugin.settings.maxTokens = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("0 = deterministic. Applied to every request.")
      .addSlider((s) => s.setLimits(0, 1, 0.1).setDynamicTooltip()
        .setValue(this.plugin.settings.temperature)
        .onChange(async (v) => { this.plugin.settings.temperature = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Hide model thinking")
      .setDesc("Strip <think>…</think> reasoning blocks from answers before showing/saving them.")
      .addToggle((t) => t.setValue(this.plugin.settings.hideThinking)
        .onChange(async (v) => { this.plugin.settings.hideThinking = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Max tool steps")
      .setDesc("Upper bound on tool-call rounds per question.")
      .addSlider((s) => s.setLimits(1, 12, 1).setDynamicTooltip()
        .setValue(this.plugin.settings.maxToolSteps)
        .onChange(async (v) => { this.plugin.settings.maxToolSteps = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Hardware & context").setHeading();

    const hw = detectHardware();
    const info = containerEl.createDiv({ cls: "lms-hw-info" });
    info.createDiv({ text: `🧠 CPU: ${hw.cpuModel}${hw.cores ? ` · ${hw.cores} cores` : ""}` });
    info.createDiv({ text: `💾 RAM: ${hw.ramGB ? hw.ramGB + " GB" : "unknown"}` });
    info.createDiv({
      text: `🎮 GPU: ${hw.gpu}` +
        (hw.gpuTier === "discrete" ? " · discrete GPU" : hw.gpuTier === "integrated" ? " · integrated graphics" : ""),
    });
    if (hw.platform) info.createDiv({ cls: "lms-hw-plat", text: hw.platform });

    const MINCTX = 2048, MAXCTX = 32768;
    const lim = contextLimits(hw);
    const pct = (v: number) => Math.max(0, Math.min(100, ((v - MINCTX) / (MAXCTX - MINCTX)) * 100));
    let updateFeas: (v: number) => void = () => {};   // assigned after the bar is built

    new Setting(containerEl)
      .setName("Context window (tokens)")
      .setDesc("Token budget for the conversation and search results. Older turns are trimmed once it's exceeded, and the meter above the chat shows usage. Match this to the context length of the model loaded in LM Studio.")
      .addSlider((s) => s.setLimits(MINCTX, MAXCTX, 1024).setDynamicTooltip()
        .setValue(this.plugin.settings.contextWindow)
        .onChange(async (v) => {
          this.plugin.settings.contextWindow = v;
          updateFeas(v);                 // live feasibility readout
          await this.plugin.saveSettings();
        }));

    // Feasibility visualiser: a green/yellow/red zone bar (sized by the
    // hardware's estimated limits) with a marker at the chosen value.
    const feas = containerEl.createDiv({ cls: "lms-ctx-feas" });
    const zonebar = feas.createDiv({ cls: "lms-ctx-zonebar" });
    const track = zonebar.createDiv({ cls: "lms-ctx-track" });
    const green = track.createDiv({ cls: "lms-ctx-zone lms-ctx-green" });
    const yellow = track.createDiv({ cls: "lms-ctx-zone lms-ctx-yellow" });
    const red = track.createDiv({ cls: "lms-ctx-zone lms-ctx-red" });
    green.style.width = pct(lim.comfortable) + "%";
    yellow.style.width = (pct(lim.max) - pct(lim.comfortable)) + "%";
    red.style.width = (100 - pct(lim.max)) + "%";
    const marker = zonebar.createDiv({ cls: "lms-ctx-marker" });
    const label = feas.createDiv({ cls: "lms-ctx-label" });

    updateFeas = (v: number) => {
      marker.style.left = pct(v) + "%";
      const st = contextStatus(v, lim);
      label.setText(`${v.toLocaleString()} tokens — ${st.label}`);
      label.className = "lms-ctx-label lms-ctx-" + st.cls;
    };
    updateFeas(this.plugin.settings.contextWindow);

    new Setting(containerEl)
      .setName("Recommended context")
      .setDesc(
        `Comfortable for this hardware: ~${lim.comfortable.toLocaleString()} tokens` +
        (hw.gpuTier === "discrete" ? " (discrete GPU → raised)" : hw.ramGB ? ` (based on ${hw.ramGB}GB RAM)` : "") +
        ". Rough estimate assuming a ~7–8B Q4 model; GPU offload and the real context length are set in LM Studio.")
      .addButton((b) => b.setButtonText(`Apply ${lim.comfortable.toLocaleString()}`).setCta()
        .onClick(async () => {
          this.plugin.settings.contextWindow = lim.comfortable;
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl).setName("Selection search").setHeading();

    new Setting(containerEl)
      .setName("Show search button on selection")
      .setDesc("Highlight text in a note to get a small web-search button; the result is summarised into a table you can insert.")
      .addToggle((t) => t.setValue(this.plugin.settings.selectionSearch)
        .onChange(async (v) => { this.plugin.settings.selectionSearch = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Results to summarise")
      .setDesc("How many search results the selection search condenses into the table.")
      .addSlider((s) => s.setLimits(2, 5, 1).setDynamicTooltip()
        .setValue(this.plugin.settings.selectionResults)
        .onChange(async (v) => { this.plugin.settings.selectionResults = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Summarise with the model")
      .setDesc("On: the local model writes the table (streamed live). Off: build the table directly from search results — instant and CPU-friendly, no inference.")
      .addToggle((t) => t.setValue(this.plugin.settings.selectionUseLLM)
        .onChange(async (v) => { this.plugin.settings.selectionUseLLM = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Selection-search system prompt")
      .setDesc("Guides how the model summarises selection searches into the table. Only used when 'Summarise with the model' is on.")
      .setClass("lms-system-prompt")
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.selectionSystemPrompt)
          .setPlaceholder(DEFAULT_SETTINGS.selectionSystemPrompt)
          .onChange(async (v) => { this.plugin.settings.selectionSystemPrompt = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 4;
      });

    new Setting(containerEl).setName("Saving").setHeading();

    new Setting(containerEl)
      .setName("New-note folder")
      .setDesc("Vault-relative folder for the New note action. Empty = vault root.")
      .addText((t) => t.setPlaceholder("Research")
        .setValue(this.plugin.settings.noteFolder)
        .onChange(async (v) => { this.plugin.settings.noteFolder = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Append sources")
      .setDesc("Add a Sources list of the URLs the tools used to saved/inserted answers.")
      .addToggle((t) => t.setValue(this.plugin.settings.appendSources)
        .onChange(async (v) => { this.plugin.settings.appendSources = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Behaviour").setHeading();
    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("What the model is told before every question: which tool answers " +
               "what, and how to read the results. Edit freely — the arrow puts " +
               "the shipped default back.")
      .setClass("lms-system-prompt")
      .addExtraButton((b) => b.setIcon("rotate-ccw").setTooltip("Restore default")
        .onClick(async () => {
          this.plugin.settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
          await this.plugin.saveSettings();
          this.display();
        }))
      .addTextArea((t) => { t.setValue(this.plugin.settings.systemPrompt)
        .onChange(async (v) => { this.plugin.settings.systemPrompt = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 14; });
  }
}
