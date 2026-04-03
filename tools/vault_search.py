#!/usr/bin/env python3
"""
vault_search.py - 大文件智能搜索工具
用于 Clawdian / OpenClaw 场景下对大型文本文件进行关键词搜索和上下文提取。

用法：
  python vault_search.py --query "问题" --path "文件或文件夹路径"
  python vault_search.py --query "问题" --path "文件夹" --ext md,txt
  python vault_search.py --query "问题" --path "文件" --context 50 --max-chars 30000
"""

import argparse
import os
import re
import subprocess
import shutil
import sys

# jieba lazy load to avoid startup cost when not needed
_jieba = None
def get_jieba():
    global _jieba
    if _jieba is None:
        import jieba
        jieba.setLogLevel(20)  # suppress loading messages
        _jieba = jieba
    return _jieba

# ── 停用词（高频无意义词）──
STOPWORDS = set(
    "的 了 是 在 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 "
    "自己 这 他 她 它 们 那 里 为 什么 怎么 怎样 如何 吗 呢 吧 啊 哦 嗯 哈 "
    "把 被 让 给 用 从 对 与 而 但 如果 因为 所以 虽然 可以 可能 应该 需要 "
    "这个 那个 这些 那些 其他 其它 以及 或者 还是 已经 正在 "
    "the a an is are was were be been being have has had do does did "
    "will would shall should can could may might must need "
    "i you he she it we they me him her us them my your his its our their "
    "this that these those what which who whom how when where why "
    "and or but not no nor so yet for if then than too also very "
    "about after again all am an any at before between both by each few "
    "from further get got had here in into just more most no now of off on "
    "once only other out over own same some still such through to under until up "
    "。 ， ！ ？ ； ： 、 " " ' ' （ ） 《 》 【 】 … — · "
    ". , ! ? ; : \" ' ( ) [ ] { } - _ + = / \\ | ~ ` @ # $ % ^ & * < >"
    .split()
)

# ── 文件扩展名 ──
DEFAULT_EXTENSIONS = {'.md', '.txt', '.markdown', '.text', '.rst', '.org'}


def extract_keywords(query: str, min_len: int = 2) -> list[str]:
    """用 jieba 从查询中提取关键词，去停用词，保留有意义的词。
    优先提取长词（3字以上），这些更能精准定位。"""
    jieba = get_jieba()

    # 先尝试提取长词（search mode 会切出更多组合）
    words_search = list(jieba.cut_for_search(query))
    words_default = list(jieba.cut(query, cut_all=False))

    # 合并两种分词结果，优先长词
    all_words = sorted(set(w.strip() for w in words_search + words_default),
                       key=lambda w: -len(w))

    keywords = []
    seen = set()
    # 先加长词（>=3字符），再加短词
    for w in all_words:
        w = w.strip()
        if len(w) < min_len:
            continue
        if w.lower() in STOPWORDS or w in STOPWORDS:
            continue
        if w.lower() in seen:
            continue
        # 跳过已被更长词完全包含的短词
        if any(w in kw and w != kw for kw in keywords):
            continue
        seen.add(w.lower())
        keywords.append(w)

    # 尝试组合相邻分词为更长的短语（3-6字），如果在原文中存在
    combined = []
    default_words = [w.strip() for w in words_default if w.strip()]
    for i in range(len(default_words) - 1):
        for j in range(i + 1, min(i + 4, len(default_words))):
            phrase = ''.join(default_words[i:j+1])
            if 3 <= len(phrase) <= 8 and phrase in query:
                if phrase.lower() not in seen and phrase.lower() not in STOPWORDS:
                    combined.append(phrase)
                    seen.add(phrase.lower())
    # 长短语优先放前面
    combined.sort(key=lambda w: -len(w))
    result = combined + keywords
    # Limit to top 6 keywords to avoid noise
    return result[:6]


# ── ripgrep 检测 ──
_rg_path = shutil.which('rg')


def _rg_search_hits(filepath: str, keywords: list[str]) -> dict[int, set[str]]:
    """用 ripgrep 搜索文件，返回 {line_idx: set(keywords)} 映射。"""
    hit_lines: dict[int, set[str]] = {}
    for kw in keywords:
        try:
            result = subprocess.run(
                [_rg_path, '--line-number', '--no-heading', '--color', 'never',
                 '-i', '-F', '--', kw, filepath],
                capture_output=True, text=True, encoding='utf-8', errors='replace',
                timeout=30
            )
        except (subprocess.TimeoutExpired, OSError):
            continue
        for line in result.stdout.splitlines():
            # rg output: "LINE_NUM:content"
            colon = line.find(':')
            if colon > 0:
                try:
                    idx = int(line[:colon]) - 1  # 0-indexed
                    if idx not in hit_lines:
                        hit_lines[idx] = set()
                    hit_lines[idx].add(kw)
                except ValueError:
                    continue
    return hit_lines


