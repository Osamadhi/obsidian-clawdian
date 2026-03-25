var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

var main_exports = {};
__export(main_exports, { default: () => ClawdianPlugin });
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

// ============================================
// SecureStorage (preserved from v0.4.1)
// ============================================
var safeStorage = null;
var safeStorageAvailable = null;

function getSafeStorage() {
  var _a;
  if (safeStorageAvailable === false) return null;
  if (safeStorage) return safeStorage;
  try {
    const electron = require("electron");
    if ((_a = electron == null ? void 0 : electron.remote) == null ? void 0 : _a.safeStorage) {
      safeStorage = electron.remote.safeStorage;
    } else if (electron == null ? void 0 : electron.safeStorage) {
      safeStorage = electron.safeStorage;
    }
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      safeStorageAvailable = true;
      return safeStorage;
    }
  } catch (e) {}
  safeStorageAvailable = false;
  return null;
}

function getEnvToken() {
  try { return process.env.OPENCLAW_TOKEN || null; } catch (e) { return null; }
}

var SecureTokenStorage = class {
  constructor() { this.encryptedToken = null; this.plaintextToken = ""; }
  getActiveMethod() {
    if (getEnvToken()) return "envVar";
    if (getSafeStorage()) return "safeStorage";
    return "plaintext";
  }
  getStatusInfo() {
    if (getEnvToken()) return { method: "envVar", description: "Using OPENCLAW_TOKEN environment variable", secure: true };
    if (getSafeStorage()) return { method: "safeStorage", description: "Encrypted with OS keychain", secure: true };
    return { method: "plaintext", description: "\u26A0\uFE0F Stored in plaintext", secure: false };
  }
  setToken(token) {
    if (getEnvToken()) return { encrypted: null, plaintext: "" };
    const storage = getSafeStorage();
    if (storage && token) {
      try {
        const encrypted = storage.encryptString(token);
        this.encryptedToken = encrypted.toString("base64");
        this.plaintextToken = "";
        return { encrypted: this.encryptedToken, plaintext: "" };
      } catch (e) {}
    }
    this.encryptedToken = null;
    this.plaintextToken = token;
    return { encrypted: null, plaintext: token };
  }
  getToken(encrypted, plaintext) {
    const envToken = getEnvToken();
    if (envToken) return envToken;
    if (encrypted) {
      const storage = getSafeStorage();
      if (storage) {
        try { return storage.decryptString(Buffer.from(encrypted, "base64")); } catch (e) {}
      }
    }
    return plaintext || "";
  }
};

var secureTokenStorage = new SecureTokenStorage();

// ============================================
// Settings & Defaults
// ============================================
var DEFAULT_SETTINGS = {
  gatewayUrl: "http://127.0.0.1:18789",
  gatewayTokenEncrypted: null,
  gatewayTokenPlaintext: "",
  showActionsInChat: true,
  auditLogEnabled: false,
  auditLogPath: "Clawdian/audit-log.md",
  includeCurrentNote: true,
  conversationsPath: "Clawdian/conversations",
  syncEnabled: false,
  syncServerUrl: "http://127.0.0.1:18790",
  syncPaths: [{ remotePath: "notes", localPath: "Clawdian/Notes", enabled: true }],
  syncInterval: 0,
  syncConflictBehavior: "ask",
  selectedModel: ""
};

