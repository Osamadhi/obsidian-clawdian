/**
 * vault_search.js — Clawdian 内嵌大文件搜索模块
 * 零外部依赖，优先使用 ripgrep，回退纯 JS
 * 
 * 用法（Node.js）:
 *   const { vaultSearch } = require('./vault_search.js');
 *   const result = vaultSearch(query, filePath, { contextLines: 15, maxChars: 20000 });
 * 
 * 用法（CLI）:
 *   node vault_search.js --query "搜索词" --path "文件路径" [--context 15] [--max-chars 20000]
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── 常量 ──

const MAX_OUTPUT_CHARS = 20000;
const DEFAULT_CONTEXT_LINES = 15;
const MAX_PARAGRAPH_CHARS = 3000;
const MAX_RESULTS = 15;
const MAX_COLUMNS = 500; // 同 Claude Code，过滤超长行
const RG_TIMEOUT = 15000; // 15s

// 中文高频停用词（短小精悍，不需要完整停用词表）
const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '被',
  '从', '把', '让', '用', '为', '什么', '怎么', '如何', '可以', '这个',
  '那个', '但是', '因为', '所以', '如果', '虽然', '已经', '还是',
  '或者', '以及', '关于', '通过', '进行', '可能', '需要', '应该',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'can', 'shall',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
  'of', 'in', 'to', 'for', 'with', 'on', 'at', 'from', 'by',
  'and', 'or', 'but', 'not', 'no', 'if', 'then', 'than', 'that', 'this',
]);

// ── ripgrep 检测 ──

let _rgPath = null;
let _rgChecked = false;

function getRgPath() {
  if (_rgChecked) return _rgPath;
  _rgChecked = true;
  try {
    // Windows: where rg / Unix: which rg
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['rg'], {
      encoding: 'utf-8', timeout: 5000, windowsHide: true
    }).trim().split('\n')[0].trim();
    if (result && fs.existsSync(result)) {
      _rgPath = result;
    }
  } catch (_) { /* rg not found */ }
  return _rgPath;
}

// ── 分词：中文 N-gram + 英文空格分词 ──

// 中文语气词/连接词，用于断句
const CN_BREAKS = new Set([
  '的', '了', '在', '是', '和', '与', '或', '也', '都', '把', '被', '让',
  '给', '从', '到', '向', '对', '跟', '比', '而', '但', '又', '还',
  '就', '才', '却', '只', '很', '太', '更', '最', '不', '没', '别',
  '吗', '呢', '吧', '啊', '哦', '嘛', '呀', '哈', '嗯',
  '什么', '怎么', '如何', '哪里', '哪个', '为什么', '怎样',
  '时', '时候', '以后', '之后', '之前', '以前', '中',
]);

/**
 * 从查询中提取搜索关键词
 * 中文：按语气词/连接词断句 → 生成有意义的片段
 * 英文：按空格分词，去停用词
 * 返回去重后的关键词数组（长的在前）
 */
function extractKeywords(query) {
  const keywords = new Set();
  const trimmed = query.trim();

  // 分离中英文
  const englishWords = trimmed.match(/[a-zA-Z]{2,}/g) || [];
  // 提取纯中文字符串（保留连续中文）
  const chineseSegments = trimmed.match(/[\u4e00-\u9fff]+/g) || [];

  for (const seg of chineseSegments) {
    // 整段（如果不太长）
    if (seg.length >= 2 && seg.length <= 8) {
      keywords.add(seg);
    }

    // 按语气词/连接词拆分，同时收集断点信息
    const parts = splitByBreakWordsEx(seg);
    for (const { text, breakAfter } of parts) {
      if (text.length >= 2 && !STOP_WORDS.has(text)) {
        keywords.add(text);
        // 长片段（>=4字）额外生成首尾2字子词，增加召回
        if (text.length >= 4) {
          const head = text.slice(0, 2);
          const tail = text.slice(-2);
          if (!STOP_WORDS.has(head)) keywords.add(head);
          if (!STOP_WORDS.has(tail)) keywords.add(tail);
        }
        // 粘连词：词 + 断词字 → 更长的搜索词（如 "打坐"+"时" → "打坐时"）
        if (breakAfter && text.length + breakAfter.length <= 6) {
          keywords.add(text + breakAfter);
        }
      }
    }
  }

  // 英文：单词级
  for (const w of englishWords) {
    if (!STOP_WORDS.has(w.toLowerCase()) && w.length >= 2) {
      keywords.add(w);
    }
  }

  // 按长度降序排列
  return [...keywords].sort((a, b) => b.length - a.length);
}

