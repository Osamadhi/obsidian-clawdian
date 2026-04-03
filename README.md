# 🦞 Clawdian

AI chat assistant for [Obsidian](https://obsidian.md) with deep vault integration.

Works with any **OpenAI-compatible API** — [OpenClaw](https://github.com/nicekate/openclaw), [OpenRouter](https://openrouter.ai), [LM Studio](https://lmstudio.ai), [Ollama](https://ollama.ai), or any self-hosted server.

## Features

- **Streaming chat** with thinking/reasoning display
- **Multi-conversation tabs** with auto-save & AI-generated titles
- **@ file mentions** — attach any vault file as context
- **Inline edit** — edit text directly in the editor with AI (selection or cursor mode)
- **Word-level diff** — see exactly what AI changed before accepting
- **Slash commands** — `/rewrite` `/translate` `/summarize` `/expand` `/fix` `/compact`
- **Custom commands** — define your own prompt templates, access via `/` or right-click menu
- **Usage-frequency sorting** — most-used commands float to the top of the slash menu
- **Current note context** — AI always sees what you're working on
- **Editor selection detection** — select text, then ask about it
- **Image paste & drag-drop** — send screenshots to AI
- **Input history** — press ↑ in the input box to recall previous messages
- **Model switcher** — configure and switch between models
- **Secure token storage** — OS keychain with plaintext fallback
- **Large file search** — optional `vault_search.py` for 30K+ char files

## Quick Start

### 1. Install

Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/nicekate/clawdian/releases).

```
<your-vault>/.obsidian/plugins/clawdian/
├── main.js
├── styles.css
└── manifest.json
```

Enable in Obsidian → Settings → Community plugins.

### 2. Connect your API

Open Settings → Clawdian:

1. **Gateway URL** — your API endpoint
2. **Token** — your API key
3. **Default model** — the model name to use (e.g. `gpt-4o`, `claude-sonnet-4`, `qwen-plus`)
4. Click **Test Connection**

### 3. Add models to the switcher (optional)

In Settings → Clawdian → **Custom models**, add one model per line:

```
gpt-4o|GPT-4o
claude-sonnet-4|Sonnet 4
qwen-plus|Qwen Plus
```

Format: `model-id|Display Name`. These appear in the model dropdown in the chat toolbar.

### 4. Start chatting

Click the 🦞 icon in the sidebar. Done!

## Provider Setup Examples

### OpenRouter

| Setting | Value |
|---------|-------|
| Gateway URL | `https://openrouter.ai/api` |
| Token | Your OpenRouter API key |
| Default model | `anthropic/claude-sonnet-4` |

### LM Studio

| Setting | Value |
|---------|-------|
| Gateway URL | `http://127.0.0.1:1234` |
| Token | `lm-studio` (or leave empty) |
| Default model | Your loaded model name |

### Ollama

| Setting | Value |
|---------|-------|
| Gateway URL | `http://127.0.0.1:11434` |
| Token | (leave empty) |
| Default model | `llama3` |

### OpenClaw Gateway (advanced)

OpenClaw users get the richest experience: tool use, vault file operations, and agent personas.

| Setting | Value |
|---------|-------|
| Gateway URL | `http://127.0.0.1:18789` |
| Token | Your OpenClaw token |
| Default model | `openclaw/obsidian` |
| Scopes header | `operator.admin,operator.read,operator.write` |

**Optional: Create a dedicated Obsidian agent** for best results:

```bash
openclaw agents add obsidian --workspace "<your-vault-path>" --model "your-model"
```

Then place agent configuration files in your vault root. See [`examples/openclaw/`](examples/openclaw/) for templates:
- `AGENTS.md` — agent behavior rules
- `SOUL.md` — personality definition
- `USER.md` — your preferences
- `TOOLS.md` — tool usage guide

## Usage

### Chat

| Action | Key |
|--------|-----|
| Send message | `Enter` |
| New line | `Shift + Enter` |
| Mention a file | Type `@` |
| Slash command | Type `/` |
| Stop generation | Click ■ button |

Hover over any message to see action buttons (edit, regenerate, copy).

### Inline Edit

1. Select text in the editor (or place cursor for insert mode)
2. Run command: `Inline Edit (selection)` or `Inline Edit at cursor`
3. Type your instruction (e.g. "translate to English", "make it concise")
4. Review the word-level diff → **Enter** to accept, **Esc** to reject

### Slash Commands

| Command | Description |
|---------|-------------|
| `/rewrite` | Rewrite the current note |
| `/translate` | Translate selected text |
| `/summarize` | Summarize the current note |
| `/expand` | Expand selected content |
| `/fix` | Fix grammar and spelling |
| `/compact` | Compress conversation history to save tokens |
| `/your-command` | Any custom command you define in settings |

### Commands (Ctrl+P)

| Command | Description |
|---------|-------------|
| Open Clawdian | Open the chat panel |
| New Chat | Start a new conversation |
| Send selection to Clawdian | Send selected text to chat |
| Summarize current note | Generate a summary |
| Ask Clawdian about selection | Ask about selected text |
| Inline Edit (selection) | AI-edit selected text |
| Inline Edit at cursor | AI-insert at cursor |

### Custom Commands

Define your own prompt templates in Settings → Clawdian → **Custom Commands**:

1. Click **+ Add command**
2. Fill in a name (e.g. `polish`) and a prompt (e.g. `Polish the following text: {{text}}`)
3. Toggle **In slash menu** to access it via `/polish`
4. Toggle **In right-click menu** to access it by selecting text and right-clicking

`{{text}}` is replaced with your current selection when the command is triggered.

## Optional: Large File Search

For vaults with large files (30K+ characters), Clawdian can use `vault_search.py` to search relevant passages instead of sending the entire file.

### Setup

1. Copy `tools/vault_search.py` from this repo to anywhere on your machine
2. Install dependencies: `pip install jieba`
3. In Settings → Clawdian → **Vault search script**, enter the full path to the script

When enabled, large files attached via `@` or as current note will be automatically searched for relevant content based on your question.

## All Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Gateway URL | API endpoint URL | `http://127.0.0.1:18789` |
| Token | API authentication key | — |
| Default model | Model name for requests | `openclaw/obsidian` |
| Scopes header | OpenClaw-specific header (leave empty for other providers) | — |
| Custom models | Models for the dropdown switcher (`id\|label` per line) | — |
| Include current note | Auto-attach focused note as context | ✅ |
| Show file actions | Display file action indicators in chat | ✅ |
| Vault search script | Path to `vault_search.py` (optional) | — |
| Conversations folder | Where to store chat history | `Clawdian/conversations` |
| Audit logging | Log all interactions to a file | ❌ |

## Data Storage

| Data | Location |
|------|----------|
| Conversations | `<vault>/Clawdian/conversations/*.json` |
| Markdown export | `<vault>/Clawdian/conversations/md/*.md` |
| Settings | `<vault>/.obsidian/plugins/clawdian/data.json` |
| Audit log | `<vault>/Clawdian/audit-log.md` (if enabled) |

## API Compatibility

Clawdian sends standard OpenAI-format requests to `/v1/chat/completions`. Any compatible API works:

| Provider | Chat | Tool Use | Vault Operations |
|----------|------|----------|-----------------|
| OpenClaw | ✅ | ✅ | ✅ |
| OpenRouter | ✅ | ✅ (model-dependent) | ❌ |
| LM Studio | ✅ | ❌ | ❌ |
| Ollama | ✅ | ❌ | ❌ |

> Tool use and vault operations require a backend that supports function calling AND has file access to your vault. Without these, Clawdian works as a standard chat interface.

## License

MIT — see [LICENSE](LICENSE)

## Credits

Built by Zorba with Claude & Maya.

---

## 中文安装指南

> 给同事看的版本。跟着做，5 分钟装完。

### 第一步：下载插件文件

打开 [最新 Release 页面](https://github.com/nicekate/obsidian-clawdian/releases/latest)，下载这三个文件：

- `main.js`
- `styles.css`
- `manifest.json`

### 第二步：放到 Obsidian 插件目录

在你的 Obsidian Vault 文件夹里，找到（或新建）这个路径：

```
你的Vault/.obsidian/plugins/clawdian/
```

把下载的三个文件放进去。

### 第三步：启用插件

打开 Obsidian → 设置 → 第三方插件 → 已安装插件 → 找到 **Clawdian** → 打开开关。

如果没看到，点一下「刷新」按钮。

### 第四步：填写连接信息

设置 → Clawdian：

| 填什么 | 填哪里 | 示例 |
|--------|--------|------|
| Gateway URL | API 地址 | `http://127.0.0.1:18789` |
| Token | API 密钥 | 找 Zorba 要 |
| Default model | 默认模型 | `openclaw/obsidian` |

填完点 **Test Connection**，显示绿色 ✅ 就成功了。

### 第五步：开始用

左侧边栏点 🦞 龙虾图标，打开 Clawdian，开聊。

**常用操作：**
- `Enter` 发送，`Shift+Enter` 换行
- 输入 `@` + 文件名，把某篇笔记发给 AI
- 在编辑器选中文字，切到 Clawdian 直接问
- 输入 `/` 查看快捷命令

遇到问题先看 [使用手册](https://github.com/nicekate/obsidian-clawdian/blob/main/README.md#usage) 或者找 Zorba。