// ============================================
// OpenClaw Gateway API (streaming via Node http)
// ============================================
var ClawdianAPI = class {
  constructor(settings) { this.settings = settings; }
  getToken() {
    return secureTokenStorage.getToken(this.settings.gatewayTokenEncrypted, this.settings.gatewayTokenPlaintext);
  }

  /**
   * Streaming chat with thinking support.
   * Returns { text, thinking } — thinking is array of { content } blocks.
   */
  async chat(messages, onChunk, onThinking, abortSignal) {
    const parsedUrl = new URL(`${this.settings.gatewayUrl}/v1/chat/completions`);
    const token = this.getToken();
    const isCustomModel = !!this.settings.selectedModel;
    const model = this.settings.selectedModel || "clawdbot:main";
    // When using a custom model (not clawdbot:main), inject a system prompt
    // since the Gateway won't load SOUL.md for direct model API calls
    let apiMessages = messages;
    if (isCustomModel) {
      const sysPrompt = { role: "system", content: "You are Clawdian, an AI assistant in Obsidian. Be helpful, concise, and direct. Use Chinese by default. Use markdown formatting." };
      apiMessages = [sysPrompt, ...messages.filter(m => m.role !== "system")];
    }
    const body = JSON.stringify({
      model: model,
      messages: apiMessages,
      stream: true
    });

    const http = require(parsedUrl.protocol === "https:" ? "https" : "http");

    return new Promise((resolve, reject) => {
      if (abortSignal?.aborted) { reject(new Error("AbortError")); return; }

      const req = http.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname,
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "text/event-stream"
        }
      }, (res) => {
        if (res.statusCode >= 400) {
          let errBody = "";
          res.on("data", (chunk) => errBody += chunk);
          res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
          return;
        }

        let fullText = "";
        let thinkingText = "";
        let inThinking = false;
        let buffer = "";

        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              if (!delta) continue;

              // Check for thinking/reasoning content
              if (delta.reasoning_content || delta.reasoning) {
                const rc = delta.reasoning_content || delta.reasoning;
                thinkingText += rc;
                inThinking = true;
                if (onThinking) onThinking(thinkingText);
              }
              if (delta.content) {
                if (inThinking) inThinking = false;
                fullText += delta.content;
                if (onChunk) onChunk(fullText, delta.content);
              }
            } catch (e) {}
          }
        });

        res.on("end", () => resolve({ text: fullText, thinking: thinkingText }));
        res.on("error", (err) => reject(err));
      });

      req.on("error", (err) => reject(new Error(`Connection failed: ${err.message}`)));

      if (abortSignal) {
        const onAbort = () => { req.destroy(); reject(Object.assign(new Error("Cancelled"), { name: "AbortError" })); };
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      req.write(body);
      req.end();
    });
  }

  async chatSync(message) {
    const url = `${this.settings.gatewayUrl}/v1/chat/completions`;
    const token = this.getToken();
    const response = await (0, import_obsidian.requestUrl)({
      url, method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.settings.selectedModel || "clawdbot:main", messages: [{ role: "user", content: message }], stream: false })
    });
    if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${response.text}`);
    return response.json?.choices?.[0]?.message?.content || "";
  }
};

// ============================================
// ConversationStore — Persistence
// ============================================
var ConversationStore = class {
  constructor(app, getSettings) {
    this.app = app;
    this.getSettings = getSettings;
    this.conversations = new Map();
  }

  generateId() { return "conv-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8); }

  createConversation(title) {
    const id = this.generateId();
    const conv = { id, title: title || "New Chat", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    this.conversations.set(id, conv);
    return conv;
  }

  getConversation(id) { return this.conversations.get(id) || null; }

  deleteConversation(id) { this.conversations.delete(id); this.deleteFile(id); }

  updateTitle(id, title) {
    const conv = this.conversations.get(id);
    if (conv) { conv.title = title; conv.updatedAt = Date.now(); }
  }

  addMessage(convId, role, content, extra) {
    const conv = this.conversations.get(convId);
    if (!conv) return;
    const msg = { role, content, timestamp: Date.now() };
    if (extra?.thinking) msg.thinking = extra.thinking;
    if (extra?.images) msg.images = extra.images;
    conv.messages.push(msg);
    conv.updatedAt = Date.now();
    if (conv.title === "New Chat" && role === "user") {
      conv.title = content.slice(0, 40) + (content.length > 40 ? "..." : "");
    }
  }

  removeMessage(convId, index) {
    const conv = this.conversations.get(convId);
    if (!conv || index < 0 || index >= conv.messages.length) return;
    conv.messages.splice(index, 1);
    conv.updatedAt = Date.now();
  }

  // Truncate messages from index onwards (for edit-resend)
  truncateFrom(convId, index) {
    const conv = this.conversations.get(convId);
    if (!conv) return;
    conv.messages = conv.messages.slice(0, index);
    conv.updatedAt = Date.now();
  }

  getMessages(convId) {
    const conv = this.conversations.get(convId);
    if (!conv) return [];
    return conv.messages.map(m => ({ role: m.role, content: m.content }));
  }

  getAllConversations() {
    return Array.from(this.conversations.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveConversation(id) {
    const conv = this.conversations.get(id);
    if (!conv) return;
    const settings = this.getSettings();
    const folder = settings.conversationsPath;
    await this.ensureFolder(folder);
    const filePath = `${folder}/${id}.json`;
    const data = JSON.stringify(conv, null, 2);
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof import_obsidian.TFile) {
      await this.app.vault.modify(existing, data);
    } else {
      await this.app.vault.create(filePath, data);
    }
  }

  async loadAll() {
    const settings = this.getSettings();
    const folder = settings.conversationsPath;
    const folderObj = this.app.vault.getAbstractFileByPath(folder);
    if (!folderObj || !(folderObj instanceof import_obsidian.TFolder)) return;
    for (const child of folderObj.children) {
      if (child instanceof import_obsidian.TFile && child.extension === "json") {
        try {
          const raw = await this.app.vault.read(child);
          const conv = JSON.parse(raw);
          if (conv.id && conv.messages) this.conversations.set(conv.id, conv);
        } catch (e) { console.error("Clawdian: Failed to load conversation", child.path, e); }
      }
    }
  }

  async deleteFile(id) {
    const settings = this.getSettings();
    const file = this.app.vault.getAbstractFileByPath(`${settings.conversationsPath}/${id}.json`);
    if (file) { try { await this.app.vault.delete(file); } catch (e) {} }
  }

  async ensureFolder(path) {
    const parts = path.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }
};

// ============================================
// File Action Executor (preserved from v0.4.1)
// ============================================
var DESTRUCTIVE_ACTIONS = ["deleteFile", "updateFile", "renameFile"];

var ConfirmActionModal = class extends import_obsidian.Modal {
  constructor(app, action, description) {
    super(app); this.action = action; this.description = description; this.result = false;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Confirm Action" });
    contentEl.createEl("p", { text: "Clawdian wants to perform the following action:" });
    const detailsEl = contentEl.createDiv({ cls: "oc-confirm-details" });
    detailsEl.createEl("strong", { text: this.getActionLabel() });
    detailsEl.createEl("p", { text: this.description });
    if (this.action.action === "deleteFile") contentEl.createDiv({ cls: "oc-confirm-warning" }).setText("\u26A0\uFE0F This action cannot be undone.");
    const buttons = contentEl.createDiv({ cls: "oc-confirm-buttons" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => { this.result = false; this.close(); });
    const confirmBtn = buttons.createEl("button", { text: "Confirm", cls: "mod-cta" });
    confirmBtn.addEventListener("click", () => { this.result = true; this.close(); });
    confirmBtn.focus();
  }
  onClose() { this.contentEl.empty(); if (this.resolvePromise) this.resolvePromise(this.result); }
  getActionLabel() {
    return ({ deleteFile: "\uD83D\uDDD1\uFE0F Delete", updateFile: "\u270F\uFE0F Update", renameFile: "\uD83D\uDCDD Rename" })[this.action.action] || this.action.action;
  }
  async waitForResult() { return new Promise(resolve => { this.resolvePromise = resolve; this.open(); }); }
};

var ActionExecutor = class {
  constructor(app, getSettings) { this.app = app; this.getSettings = getSettings; }
  async execute(actions) {
    let success = 0, failed = 0, skipped = 0;
    for (const action of actions) {
      try {
        if (DESTRUCTIVE_ACTIONS.includes(action.action)) {
          const modal = new ConfirmActionModal(this.app, action, this.getDesc(action));
          if (!await modal.waitForResult()) { skipped++; await this.log(action, "skipped"); continue; }
        }
        await this.executeOne(action);
        await this.log(action, "success");
        success++;
      } catch (err) {
        await this.log(action, "failed", err instanceof Error ? err.message : String(err));
        failed++;
      }
    }
    if (success > 0) new import_obsidian.Notice(`Clawdian: ${success} action(s) completed`);
    if (failed > 0) new import_obsidian.Notice(`Clawdian: ${failed} action(s) failed`);
    return { success, failed, skipped };
  }
  getDesc(action) {
    if (action.action === "deleteFile") return `Delete: ${action.path}`;
    if (action.action === "updateFile") return `Replace: ${action.path}`;
    if (action.action === "renameFile") return `Rename: ${action.path} \u2192 ${action.newPath}`;
    return JSON.stringify(action);
  }
  async log(action, status, error) {
    const settings = this.getSettings();
    if (!settings.auditLogEnabled) return;
    const { vault } = this.app;
    const logPath = settings.auditLogPath;
    const ts = new Date().toISOString();
    const emoji = status === "success" ? "\u2705" : status === "failed" ? "\u274C" : "\u23ED\uFE0F";
    let entry = `\n| ${ts} | ${emoji} ${status} | \`${action.action}\` | `;
    if (action.action === "renameFile") entry += `\`${action.path}\` \u2192 \`${action.newPath}\` |`;
    else if (action.path) entry += `\`${action.path}\` |`;
    else entry += `${JSON.stringify(action)} |`;
    if (error) entry += ` ${error}`;
    let logFile = vault.getAbstractFileByPath(logPath);
    if (!logFile) {
      const folder = logPath.substring(0, logPath.lastIndexOf("/"));
      if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
      await vault.create(logPath, `# Clawdian Audit Log\n\n| Timestamp | Status | Action | Details |\n|-----------|--------|--------|---------|` + entry);
    } else if (logFile instanceof import_obsidian.TFile) {
      const content = await vault.read(logFile);
      await vault.modify(logFile, content + entry);
    }
  }
  async executeOne(action) {
    const { vault } = this.app;
    switch (action.action) {
      case "createFile": {
        if (vault.getAbstractFileByPath(action.path)) throw new Error(`Exists: ${action.path}`);
        const folder = action.path.substring(0, action.path.lastIndexOf("/"));
        if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
        await vault.create(action.path, action.content);
        break;
      }
      case "updateFile": { const f = vault.getAbstractFileByPath(action.path); if (!(f instanceof import_obsidian.TFile)) throw new Error(`Not found: ${action.path}`); await vault.modify(f, action.content); break; }
      case "appendToFile": { const f = vault.getAbstractFileByPath(action.path); if (!(f instanceof import_obsidian.TFile)) throw new Error(`Not found: ${action.path}`); await vault.modify(f, (await vault.read(f)) + "\n" + action.content); break; }
      case "deleteFile": { const f = vault.getAbstractFileByPath(action.path); if (!f) throw new Error(`Not found: ${action.path}`); await vault.delete(f); break; }
      case "renameFile": { const f = vault.getAbstractFileByPath(action.path); if (!f) throw new Error(`Not found: ${action.path}`); await vault.rename(f, action.newPath); break; }
      case "openFile": { const f = vault.getAbstractFileByPath(action.path); if (!(f instanceof import_obsidian.TFile)) throw new Error(`Not found: ${action.path}`); await this.app.workspace.getLeaf().openFile(f); break; }
      default: throw new Error(`Unknown: ${action.action}`);
    }
  }
  parseActions(text) {
    const match = text.match(/```json:openclaw-actions\n([\s\S]*?)```/);
    if (!match) return [];
    try { return JSON.parse(match[1]); } catch (e) { return []; }
  }
  stripActionBlocks(text) { return text.replace(/```json:openclaw-actions\n[\s\S]*?```\n?/g, "").trim(); }
};

