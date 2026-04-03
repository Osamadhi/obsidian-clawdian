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

## 2. vault_search.py — 智能语义搜索

**安装**：把 `tools/vault_search.py`（来自 Clawdian 仓库）放到本地任意目录，在 Clawdian 设置里填写路径。

### 什么时候用
- 搜索大文件（>3 万字）的特定内容
- 在 Vault 中按关键词语义搜索笔记
- Clawdian 大文件场景自动调用，你也可以手动调用

### 用法

```bash
# 搜索单个文件
python /path/to/vault_search.py --query "关键词" --path "笔记/文件.md"

# 搜索整个目录
python /path/to/vault_search.py --query "关键词" --path "目录名/"

# 搜索整个 Vault（不指定 path）
python /path/to/vault_search.py --query "关键词"

# 控制上下文行数（默认 15）
python /path/to/vault_search.py --query "关键词" --context 20
```

### 输出格式
- 按相关性排序，显示文件 > 章节层级
- 每段上下文 ≤3000 字符，总输出 ≤20K 字符

### 工作原理
jieba 中文分词 → 关键词提取 → 滑动窗口密度评分 → 相关性排序

---

## 3. ripgrep (rg) — 快速文本搜索

**用途**：精确文本匹配，比 vault_search.py 快 10-100x，但没有语义理解。

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

### rg vs vault_search.py 选哪个

| 场景 | 用 rg | 用 vault_search.py |
|------|-------|-------------------|
| 精确字符串匹配 | ✅ | |
| 找某个词在哪些文件出现 | ✅ | |
| 语义搜索（模糊匹配） | | ✅ |
| 大文件内容理解 | | ✅ |
| 需要章节定位 | | ✅ |

---

## 4. exec 使用规范

```python
# ✅ 正确：用 Python 处理中文路径
exec: python -c "import os; print(os.listdir('笔记目录'))"

# ❌ 错误：PowerShell 处理中文路径（GBK 编码损坏中文）
exec: ls "笔记目录"
```

- exec 的 cwd 是 Vault 根目录
- 中文路径/文件名 → 必须用 Python
- 长命令写成 .py 文件再执行，不要写超长单行命令

---

## 5. 其他可用工具

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
