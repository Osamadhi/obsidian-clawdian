# TOOLS.md - Tool Reference

> Available tools for the OpenClaw obsidian agent. Place in your vault root.

## File Operations

| Tool | Usage | Rules |
|------|-------|-------|
| `read` | Read file content | Use **relative paths**: `read("notes/file.md")` |
| `edit` | Modify existing file | Provide oldText + newText. **Never use write to modify existing files** |
| `write` | Create new file | **Only for new files** |
| `exec` | Run commands | cwd = vault root |

## Path Rules

- ✅ Relative: `02-Projects/readme.md`
- ❌ Absolute: `C:\Users\me\vault\02-Projects\readme.md`

## Optional: vault_search.py

If installed, use for searching large files:

```bash
python "<path-to-vault_search.py>" --query "keyword" --path "file.md"
```

## New File Template

```markdown
---
title: Title
date: YYYY-MM-DD
tags: []
status: draft
---

## Content starts here
```
