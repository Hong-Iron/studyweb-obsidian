import {
  App, ItemView, MarkdownRenderer, MarkdownView, Notice, Plugin,
  PluginSettingTab, Setting, WorkspaceLeaf, requestUrl, setIcon,
} from "obsidian";

/* ------------------------------------------------------------------ settings */

interface LMSSettings {
  lmStudioUrl: string;   // OpenAI-compatible base, e.g. http://localhost:1234/v1
  studywebUrl: string;   // studyweb backend, e.g. http://localhost:8787
  studywebApiKey: string;
  model: string;         // "auto" = use whatever is loaded, or a specific id
  temperature: number;
  maxToolSteps: number;
  hideThinking: boolean;
  systemPrompt: string;
  noteFolder: string;    // where "New note" writes; "" = vault root
  maxContextChars: number; // trim old turns past this to avoid overflowing context
  appendSources: boolean;  // append a Sources list to saved answers
}

const DEFAULT_SETTINGS: LMSSettings = {
  lmStudioUrl: "http://localhost:1234/v1",
  studywebUrl: "http://localhost:8787",
  studywebApiKey: "",
  model: "auto",
  temperature: 0,
  maxToolSteps: 6,
  hideThinking: true,
  systemPrompt:
    "You are a research assistant inside Obsidian with live web tools. When the " +
    "user asks for facts, data, or prices, use the tools to look them up instead " +
    "of guessing. Cite the source URL for any figure. Answer in clean Markdown.",
  noteFolder: "",
  maxContextChars: 48000,
  appendSources: true,
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
];

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

/** Thin client over LM Studio (OpenAI API) + the studyweb backend. */
class Backend {
  constructor(private settings: LMSSettings) {}

  private lmBase() { return this.settings.lmStudioUrl.replace(/\/+$/, ""); }
  private swBase() { return this.settings.studywebUrl.replace(/\/+$/, ""); }

  async listModels(): Promise<string[]> {
    const res = await requestUrl({ url: `${this.lmBase()}/models`, method: "GET", throw: false });
    if (res.status !== 200) throw new Error(`LM Studio /models -> HTTP ${res.status}`);
    return (res.json?.data ?? []).map((m: any) => m.id);
  }

  async resolveModel(): Promise<string> {
    if (this.settings.model && this.settings.model !== "auto") return this.settings.model;
    const ids = await this.listModels();
    if (!ids.length) throw new Error("No model is loaded in LM Studio.");
    return ids[0];
  }

  /** Confirm the studyweb backend is reachable; returns its reported version. */
  async studywebHealth(): Promise<string> {
    const res = await requestUrl({ url: `${this.swBase()}/health`, method: "GET", throw: false });
    if (res.status !== 200) throw new Error(`studyweb /health -> HTTP ${res.status}`);
    return res.json?.version ?? "ok";
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

  async chat(messages: ChatMessage[], model: string, tools: unknown[] | null): Promise<any> {
    const payload: any = {
      model,
      messages,
      temperature: this.settings.temperature,
      stream: false,
    };
    if (tools && tools.length) { payload.tools = tools; payload.tool_choice = "auto"; }
    const res = await requestUrl({
      url: `${this.lmBase()}/chat/completions`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      throw: false,
    });
    if (res.status !== 200) throw new Error(`chat/completions -> HTTP ${res.status}: ${res.text?.slice(0, 200)}`);
    return res.json.choices[0].message;
  }

  private async swPost(path: string, body: unknown): Promise<any> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.settings.studywebApiKey) headers["Authorization"] = `Bearer ${this.settings.studywebApiKey}`;
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
      if (name === "open_url") {
        const data = await this.swPost("/extract", { urls: [args.url], include_raw_content: false });
        const r = (data.results ?? [])[0];
        if (!r) return `Could not read ${args.url}`;
        return JSON.stringify({ url: r.url, title: r.title, content: (r.content ?? "").slice(0, 5000) });
      }
      if (name === "collect_rag") {
        const data = await this.swPost("/rag", { query: args.query, max_results: args.max_results ?? 4 });
        const sample = (data.chunks ?? []).slice(0, 5).map((c: any) => ({
          source_url: c.metadata?.source_url, text: (c.text ?? "").slice(0, 300),
        }));
        return JSON.stringify({ n_documents: data.n_documents, n_chunks: data.n_chunks, sample_chunks: sample });
      }
      return `Unknown tool: ${name}`;
    } catch (e: any) {
      return `Error running ${name}: ${e.message}. Is 'studyweb serve' running at ${this.swBase()}?`;
    }
  }
}