def _python_search_hits(lines: list[str], keywords: list[str]) -> dict[int, set[str]]:
    """纯 Python 逐行搜索，返回 {line_idx: set(keywords)} 映射。"""
    hit_lines: dict[int, set[str]] = {}
    for kw in keywords:
        pattern = re.compile(re.escape(kw), re.IGNORECASE)
        for idx, line in enumerate(lines):
            if pattern.search(line):
                if idx not in hit_lines:
                    hit_lines[idx] = set()
                hit_lines[idx].add(kw)
    return hit_lines


def search_file(filepath: str, keywords: list[str], context_lines: int = 30,
                max_region_lines: int = 0) -> list[dict]:
    """
    在单个文件中搜索关键词，返回命中区域列表。
    每个区域包含：行范围、命中关键词、文本内容。

    当关键词高频出现导致合并后区域过大时，自动切换为滑动窗口模式，
    选取关键词密度最高的窗口。
    """
    try:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
    except (OSError, PermissionError):
        return []

    if not lines:
        return []

    # Default max_region_lines to 4x context_lines
    if max_region_lines <= 0:
        max_region_lines = max(context_lines * 4, 60)

    # 为每个关键词找到命中行号（优先 ripgrep，回退 Python）
    if _rg_path:
        hit_lines = _rg_search_hits(filepath, keywords)
    else:
        hit_lines = _python_search_hits(lines, keywords)

    if not hit_lines:
        return []

    # 扩展上下文并合并重叠区域
    regions = []
    for idx in sorted(hit_lines.keys()):
        start = max(0, idx - context_lines)
        end = min(len(lines), idx + context_lines + 1)
        kws = hit_lines[idx]
        regions.append({'start': start, 'end': end, 'keywords': kws, 'center': idx})

    # 合并重叠/相邻区域
    merged = []
    for r in regions:
        if merged and r['start'] <= merged[-1]['end']:
            merged[-1]['end'] = max(merged[-1]['end'], r['end'])
            merged[-1]['keywords'] |= r['keywords']
            merged[-1]['centers'].append(r['center'])
        else:
            merged.append({
                'start': r['start'],
                'end': r['end'],
                'keywords': r['keywords'],
                'centers': [r['center']]
            })

    # 对过大的合并区域，用滑动窗口提取密度最高的片段
    final_results = []
    for m in merged:
        region_size = m['end'] - m['start']
        if region_size <= max_region_lines:
            # 正常大小，直接用
            final_results.append(m)
        else:
            # 区域太大，用滑动窗口找密度最高的片段
            windows = _extract_dense_windows(
                lines, hit_lines, m['start'], m['end'],
                window_size=max_region_lines, max_windows=5
            )
            final_results.extend(windows)

    # 构建章节标题索引（向上查找最近的 # 和 ## 标题）
    def find_section_headers(line_idx):
        """从 line_idx 向上查找最近的 # 一级标题和 ## 二级标题"""
        book_title = ''
        chapter_title = ''
        for i in range(line_idx, -1, -1):
            line = lines[i].strip()
            if line.startswith('## ') and not chapter_title:
                chapter_title = line.lstrip('#').strip()
            elif line.startswith('# ') and not line.startswith('## '):
                book_title = line.lstrip('#').strip()
                break  # 一级标题找到即停
        return book_title, chapter_title

    # 构建结果
    results = []
    for m in final_results:
        text_lines = lines[m['start']:m['end']]
        text = ''.join(text_lines)
        book, chapter = find_section_headers(m['start'])
        results.append({
            'file': filepath,
            'line_start': m['start'] + 1,  # 1-indexed
            'line_end': m['end'],
            'keywords': sorted(m['keywords']),
            'hit_count': len(m.get('centers', [])),
            'text': text,
            'book': book,
            'chapter': chapter,
        })

    return results


def _extract_dense_windows(lines: list[str], hit_lines: dict[int, set[str]],
                           region_start: int, region_end: int,
                           window_size: int = 120, max_windows: int = 5) -> list[dict]:
    """
    在一个大区域中用滑动窗口找关键词密度最高的片段。
    优先选择命中关键词种类多的窗口，其次看命中总数。
    窗口之间不重叠。
    """
    # 构建区域内的命中索引
    hits_in_region = {idx: kws for idx, kws in hit_lines.items()
                      if region_start <= idx < region_end}

    if not hits_in_region:
        return []

    # 滑动窗口，步长 = window_size // 2（50%重叠扫描）
    step = max(1, window_size // 2)
    candidates = []
    for ws in range(region_start, region_end - window_size + 1, step):
        we = ws + window_size
        kws_in_window = set()
        centers = []
        for idx, kws in hits_in_region.items():
            if ws <= idx < we:
                kws_in_window |= kws
                centers.append(idx)
        if centers:
            # 评分：关键词种类数 * 1000 + 命中行数
            score = len(kws_in_window) * 1000 + len(centers)
            candidates.append({
                'start': ws, 'end': we,
                'keywords': kws_in_window,
                'centers': centers,
                'score': score
            })

    # 按评分排序，贪心选不重叠的窗口
    candidates.sort(key=lambda c: c['score'], reverse=True)
    selected = []
    for c in candidates:
        if len(selected) >= max_windows:
            break
        # 检查是否与已选窗口重叠
        overlap = False
        for s in selected:
            if c['start'] < s['end'] and c['end'] > s['start']:
                overlap = True
                break
        if not overlap:
            selected.append(c)

    # 按出现顺序排序
    selected.sort(key=lambda c: c['start'])
    return selected


def collect_files(path: str, extensions: set[str]) -> list[str]:
    """收集目标路径下的所有文本文件。"""
    if os.path.isfile(path):
        return [path]

    files = []
    for root, dirs, filenames in os.walk(path):
        # 跳过隐藏目录和常见无关目录
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in
                   ('node_modules', '__pycache__', '.git', '.obsidian')]
        for fn in filenames:
            _, ext = os.path.splitext(fn)
            if ext.lower() in extensions:
                files.append(os.path.join(root, fn))
    return sorted(files)