// ============================================
// Icons
// ============================================
var LOBSTER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="50" cy="42" rx="14" ry="18"/><ellipse cx="50" cy="62" rx="11" ry="10"/><ellipse cx="50" cy="76" rx="8" ry="7"/><circle cx="44" cy="32" r="3" fill="currentColor"/><circle cx="56" cy="32" r="3" fill="currentColor"/><path d="M36 38c-8-2-16-1-20 4s-1 12 5 14"/><path d="M64 38c8-2 16-1 20 4s1 12-5 14"/><path d="M21 56c-5 1-10-1-12-5"/><path d="M79 56c5 1 10-1 12-5"/><path d="M24 48c-6-2-11 0-13 5"/><path d="M76 48c6-2 11 0 13 5"/><path d="M42 82l-7 10"/><path d="M58 82l7 10"/><path d="M47 83l-1 11"/><path d="M53 83l1 11"/><path d="M50 83v11"/><path d="M40 26c-3-6-8-14-8-14"/><path d="M60 26c3-6 8-14 8-14"/></svg>`;

// Use Obsidian's setIcon API (Lucide icons) instead of raw innerHTML
// This guarantees rendering in Obsidian's Electron environment
function setIconSafe(el, iconName, size) {
  try {
    if (typeof import_obsidian.setIcon === "function") {
      import_obsidian.setIcon(el, iconName);
    } else {
      // Fallback: create SVG manually for critical icons
      var fallbackMap = {
        "plus": "+", "trash-2": "\uD83D\uDDD1", "copy": "\uD83D\uDCCB",
        "check": "\u2713", "chevron-down": "\u25BC", "chevron-right": "\u25B6",
        "file-text": "\uD83D\uDCC4", "image": "\uD83D\uDDBC", "square": "\u25A0",
        "refresh-cw": "\u21BB", "pencil": "\u270F", "brain": "\uD83E\uDDE0", "x": "\u2715"
      };
      el.setText(fallbackMap[iconName] || iconName);
      return;
    }
    if (size) {
      var svg = el.querySelector("svg") || el.querySelector(".svg-icon");
      if (svg) { svg.setAttribute("width", size); svg.setAttribute("height", size); }
    }
  } catch (e) {
    console.error("Clawdian setIconSafe failed:", iconName, e);
    el.setText(iconName);
  }
}

// Lucide icon names used:
// plus, trash-2, chevron-down, chevron-right, copy, check, file-text,
// image, square, refresh-cw, pencil, brain, x

// ============================================
// @ File Mention Popup
// ============================================
var FileMentionPopup = class {
  constructor(app, inputEl, onSelect) {
    this.app = app;
    this.inputEl = inputEl;
    this.onSelect = onSelect;
    this.popupEl = null;
    this.items = [];
    this.selectedIndex = 0;
    this.active = false;
    this.mentionStart = -1;
  }

  show(cursorPos) {
    this.mentionStart = cursorPos;
    this.active = true;
    this.selectedIndex = 0;

    if (!this.popupEl) {
      this.popupEl = document.createElement("div");
      this.popupEl.addClass("oc-mention-popup");
      this.inputEl.parentElement.appendChild(this.popupEl);
    }
    this.popupEl.style.display = "block";
    this.updateList("");
  }

  hide() {
    this.active = false;
    this.mentionStart = -1;
    if (this.popupEl) this.popupEl.style.display = "none";
  }

  updateList(query) {
    if (!this.popupEl) return;
    this.popupEl.empty();

    const files = this.app.vault.getMarkdownFiles()
      .filter(f => !f.path.startsWith("Clawdian/"))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    const q = query.toLowerCase();
    this.items = files
      .filter(f => !q || f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .slice(0, 10);

    if (this.items.length === 0) {
      this.popupEl.createDiv({ cls: "oc-mention-empty", text: "No files found" });
      return;
    }

    this.items.forEach((file, i) => {
      const item = this.popupEl.createDiv({
        cls: "oc-mention-item" + (i === this.selectedIndex ? " selected" : "")
      });
      item.createSpan({ cls: "oc-mention-name", text: file.basename });
      const pathDisplay = file.parent?.path || "";
      if (pathDisplay) item.createSpan({ cls: "oc-mention-path", text: pathDisplay });
      item.addEventListener("click", () => this.select(file));
      item.addEventListener("mouseenter", () => {
        this.selectedIndex = i;
        this.highlightSelected();
      });
    });
  }

  highlightSelected() {
    if (!this.popupEl) return;
    const children = this.popupEl.querySelectorAll(".oc-mention-item");
    children.forEach((el, i) => el.toggleClass("selected", i === this.selectedIndex));
  }

  handleKey(e) {
    if (!this.active) return false;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.items.length - 1);
      this.highlightSelected();
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.highlightSelected();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (this.items.length > 0) {
        e.preventDefault();
        this.select(this.items[this.selectedIndex]);
        return true;
      }
    }
    if (e.key === "Escape") {
      this.hide();
      return true;
    }
    return false;
  }

  handleInput() {
    if (!this.active) return;
    const val = this.inputEl.value;
    const query = val.slice(this.mentionStart + 1, this.inputEl.selectionStart);
    if (query.includes(" ") && query.length > 20) { this.hide(); return; }
    this.selectedIndex = 0;
    this.updateList(query);
  }

  select(file) {
    this.onSelect(file, this.mentionStart);
    this.hide();
  }
};

// ============================================
// Rename Modal
// ============================================
var RenameModal = class extends import_obsidian.Modal {
  constructor(app, currentTitle, onSubmit) {
    super(app);
    this.currentTitle = currentTitle;
    this.onSubmit = onSubmit;
  }
  onOpen() {
    this.titleEl.setText("Rename conversation");
    const input = this.contentEl.createEl("input", {
      type: "text", value: this.currentTitle, cls: "oc-rename-input"
    });
    input.style.width = "100%";
    input.style.padding = "8px";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { this.onSubmit(input.value.trim()); this.close(); }
      if (e.key === "Escape") this.close();
    });
    const btns = this.contentEl.createDiv({ cls: "oc-confirm-buttons" });
    btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: "Rename", cls: "mod-cta" }).addEventListener("click", () => {
      this.onSubmit(input.value.trim()); this.close();
    });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }
  onClose() { this.contentEl.empty(); }
};

// ============================================
// Main Chat View (v2.0)
// ============================================

var TEXTAREA_MIN_MAX_HEIGHT = 150;
var TEXTAREA_MAX_HEIGHT_PERCENT = 0.55;
var CLAWDIAN_VIEW_TYPE = "clawdian-chat-view";

var ClawdianView = class extends import_obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeConvId = null;
    this.isStreaming = false;
    this.abortController = null;
    this.autoScrollEnabled = true;
    this.streamingEl = null;
    this.streamingContentEl = null;
    this.thinkingEl = null;
    this.thinkingContentEl = null;
    this.mentionPopup = null;
    this.attachedFiles = []; // files attached via @
    this.pastedImages = []; // images pasted/dropped
  }

  getViewType() { return CLAWDIAN_VIEW_TYPE; }
  getDisplayText() { return "Clawdian"; }
  getIcon() { return "clawdian-lobster"; }

  async onOpen() {
    try { await this._onOpen(); }
    catch (e) {
      console.error("Clawdian onOpen failed:", e);
      const container = this.containerEl.children[1];
      container.empty();
      container.createEl("p", { text: "\u274C Clawdian failed to load: " + (e.message || e) });
      container.createEl("p", { text: "Check developer console (Ctrl+Shift+I) for details." });
    }
  }

  async _onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("openclaw-container");

    // ---- Header ----
    const header = container.createDiv({ cls: "oc-header" });
    this.tabBarEl = header.createDiv({ cls: "oc-tab-bar" });
    const actions = header.createDiv({ cls: "oc-header-actions" });

    const newBtn = actions.createEl("button", { cls: "oc-header-btn", attr: { "aria-label": "New Chat" } });
    setIconSafe(newBtn, "plus");
    newBtn.addEventListener("click", () => this.newConversation());

    const clearBtn = actions.createEl("button", { cls: "oc-header-btn", attr: { "aria-label": "Delete Chat" } });
    setIconSafe(clearBtn, "trash-2");
    clearBtn.addEventListener("click", () => this.deleteCurrentConversation());

    // ---- Messages ----
    const messagesWrapper = container.createDiv({ cls: "oc-messages-wrapper" });
    this.messagesEl = messagesWrapper.createDiv({ cls: "oc-messages" });

    // Scroll to bottom button
    this.scrollBtnEl = messagesWrapper.createDiv({ cls: "oc-scroll-btn" });
    setIconSafe(this.scrollBtnEl, "chevron-down");
    this.scrollBtnEl.addEventListener("click", () => this.scrollToBottom());

    this.messagesEl.addEventListener("scroll", () => {
      const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
      const atBottom = scrollHeight - scrollTop - clientHeight < 30;
      this.autoScrollEnabled = atBottom;
      this.scrollBtnEl.toggleClass("visible", !atBottom);
    });

    // ---- Input ----
    const inputContainer = container.createDiv({ cls: "oc-input-container" });
    const inputWrapper = inputContainer.createDiv({ cls: "oc-input-wrapper" });

    // Context row (attached files + images)
    this.contextRowEl = inputWrapper.createDiv({ cls: "oc-context-row" });

    // Textarea
    this.inputEl = inputWrapper.createEl("textarea", {
      cls: "oc-input",
      attr: { placeholder: "Message Clawdian... (@ to mention files)", rows: "1" }
    });

    this.inputEl.addEventListener("input", () => {
      this.autoResizeInput();
      if (this.mentionPopup) this.mentionPopup.handleInput();
    });

    // @ mention support
    this.mentionPopup = new FileMentionPopup(this.app, this.inputEl, (file, mentionStart) => {
      const val = this.inputEl.value;
      const cursorPos = this.inputEl.selectionStart;
      const before = val.slice(0, mentionStart);
      const after = val.slice(cursorPos);
      this.inputEl.value = before + `@${file.basename} ` + after;
      this.inputEl.selectionStart = this.inputEl.selectionEnd = before.length + file.basename.length + 2;
      this.inputEl.focus();
      // Track attached file
      if (!this.attachedFiles.find(f => f.path === file.path)) {
        this.attachedFiles.push(file);
        this.updateContextRow();
      }
    });

    this.inputEl.addEventListener("keydown", (e) => {
      // @ mention popup handling
      if (this.mentionPopup && this.mentionPopup.handleKey(e)) return;

      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // Detect @ trigger
    this.inputEl.addEventListener("keyup", (e) => {
      if (e.key === "@" || e.key === "Process") {
        const pos = this.inputEl.selectionStart - 1;
        const val = this.inputEl.value;
        if (pos >= 0 && val[pos] === "@" && (pos === 0 || val[pos - 1] === " " || val[pos - 1] === "\n")) {
          this.mentionPopup.show(pos);
        }
      }
    });

    // Image paste
    this.inputEl.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) this.addPastedImage(blob);
          return;
        }
      }
    });

    // Image drag & drop
    inputWrapper.addEventListener("dragover", (e) => {
      e.preventDefault();
      inputWrapper.addClass("drag-over");
    });
    inputWrapper.addEventListener("dragleave", () => inputWrapper.removeClass("drag-over"));
    inputWrapper.addEventListener("drop", (e) => {
      e.preventDefault();
      inputWrapper.removeClass("drag-over");
      const files = e.dataTransfer?.files;
      if (!files) return;
      for (const file of files) {
        if (file.type.startsWith("image/")) this.addPastedImage(file);
      }
    });

    // Toolbar
    const toolbar = inputWrapper.createDiv({ cls: "oc-input-toolbar" });
    const toolbarLeft = toolbar.createDiv({ cls: "oc-toolbar-left" });

    // Include current note toggle
    this.noteToggleBtn = toolbarLeft.createEl("button", {
      cls: "oc-toolbar-btn" + (this.plugin.settings.includeCurrentNote ? " active" : ""),
      attr: { "aria-label": "Include current note" }
    });
    setIconSafe(this.noteToggleBtn, "file-text");
    this.noteToggleBtn.addEventListener("click", () => {
      this.plugin.settings.includeCurrentNote = !this.plugin.settings.includeCurrentNote;
      this.noteToggleBtn.toggleClass("active", this.plugin.settings.includeCurrentNote);
      this.plugin.saveSettings();
      this.updateContextRow();
    });

    // Image attach button
    const imgBtn = toolbarLeft.createEl("button", {
      cls: "oc-toolbar-btn",
      attr: { "aria-label": "Attach image" }
    });
    setIconSafe(imgBtn, "image");
    imgBtn.addEventListener("click", () => {
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/*";
      fileInput.multiple = true;
      fileInput.addEventListener("change", () => {
        if (fileInput.files) {
          for (const f of fileInput.files) this.addPastedImage(f);
        }
      });
      fileInput.click();
    });

    const toolbarRight = toolbar.createDiv({ cls: "oc-toolbar-right" });

    // Model selector dropdown
    const modelSelect = toolbarRight.createEl("select", { cls: "oc-model-select" });
    const models = [
      { value: "", label: "Default \u2728" },
      { value: "bailian/qwen3.5-plus", label: "Qwen3.5+" },
      { value: "bailian/kimi-k2.5", label: "Kimi K2.5" },
      { value: "zenmux-anthropic/anthropic/claude-opus-4.6", label: "Opus 4.6" },
      { value: "zenmux-anthropic/anthropic/claude-sonnet-4.6", label: "Sonnet 4.6" },
      { value: "local/qwen3.5:27b", label: "Local 27B" },
      { value: "bailian/qwen3-max-2026-01-23", label: "Qwen3 Max" },
      { value: "bailian/glm-5", label: "GLM-5" },
      { value: "bailian/MiniMax-M2.5", label: "MiniMax" }
    ];
    for (const m of models) {
      const opt = modelSelect.createEl("option", { text: m.label, attr: { value: m.value } });
      if (m.value === this.plugin.settings.selectedModel) opt.selected = true;
    }
    modelSelect.addEventListener("change", async () => {
      this.plugin.settings.selectedModel = modelSelect.value;
      await this.plugin.saveSettings();
      new import_obsidian.Notice(modelSelect.value ? `Model: ${modelSelect.options[modelSelect.selectedIndex].text}` : "Model: Default");
    });

    // Stop button (visible during streaming)
    this.stopBtn = toolbarRight.createEl("button", {
      cls: "oc-toolbar-btn oc-stop-btn",
      attr: { "aria-label": "Stop generating" }
    });
    setIconSafe(this.stopBtn, "square");
    this.stopBtn.style.display = "none";
    this.stopBtn.addEventListener("click", () => {
      if (this.abortController) this.abortController.abort();
    });

    toolbarRight.createDiv({ cls: "oc-send-hint", text: "Enter \u2192 send \u00B7 @ \u2192 files" });

    // ---- Initialize ----
    await this.plugin.conversationStore.loadAll();
    const convs = this.plugin.conversationStore.getAllConversations();
    if (convs.length === 0) {
      this.newConversation();
    } else {
      const tabState = this.plugin.settings._tabState;
      if (tabState?.tabs?.length > 0) {
        this.openTabs = tabState.tabs.filter(id => this.plugin.conversationStore.getConversation(id));
        if (this.openTabs.length === 0) this.openTabs = [convs[0].id];
        const activeId = tabState.activeId;
        this.switchToConversation(this.openTabs.includes(activeId) ? activeId : this.openTabs[0]);
      } else {
        this.openTabs = [convs[0].id];
        this.switchToConversation(convs[0].id);
      }
    }

    this.updateContextRow();
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateContextRow()));
  }

  async onClose() {
    if (this.openTabs) {
      this.plugin.settings._tabState = { tabs: this.openTabs, activeId: this.activeConvId };
      await this.plugin.saveSettings();
    }
  }

  // ---- Image Handling ----

  async addPastedImage(blob) {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result;
      this.pastedImages.push({ data: base64, name: blob.name || `image-${Date.now()}.png`, type: blob.type });
      this.updateContextRow();
    };
    reader.readAsDataURL(blob);
  }

  showLightbox(src) {
    const overlay = document.createElement("div");
    overlay.addClass("oc-lightbox");
    const img = overlay.createEl("img", { attr: { src } });
    overlay.addEventListener("click", () => overlay.remove());
    document.body.appendChild(overlay);
    // ESC to close
    const onKey = (e) => { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);
  }

  // ---- Tab Management ----

  get openTabs() { return this._openTabs || []; }
  set openTabs(val) { this._openTabs = val; }

  renderTabs() {
    this.tabBarEl.empty();
    for (const convId of this.openTabs) {
      const conv = this.plugin.conversationStore.getConversation(convId);
      if (!conv) continue;

      const tab = this.tabBarEl.createDiv({ cls: "oc-tab" + (convId === this.activeConvId ? " active" : "") });
      const label = conv.title.length > 16 ? conv.title.slice(0, 16) + "\u2026" : conv.title;
      tab.createSpan({ text: label });

      if (this.openTabs.length > 1) {
        const closeBtn = tab.createSpan({ cls: "oc-tab-close", text: "\u00D7" });
        closeBtn.addEventListener("click", (e) => { e.stopPropagation(); this.closeTab(convId); });
      }

      tab.addEventListener("click", () => this.switchToConversation(convId));

      // Right-click context menu
      tab.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = new import_obsidian.Menu();
        menu.addItem(item => item.setTitle("Rename").setIcon("pencil").onClick(() => {
          new RenameModal(this.app, conv.title, (newTitle) => {
            if (newTitle) {
              this.plugin.conversationStore.updateTitle(convId, newTitle);
              this.plugin.conversationStore.saveConversation(convId);
              this.renderTabs();
            }
          }).open();
        }));
        menu.addItem(item => item.setTitle("Close").setIcon("x").onClick(() => this.closeTab(convId)));
        if (this.openTabs.length > 1) {
          menu.addItem(item => item.setTitle("Close others").setIcon("x-circle").onClick(() => {
            this.openTabs = [convId];
            this.switchToConversation(convId);
          }));
        }
        menu.addSeparator();
        menu.addItem(item => item.setTitle("Delete").setIcon("trash").onClick(() => {
          this.deleteConversation(convId);
        }));
        menu.showAtMouseEvent(e);
      });

      if (this.isStreaming && convId === this.activeConvId) tab.addClass("streaming");
    }
  }

  newConversation() {
    const conv = this.plugin.conversationStore.createConversation();
    this.openTabs = [...this.openTabs, conv.id];
    this.switchToConversation(conv.id);
  }

  closeTab(convId) {
    if (this.openTabs.length <= 1) return;
    const idx = this.openTabs.indexOf(convId);
    this.openTabs = this.openTabs.filter(id => id !== convId);
    if (this.activeConvId === convId) {
      this.switchToConversation(this.openTabs[Math.min(idx, this.openTabs.length - 1)]);
    } else {
      this.renderTabs();
    }
  }

  async deleteConversation(convId) {
    const conv = this.plugin.conversationStore.getConversation(convId);
    if (!conv) return;
    if (conv.messages.length > 0) {
      const confirmed = await new Promise(resolve => {
        const modal = new import_obsidian.Modal(this.app);
        modal.titleEl.setText("Delete conversation?");
        modal.contentEl.setText(`"${conv.title}" (${conv.messages.length} messages)`);
        const btns = modal.contentEl.createDiv({ cls: "oc-confirm-buttons" });
        btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => { resolve(false); modal.close(); });
        btns.createEl("button", { text: "Delete", cls: "mod-warning" }).addEventListener("click", () => { resolve(true); modal.close(); });
        modal.open();
      });
      if (!confirmed) return;
    }
    this.plugin.conversationStore.deleteConversation(convId);
    if (this.openTabs.includes(convId)) {
      this.closeTab(convId);
    }
    if (this.openTabs.length === 0) this.newConversation();
  }

  async deleteCurrentConversation() {
    if (this.activeConvId) await this.deleteConversation(this.activeConvId);
  }

  switchToConversation(convId) {
    this.activeConvId = convId;
    if (!this.openTabs.includes(convId)) this.openTabs = [...this.openTabs, convId];
    this.renderTabs();
    this.renderMessages();
  }

  // ---- Message Rendering ----

  renderMessages() {
    this.messagesEl.empty();
    const conv = this.plugin.conversationStore.getConversation(this.activeConvId);
    if (!conv || conv.messages.length === 0) {
      const welcome = this.messagesEl.createDiv({ cls: "oc-welcome" });
      welcome.createDiv({ cls: "oc-welcome-greeting", text: "\uD83E\uDD9E Hey, Zorba" });
      welcome.createDiv({ cls: "oc-welcome-hint", text: "Enter to send \u00B7 @ to attach files \u00B7 paste images" });
      return;
    }
    for (let i = 0; i < conv.messages.length; i++) {
      const msg = conv.messages[i];
      this.appendMessageEl(msg.role, msg.content, i, msg.thinking);
    }
    this.scrollToBottom();
  }

  appendMessageEl(role, content, msgIndex, thinking) {
    // Hide welcome screen when first message appears
    const welcome = this.messagesEl.querySelector(".oc-welcome");
    if (welcome) welcome.remove();

    const msgEl = this.messagesEl.createDiv({ cls: `oc-message oc-message-${role}` });

    // Role label
    if (role === "assistant") {
      msgEl.createDiv({ cls: "oc-role-label", text: "\uD83E\uDD9E Clawdian" });
    } else if (role === "user") {
      msgEl.createDiv({ cls: "oc-role-label oc-role-user", text: "You" });
      // Render images ABOVE user message bubble (Claudian-style)
      const conv = this.plugin.conversationStore.getConversation(this.activeConvId);
      if (conv && typeof msgIndex === "number") {
        const msg = conv.messages[msgIndex];
        if (msg && msg.images && msg.images.length > 0) {
          const imagesEl = msgEl.createDiv({ cls: "oc-message-images" });
          for (const imgData of msg.images) {
            const imgWrap = imagesEl.createDiv({ cls: "oc-message-image" });
            imgWrap.createEl("img", { attr: { src: imgData } });
            imgWrap.addEventListener("click", () => this.showLightbox(imgData));
          }
        }
      }
    }

    // Thinking block (collapsible)
    if (thinking && role === "assistant") {
      const thinkWrap = msgEl.createDiv({ cls: "oc-thinking" });
      const thinkHeader = thinkWrap.createDiv({ cls: "oc-thinking-header" });
      const thBrainIcon = thinkHeader.createSpan({ cls: "oc-think-icon" });
      setIconSafe(thBrainIcon, "brain", "12");
      thinkHeader.createSpan({ text: "Thinking" });
      const thChevron = thinkHeader.createSpan({ cls: "oc-think-chevron" });
      setIconSafe(thChevron, "chevron-right", "12");
      const thinkBody = thinkWrap.createDiv({ cls: "oc-thinking-body" });
      thinkBody.style.display = "none";
      thinkBody.setText(thinking);
      let expanded = false;
      thinkHeader.addEventListener("click", () => {
        expanded = !expanded;
        thinkBody.style.display = expanded ? "block" : "none";
        thinkHeader.toggleClass("expanded", expanded);
      });
    }

    const contentEl = msgEl.createDiv({ cls: "oc-message-content" });

    if (role === "assistant") {
      import_obsidian.MarkdownRenderer.render(this.app, content, contentEl, "", this.plugin);
    } else if (role === "error") {
      contentEl.createEl("code").setText(content);
    } else {
      const lines = content.split("\n");
      lines.forEach((line, i) => { contentEl.appendText(line); if (i < lines.length - 1) contentEl.createEl("br"); });
    }



    // Message actions
    if (role === "assistant" || role === "user") {
      const actionsEl = msgEl.createDiv({ cls: "oc-message-actions" });

      // Copy
      const copyBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Copy" } });
      setIconSafe(copyBtn, "copy");
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(content);
        setIconSafe(copyBtn, "check");
        copyBtn.addClass("copied");
        setTimeout(() => { setIconSafe(copyBtn, "copy"); copyBtn.removeClass("copied"); }, 1500);
      });

      if (role === "user" && typeof msgIndex === "number") {
        // Edit & resend
        const editBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Edit & resend" } });
        setIconSafe(editBtn, "pencil");
        editBtn.addEventListener("click", () => {
          // Truncate conversation from this message onward
          this.plugin.conversationStore.truncateFrom(this.activeConvId, msgIndex);
          this.inputEl.value = content;
          this.autoResizeInput();
          this.renderMessages();
          this.inputEl.focus();
        });
      }

      if (role === "assistant" && typeof msgIndex === "number") {
        // Regenerate
        const regenBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Regenerate" } });
        setIconSafe(regenBtn, "refresh-cw");
        regenBtn.addEventListener("click", () => {
          // Remove this assistant message and resend the previous user message
          this.plugin.conversationStore.truncateFrom(this.activeConvId, msgIndex);
          this.renderMessages();
          this.resendLastUserMessage();
        });
      }
    }

    if (this.autoScrollEnabled) this.scrollToBottom();
    return msgEl;
  }

  // ---- Streaming Message ----

  startStreamingMessage() {
    // Thinking indicator (shown first, before content arrives)
    this.streamingEl = this.messagesEl.createDiv({ cls: "oc-message oc-message-assistant" });

    this.thinkingEl = this.streamingEl.createDiv({ cls: "oc-thinking streaming" });
    this.thinkingHeaderEl = this.thinkingEl.createDiv({ cls: "oc-thinking-header expanded" });
    const stBrainIcon = this.thinkingHeaderEl.createSpan({ cls: "oc-think-icon" });
    setIconSafe(stBrainIcon, "brain", "12");
    this.thinkingHeaderEl.createSpan({ text: "Thinking..." });
    this.thinkingContentEl = this.thinkingEl.createDiv({ cls: "oc-thinking-body" });
    this.thinkingContentEl.style.display = "block";
    this.thinkingEl.style.display = "none"; // Hidden until thinking content arrives

    this.streamingContentEl = this.streamingEl.createDiv({ cls: "oc-message-content" });

    const loadingEl = this.streamingContentEl.createDiv({ cls: "oc-loading" });
    const dots = loadingEl.createDiv({ cls: "oc-loading-dots" });
    dots.createEl("span"); dots.createEl("span"); dots.createEl("span");

    this.scrollToBottom();
  }

  updateThinking(thinkingText) {
    if (!this.thinkingEl || !this.thinkingContentEl) return;
    this.thinkingEl.style.display = "block";
    this.thinkingContentEl.setText(thinkingText);
    if (this.autoScrollEnabled) this.scrollToBottom();
  }

  updateStreamingMessage(fullText) {
    if (!this.streamingContentEl) return;
    this.streamingContentEl.empty();
    import_obsidian.MarkdownRenderer.render(this.app, fullText, this.streamingContentEl, "", this.plugin);
    if (this.autoScrollEnabled) this.scrollToBottom();
  }

  finalizeStreamingMessage(fullText, thinkingText) {
    if (!this.streamingEl || !this.streamingContentEl) return;

    // Finalize thinking block
    if (thinkingText && this.thinkingEl) {
      this.thinkingEl.removeClass("streaming");
      this.thinkingHeaderEl.empty();
      const fBrainIcon = this.thinkingHeaderEl.createSpan({ cls: "oc-think-icon" });
      setIconSafe(fBrainIcon, "brain", "12");
      this.thinkingHeaderEl.createSpan({ text: "Thinking" });
      const fChevron = this.thinkingHeaderEl.createSpan({ cls: "oc-think-chevron" });
      setIconSafe(fChevron, "chevron-right", "12");
      this.thinkingContentEl.style.display = "none";
      this.thinkingHeaderEl.removeClass("expanded");
      let expanded = false;
      this.thinkingHeaderEl.addEventListener("click", () => {
        expanded = !expanded;
        this.thinkingContentEl.style.display = expanded ? "block" : "none";
        this.thinkingHeaderEl.toggleClass("expanded", expanded);
      });
    } else if (this.thinkingEl) {
      this.thinkingEl.remove();
    }

    // Re-render final content
    this.streamingContentEl.empty();
    import_obsidian.MarkdownRenderer.render(this.app, fullText, this.streamingContentEl, "", this.plugin);

    // Add action buttons
    const actionsEl = this.streamingEl.createDiv({ cls: "oc-message-actions" });

    const copyBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Copy" } });
    setIconSafe(copyBtn, "copy");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(fullText);
      setIconSafe(copyBtn, "check");
      copyBtn.addClass("copied");
      setTimeout(() => { setIconSafe(copyBtn, "copy"); copyBtn.removeClass("copied"); }, 1500);
    });

    const regenBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Regenerate" } });
    setIconSafe(regenBtn, "refresh-cw");
    regenBtn.addEventListener("click", () => {
      // Find msg index
      const conv = this.plugin.conversationStore.getConversation(this.activeConvId);
      if (conv) {
        const idx = conv.messages.length - 1;
        this.plugin.conversationStore.truncateFrom(this.activeConvId, idx);
        this.renderMessages();
        this.resendLastUserMessage();
      }
    });

    this.streamingEl = null;
    this.streamingContentEl = null;
    this.thinkingEl = null;
    this.thinkingHeaderEl = null;
    this.thinkingContentEl = null;
  }

  // ---- Send Message ----

  async resendLastUserMessage() {
    const conv = this.plugin.conversationStore.getConversation(this.activeConvId);
    if (!conv || conv.messages.length === 0) return;
    const lastUser = [...conv.messages].reverse().find(m => m.role === "user");
    if (!lastUser) return;
    await this._doSend(lastUser.content, true);
  }

  async sendMessage() {
    const content = this.inputEl.value.trim();
    if (!content || this.isStreaming) return;
    this.inputEl.value = "";
    this.autoResizeInput();
    await this._doSend(content, false);
  }

  async _doSend(content, isResend) {
    this.isStreaming = true;
    this.autoScrollEnabled = true;
    this.stopBtn.style.display = "";
    this.renderTabs();

    const convId = this.activeConvId;
    if (!convId) return;

    // Build enriched content with file context
    let userContent = content;
    const contextParts = [];

    // @ mentioned files
    if (this.attachedFiles.length > 0) {
      for (const file of this.attachedFiles) {
        try {
          const fileContent = await this.app.vault.read(file);
          contextParts.push(`[Attached: ${file.path}]\n\`\`\`\n${fileContent.slice(0, 8000)}\n\`\`\``);
        } catch (e) {}
      }
      this.attachedFiles = [];
    }

    // Current note
    if (this.plugin.settings.includeCurrentNote) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile instanceof import_obsidian.TFile && activeFile.extension === "md") {
        if (!activeFile.path.startsWith(this.plugin.settings.conversationsPath || "Clawdian/conversations")) {
          try {
            const noteContent = await this.app.vault.read(activeFile);
            if (noteContent.trim()) contextParts.push(`[Currently viewing: ${activeFile.path}]\n\`\`\`\n${noteContent.slice(0, 4000)}\n\`\`\``);
          } catch (e) {}
        }
      }
    }

    if (contextParts.length > 0) userContent += "\n\n" + contextParts.join("\n\n");

    // Handle images — build multimodal content
    let apiContent = userContent;
    if (this.pastedImages.length > 0) {
      apiContent = [
        { type: "text", text: userContent }
      ];
      for (const img of this.pastedImages) {
        apiContent.push({
          type: "image_url",
          image_url: { url: img.data }
        });
      }
      this.pastedImages = [];
    }

    // Capture images before clearing
    const messageImages = this.pastedImages.map(img => img.data);

    // Add to store & render
    if (!isResend) {
      this.plugin.conversationStore.addMessage(convId, "user", content, messageImages.length > 0 ? { images: messageImages } : undefined);
      const conv = this.plugin.conversationStore.getConversation(convId);
      this.appendMessageEl("user", content, conv ? conv.messages.length - 1 : undefined);
    }

    this.startStreamingMessage();
    this.abortController = new AbortController();
    this.updateContextRow();

    try {
      const history = this.plugin.conversationStore.getMessages(convId);
      const apiMessages = history.map((m, i) => {
        if (i === history.length - 1 && m.role === "user") {
          return { role: "user", content: apiContent };
        }
        return m;
      });

      const result = await this.plugin.api.chat(
        apiMessages,
        (text, _delta) => this.updateStreamingMessage(text),
        (thinkText) => this.updateThinking(thinkText),
        this.abortController.signal
      );

      const fullText = result.text;
      const thinkingText = result.thinking;

      const cleanText = this.plugin.actionExecutor.stripActionBlocks(fullText);
      const actions = this.plugin.actionExecutor.parseActions(fullText);

      this.finalizeStreamingMessage(cleanText, thinkingText);
      this.plugin.conversationStore.addMessage(convId, "assistant", cleanText, { thinking: thinkingText || undefined });

      if (actions.length > 0) await this.plugin.actionExecutor.execute(actions);
      await this.plugin.conversationStore.saveConversation(convId);

    } catch (err) {
      if (err.name === "AbortError") {
        this.finalizeStreamingMessage("*(cancelled)*", "");
      } else {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (this.streamingEl) { this.streamingEl.remove(); this.streamingEl = null; this.streamingContentEl = null; }
        this.appendMessageEl("error", errMsg);
      }
    }

    this.isStreaming = false;
    this.abortController = null;
    this.stopBtn.style.display = "none";
    this.renderTabs();
    this.inputEl.focus();
  }

  // ---- Helpers ----

  autoResizeInput() {
    // Claudian-style: use minHeight to expand, maxHeight to cap
    this.inputEl.style.minHeight = "";
    const container = this.inputEl.closest(".openclaw-container");
    const viewHeight = container ? container.clientHeight : window.innerHeight;
    const maxHeight = Math.max(TEXTAREA_MIN_MAX_HEIGHT, viewHeight * TEXTAREA_MAX_HEIGHT_PERCENT);
    const flexAllocatedHeight = this.inputEl.offsetHeight;
    const contentHeight = Math.min(this.inputEl.scrollHeight, maxHeight);
    if (contentHeight > flexAllocatedHeight) {
      this.inputEl.style.minHeight = `${contentHeight}px`;
    }
    this.inputEl.style.maxHeight = `${maxHeight}px`;
  }

  scrollToBottom() {
    requestAnimationFrame(() => { this.messagesEl.scrollTop = this.messagesEl.scrollHeight; });
  }

  updateContextRow() {
    this.contextRowEl.empty();
    let hasContent = false;

    // Show attached files
    for (const file of this.attachedFiles) {
      hasContent = true;
      const chip = this.contextRowEl.createDiv({ cls: "oc-context-chip" });
      chip.createSpan({ text: `\uD83D\uDCC4 ${file.basename}` });
      const removeBtn = chip.createSpan({ cls: "oc-chip-remove", text: "\u00D7" });
      removeBtn.addEventListener("click", () => {
        this.attachedFiles = this.attachedFiles.filter(f => f.path !== file.path);
        this.updateContextRow();
      });
    }

    // Show pasted images as thumbnails
    for (let i = 0; i < this.pastedImages.length; i++) {
      hasContent = true;
      const chip = this.contextRowEl.createDiv({ cls: "oc-image-chip" });
      const thumb = chip.createEl("img", {
        cls: "oc-image-thumb",
        attr: { src: this.pastedImages[i].data, alt: this.pastedImages[i].name }
      });
      // Click to enlarge
      thumb.addEventListener("click", () => this.showLightbox(this.pastedImages[i].data));
      const removeBtn = chip.createDiv({ cls: "oc-image-chip-remove" });
      removeBtn.setText("\u00D7");
      const idx = i;
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.pastedImages.splice(idx, 1);
        this.updateContextRow();
      });
    }

    // Show current note indicator
    if (this.plugin.settings.includeCurrentNote) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile instanceof import_obsidian.TFile && activeFile.extension === "md") {
        if (!activeFile.path.startsWith(this.plugin.settings.conversationsPath || "Clawdian/conversations")) {
          hasContent = true;
          const chip = this.contextRowEl.createDiv({ cls: "oc-context-chip oc-context-auto" });
          chip.createSpan({ text: `\uD83D\uDCC4 ${activeFile.basename}` });
        }
      }
    }

    this.contextRowEl.toggleClass("has-content", hasContent);
  }
};