/* --------------------------------------------------------------------- view */

type DisplayEntry =
  | { kind: "plain"; role: "user" | "assistant" | "tool"; md: string; markdown: boolean }
  | { kind: "answer"; md: string; sources: string[] };

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
    this.statusEl = header.createSpan({ cls: "lms-status", text: "…" });
    const clearBtn = header.createEl("button", { cls: "lms-icon-btn", title: "New conversation" });
    setIcon(clearBtn, "eraser");
    clearBtn.onclick = () => this.reset();

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
    void this.refreshStatus();
  }

  async onClose() {}

  /** Ping both backends and reflect connectivity in the header. */
  private async refreshStatus() {
    const backend = new Backend(this.plugin.settings);
    const parts: string[] = [];
    let ok = true;
    try { await backend.studywebHealth(); parts.push("studyweb ✓"); }
    catch { parts.push("studyweb ✗"); ok = false; }
    try {
      const ids = await backend.listModels();
      parts.push(ids.length ? `LM Studio ✓ (${ids.length})` : "LM Studio: no model");
      if (!ids.length) ok = false;
    } catch { parts.push("LM Studio ✗"); ok = false; }
    this.statusEl.setText(parts.join(" · "));
    this.statusEl.toggleClass("lms-status-bad", !ok);
    this.statusEl.toggleClass("lms-status-ok", ok);
  }

  private reset() {
    this.gen++;                       // cancel any in-flight turn
    this.setBusy(false);
    this.plugin.messages = [{ role: "system", content: this.plugin.settings.systemPrompt }];
    this.plugin.displayLog = [];
    this.log.empty();
    this.pushBubble({ kind: "plain", role: "assistant",
      md: "_Connected to LM Studio. Ask me to look something up._", markdown: true });
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
      if (e.kind === "answer") this.renderAnswer(e.md, e.sources, false);
      else this.bubble(e.role, e.md, e.markdown);
    }
  }

  private pushBubble(e: DisplayEntry): HTMLElement {
    this.history.push(e);
    if (e.kind === "answer") return this.renderAnswer(e.md, e.sources, false);
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

  /** Drop oldest non-system turns so the running context can't overflow the
   * model. Never orphans a `tool` message (which must follow its assistant). */
  private trimContext() {
    const budget = this.plugin.settings.maxContextChars;
    const size = () => this.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    while (this.messages.length > 2 && size() > budget) {
      this.messages.splice(1, 1);
      while (this.messages.length > 1 && this.messages[1].role === "tool") {
        this.messages.splice(1, 1);
      }
    }
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

    const working = this.bubble("tool", "⏳ Working…", false);
    this.pendingEl = working;
    const backend = new Backend(this.plugin.settings);
    const sources = new Set<string>();
    try {
      const model = await backend.resolveModel();
      if (myGen !== this.gen) return;               // cancelled while resolving
      let answered = false;
      const tools = await backend.getToolSchemas();
      for (let step = 0; step < this.plugin.settings.maxToolSteps; step++) {
        this.trimContext();
        const msg = await backend.chat(this.messages, model, tools);
        if (myGen !== this.gen) return;             // cancelled during the call
        const toolCalls = msg.tool_calls ?? [];
        this.messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: toolCalls.length ? toolCalls : undefined });

        if (!toolCalls.length) {
          working.remove();
          const clean = this.plugin.settings.hideThinking ? stripThinking(msg.content ?? "") : (msg.content ?? "");
          this.pushBubble({ kind: "answer", md: clean, sources: [...sources] });
          answered = true;
          break;
        }
        for (const tc of toolCalls) {
          let args: any = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* ignore */ }
          working.setText(`🔧 ${tc.function?.name}…`);
          this.pushBubble({ kind: "plain", role: "tool", md: `🔧 ${tc.function?.name}(${JSON.stringify(args)})`, markdown: false });
          const result = await backend.dispatchTool(tc.function?.name, args);
          if (myGen !== this.gen) return;           // cancelled during a tool call
          for (const u of urlsFromToolResult(result)) sources.add(u);
          this.messages.push({ role: "tool", tool_call_id: tc.id ?? tc.function?.name, name: tc.function?.name, content: result });
        }
      }
      if (!answered) {
        working.setText("✍️ Writing answer…");
        this.trimContext();
        const msg = await backend.chat(this.messages, model, null);
        if (myGen !== this.gen) return;
        working.remove();
        const clean = this.plugin.settings.hideThinking ? stripThinking(msg.content ?? "") : (msg.content ?? "");
        this.pushBubble({ kind: "answer", md: clean, sources: [...sources] });
      }
    } catch (e: any) {
      if (myGen !== this.gen) return;
      working.remove();
      this.pushBubble({ kind: "plain", role: "assistant", md: `⚠️ ${e.message}`, markdown: false });
    } finally {
      if (myGen === this.gen) { this.setBusy(false); this.pendingEl = null; }
    }
  }

  private renderAnswer(md: string, sources: string[], record = true): HTMLElement {
    if (record) this.history.push({ kind: "answer", md, sources });
    const el = this.bubble("assistant", md || "_(empty response)_", true);
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
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) { new Notice("Open a note first to insert into it."); return; }
      view.editor.replaceSelection(md + "\n");
      new Notice("Inserted into note.");
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

