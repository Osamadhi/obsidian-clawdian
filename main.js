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

// CodeMirror 6 modules
var cm_state = require("@codemirror/state");
var cm_view = require("@codemirror/view");

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
// Vault Helper Functions (Phase 1)
// ============================================
function getVaultBasePath(app) {
  const adapter = app.vault.adapter;
  if (adapter && adapter.basePath) return adapter.basePath;
  return null;
}

function listSiblingFiles(app, file) {
  if (!file || !file.parent) return [];
  return file.parent.children.map(c => c.name).sort();
}

function buildSystemPrompt(app) {
  const vaultPath = getVaultBasePath(app);
  const activeFile = app.workspace.getActiveFile();
  let prompt = `你正在 Obsidian vault 中协助用户编辑笔记。\n`;
  if (vaultPath) prompt += `Vault 路径: ${vaultPath}\n`;
  if (activeFile) {
    const fullPath = vaultPath ? `${vaultPath}\\${activeFile.path.replace(/\//g, '\\')}` : activeFile.path;
    prompt += `当前文件: ${activeFile.path}（完整路径: ${fullPath}）\n`;
    const siblings = listSiblingFiles(app, activeFile);
    if (siblings.length > 0) {
      prompt += `当前目录内容:\n${siblings.map(s => `  - ${s}`).join('\n')}\n`;
    }
  }
  prompt += `\n你可以使用 read/write/edit 工具直接操作 vault 中的文件。\n`;
  if (vaultPath) {
    prompt += `- 修改文件: 用 edit 工具，路径用完整路径如 "${vaultPath}\\文件名.md"\n`;
  }
  prompt += `- 创建文件: 用 write 工具\n- 读取文件: 用 read 工具\n文件修改后 Obsidian 会自动检测到变化。\n`;
  prompt += `\n## 大文件处理\n`;
  prompt += `大文件（>30K字符）会自动根据用户问题搜索相关段落，搜索结果已包含在附件上下文中。\n`;
  prompt += `如果搜索结果不够，可用 exec 执行 vault_search.py 手动补充搜索，或用 read 工具读取指定行范围。\n`;
  prompt += `手动搜索命令: python E:\\\\openclaw-work\\\\clawdian\\\\vault_search.py --query "关键词" --path "文件路径"\n`;
  return prompt;
}

// ============================================
// Word-level Diff (Phase 2 - Inline Edit)
// ============================================
function computeWordDiff(oldText, newText) {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);
  // Simple LCS-based diff
  const m = oldWords.length, n = newWords.length;
  // For performance, use a simplified approach
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // Backtrack
  const result = [];
  let i = m, j = n;
  const ops = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      ops.push({ type: 'same', text: oldWords[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'ins', text: newWords[j - 1] });
      j--;
    } else {
      ops.push({ type: 'del', text: oldWords[i - 1] });
      i--;
    }
  }
  ops.reverse();
  return ops;
}