// 常见多字词组，不应被断开（断词的例外）
const CN_COMPOUNDS = new Set([
  '怎么办', '怎么样', '什么样', '为什么', '怎么做', '怎么说',
  '是不是', '能不能', '会不会', '有没有', '好不好', '行不行',
  '不知道', '不一样', '不应该', '不可以',
]);

/**
 * 按中文语气词/连接词拆分字符串（增强版，返回断点信息）
 * "打坐时腿疼怎么办" → [{text:"打坐", breakAfter:"时"}, {text:"腿疼", breakAfter:null}, {text:"怎么办", breakAfter:null}]
 */
function splitByBreakWordsEx(text) {
  const results = []; // {text, breakAfter}
  let current = '';
  let lastBreak = null; // 上一个断词字

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // 先检查 3 字复合词（不拆）
    let compoundMatch = false;
    if (i + 2 < text.length) {
      const three = text.slice(i, i + 3);
      if (CN_COMPOUNDS.has(three)) {
        if (current.length >= 2) {
          results.push({ text: current, breakAfter: null });
        }
        current = '';
        results.push({ text: three, breakAfter: null });
        i += 2;
        lastBreak = null;
        compoundMatch = true;
      }
    }
    if (compoundMatch) continue;

    // 检查 2 字断词
    let broke = false;
    if (i + 1 < text.length) {
      const two = text.slice(i, i + 2);
      if (CN_BREAKS.has(two)) {
        if (current.length >= 2) {
          results.push({ text: current, breakAfter: two });
        }
        current = '';
        lastBreak = two;
        i++;
        broke = true;
      }
    }

    if (!broke) {
      // 单字断词
      if (CN_BREAKS.has(char)) {
        if (current.length >= 2) {
          results.push({ text: current, breakAfter: char });
        }
        current = '';
        lastBreak = char;
      } else {
        current += char;
      }
    }
  }

  if (current.length >= 2) results.push({ text: current, breakAfter: null });
  return results;
}

/**
 * 从关键词列表中选出用于 rg 搜索的核心词
 * 策略：先去重（被更长词完全包含的短词跳过），再控制总量
 */
function selectSearchTerms(keywords, maxTerms = 8) {
  if (keywords.length <= maxTerms) return keywords;

  // keywords 已按长度降序排列
  const selected = [];
  for (const kw of keywords) {
    if (selected.length >= maxTerms) break;
    // 跳过被已选更长词完全包含的
    const dominated = selected.some(s => s.includes(kw));
    if (!dominated) selected.push(kw);
  }
  return selected;
}

// ── 搜索引擎 ──

/**
 * 用 ripgrep 搜索文件，返回命中行号集合 Map<lineIdx, Set<keyword>>
 */
function rgSearch(filePath, searchTerms) {
  const rg = getRgPath();
  if (!rg) return null;

  const hitLines = new Map(); // lineIdx -> Set<keyword>

  for (const term of searchTerms) {
    try {
      const result = execFileSync(rg, [
        '--line-number', '--no-heading', '--color', 'never',
        '-i', '-F', '--max-columns', String(MAX_COLUMNS),
        '--', term, filePath
      ], {
        encoding: 'utf-8', timeout: RG_TIMEOUT,
        windowsHide: true, maxBuffer: 10 * 1024 * 1024
      });

      for (const line of result.split('\n')) {
        const colon = line.indexOf(':');
        if (colon > 0) {
          const idx = parseInt(line.slice(0, colon), 10) - 1;
          if (!isNaN(idx) && idx >= 0) {
            if (!hitLines.has(idx)) hitLines.set(idx, new Set());
            hitLines.get(idx).add(term);
          }
        }
      }
    } catch (_) { /* term not found or timeout */ }
  }

  return hitLines;
}