/* ------------------------------------------------------------------- plugin */

export default class StudywebLMSPlugin extends Plugin {
  settings!: LMSSettings;
  // Conversation state shared with the view so it survives the pane closing.
  messages: ChatMessage[] = [];
  displayLog: DisplayEntry[] = [];

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

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }
}

/* ------------------------------------------------------------- settings tab */

class LMSSettingTab extends PluginSettingTab {
  plugin: StudywebLMSPlugin;
  constructor(app: App, plugin: StudywebLMSPlugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Connections").setHeading();

    new Setting(containerEl)
      .setName("LM Studio URL")
      .setDesc("OpenAI-compatible base URL. Change the port here if LM Studio uses a different one.")
      .addText((t) => t.setPlaceholder("http://localhost:1234/v1")
        .setValue(this.plugin.settings.lmStudioUrl)
        .onChange(async (v) => { this.plugin.settings.lmStudioUrl = v.trim(); await this.plugin.saveSettings(); }));

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

    new Setting(containerEl).setName("Model").setHeading();

    const modelSetting = new Setting(containerEl)
      .setName("Model")
      .setDesc('"auto" uses whatever model is loaded in LM Studio. Click Refresh to list installed models.');
    let dropdownRef: any = null;
    modelSetting.addDropdown((d) => {
      dropdownRef = d;
      d.addOption("auto", "auto (currently loaded)");
      if (this.plugin.settings.model !== "auto") d.addOption(this.plugin.settings.model, this.plugin.settings.model);
      d.setValue(this.plugin.settings.model);
      d.onChange(async (v) => { this.plugin.settings.model = v; await this.plugin.saveSettings(); });
    });
    modelSetting.addExtraButton((b) => b.setIcon("refresh-cw").setTooltip("Refresh model list").onClick(async () => {
      try {
        const ids = await new Backend(this.plugin.settings).listModels();
        dropdownRef.selectEl.empty();
        dropdownRef.addOption("auto", "auto (currently loaded)");
        for (const id of ids) dropdownRef.addOption(id, id);
        dropdownRef.setValue(this.plugin.settings.model);
        new Notice(`Found ${ids.length} model(s).`);
      } catch (e: any) { new Notice(`Could not list models: ${e.message}`); }
    }));

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

    new Setting(containerEl)
      .setName("Max context characters")
      .setDesc("Older turns are dropped past this size so the running conversation can't overflow the model's context window.")
      .addSlider((s) => s.setLimits(8000, 128000, 4000).setDynamicTooltip()
        .setValue(this.plugin.settings.maxContextChars)
        .onChange(async (v) => { this.plugin.settings.maxContextChars = v; await this.plugin.saveSettings(); }));

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
      .setClass("lms-system-prompt")
      .addTextArea((t) => { t.setValue(this.plugin.settings.systemPrompt)
        .onChange(async (v) => { this.plugin.settings.systemPrompt = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 5; });
  }
}