// ============================================
// Settings Tab
// ============================================
var ClawdianSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Clawdian Settings" });

    new import_obsidian.Setting(containerEl)
      .setName("Gateway URL")
      .setDesc("URL of your OpenClaw gateway")
      .addText(text => text.setPlaceholder("http://127.0.0.1:18789").setValue(this.plugin.settings.gatewayUrl)
        .onChange(async (val) => { this.plugin.settings.gatewayUrl = val.replace(/\/+$/, ""); await this.plugin.saveSettings(); }));

    const statusInfo = secureTokenStorage.getStatusInfo();
    const tokenSetting = new import_obsidian.Setting(containerEl).setName("Gateway Token").setDesc("Authentication token");
    const statusEl = containerEl.createDiv({ cls: "oc-token-status" });
    statusEl.innerHTML = `<span class="oc-status-${statusInfo.secure ? "secure" : "insecure"}">${statusInfo.secure ? "\uD83D\uDD12" : "\u26A0\uFE0F"} ${statusInfo.description}</span>`;

    if (statusInfo.method === "envVar") {
      tokenSetting.addButton(btn => btn.setButtonText("Using Environment Variable").setDisabled(true));
    } else {
      const currentToken = secureTokenStorage.getToken(this.plugin.settings.gatewayTokenEncrypted, this.plugin.settings.gatewayTokenPlaintext);
      tokenSetting.addText(text => {
        text.setPlaceholder("Enter your token").setValue(currentToken)
          .onChange(async (val) => {
            const { encrypted, plaintext } = secureTokenStorage.setToken(val);
            this.plugin.settings.gatewayTokenEncrypted = encrypted;
            this.plugin.settings.gatewayTokenPlaintext = plaintext;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });
    }

    new import_obsidian.Setting(containerEl).setName("Include current note").setDesc("Attach focused note as context")
      .addToggle(t => t.setValue(this.plugin.settings.includeCurrentNote).onChange(async v => { this.plugin.settings.includeCurrentNote = v; await this.plugin.saveSettings(); }));

    new import_obsidian.Setting(containerEl).setName("Show file actions").setDesc("Display file action indicators")
      .addToggle(t => t.setValue(this.plugin.settings.showActionsInChat).onChange(async v => { this.plugin.settings.showActionsInChat = v; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "Audit Log" });
    new import_obsidian.Setting(containerEl).setName("Enable audit logging")
      .addToggle(t => t.setValue(this.plugin.settings.auditLogEnabled).onChange(async v => { this.plugin.settings.auditLogEnabled = v; await this.plugin.saveSettings(); }));
    new import_obsidian.Setting(containerEl).setName("Audit log path")
      .addText(t => t.setPlaceholder("Clawdian/audit-log.md").setValue(this.plugin.settings.auditLogPath)
        .onChange(async v => { this.plugin.settings.auditLogPath = v || "Clawdian/audit-log.md"; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "Storage" });
    new import_obsidian.Setting(containerEl).setName("Conversations folder")
      .addText(t => t.setPlaceholder("Clawdian/conversations").setValue(this.plugin.settings.conversationsPath)
        .onChange(async v => { this.plugin.settings.conversationsPath = v || "Clawdian/conversations"; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "Connection Test" });
    const testContainer = containerEl.createDiv({ cls: "oc-test-container" });
    const testBtn = testContainer.createEl("button", { text: "Test Connection" });
    const testResult = testContainer.createEl("span", { cls: "oc-test-result" });
    testBtn.addEventListener("click", async () => {
      testResult.setText("Testing...");
      testResult.removeClass("oc-test-success", "oc-test-error");
      try {
        const response = await this.plugin.api.chatSync("Say 'Connected!' in one word");
        testResult.setText(`\u2713 ${response}`);
        testResult.addClass("oc-test-success");
      } catch (err) {
        testResult.setText(`\u2717 ${err instanceof Error ? err.message : "Failed"}`);
        testResult.addClass("oc-test-error");
      }
    });
  }
};

// ============================================
// Plugin Entry Point
// ============================================
var ClawdianPlugin = class extends import_obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.api = new ClawdianAPI(this.settings);
    this.actionExecutor = new ActionExecutor(this.app, () => this.settings);
    this.conversationStore = new ConversationStore(this.app, () => this.settings);

    (0, import_obsidian.addIcon)("clawdian-lobster", LOBSTER_ICON);

    this.registerView(CLAWDIAN_VIEW_TYPE, (leaf) => new ClawdianView(leaf, this));
    // Backwards compat: re-register old view type so Obsidian doesn't error on workspace restore
    this.registerView("openclaw-chat-view", (leaf) => new ClawdianView(leaf, this));

    this.addRibbonIcon("clawdian-lobster", "Open Clawdian", () => this.activateView());

    // ---- Commands ----
    this.addCommand({ id: "open-chat", name: "Open Clawdian", callback: () => this.activateView() });

    this.addCommand({
      id: "new-chat", name: "New Chat",
      callback: async () => {
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType(CLAWDIAN_VIEW_TYPE);
        if (leaves.length > 0) { const view = leaves[0].view; if (view instanceof ClawdianView) view.newConversation(); }
      }
    });

    // Send selection to Clawdian
    this.addCommand({
      id: "send-selection", name: "Send selection to Clawdian",
      editorCallback: async (editor) => {
        const selection = editor.getSelection();
        if (!selection) { new import_obsidian.Notice("No text selected"); return; }
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType(CLAWDIAN_VIEW_TYPE);
        if (leaves.length > 0) {
          const view = leaves[0].view;
          if (view instanceof ClawdianView) {
            view.inputEl.value = selection;
            view.autoResizeInput();
            view.inputEl.focus();
          }
        }
      }
    });

    // Summarize current note
    this.addCommand({
      id: "summarize-note", name: "Summarize current note",
      editorCallback: async (editor, markdownView) => {
        const file = markdownView.file;
        if (!file) { new import_obsidian.Notice("No file open"); return; }
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType(CLAWDIAN_VIEW_TYPE);
        if (leaves.length > 0) {
          const view = leaves[0].view;
          if (view instanceof ClawdianView) {
            view.inputEl.value = `Summarize this note: ${file.basename}`;
            view.autoResizeInput();
            view.sendMessage();
          }
        }
      }
    });

    // Ask about selection
    this.addCommand({
      id: "ask-about-selection", name: "Ask Clawdian about selection",
      editorCallback: async (editor) => {
        const selection = editor.getSelection();
        if (!selection) { new import_obsidian.Notice("No text selected"); return; }
        await this.activateView();
        const leaves = this.app.workspace.getLeavesOfType(CLAWDIAN_VIEW_TYPE);
        if (leaves.length > 0) {
          const view = leaves[0].view;
          if (view instanceof ClawdianView) {
            view.inputEl.value = `Explain this:\n\n${selection}`;
            view.autoResizeInput();
            view.inputEl.focus();
          }
        }
      }
    });

    // ---- Editor context menu ----
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const selection = editor.getSelection();
        if (selection) {
          menu.addItem(item => {
            item.setTitle("Send to Clawdian")
              .setIcon("clawdian-lobster")
              .onClick(async () => {
                await this.activateView();
                const leaves = this.app.workspace.getLeavesOfType(CLAWDIAN_VIEW_TYPE);
                if (leaves.length > 0) {
                  const view = leaves[0].view;
                  if (view instanceof ClawdianView) {
                    view.inputEl.value = selection;
                    view.autoResizeInput();
                    view.inputEl.focus();
                  }
                }
              });
          });
          menu.addItem(item => {
            item.setTitle("Ask Clawdian to explain")
              .setIcon("clawdian-lobster")
              .onClick(async () => {
                await this.activateView();
                const leaves = this.app.workspace.getLeavesOfType(CLAWDIAN_VIEW_TYPE);
                if (leaves.length > 0) {
                  const view = leaves[0].view;
                  if (view instanceof ClawdianView) {
                    view.inputEl.value = `Explain this:\n\n${selection}`;
                    view.autoResizeInput();
                    view.inputEl.focus();
                  }
                }
              });
          });
        }
      })
    );

    this.addSettingTab(new ClawdianSettingTab(this.app, this));
    console.log("Clawdian v2.0 loaded \uD83E\uDD9E");
  }

  onunload() { console.log("Clawdian unloaded"); }

  async loadSettings() {
    const data = await this.loadData() || {};
    if (data.gatewayToken && !data.gatewayTokenPlaintext && !data.gatewayTokenEncrypted) {
      data.gatewayTokenPlaintext = data.gatewayToken;
      delete data.gatewayToken;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.api = new ClawdianAPI(this.settings);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = null;
    // Check both new and old view types
    let leaves = workspace.getLeavesOfType(CLAWDIAN_VIEW_TYPE);
    if (leaves.length === 0) leaves = workspace.getLeavesOfType("openclaw-chat-view");
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: CLAWDIAN_VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }
};
