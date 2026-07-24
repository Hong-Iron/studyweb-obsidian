# studyweb-obsidian

An **Obsidian plugin** that puts a chat with your **local LM Studio model** in
the right sidebar — armed with live web tools from the
[`studyweb`](../studyweb) backend. Research the web without leaving your vault,
then drop the results straight into a note.

```
Obsidian (right pane) ──▶ LM Studio model ──tool calls──▶ studyweb backend ──▶ the web
                                     └── answer ──▶ "Insert into note" / "New note"
```

## Features

- 🗨️ **Right-pane chat** with any model loaded in LM Studio
- 🌐 **Web tools**: the model can `web_search`, `site_search`, `open_url`, and `collect_rag`
- 📝 **Save to notes**: insert an answer at the cursor, or spin up a new note —
  with an auto-appended **Sources** list of the URLs the tools used
- ⏹ **Cancellable**: a Stop button ends a running turn; stale replies never
  render into a newer conversation
- 🩺 **Live status**: the header shows whether LM Studio and studyweb are reachable
- 🔎 **Model auto-detect**: reads LM Studio's `/v1/models` — pick one or use `auto`
- 🧠 **Thinking-aware**: strips `<think>…</think>` blocks (including unclosed ones)
- 🔧 **Fully configurable**: URLs/port, model, temperature, save folder, context budget

## Prerequisites

1. **LM Studio** running with its server on (default `http://localhost:1234`)
   and a tool-capable model loaded.
2. **The studyweb backend** running (from the `studyweb` project):
   ```bash
   pip install /path/to/studyweb
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

## Settings

| Setting | Default | Purpose |
|---|---|---|
| LM Studio URL | `http://localhost:1234/v1` | Change the port here if LM Studio differs |
| studyweb backend URL | `http://localhost:8787` | Where `studyweb serve` runs |
| studyweb API key | *(empty)* | Only if the backend uses `STUDYWEB_API_KEY` |
| Model | `auto` | `auto` = currently-loaded model; or pick from the list (Refresh) |
| Temperature | `0` | Applied to every request |
| Hide model thinking | on | Strip `<think>` blocks before showing/saving |
| Max tool steps | `6` | Tool-call rounds per question |
| Max context characters | `48000` | Older turns are trimmed past this so context can't overflow |
| New-note folder | *(root)* | Where the *New note* action saves |
| Append sources | on | Add a Sources list of tool URLs to saved answers |
| System prompt | *(preset)* | Editable |

Everything is dynamic: change the LM Studio port, swap the loaded model, or move
the backend — just update the settings, no rebuild required.

The `studyweb API key` is stored in plain text in this plugin's `data.json`
inside your vault. If you sync your vault, treat that key accordingly (or leave
it empty and run the backend without `STUDYWEB_API_KEY`).

## Publish (Obsidian community plugin)

Follow the [Obsidian plugin submission guide](https://docs.obsidian.md/Plugins/Releases/Submit+your+plugin):
tag a GitHub release containing `main.js`, `manifest.json`, and `styles.css`.

## License

MIT
