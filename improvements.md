# studyweb-obsidian — Improvements toward production

"Production" here means two bars: (a) reliable daily use, and (b) passing
Obsidian community-plugin review if you submit it. Backend-side issues are in
`../studyweb/improvements.md`.

## P0 — Reliability

### 1. Unbounded conversation context
`main.ts` appends to `this.messages` forever; nothing trims to the model's
context window. A long chat (especially with tool results — each `web_search`
adds several KB) eventually overflows the loaded model's context and LM Studio
starts erroring or silently truncating the system prompt. Add a token-budget
trim (drop oldest turn pairs, always keep the system prompt) before each
`chat()` call.

### 2. No cancel and no timeout on generation
`send()` sets `busy` and disables the button until the request returns —
`requestUrl` has no abort, so a hung LM Studio (model loading, OOM) locks the
view indefinitely. Options: switch the LM Studio calls to `fetch` with an
`AbortController` (localhost CORS is fine for LM Studio's server), show a Stop
button while busy, and use a generation counter so a stale response can't
render into a newer conversation after reset.

### 3. Unhandled promise rejections in UI callbacks
`newNote()` (`main.ts:344-350`) throws if the target filename already exists
(two answers saved within the same second) or the vault path is invalid, and
the `onclick` handler doesn't catch it. Same pattern for `insertIntoNote` if
the editor is gone. Wrap the action handlers in try/catch → `Notice`.

### 4. `stripThinking` misses unterminated blocks
`main.ts:117-123` only removes *paired* `<think>…</think>`. When generation is
cut off mid-reasoning (max tokens, manual stop), the raw opening tag and the
whole chain of thought land in the note. Also strip from an unclosed opening
tag to end-of-string.

## P1 — UX for daily use

### 5. Streaming (or at least visible progress)
`stream: false` means the user watches a frozen pane for the whole
generation + tool loop. Minimum: render a placeholder "assistant is working…"
bubble and update it per tool call (the tool bubbles help, but there is
nothing during the final synthesis). Better: stream tokens (requires the
`fetch`-based client from item 2) — this is the single biggest perceived-
quality improvement available.

### 6. Persist the conversation
`messages` lives in the view instance; closing the pane, reloading Obsidian,
or a workspace switch silently discards the chat. Persist the transcript
(e.g. in `saveData` alongside settings, or per-day note) and restore it in
`onOpen`, with the existing eraser button as the explicit reset.

### 7. Source-aware saving
"Insert into note"/"New note" write the raw answer text. The whole point of
the stack is grounded answers — capture the source URLs from the tool results
of that turn and append a `Sources:` list (or YAML frontmatter with
`url:`/`retrieved:`) so saved research stays citable. Consider making the new-
note folder and filename template settings instead of hardcoding
`LMS Research <timestamp>.md` into the vault root (`main.ts:345-346`).

### 8. Single-source the tool schemas
`TOOL_SCHEMAS` (`main.ts:37-105`) is the third hand-maintained copy of the
tool definitions (backend `lms.py`, LM Studio plugin, here) and they have
already drifted in wording. The backend exposes `GET /tool-schema` — fetch it
once per session (with the hardcoded array as offline fallback) so tool
improvements land everywhere at once.

### 9. Backend health surfacing
Errors currently appear only after a failed tool call, mid-conversation. Ping
`GET /health` (studyweb) and `/models` (LM Studio) when the view opens and show
a one-line status in the header (`● connected · model: gemma-4-e4b…`), so the
"is the server running / which port" problems are visible before the first
question.

## P2 — Community-plugin review readiness

These are things the Obsidian plugin review bot/reviewers flag:

- **No LICENSE file** in the repo (package.json says MIT). Required.
- **Inline styles**: `t.inputEl.style.width = "100%"` (`main.ts:471`) — move to
  `styles.css`.
- **Headings in settings**: `containerEl.createEl("h3", ...)`
  (`main.ts:399,422,466`) — use `new Setting(containerEl).setName(...).setHeading()`.
- **Command naming**: "Open LMS chat in the right sidebar" — review guidance
  prefers commands not to describe UI placement; "Open studyweb chat" is safer,
  and the plugin display name "LMS" will read as "Learning Management System"
  to everyone but you — consider renaming the user-facing strings to
  "studyweb" with LM Studio mentioned in the description.
- **Repo layout**: community release flow expects `main.js`/`manifest.json`
  attached to a GitHub release, `versions.json` maintained, and typically
  `main.js` gitignored in the source repo. Also: not a git repo yet —
  `git init` first.
- **`getRightLeaf(false)!`** (`main.ts:380`) — the non-null assertion can crash
  in edge layouts; guard and fall back to `getLeaf(true)`.

## P3 — Hygiene

- **No tests / lint**: `Backend` (chat payloads, tool dispatch mapping,
  `stripThinking`) is pure logic and unit-testable without Obsidian; add
  vitest + eslint/prettier and a CI step (`tsc -noEmit` already exists in the
  build script — run it in CI too).
- **Types**: `tool_calls?: any[]`, `dropdownRef: any`, `res.json` untyped —
  define minimal interfaces for the OpenAI-compatible response and the
  studyweb endpoints; `tsconfig` strictness only pays off if the boundaries
  are typed.
- **API key storage**: plaintext in `data.json` is the Obsidian norm, but say
  so in the README so users don't put a sensitive key in a synced vault.