// ============================================
// Slash Commands Definition
// ============================================
var SLASH_COMMANDS = [
  { command: '/rewrite', label: '/rewrite', description: '重写当前文件' },
  { command: '/translate', label: '/translate', description: '翻译选中文本' },
  { command: '/summarize', label: '/summarize', description: '总结当前文件' },
  { command: '/expand', label: '/expand', description: '扩展选中内容' },
  { command: '/fix', label: '/fix', description: '修正语法错误' },
];

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
    const body = JSON.stringify({
      model: "openclaw",
      messages: messages,
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
          "Accept": "text/event-stream",
          "x-openclaw-scopes": "operator.admin,operator.read,operator.write"
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

  async chatSync(message, systemPrompt) {
    const url = `${this.settings.gatewayUrl}/v1/chat/completions`;
    const token = this.getToken();
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: message });
    const response = await (0, import_obsidian.requestUrl)({
      url, method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "x-openclaw-scopes": "operator.admin,operator.read,operator.write" },
      body: JSON.stringify({ model: "openclaw", messages, stream: false })
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
    // Dual-write: export readable Markdown copy
    try { await this.exportMarkdown(id); } catch (e) { console.error("Clawdian: MD export error", e); }
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

  async exportMarkdown(id) {
    const conv = this.conversations.get(id);
    if (!conv || !conv.messages.length) return;
    const settings = this.getSettings();
    const mdFolder = settings.conversationsPath + "/md";
    await this.ensureFolder(mdFolder);

    const created = new Date(conv.createdAt);
    const updated = new Date(conv.updatedAt);
    const pad = (n) => String(n).padStart(2, "0");
    const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    // Build safe filename from title
    const safeTitle = (conv.title || "Untitled").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    const datePrefix = `${created.getFullYear()}${pad(created.getMonth()+1)}${pad(created.getDate())}`;
    const fileName = `${datePrefix}-${safeTitle}.md`;

    let md = `---\ntitle: "${conv.title.replace(/"/g, '\\"')}"\ncreated: ${fmtDate(created)}\nupdated: ${fmtDate(updated)}\nid: ${conv.id}\n---\n\n`;

    for (const msg of conv.messages) {
      const time = new Date(msg.timestamp);
      const timeStr = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
      if (msg.role === "user") {
        md += `## 👤 User (${timeStr})\n\n${msg.content}\n\n`;
      } else if (msg.role === "assistant") {
        if (msg.thinking) {
          md += `## 🤖 Assistant (${timeStr})\n\n<details><summary>💭 Thinking</summary>\n\n${msg.thinking}\n\n</details>\n\n${msg.content}\n\n`;
        } else {
          md += `## 🤖 Assistant (${timeStr})\n\n${msg.content}\n\n`;
        }
      }
    }

    const mdPath = `${mdFolder}/${fileName}`;
    const existing = this.app.vault.getAbstractFileByPath(mdPath);
    try {
      if (existing instanceof import_obsidian.TFile) {
        await this.app.vault.modify(existing, md);
      } else {
        // Remove old exports for same conv id (title may have changed)
        const folder = this.app.vault.getAbstractFileByPath(mdFolder);
        if (folder instanceof import_obsidian.TFolder) {
          for (const child of folder.children) {
            if (child instanceof import_obsidian.TFile && child.extension === "md") {
              try {
                const raw = await this.app.vault.read(child);
                if (raw.includes("id: " + conv.id)) {
                  await this.app.vault.delete(child);
                }
              } catch (e) {}
            }
          }
        }
        await this.app.vault.create(mdPath, md);
      }
    } catch (e) { console.error("Clawdian: MD export failed", e); }
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

function setIconSafe(el, iconName, size) {
  try {
    if (typeof import_obsidian.setIcon === "function") {
      import_obsidian.setIcon(el, iconName);
    } else {
      var fallbackMap = {
        "plus": "+", "trash-2": "\uD83D\uDDD1", "copy": "\uD83D\uDCCB",
        "check": "\u2713", "chevron-down": "\u25BC", "chevron-right": "\u25B6",
        "file-text": "\uD83D\uDCC4", "image": "\uD83D\uDDBC", "square": "\u25A0",
        "refresh-cw": "\u21BB", "pencil": "\u270F", "brain": "\uD83E\uDDE0", "x": "\u2715",
        "type": "T", "wand-2": "\u2728", "zap": "\u26A1",
        "chevron-up": "\u25B2"
      };
      el.setText(fallbackMap[iconName] || iconName);
      return;
    }
    // Always force SVG size via inline style (Obsidian's default is too small for action buttons)
    var svg = el.querySelector("svg") || el.querySelector(".svg-icon");
    if (svg) {
      var s = size || "18";
      svg.style.width = s + "px";
      svg.style.height = s + "px";
      svg.style.minWidth = s + "px";
      svg.style.minHeight = s + "px";
      svg.style.strokeWidth = "2px";
    }
  } catch (e) {
    console.error("Clawdian setIconSafe failed:", iconName, e);
    el.setText(iconName);
  }
}

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
// Slash Command Popup
// ============================================
var SlashCommandPopup = class {
  constructor(inputEl, onSelect) {
    this.inputEl = inputEl;
    this.onSelect = onSelect;
    this.popupEl = null;
    this.items = [];
    this.selectedIndex = 0;
    this.active = false;
  }

  show(query) {
    this.active = true;
    this.selectedIndex = 0;

    if (!this.popupEl) {
      this.popupEl = document.createElement("div");
      this.popupEl.addClass("oc-slash-popup");
      this.inputEl.parentElement.appendChild(this.popupEl);
    }
    this.popupEl.style.display = "block";
    this.updateList(query);
  }

  hide() {
    this.active = false;
    if (this.popupEl) this.popupEl.style.display = "none";
  }

  updateList(query) {
    if (!this.popupEl) return;
    this.popupEl.empty();

    const q = (query || "").toLowerCase().replace(/^\//, '');
    this.items = SLASH_COMMANDS.filter(c =>
      !q || c.command.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)
    );

    if (this.items.length === 0) { this.hide(); return; }

    this.items.forEach((cmd, i) => {
      const item = this.popupEl.createDiv({
        cls: "oc-slash-item" + (i === this.selectedIndex ? " selected" : "")
      });
      item.createSpan({ cls: "oc-slash-cmd", text: cmd.command });
      item.createSpan({ cls: "oc-slash-desc", text: cmd.description });
      item.addEventListener("click", () => this.select(cmd));
      item.addEventListener("mouseenter", () => {
        this.selectedIndex = i;
        this.highlightSelected();
      });
    });
  }

  highlightSelected() {
    if (!this.popupEl) return;
    const children = this.popupEl.querySelectorAll(".oc-slash-item");
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

  handleInput(value) {
    if (value.startsWith('/') && !value.includes(' ') && !value.includes('\n')) {
      this.show(value);
    } else {
      this.hide();
    }
  }

  select(cmd) {
    this.onSelect(cmd);
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
// Inline Edit Manager (Phase 2)
// ============================================

// Single shared StateEffect + StateField to avoid appendConfig accumulation
var inlineEditEffect = cm_state.StateEffect.define();
var inlineEditField = cm_state.StateField.define({
  create() { return cm_view.Decoration.none; },
  update(value, tr) {
    value = value.map(tr.changes);
    for (let e of tr.effects) {
      if (e.is(inlineEditEffect)) {
        value = e.value;
      }
    }
    return value;
  },
  provide(field) { return cm_view.EditorView.decorations.from(field); }
});

var InlineEditManager = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.activeWidget = null;
    this.activeDiff = null;
    // Register the shared StateField once for all editor views
    this.plugin.registerEditorExtension([inlineEditField]);
  }

  getActiveEditorView() {
    const leaf = this.plugin.app.workspace.activeLeaf;
    if (!leaf || !leaf.view || !leaf.view.editor) return null;
    return leaf.view.editor.cm; // CM6 EditorView
  }

  getActiveEditor() {
    const leaf = this.plugin.app.workspace.activeLeaf;
    if (!leaf || !leaf.view || !leaf.view.editor) return null;
    return leaf.view.editor;
  }

  async triggerInlineEdit(cursorMode) {
    const editor = this.getActiveEditor();
    if (!editor) { new import_obsidian.Notice("No active editor"); return; }

    const editorView = editor.cm;
    if (!editorView) { new import_obsidian.Notice("Cannot access editor view"); return; }

    const selection = editor.getSelection();
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) { new import_obsidian.Notice("No active file"); return; }

    const isInsertMode = cursorMode || !selection;
    const selectedText = selection || "";
    const cursor = editor.getCursor();

    // Create inline input widget
    this.showInlineInput(editorView, editor, selectedText, activeFile, isInsertMode, cursor);
  }

  showInlineInput(editorView, editor, selectedText, file, isInsertMode, cursor) {
    // Remove previous widget if any
    this.clearWidget();

    // Determine position
    const pos = isInsertMode
      ? editor.posToOffset(cursor)
      : editor.posToOffset(editor.getCursor("from"));

    // Create the input container as a DOM element
    const container = document.createElement("div");
    container.addClass("oc-inline-edit-container");

    const input = document.createElement("input");
    input.type = "text";
    input.addClass("oc-inline-input");
    input.placeholder = isInsertMode ? "Describe what to insert..." : "Describe how to edit...";
    container.appendChild(input);

    const spinner = document.createElement("div");
    spinner.addClass("oc-inline-spinner");
    spinner.style.display = "none";
    container.appendChild(spinner);

    // Create CM6 widget
    const self = this;
    const widgetDeco = cm_view.Decoration.widget({
      widget: new (class extends cm_view.WidgetType {
        toDOM() { return container; }
        ignoreEvent() { return false; }
      })(),
      side: 1,
    });

    const decoSet = cm_view.Decoration.set([widgetDeco.range(pos)]);

    editorView.dispatch({
      effects: inlineEditEffect.of(decoSet)
    });

    this.activeWidget = { container, editorView };

    // Focus input after a tick
    setTimeout(() => input.focus(), 50);

    // Handle input events
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const instruction = input.value.trim();
        if (!instruction) return;
        input.style.display = "none";
        spinner.style.display = "block";

        try {
          const result = await self.callInlineAPI(selectedText, instruction, file, isInsertMode);
          self.clearWidget();
          if (result) {
            self.showDiff(editorView, editor, selectedText, result, isInsertMode, cursor);
          }
        } catch (err) {
          new import_obsidian.Notice(`Inline edit failed: ${err.message}`);
          self.clearWidget();
        }
      } else if (e.key === "Escape") {
        self.clearWidget();
      }
    });
  }

  async callInlineAPI(selectedText, instruction, file, isInsertMode) {
    const vaultPath = getVaultBasePath(this.plugin.app);
    let systemPrompt;
    if (isInsertMode) {
      systemPrompt = `你是内嵌在 Obsidian 中的编辑助手。用户在文件 "${file.path}" 中指定了光标位置，要求插入内容。
直接输出要插入的文本，用 <insertion> 标签包裹：
<insertion>要插入的文本</insertion>
不要解释，不要寒暄，只输出插入结果。`;
    } else {
      systemPrompt = `你是内嵌在 Obsidian 中的编辑助手。用户选中了文本并给出编辑指令。
直接输出修改后的文本，用 <replacement> 标签包裹：
<replacement>修改后的文本</replacement>
不要解释，不要寒暄，只输出替换结果。`;
    }

    let userMsg;
    if (isInsertMode) {
      userMsg = `文件: ${file.path}\n指令: ${instruction}`;
    } else {
      userMsg = `选中文本:\n${selectedText}\n\n指令: ${instruction}`;
    }

    const response = await this.plugin.api.chatSync(userMsg, systemPrompt);

    // Parse response
    if (isInsertMode) {
      const match = response.match(/<insertion>([\s\S]*?)<\/insertion>/);
      return match ? match[1] : response.trim();
    } else {
      const match = response.match(/<replacement>([\s\S]*?)<\/replacement>/);
      return match ? match[1] : response.trim();
    }
  }

  showDiff(editorView, editor, originalText, newText, isInsertMode, cursor) {
    this.clearDiff();

    if (isInsertMode) {
      // For insert mode, just show the new text with accept/reject
      const pos = editor.posToOffset(cursor);
      const container = document.createElement("div");
      container.addClass("oc-inline-diff-replace");

      const insSpan = document.createElement("span");
      insSpan.addClass("oc-diff-ins");
      insSpan.textContent = newText;
      container.appendChild(insSpan);

      const buttonsDiv = document.createElement("div");
      buttonsDiv.addClass("oc-inline-diff-buttons");

      const acceptBtn = document.createElement("button");
      acceptBtn.textContent = "✓ Accept";
      acceptBtn.addClass("oc-diff-accept");
      acceptBtn.addEventListener("click", () => {
        // Insert text at cursor
        editor.replaceRange(newText, cursor);
        this.clearDiff();
      });

      const rejectBtn = document.createElement("button");
      rejectBtn.textContent = "✗ Reject";
      rejectBtn.addClass("oc-diff-reject");
      rejectBtn.addEventListener("click", () => {
        this.clearDiff();
      });

      buttonsDiv.appendChild(acceptBtn);
      buttonsDiv.appendChild(rejectBtn);
      container.appendChild(buttonsDiv);

      const widgetDeco = cm_view.Decoration.widget({
        widget: new (class extends cm_view.WidgetType {
          toDOM() { return container; }
          ignoreEvent() { return false; }
        })(),
        side: 1,
      });

      const decoSet = cm_view.Decoration.set([widgetDeco.range(pos)]);

      editorView.dispatch({
        effects: inlineEditEffect.of(decoSet)
      });

      this.activeDiff = { container, editorView };
    } else {
      // For replace mode, show word-level diff
      const fromPos = editor.posToOffset(editor.getCursor("from"));
      const toPos = editor.posToOffset(editor.getCursor("to"));

      const container = document.createElement("div");
      container.addClass("oc-inline-diff-replace");

      const diffOps = computeWordDiff(originalText, newText);
      const diffContent = document.createElement("div");
      diffContent.addClass("oc-diff-content");

      for (const op of diffOps) {
        if (op.type === 'same') {
          diffContent.appendChild(document.createTextNode(op.text));
        } else if (op.type === 'del') {
          const span = document.createElement("span");
          span.addClass("oc-diff-del");
          span.textContent = op.text;
          diffContent.appendChild(span);
        } else if (op.type === 'ins') {
          const span = document.createElement("span");
          span.addClass("oc-diff-ins");
          span.textContent = op.text;
          diffContent.appendChild(span);
        }
      }
      container.appendChild(diffContent);

      const buttonsDiv = document.createElement("div");
      buttonsDiv.addClass("oc-inline-diff-buttons");

      const acceptBtn = document.createElement("button");
      acceptBtn.textContent = "✓ Accept";
      acceptBtn.addClass("oc-diff-accept");
      acceptBtn.addEventListener("click", () => {
        // Replace the selected text
        const from = editor.offsetToPos(fromPos);
        const to = editor.offsetToPos(toPos);
        editor.replaceRange(newText, from, to);
        this.clearDiff();
      });

      const rejectBtn = document.createElement("button");
      rejectBtn.textContent = "✗ Reject";
      rejectBtn.addClass("oc-diff-reject");
      rejectBtn.addEventListener("click", () => {
        this.clearDiff();
      });

      buttonsDiv.appendChild(acceptBtn);
      buttonsDiv.appendChild(rejectBtn);
      container.appendChild(buttonsDiv);

      const widgetDeco = cm_view.Decoration.widget({
        widget: new (class extends cm_view.WidgetType {
          toDOM() { return container; }
          ignoreEvent() { return false; }
        })(),
        side: 1,
      });

      const decoSet = cm_view.Decoration.set([widgetDeco.range(fromPos)]);

      editorView.dispatch({
        effects: inlineEditEffect.of(decoSet)
      });

      this.activeDiff = { container, editorView };
    }

    // Keyboard handler for accept/reject
    const onKey = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const acceptBtn = this.activeDiff?.container?.querySelector('.oc-diff-accept');
        if (acceptBtn) acceptBtn.click();
        document.removeEventListener("keydown", onKey);
      } else if (e.key === "Escape") {
        this.clearDiff();
        document.removeEventListener("keydown", onKey);
      }
    };
    document.addEventListener("keydown", onKey);
  }

  clearWidget() {
    if (this.activeWidget) {
      try { this.activeWidget.container.remove(); } catch (e) {}
      try {
        this.activeWidget.editorView.dispatch({
          effects: inlineEditEffect.of(cm_view.Decoration.none)
        });
      } catch (e) {}
      this.activeWidget = null;
    }
  }

  clearDiff() {
    if (this.activeDiff) {
      try { this.activeDiff.container.remove(); } catch (e) {}
      try {
        this.activeDiff.editorView.dispatch({
          effects: inlineEditEffect.of(cm_view.Decoration.none)
        });
      } catch (e) {}
      this.activeDiff = null;
    }
  }
};

