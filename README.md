# studyweb-obsidian

An **Obsidian plugin** that puts a chat with a **local or cloud model** in the
right sidebar — armed with live web tools from the
[`studyweb`](https://github.com/Hong-Iron/studyWeb) backend. Research the web
without leaving your vault, then drop the results straight into a note.

```
Obsidian (right pane) ──▶ your model ──tool calls──▶ studyweb backend ──▶ the web
   LM Studio · OpenAI · Claude       └── answer ──▶ "Insert into note" / "New note"
   NVIDIA NIM · Claude Code CLI
```

## Features

- 🗨️ **Right-pane chat** with a local model *or* a cloud one — LM Studio,
  OpenAI, the Claude API, NVIDIA NIM, the Claude Code CLI, or any
  OpenAI-compatible endpoint. Switch provider from a dropdown.
- 🌐 **Web tools**: the model can `web_search`, `site_search`, `find_prices`, `open_url`, `extract_data`, and `collect_rag`
- 💰 **Prices, not snippets**: `find_prices` checks several shopping sites at once
  and reads each price off the seller's own page — cheapest first, with the sites
  it couldn't read reported rather than hidden
- 💸 **Usage on every answer**: tokens in/out, cost in USD, and elapsed time,
  plus a running session total and an all-time total in settings
- 🚦 **Status lights**: a coloured dot per provider — connected, key needed,
  key rejected, no model, rate-limited, unreachable, not installed — with the
  reason on hover and a *Test connection* button
- 🔐 **Keys your way**: paste them in settings, or flip one toggle to route model
  calls through the studyweb backend so keys never touch your vault
- 📝 **Save to notes**: insert an answer at the cursor, or spin up a new note —
  with an auto-appended **Sources** list of the URLs the tools used
- ⏹ **Cancellable**: a Stop button ends a running turn; stale replies never
  render into a newer conversation
- 🔎 **Model auto-detect**: reads each provider's model list — pick one or leave
  it on the default
- 🧠 **Thinking-aware**: strips `<think>…</think>` blocks (including unclosed ones)
- 🔧 **Fully configurable**: endpoints, models, temperature, reply cap, save
  folder, context budget, per-model prices

## Prerequisites

1. **A model.** Either **LM Studio** with its server on (default
   `http://localhost:1234`) and a tool-capable model loaded, or an API key for
   OpenAI / Claude / NVIDIA NIM, or the `claude` CLI on your PATH.
2. **The [studyweb](https://github.com/Hong-Iron/studyWeb) backend** running —
   the web tools are all served by it:
   ```bash
   pipx install "git+https://github.com/Hong-Iron/studyWeb"
   studyweb serve --port 8787
   ```

## Install (manual / development)

```bash
cd studyweb-obsidian
npm install
npm run build        # produces main.js
```

Then copy `main.js`, `manifest.json`, and `styles.css` into your vault at:

```
<your-vault>/.obsidian/plugins/studyweb-lms/
```

Enable **studyweb (LM Studio)** under *Settings → Community plugins*. Open the
chat from the ribbon 🌐 icon or the command palette (*studyweb: Open chat*).

> For live development you can `npm run dev` (esbuild watch) and symlink the
> folder into `.obsidian/plugins/`.

## Providers

*Settings → studyweb (LM Studio) → Model providers* shows a card per provider
with a status dot, its key, endpoint and model, and a **Test connection**
button. Pick which one answers with **Active provider**.

| Provider | Needs | Notes |
|---|---|---|
| **LM Studio (local)** | nothing | Free, private, offline. Uses whatever model is loaded. |
| **OpenAI** | `OPENAI_API_KEY` | Full tool-calling. |
| **Claude (Anthropic API)** | `ANTHROPIC_API_KEY` | Full tool-calling. Sampling params current models reject are omitted automatically. |
| **NVIDIA NIM** | `NVIDIA_API_KEY` | Hosted build.nvidia.com, or point the base URL at your own NIM container. |
| **Claude Code CLI** | the `claude` binary | Uses the login you already have and reports its exact charge. It runs its own agent loop, so studyweb's web tools aren't attached. Desktop only. |
| **Custom OpenAI-compatible** | optional key | Ollama, vLLM, llama.cpp, OpenRouter, Groq, Together… |

**Where your keys live** is your choice. By default the plugin calls providers
directly using keys stored in this plugin's `data.json` **inside your vault** —
convenient, but it syncs with the vault. Turn on **Keep API keys on the server**
and model calls go through `studyweb serve` instead, which uses the keys in its
own environment; nothing secret is written to the vault.

Streaming (token-by-token output) only applies to a local OpenAI-compatible
server. Cloud providers answer in one shot — the reply appears when it lands.

## Usage & cost

With **Show usage after each answer** on (default), each reply carries a line
like:

```
anthropic/claude-opus-5 · 12,481 in · 302 out · 12,783 tok · $0.0699 · 8.4s · 3 calls
```

Above the chat, a session total tracks what the conversation has cost; settings
show the all-time total and a reset. Costs come from a built-in price table —
matched to the backend's table when `studyweb serve` is reachable — and a model
with no known price honestly reports tokens only, with `cost unknown`. Add a
**Price override** for it (`provider/model in out` in USD per 1M tokens) to get
a figure.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| Active provider | LM Studio | Which model answers |
| Keep API keys on the server | off | Route model calls via studyweb so keys stay out of the vault |
| API key / Base URL / Model | *(per provider)* | With Refresh to list the provider's models |
| Max reply tokens | `8192` | Cap on one reply. Claude counts its thinking against this. |
| Show usage after each answer | on | The token/cost receipt and session total |
| Price override | *(none)* | Price a model the table doesn't know |
| studyweb backend URL | `http://localhost:8787` | Where `studyweb serve` runs |
| studyweb API key | *(empty)* | Only if the backend uses `STUDYWEB_API_KEY` |
| Temperature | `0` | Applied where the model accepts it |
| Hide model thinking | on | Strip `<think>` blocks before showing/saving |
| Max tool steps | `6` | Tool-call rounds per question |
| Context window | *(from hardware)* | Older turns are trimmed past this so context can't overflow |
| New-note folder | *(root)* | Where the *New note* action saves |
| Append sources | on | Add a Sources list of tool URLs to saved answers |
| System prompt | *(preset)* | Editable |

Everything is dynamic: change a port, swap the model, switch provider, or move
the backend — just update the settings, no rebuild required. Upgrading from an
earlier version carries your LM Studio URL and model into the new per-provider
settings automatically.

Keys and the `studyweb API key` are stored in plain text in this plugin's
`data.json` inside your vault. If you sync your vault, either treat those keys
accordingly or use **Keep API keys on the server**.

## Publish (Obsidian community plugin)

Follow the [Obsidian plugin submission guide](https://docs.obsidian.md/Plugins/Releases/Submit+your+plugin):
tag a GitHub release containing `main.js`, `manifest.json`, and `styles.css`.

## Part of the studyweb suite

A local, free, private stack for web search + crawl + RAG — a self-hosted
alternative to hosted search APIs. Three separately-published projects:

| Project | What it is |
|---|---|
| [**studyweb**](https://github.com/Hong-Iron/studyWeb) | The Python engine: search, crawl, clean, RAG chunking, multi-site price lookup, a multi-provider model layer with usage/cost accounting, a CLI, and a Tavily-compatible HTTP API. **Required by this plugin.** |
| **studyweb-obsidian** | This plugin. |
| [**studyweb-lmstudio**](https://github.com/Hong-Iron/studyweb-lmstudio) | An LM Studio Tools Provider plugin — the same web tools inside the LM Studio GUI, plus `ask_expert` to hand a hard question to an external API. |

The backend's [`docs/llm-guide.md`](https://github.com/Hong-Iron/studyWeb/blob/main/docs/llm-guide.md)
is written for the *model*: which tool answers which question, and why `site:`
operators must never appear in a query. Worth pasting into a system prompt if a
small model keeps misusing the tools.

## License

MIT