def format_output(all_results: list[dict], query: str, keywords: list[str],
                  max_chars: int = 20000) -> str:
    """格式化搜索结果，控制总输出长度。"""
    if not all_results:
        return f"未找到与「{query}」相关的内容。\n搜索关键词：{', '.join(keywords)}"

    # 按命中密度排序（命中关键词数 × 命中行数）
    all_results.sort(key=lambda r: (len(r['keywords']), r['hit_count']), reverse=True)

    output_parts = []
    total_chars = 0
    included = 0

    header = f"搜索：{query}\n关键词：{', '.join(keywords)}\n共找到 {len(all_results)} 个相关段落\n"
    output_parts.append(header)
    total_chars += len(header)

    for i, r in enumerate(all_results):
        # 构建来源信息
        source_parts = []
        if r.get('book'):
            source_parts.append(f"📖 {r['book']}")
        if r.get('chapter'):
            source_parts.append(f"📑 {r['chapter']}")
        source_line = ' > '.join(source_parts) if source_parts else r['file']
        section_header = f"\n{'='*60}\n【段落 {i+1}】{source_line}\n行 {r['line_start']}-{r['line_end']} | 命中：{', '.join(r['keywords'])} | 密度：{r['hit_count']} 处\n{'='*60}\n"

        available = max_chars - total_chars - len(section_header) - 200  # 预留尾部
        if available <= 0:
            output_parts.append(f"\n... 还有 {len(all_results) - included} 个段落未显示（已达输出上限）")
            break

        text = r['text']
        # Cap individual paragraph to ~3000 chars for readability
        per_para_max = min(3000, available)
        if len(text) > per_para_max:
            text = text[:per_para_max] + '\n... (段落截断)'

        output_parts.append(section_header + text)
        total_chars += len(section_header) + len(text)
        included += 1

    output_parts.append(f"\n\n已展示 {included}/{len(all_results)} 个段落，共约 {total_chars} 字符")
    return ''.join(output_parts)


def main():
    parser = argparse.ArgumentParser(description='Vault 大文件智能搜索')
    parser.add_argument('--query', '-q', required=True, help='搜索问题（自然语言）')
    parser.add_argument('--path', '-p', required=True, help='文件或文件夹路径')
    parser.add_argument('--ext', default='md,txt', help='文件扩展名，逗号分隔（默认 md,txt）')
    parser.add_argument('--context', '-c', type=int, default=30, help='每个命中点前后扩展行数（默认 30）')
    parser.add_argument('--max-chars', '-m', type=int, default=20000, help='最大输出字符数（默认 20000）')
    parser.add_argument('--keywords', '-k', help='手动指定关键词，逗号分隔（跳过自动提取）')
    args = parser.parse_args()

    # 验证路径
    if not os.path.exists(args.path):
        print(f"错误：路径不存在 - {args.path}", file=sys.stderr)
        sys.exit(1)

    # 提取关键词
    if args.keywords:
        keywords = [k.strip() for k in args.keywords.split(',') if k.strip()]
    else:
        keywords = extract_keywords(args.query)

    if not keywords:
        print(f"无法从问题中提取有效关键词：{args.query}", file=sys.stderr)
        print("提示：使用 --keywords 手动指定关键词", file=sys.stderr)
        sys.exit(1)

    # 收集文件
    extensions = {'.' + e.strip().lstrip('.') for e in args.ext.split(',')}
    files = collect_files(args.path, extensions)
    if not files:
        print(f"未找到匹配的文件（扩展名：{args.ext}）", file=sys.stderr)
        sys.exit(1)

    # 搜索
    all_results = []
    for fp in files:
        results = search_file(fp, keywords, args.context)
        all_results.extend(results)

    # 输出
    output = format_output(all_results, args.query, keywords, args.max_chars)
    print(output)


if __name__ == '__main__':
    main()