// ============================================
// Main Chat View (v3.0)
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
    this.slashPopup = null;
    this.attachedFiles = []; // files attached via @
    this.pastedImages = []; // images pasted/dropped
    this.selectionCheckInterval = null;
    this.lastSelection = "";
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

    // Scroll to top button
    this.scrollTopBtnEl = messagesWrapper.createDiv({ cls: "oc-scroll-btn oc-scroll-top" });
    setIconSafe(this.scrollTopBtnEl, "chevron-up");
    this.scrollTopBtnEl.addEventListener("click", () => {
      this.messagesEl.scrollTo({ top: 0, behavior: "smooth" });
    });

    // Scroll to bottom button
    this.scrollBtnEl = messagesWrapper.createDiv({ cls: "oc-scroll-btn" });
    setIconSafe(this.scrollBtnEl, "chevron-down");
    this.scrollBtnEl.addEventListener("click", () => this.scrollToBottom());

    this.messagesEl.addEventListener("scroll", () => {
      const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
      const atBottom = scrollHeight - scrollTop - clientHeight < 30;
      const atTop = scrollTop < 30;
      this.autoScrollEnabled = atBottom;
      this.scrollBtnEl.toggleClass("visible", !atBottom);
      this.scrollTopBtnEl.toggleClass("visible", !atTop);
    });

    // ---- Input ----
    const inputContainer = container.createDiv({ cls: "oc-input-container" });
    const inputWrapper = inputContainer.createDiv({ cls: "oc-input-wrapper" });

    // Context row (attached files + images + selection)
    this.contextRowEl = inputWrapper.createDiv({ cls: "oc-context-row" });

    // Textarea
    this.inputEl = inputWrapper.createEl("textarea", {
      cls: "oc-input",
      attr: { placeholder: "Message Clawdian... (@ to mention files, / for commands)", rows: "1" }
    });

    this.inputEl.addEventListener("input", () => {
      this.autoResizeInput();
      if (this.mentionPopup) this.mentionPopup.handleInput();
      // Slash command detection
      if (this.slashPopup) this.slashPopup.handleInput(this.inputEl.value);
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
      if (!this.attachedFiles.find(f => f.path === file.path)) {
        this.attachedFiles.push(file);
        this.updateContextRow();
      }
    });

    // Slash command popup
    this.slashPopup = new SlashCommandPopup(this.inputEl, (cmd) => {
      this.inputEl.value = cmd.command + " ";
      this.inputEl.focus();
      this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
    });

    this.inputEl.addEventListener("keydown", (e) => {
      // Slash popup handling
      if (this.slashPopup && this.slashPopup.handleKey(e)) return;
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
      { value: "bailian/MiniMax-M2.5", label: "MiniMax" },
      { value: "openai-codex/gpt-5.4", label: "GPT-5.4" }
    ];
    for (const m of models) {
      const opt = modelSelect.createEl("option", { text: m.label, attr: { value: m.value } });
      if (m.value === this.plugin.settings.selectedModel) opt.selected = true;
    }
    this.modelSelectEl = modelSelect;
    modelSelect.addEventListener("change", async () => {
      const selectedValue = modelSelect.value;
      const selectedLabel = modelSelect.options[modelSelect.selectedIndex].text;
      if (!this.isStreaming) {
        this.inputEl.value = selectedValue ? `/model ${selectedValue}` : `/model default`;
        await this.sendMessage();
        // Persist selected model so it survives restart
        this.plugin.settings.selectedModel = selectedValue;
        await this.plugin.saveSettings();
        new import_obsidian.Notice(`Switching to ${selectedLabel}...`);
      } else {
        new import_obsidian.Notice("Wait for response to finish");
        modelSelect.value = this.plugin.settings.selectedModel || "";
      }
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

    toolbarRight.createDiv({ cls: "oc-send-hint", text: "Enter \u2192 send \u00B7 @ files \u00B7 / cmds" });

    // ---- Initialize ----
    await this.plugin.conversationStore.loadAll();
    const convs = this.plugin.conversationStore.getAllConversations();
    if (convs.length === 0) {
      this.newConversation();
    } else {
      // Restore all conversations as tabs (sorted by updatedAt desc)
      const allIds = convs.map(c => c.id);
      const tabState = this.plugin.settings._tabState;
      // Put previously open tabs first (preserving order), then append any new ones
      const prevTabs = (tabState?.tabs || []).filter(id => allIds.includes(id));
      const remaining = allIds.filter(id => !prevTabs.includes(id));
      this.openTabs = [...prevTabs, ...remaining];
      if (this.openTabs.length === 0) this.openTabs = [convs[0].id];
      const activeId = tabState?.activeId;
      this.switchToConversation(this.openTabs.includes(activeId) ? activeId : this.openTabs[0]);
    }

    this.updateContextRow();
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateContextRow()));

    // Start selection auto-detection (Phase 1, item 4)
    this.startSelectionDetection();
  }

  async onClose() {
    this.stopSelectionDetection();
    if (this.openTabs) {
      this.plugin.settings._tabState = { tabs: this.openTabs, activeId: this.activeConvId };
      await this.plugin.saveSettings();
    }
  }

  // ---- Selection Auto-Detection (Phase 1) ----

  startSelectionDetection() {
    this.selectionCheckInterval = setInterval(() => {
      // When focus is inside the chat panel, freeze selection to preserve the chip
      const activeEl = document.activeElement;
      if (activeEl && this.containerEl && this.containerEl.contains(activeEl)) {
        return; // User is interacting with chat — keep last selection
      }
      const editor = this.getActiveEditor();
      if (!editor) {
        if (this.lastSelection) { this.lastSelection = ""; this.updateContextRow(); }
        return;
      }
      const sel = editor.getSelection() || "";
      if (sel !== this.lastSelection) {
        this.lastSelection = sel;
        this.updateContextRow();
      }
    }, 250);
  }

  stopSelectionDetection() {
    if (this.selectionCheckInterval) {
      clearInterval(this.selectionCheckInterval);
      this.selectionCheckInterval = null;
    }
  }

  getActiveEditor() {
    const leaf = this.app.workspace.activeLeaf;
    if (!leaf || !leaf.view || !leaf.view.editor) return null;
    return leaf.view.editor;
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
    const onKey = (e) => { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); } };
    document.addEventListener("keydown", onKey);
  }

  // ---- Tab Management ----

  get openTabs() { return this._openTabs || []; }
  set openTabs(val) { this._openTabs = val; }

  renderTabs() {
    this.tabBarEl.empty();

    // New Chat button
    const newBtn = this.tabBarEl.createDiv({ cls: "oc-tab-new", attr: { title: "New Chat" } });
    newBtn.createSpan({ text: "+" });
    newBtn.addEventListener("click", () => this.newConversation());

    // Current conversation title (clickable dropdown trigger)
    const activeConv = this.plugin.conversationStore.getConversation(this.activeConvId);
    const titleBtn = this.tabBarEl.createDiv({ cls: "oc-tab-title" });
    const titleLabel = activeConv ? (activeConv.title.length > 24 ? activeConv.title.slice(0, 24) + "\u2026" : activeConv.title) : "New Chat";
    titleBtn.createSpan({ text: titleLabel });
    titleBtn.createSpan({ cls: "oc-tab-arrow", text: "\u25BE" });
    if (this.isStreaming) titleBtn.addClass("streaming");

    titleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleConversationList();
    });

    // Right-click on title for rename/delete
    titleBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!activeConv) return;
      const menu = new import_obsidian.Menu();
      menu.addItem(item => item.setTitle("Rename").setIcon("pencil").onClick(() => {
        new RenameModal(this.app, activeConv.title, (newTitle) => {
          if (newTitle) {
            this.plugin.conversationStore.updateTitle(this.activeConvId, newTitle);
            this.plugin.conversationStore.saveConversation(this.activeConvId);
            this.renderTabs();
          }
        }).open();
      }));
      menu.addSeparator();
      menu.addItem(item => item.setTitle("Delete").setIcon("trash").onClick(() => {
        this.deleteConversation(this.activeConvId);
      }));
      menu.showAtMouseEvent(e);
    });
  }

  toggleConversationList() {
    // Remove existing dropdown if open
    const existing = this.tabBarEl.parentElement.querySelector('.oc-conv-dropdown');
    if (existing) { existing.remove(); return; }

    const allConvs = this.plugin.conversationStore.getAllConversations();
    const header = this.tabBarEl.parentElement;
    header.style.position = 'relative';
    const dropdown = header.createDiv({ cls: "oc-conv-dropdown" });

    for (const conv of allConvs) {
      const item = dropdown.createDiv({ cls: "oc-conv-item" + (conv.id === this.activeConvId ? " active" : "") });

      const info = item.createDiv({ cls: "oc-conv-info" });
      const title = conv.title.length > 30 ? conv.title.slice(0, 30) + "\u2026" : conv.title;
      info.createDiv({ cls: "oc-conv-title", text: title });
      const date = new Date(conv.updatedAt);
      const dateStr = `${date.getMonth()+1}/${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
      const msgCount = conv.messages ? conv.messages.length : 0;
      info.createDiv({ cls: "oc-conv-meta", text: `${dateStr} \u00B7 ${msgCount} msgs` });

      item.addEventListener("click", () => {
        dropdown.remove();
        if (!this.openTabs.includes(conv.id)) this.openTabs = [...this.openTabs, conv.id];
        this.switchToConversation(conv.id);
      });

      // Right-click for rename/delete
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = new import_obsidian.Menu();
        menu.addItem(i => i.setTitle("Rename").setIcon("pencil").onClick(() => {
          new RenameModal(this.app, conv.title, (newTitle) => {
            if (newTitle) {
              this.plugin.conversationStore.updateTitle(conv.id, newTitle);
              this.plugin.conversationStore.saveConversation(conv.id);
              dropdown.remove();
              this.renderTabs();
            }
          }).open();
        }));
        menu.addSeparator();
        menu.addItem(i => i.setTitle("Delete").setIcon("trash").onClick(() => {
          dropdown.remove();
          this.deleteConversation(conv.id);
        }));
        menu.showAtMouseEvent(e);
      });
    }

    // Close dropdown on outside click or Escape
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && !this.tabBarEl.contains(e.target)) {
        dropdown.remove();
        document.removeEventListener("click", closeHandler);
        document.removeEventListener("keydown", escHandler);
      }
    };
    const escHandler = (e) => {
      if (e.key === "Escape") {
        dropdown.remove();
        document.removeEventListener("click", closeHandler);
        document.removeEventListener("keydown", escHandler);
      }
    };
    setTimeout(() => {
      document.addEventListener("click", closeHandler);
      document.addEventListener("keydown", escHandler);
    }, 0);
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
      welcome.createDiv({ cls: "oc-welcome-hint", text: "Enter to send \u00B7 @ to attach files \u00B7 / for commands \u00B7 paste images" });
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

    // Role label (assistant only — user messages are visually distinct via alignment + background)
    if (role === "assistant") {
      msgEl.createDiv({ cls: "oc-role-label", text: "\uD83E\uDD9E Clawdian" });
    } else if (role === "user") {
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

    // Message actions — Claudian style: small icon row, right-aligned
    if (role === "assistant" || role === "user") {
      const actionsEl = msgEl.createDiv({ cls: "oc-message-actions" });

      if (role === "user" && typeof msgIndex === "number") {
        // Edit & resend
        const editBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Edit & resend" } });
        setIconSafe(editBtn, "pencil");
        editBtn.addEventListener("click", () => {
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
          this.plugin.conversationStore.truncateFrom(this.activeConvId, msgIndex);
          this.renderMessages();
          this.resendLastUserMessage();
        });
      }

      // Copy (always last)
      const copyBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Copy" } });
      setIconSafe(copyBtn, "copy");
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(content);
        setIconSafe(copyBtn, "check");
        copyBtn.addClass("copied");
        setTimeout(() => { setIconSafe(copyBtn, "copy"); copyBtn.removeClass("copied"); }, 1500);
      });
    }

    // Navigation arrows — right edge, Claudian style
    const navEl = msgEl.createDiv({ cls: "oc-message-nav" });
    const upBtn = navEl.createEl("button", { cls: "oc-nav-btn", attr: { "aria-label": "Scroll to previous message" } });
    setIconSafe(upBtn, "chevron-up");
    upBtn.addEventListener("click", () => {
      const prev = msgEl.previousElementSibling;
      if (prev) prev.scrollIntoView({ behavior: "smooth", block: "start" });
      else this.messagesEl.scrollTop = 0;
    });
    const downBtn = navEl.createEl("button", { cls: "oc-nav-btn", attr: { "aria-label": "Scroll to next message" } });
    setIconSafe(downBtn, "chevron-down");
    downBtn.addEventListener("click", () => {
      const next = msgEl.nextElementSibling;
      if (next) next.scrollIntoView({ behavior: "smooth", block: "start" });
      else this.scrollToBottom();
    });

    if (this.autoScrollEnabled) this.scrollToBottom();
    return msgEl;
  }

  // ---- Streaming Message ----

  startStreamingMessage() {
    this.streamingEl = this.messagesEl.createDiv({ cls: "oc-message oc-message-assistant" });

    this.thinkingEl = this.streamingEl.createDiv({ cls: "oc-thinking streaming" });
    this.thinkingHeaderEl = this.thinkingEl.createDiv({ cls: "oc-thinking-header expanded" });
    const stBrainIcon = this.thinkingHeaderEl.createSpan({ cls: "oc-think-icon" });
    setIconSafe(stBrainIcon, "brain", "12");
    this.thinkingHeaderEl.createSpan({ text: "Thinking..." });
    this.thinkingContentEl = this.thinkingEl.createDiv({ cls: "oc-thinking-body" });
    this.thinkingContentEl.style.display = "block";
    this.thinkingEl.style.display = "none";

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

    // Add action buttons — Claudian style: regenerate, then copy
    const actionsEl = this.streamingEl.createDiv({ cls: "oc-message-actions" });

    const regenBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Regenerate" } });
    setIconSafe(regenBtn, "refresh-cw");
    regenBtn.addEventListener("click", () => {
      const conv = this.plugin.conversationStore.getConversation(this.activeConvId);
      if (conv) {
        const idx = conv.messages.length - 1;
        this.plugin.conversationStore.truncateFrom(this.activeConvId, idx);
        this.renderMessages();
        this.resendLastUserMessage();
      }
    });

    const copyBtn = actionsEl.createEl("button", { cls: "oc-action-btn", attr: { "aria-label": "Copy" } });
    setIconSafe(copyBtn, "copy");
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(fullText);
      setIconSafe(copyBtn, "check");
      copyBtn.addClass("copied");
      setTimeout(() => { setIconSafe(copyBtn, "copy"); copyBtn.removeClass("copied"); }, 1500);
    });

    // Navigation arrows
    const streamEl = this.streamingEl;
    const navEl = streamEl.createDiv({ cls: "oc-message-nav" });
    const upBtn = navEl.createEl("button", { cls: "oc-nav-btn", attr: { "aria-label": "Scroll up" } });
    setIconSafe(upBtn, "chevron-up");
    upBtn.addEventListener("click", () => {
      const prev = streamEl.previousElementSibling;
      if (prev) prev.scrollIntoView({ behavior: "smooth", block: "start" });
      else this.messagesEl.scrollTop = 0;
    });
    const downBtn = navEl.createEl("button", { cls: "oc-nav-btn", attr: { "aria-label": "Scroll down" } });
    setIconSafe(downBtn, "chevron-down");
    downBtn.addEventListener("click", () => this.scrollToBottom());

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

    // @ mentioned files — large files get reference-only treatment
    if (this.attachedFiles.length > 0) {
      const LARGE_FILE_THRESHOLD = 30000;
      const vaultPath = getVaultBasePath(this.app);
      for (const file of this.attachedFiles) {
        try {
          const fileContent = await this.app.vault.read(file);
          if (fileContent.length > LARGE_FILE_THRESHOLD) {
            // Large file: auto-search with vault_search.py (Direction B)
            const fullPath = vaultPath ? vaultPath + '\\' + file.path.replace(/\//g, '\\') : file.path;
            const charCount = fileContent.length;
            const lineCount = fileContent.split('\n').length;
            let searchResult = '';
            try {
              const { execFileSync } = require('child_process');
              const result = execFileSync('python', [
                'E:\\openclaw-work\\clawdian\\vault_search.py',
                '--query', content,
                '--path', fullPath,
                '--context', '15',
                '--max-chars', '15000'
              ], { encoding: 'utf-8', timeout: 30000 });
              searchResult = result.trim();
            } catch (e) {
              searchResult = '[vault_search 执行失败: ' + (e.message || '').slice(0, 200) + ']';
            }
            if (searchResult && !searchResult.startsWith('[vault_search 执行失败')) {
              contextParts.push(`[大文件附件: ${file.path}]（${charCount} 字符，${lineCount} 行）\n以下是根据用户问题自动搜索到的相关段落：\n\n${searchResult}`);
            } else {
              contextParts.push(`[大文件附件: ${file.path}]（${charCount} 字符，${lineCount} 行）\n${searchResult}\n⚠️ 自动搜索未找到结果或失败。如需手动搜索，请用 exec 执行：\npython E:\\openclaw-work\\clawdian\\vault_search.py --query "关键词" --path "${fullPath}"`);
            }
          } else {
            // Normal file: inline content
            contextParts.push(`[Attached: ${file.path}]\n\`\`\`\n${fileContent}\n\`\`\``);
          }
        } catch (e) {}
      }
      this.attachedFiles = [];
    }

    // Current note — same large file threshold as attachments
    if (this.plugin.settings.includeCurrentNote) {
      const LARGE_FILE_THRESHOLD = 30000;
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile instanceof import_obsidian.TFile && activeFile.extension === "md") {
        if (!activeFile.path.startsWith(this.plugin.settings.conversationsPath || "Clawdian/conversations")) {
          try {
            const noteContent = await this.app.vault.read(activeFile);
            if (noteContent.trim()) {
              if (noteContent.length > LARGE_FILE_THRESHOLD) {
                const cvaultPath = getVaultBasePath(this.app);
                const fullPath = cvaultPath ? cvaultPath + '\\' + activeFile.path.replace(/\//g, '\\') : activeFile.path;
                let searchResult = '';
                try {
                  const { execFileSync } = require('child_process');
                  const result = execFileSync('python', [
                    'E:\\openclaw-work\\clawdian\\vault_search.py',
                    '--query', content,
                    '--path', fullPath,
                    '--context', '15',
                    '--max-chars', '15000'
                  ], { encoding: 'utf-8', timeout: 30000 });
                  searchResult = result.trim();
                } catch (e) {
                  searchResult = '[vault_search 执行失败: ' + (e.message || '').slice(0, 200) + ']';
                }
                if (searchResult && !searchResult.startsWith('[vault_search 执行失败')) {
                  contextParts.push(`[当前查看: ${activeFile.path}]（${noteContent.length} 字符，大文件）\n以下是根据用户问题自动搜索到的相关段落：\n\n${searchResult}`);
                } else {
                  contextParts.push(`[当前查看: ${activeFile.path}]（${noteContent.length} 字符，大文件）\n${searchResult}`);
                }
              } else {
                contextParts.push(`[Currently viewing: ${activeFile.path}]\n\`\`\`\n${noteContent}\n\`\`\``);
              }
            }
          } catch (e) {}
        }
      }
    }

    // Selection context (Phase 1, item 4)
    if (this.lastSelection && this.lastSelection.trim()) {
      contextParts.push(`[Selected text in editor]\n\`\`\`\n${this.lastSelection.slice(0, 4000)}\n\`\`\``);
    }

    if (contextParts.length > 0) userContent += "\n\n" + contextParts.join("\n\n");

    // Capture images before clearing (fix: must snapshot before clearing)
    const messageImages = this.pastedImages.map(img => img.data);

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
    }
    this.pastedImages = [];

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

      // Build API messages with system prompt (Phase 1, item 1)
      const systemPrompt = buildSystemPrompt(this.app);
      const apiMessages = [
        { role: "system", content: systemPrompt },
        ...history.map((m, i) => {
          if (i === history.length - 1 && m.role === "user") {
            return { role: "user", content: apiContent };
          }
          return m;
        })
      ];

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

      // AI title generation (Phase 2, item 7)
      const conv = this.plugin.conversationStore.getConversation(convId);
      if (conv && conv.messages.length === 2 && conv.title.startsWith(content.slice(0, 10))) {
        // First exchange — generate a short title
        this.generateTitle(convId, content);
      }

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

  // ---- AI Title Generation (Phase 2) ----
  async generateTitle(convId, firstMessage) {
    try {
      const title = await this.plugin.api.chatSync(
        `用5个字以内为这段对话起标题：${firstMessage.slice(0, 200)}`,
        "你是标题生成器。只输出标题文字，不加引号、标点或解释。"
      );
      const cleanTitle = title.replace(/["""'']/g, '').trim().slice(0, 20);
      if (cleanTitle && cleanTitle.length > 0) {
        this.plugin.conversationStore.updateTitle(convId, cleanTitle);
        await this.plugin.conversationStore.saveConversation(convId);
        this.renderTabs();
      }
    } catch (e) {
      console.log("Clawdian: Title generation failed (non-critical)", e);
    }
  }

  // ---- Helpers ----

  autoResizeInput() {
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

    // Show selection indicator (Phase 1, item 4)
    if (this.lastSelection && this.lastSelection.trim()) {
      hasContent = true;
      const chip = this.contextRowEl.createDiv({ cls: "oc-context-chip oc-selection-indicator" });
      const preview = this.lastSelection.trim().slice(0, 30) + (this.lastSelection.length > 30 ? "..." : "");
      const selIcon = chip.createSpan({ cls: "oc-context-chip-icon" });
      setIconSafe(selIcon, "type", "12");
      chip.createSpan({ text: ` ${preview}` });
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
    this.inlineEditManager = new InlineEditManager(this);

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

    // Inline Edit command (Phase 2)
    this.addCommand({
      id: "inline-edit", name: "Inline Edit (selection)",
      editorCallback: async (editor) => {
        const selection = editor.getSelection();
        if (!selection) {
          new import_obsidian.Notice("Select text first, or use 'Inline Edit at cursor'");
          return;
        }
        this.inlineEditManager.triggerInlineEdit(false);
      }
    });

    // Inline Edit at cursor (Phase 2)
    this.addCommand({
      id: "inline-edit-cursor", name: "Inline Edit at cursor (insert)",
      editorCallback: async (editor) => {
        this.inlineEditManager.triggerInlineEdit(true);
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
          // Inline edit in context menu
          menu.addItem(item => {
            item.setTitle("Inline Edit with Clawdian")
              .setIcon("wand-2")
              .onClick(() => {
                this.inlineEditManager.triggerInlineEdit(false);
              });
          });
        }
      })
    );

    this.addSettingTab(new ClawdianSettingTab(this.app, this));
    console.log("Clawdian v3.0 loaded \uD83E\uDD9E");
  }

  onunload() {
    if (this.inlineEditManager) {
      this.inlineEditManager.clearWidget();
      this.inlineEditManager.clearDiff();
    }
    console.log("Clawdian unloaded");
  }

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