/**
 * 纯 JS 搜索：逐行正则匹配
 */
function jsSearch(lines, searchTerms) {
  const hitLines = new Map();
  const patterns = searchTerms.map(t => ({
    term: t,
    re: new RegExp(escapeRegExp(t), 'i')
  }));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_COLUMNS) continue; // 跳过超长行
    for (const { term, re } of patterns) {
      if (re.test(line)) {
        if (!hitLines.has(i)) hitLines.set(i, new Set());
        hitLines.get(i).add(term);
      }
    }
  }

  return hitLines;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── 密度评分 + 窗口提取 ──

/**
 * 将命中行合并成连续区域，按密度和关键词覆盖度排序
 */
function buildRegions(hitLines, totalLines, contextLines) {
  if (hitLines.size === 0) return [];

  const sortedHits = [...hitLines.keys()].sort((a, b) => a - b);

  // 合并相邻命中行（间距 <= contextLines 的合并为一个区域）
  const mergeGap = contextLines;
  const rawRegions = [];
  let regionStart = sortedHits[0];
  let regionEnd = sortedHits[0];
  let regionKeywords = new Set(hitLines.get(sortedHits[0]));
  let regionHitCount = 1;

  for (let i = 1; i < sortedHits.length; i++) {
    const idx = sortedHits[i];
    if (idx - regionEnd <= mergeGap) {
      // 合并
      regionEnd = idx;
      for (const kw of hitLines.get(idx)) regionKeywords.add(kw);
      regionHitCount++;
    } else {
      // 保存当前区域，开始新的
      rawRegions.push({
        start: regionStart, end: regionEnd,
        keywords: regionKeywords, hitCount: regionHitCount
      });
      regionStart = idx;
      regionEnd = idx;
      regionKeywords = new Set(hitLines.get(idx));
      regionHitCount = 1;
    }
  }
  rawRegions.push({
    start: regionStart, end: regionEnd,
    keywords: regionKeywords, hitCount: regionHitCount
  });

  // 扩展上下文并评分
  return rawRegions.map(r => {
    const ctxStart = Math.max(0, r.start - contextLines);
    const ctxEnd = Math.min(totalLines - 1, r.end + contextLines);
    const span = ctxEnd - ctxStart + 1;
    // 评分：多词共现用指数权重（2词=4, 3词=9, 4词=16）远超单词
    // 惩罚过大的区域
    const sizePenalty = span > 200 ? 0.3 : span > 100 ? 0.6 : 1.0;
    const cooccurrence = r.keywords.size * r.keywords.size; // 指数权重
    const density = (r.hitCount / span) * 10;
    const score = (cooccurrence * 5 + density) * sizePenalty;
    return {
      start: ctxStart,
      end: ctxEnd,
      keywords: r.keywords,
      hitCount: r.hitCount,
      score
    };
  }).sort((a, b) => b.score - a.score);
}

// ── 标题提取 ──

/**
 * 从命中行向上查找最近的 # 和 ## 标题
 */
