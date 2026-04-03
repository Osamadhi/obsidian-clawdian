# TOOLS.md - 工具手册

> 你是 OpenClaw obsidian agent，cwd = Vault 根目录。以下是你可用的工具和使用规范。

---

## 1. 文件操作（内置工具）

| 工具 | 用途 | 关键规则 |
|------|------|----------|
| `read` | 读取文件内容 | 用**相对路径**，如 `read("笔记/xxx.md")` |
| `edit` | 精确修改文件 | **修改已有文件必须用 edit**，提供 oldText + newText |
| `write` | 创建新文件 | **仅用于新建文件**，绝不覆盖已有文件 |
| `exec` | 执行命令 | cwd = Vault 根目录，详见下方规范 |

### 路径规则
- ✅ 相对路径：`02-项目/README.md`
- ❌ 绝对路径：`C:\Users\...\vault\02-项目\README.md`
- 文件名含中文时，**exec 必须用 Python，不用 PowerShell**（GBK 编码会损坏中文）

---

## 2. 大文件搜索（内置，自动运行）

Clawdian v3.3+ 已内置搜索引擎。大文件（>3万字符）**不需要你手动搜索**——插件会自动提取相关段落发给你，你直接基于这些段落回答即可。

### 内置搜索特性
- 中文 n-gram 分词 + 关键词提取
- 同义词自动扩展（老婆 → 妻子/爱妻/伴侣 等）
- 标注所在章节/标题

### 无匹配时：用 rg 补充搜索

如果内置搜索没有找到相关内容，系统会提示你用 `rg`：

```bash
# 精确字符串搜索（推荐）
exec: rg -i -F -C 5 "关键词" "文件路径"

# 只看文件名
exec: rg -l "关键词" --type md
```

**策略**：
1. 从用户问题中提取核心关键词（不是整句话）
2. 搜不到时尝试同义词、别称
3. 找到后用 `read` + offset/limit 获取完整上下文

---

## 3. ripgrep (rg) — 快速文本搜索

**适合**：精确字符串匹配、跨文件搜索

```bash
# 搜索关键词（递归、忽略大小写）
rg -i "关键词" --type md

# 搜索特定目录
rg "关键词" "02-项目/" --type md

# 显示上下文（前后各 3 行）
rg -C 3 "关键词" --type md

# 只显示文件名
rg -l "关键词" --type md
```

---

## 4. exec 使用规范

```python
# ✅ 正确：用 Python 处理中文路径
exec: python -c "import os; print(os.listdir('笔记目录'))"

# ❌ 错误：PowerShell 处理中文路径（GBK 编码损坏中文）
exec: ls "笔记目录"
```

- cwd 是 Vault 根目录
- 中文路径/文件名 → 必须用 Python
- 长命令写成 .py 文件再执行

---

## 5. 其他工具

| 工具 | 用途 |
|------|------|
| `web_search` | 搜索互联网 |
| `web_fetch` | 抓取网页内容 |
| `image` | 分析图片 |

---

## 6. 新建文件模板

```markdown
---
title: 标题
date: YYYY-MM-DD
tags: []
status: draft
---

## 正文从二级标题开始
```

- 文件名：`YYYY.MM.DD 标题.md`
- 正文用 `##` 开始，不用 `#`
- 保持 `[[wikilink]]` 和 `#tag` 格式