function findHeadings(lines, lineIdx) {
  let h1 = null; // # 标题（书名级）
  let h2 = null; // ## 标题（章节级）

  for (let i = lineIdx; i >= 0; i--) {
    const line = lines[i].trim();
    if (!h2 && /^## /.test(line)) {
      h2 = line.replace(/^## +/, '');
    }
    if (!h1 && /^# /.test(line) && !/^## /.test(line)) {
      h1 = line.replace(/^# +/, '');
    }
    if (h1 && h2) break;
    // 不要搜太远
    if (lineIdx - i > 500) break;
  }

  if (h1 && h2) return `📖 ${h1} > 📑 ${h2}`;
  if (h1) return `📖 ${h1}`;
  if (h2) return `📑 ${h2}`;
  return null;
}

// ── 格式化输出 ──

function formatOutput(query, keywords, regions, lines, maxChars) {
  const parts = [];
  parts.push(`搜索：${query}`);
  parts.push(`关键词：${keywords.join(', ')}`);
  parts.push(`共找到 ${regions.length} 个相关段落`);
  parts.push('');

  let totalChars = parts.join('\n').length;
  let shown = 0;

  for (const region of regions) {
    if (shown >= MAX_RESULTS) break;

    // 提取段落文本
    const regionLines = lines.slice(region.start, region.end + 1);
    let text = regionLines.join('\n');
    if (text.length > MAX_PARAGRAPH_CHARS) {
      text = text.slice(0, MAX_PARAGRAPH_CHARS) + '\n...（段落截断）';
    }

    // 标题
    const heading = findHeadings(lines, region.start);
    const headingStr = heading ? `${heading}\n` : '';

    const kwList = [...region.keywords].join(', ');
    const block = [
      '=' .repeat(60),
      `【段落 ${shown + 1}】${headingStr}行 ${region.start + 1}-${region.end + 1} | 命中：${kwList} | 密度：${region.hitCount} 处`,
      '='.repeat(60),
      '',
      text,
      ''
    ].join('\n');

    if (totalChars + block.length > maxChars && shown > 0) {
      parts.push(`\n...（已达 ${maxChars} 字符上限，省略剩余 ${regions.length - shown} 个段落）`);
      break;
    }

    parts.push(block);
    totalChars += block.length;
    shown++;
  }

  return parts.join('\n');
}

// ── 主函数 ──

/**
 * @param {string} query - 搜索查询
 * @param {string} filePath - 文件绝对路径
 * @param {object} [options]
 * @param {number} [options.contextLines=15] - 上下文行数
 * @param {number} [options.maxChars=20000] - 输出字符上限
 * @returns {string} 格式化的搜索结果
 */
function vaultSearch(query, filePath, options = {}) {
  const contextLines = options.contextLines || DEFAULT_CONTEXT_LINES;
  const maxChars = options.maxChars || MAX_OUTPUT_CHARS;

  if (!query || !query.trim()) return '';
  if (!fs.existsSync(filePath)) return `文件不存在: ${filePath}`;

  // 提取关键词
  const allKeywords = extractKeywords(query);
  if (allKeywords.length === 0) return '无法从查询中提取有效关键词';

  const searchTerms = selectSearchTerms(allKeywords);

  // 读文件
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // 搜索（优先 rg，回退 JS）
  let hitLines = rgSearch(filePath, searchTerms);
  if (!hitLines || hitLines.size === 0) {
    hitLines = jsSearch(lines, searchTerms);
  }

  if (hitLines.size === 0) {
    return `搜索：${query}\n关键词：${searchTerms.join(', ')}\n未找到相关内容`;
  }

  // 构建区域并排序
  const regions = buildRegions(hitLines, lines.length, contextLines);

  // 格式化输出
  return formatOutput(query, searchTerms, regions, lines, maxChars);
}

// ── CLI 入口 ──

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--query' && args[i + 1]) opts.query = args[++i];
    else if (args[i] === '--path' && args[i + 1]) opts.path = args[++i];
    else if (args[i] === '--context' && args[i + 1]) opts.contextLines = parseInt(args[++i], 10);
    else if (args[i] === '--max-chars' && args[i + 1]) opts.maxChars = parseInt(args[++i], 10);
  }

  if (!opts.query || !opts.path) {
    console.error('Usage: node vault_search.js --query "搜索词" --path "文件路径" [--context 15] [--max-chars 20000]');
    process.exit(1);
  }

  const result = vaultSearch(opts.query, opts.path, {
    contextLines: opts.contextLines,
    maxChars: opts.maxChars
  });
  process.stdout.write(result);
}

// ── 导出 ──

module.exports = { vaultSearch, extractKeywords, getRgPath };
