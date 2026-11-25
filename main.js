'use strict';

const { Plugin, MarkdownView, Notice } = require('obsidian');

/**
 * 一条键位对应一个动作。
 * type 'text'：插入文本。caretBack 表示插完光标回退几个字符。
 * type 'line'：跨行跳转。delta 是行偏移；where 'start' = 第 0 列（# 这类 Markdown 标记之前），
 *              'end' = 该行最后一个字符之后。已经到头（首行/末行）时原地不动。
 */
const ACTIONS = {
  q: { name: '插入 #', type: 'text', text: '#' },
  w: { name: '插入 *（选中文字时两侧包裹）', type: 'text', text: '*', wrap: true },
  e: { name: '插入 **（选中文字时两侧包裹）', type: 'text', text: '**', wrap: true },
  k: { name: '跳到下一行行首', type: 'line', delta: 1, where: 'start' },
  l: { name: '跳到下一行行尾', type: 'line', delta: 1, where: 'end' },
  o: { name: '跳到上一行行首', type: 'line', delta: -1, where: 'start' },
  p: { name: '跳到上一行行尾', type: 'line', delta: -1, where: 'end' },
};

/** 把 anchor/head 排成前→后 */
function toRange(sel) {
  const a = sel.anchor;
  const h = sel.head;
  const forward = a.line < h.line || (a.line === h.line && a.ch <= h.ch);
  return forward ? { from: a, to: h } : { from: h, to: a };
}

/**
 * 插入符号。
 * 有选区且 action.wrap 为真：在选区两侧各补一个符号（123 → *123*），
 * 原文保留，插完仍选中原文，接着按另一个键就能叠加。
 * 单光标、无选区仍走 replaceSelection（最基础、最稳的编辑器 API）。
 * 早先用的 editor.transaction 在部分 Obsidian 版本上不生效，所以不用它。
 */
function insertSymbol(editor, action) {
  const text = action.text;
  const back = action.caretBack || 0;
  const ranges = editor
    .listSelections()
    .map(toRange)
    .sort((a, b) => b.from.line - a.from.line || b.from.ch - a.from.ch);

  const isEmpty = (r) => r.from.line === r.to.line && r.from.ch === r.to.ch;

  // 单光标、无选区：最基础的一条路径，交给编辑器自己处理
  if (ranges.length === 1 && isEmpty(ranges[0])) {
    editor.replaceSelection(text);
    if (back > 0) {
      const cur = editor.getCursor();
      editor.setCursor({ line: cur.line, ch: Math.max(0, cur.ch - back) });
    }
    return;
  }

  // 从后往前改，记下每条选区插完后的落点；后面（位置更靠前）的插入会让这些落点整体后移
  const results = [];

  /** 在 [from,to) 前插了 text 之后，已记录的位置要挪多少 */
  const shift = (pos, from, to, empty) => {
    if (from.line === to.line) {
      if (pos.line !== from.line) return pos;
      if (!empty && pos.ch >= to.ch) return { line: pos.line, ch: pos.ch + 2 * text.length };
      if (pos.ch >= from.ch) return { line: pos.line, ch: pos.ch + text.length };
      return pos;
    }
    let ch = pos.ch;
    if (pos.line === from.line && ch >= from.ch) ch += text.length;
    if (pos.line === to.line && ch >= to.ch) ch += text.length;
    return ch === pos.ch ? pos : { line: pos.line, ch };
  };

  for (const r of ranges) {
    const empty = isEmpty(r);
    let next;

    if (empty) {
      editor.replaceRange(text, r.from, r.from);
      const caret = { line: r.from.line, ch: Math.max(0, r.from.ch + text.length - back) };
      next = { anchor: caret, head: caret };
    } else if (action.wrap) {
      // 先补右边再补左边；右边用原坐标，左边那条还在它前面
      editor.replaceRange(text, r.to, r.to);
      editor.replaceRange(text, r.from, r.from);
      next = {
        anchor: { line: r.from.line, ch: r.from.ch + text.length },
        head: { line: r.to.line, ch: r.to.ch + text.length },
      };
    } else {
      // 不包裹的动作（#）：插在选区开头，不覆盖选中的文字
      editor.replaceRange(text, r.from, r.from);
      const caret = { line: r.from.line, ch: r.from.ch + text.length };
      next = { anchor: caret, head: caret };
    }

    for (const done of results) {
      done.anchor = shift(done.anchor, r.from, r.to, empty);
      done.head = shift(done.head, r.from, r.to, empty);
    }
    results.push(next);
  }

  editor.setSelections(
    results
      .sort((a, b) => a.anchor.line - b.anchor.line || a.anchor.ch - b.anchor.ch)
      .map((sel) => ({ anchor: sel.anchor, head: sel.head }))
  );
}

/** 跨行跳转，支持多光标；有选区时按行进方向取选区的远端（向下=底部，向上=顶部） */
function jumpLine(editor, action) {
  const selections = [];
  let changed = false;

  for (const sel of editor.listSelections()) {
    const lastLine = editor.lastLine();
    const range = toRange(sel);
    // 向下跳从选区的最后一行算，向上跳从选区的第一行算，
    // 否则往上选一段再按 Alt+K，会从选区顶部往下跳，落进选区里
    const base = action.delta > 0 ? range.to : range.from;
    const target = base.line + action.delta;

    if (target < 0) {
      // 已经在第一行，往上没地方去，这条选区原样不动
      selections.push({ anchor: sel.anchor, head: sel.head });
      continue;
    }

    if (target > lastLine) {
      // 已经在最后一行，往下没地方去：在文末补一行，相当于按 Enter
      const end = { line: lastLine, ch: editor.getLine(lastLine).length };
      editor.replaceRange('\n', end, end);
      const pos = { line: lastLine + 1, ch: 0 };
      selections.push({ anchor: pos, head: pos });
      changed = true;
      continue;
    }

    const ch = action.where === 'start' ? 0 : editor.getLine(target).length;
    const pos = { line: target, ch };
    selections.push({ anchor: pos, head: pos });
    changed = true;
  }

  if (changed) editor.setSelections(selections);
}

/**
 * Alt+D 在当前行上的两个阶段：
 * 1) 行里还有内容 → 清空内容，行保留（变成空行），光标回到行首
 * 2) 行已经是空行 → 连这一行一起删掉（中间行删换行，末行删前一个换行）
 * 只有整篇文档只剩一个空行时才是原地不动。
 */
function handleCurrentLine(editor) {
  const lines = [...new Set(editor.listSelections().map((sel) => sel.head.line))].sort(
    (a, b) => b - a
  );

  const carets = [];

  for (const line of lines) {
    const text = editor.getLine(line);
    const lastLine = editor.lastLine();

    if (text.length > 0) {
      editor.replaceRange('', { line, ch: 0 }, { line, ch: text.length });
      carets.push({ line, ch: 0 });
    } else if (line < lastLine) {
      editor.replaceRange('', { line, ch: 0 }, { line: line + 1, ch: 0 });
      carets.push({ line, ch: 0 });
    } else if (line > 0) {
      const prevLen = editor.getLine(line - 1).length;
      editor.replaceRange('', { line: line - 1, ch: prevLen }, { line, ch: 0 });
      carets.push({ line: line - 1, ch: prevLen });
    } else {
      carets.push({ line: 0, ch: 0 });
    }
  }

  // 多光标 Alt+D 之前只保住最后一个光标，这里把每条选区的落点都放回去
  const last = editor.lastLine();
  const seen = new Set();
  const unique = carets
    .map((pos) => {
      const at = Math.min(pos.line, last);
      return { line: at, ch: Math.min(pos.ch, editor.getLine(at).length) };
    })
    .filter((pos) => {
      const key = pos.line + ':' + pos.ch;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line || a.ch - b.ch);

  editor.setSelections(unique.map((pos) => ({ anchor: pos, head: pos })));
}

/** 光标前一个字符的起点；代理对（emoji 等）算一个字符 */
function charStartBefore(text, ch) {
  let i = ch - 1;
  const code = text.charCodeAt(i);
  if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
    const prev = text.charCodeAt(i - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) i -= 1;
  }
  return i;
}

/** 光标处字符的终点；代理对算一个字符 */
function charEndAfter(text, ch) {
  let i = ch + 1;
  const code = text.charCodeAt(ch);
  if (code >= 0xd800 && code <= 0xdbff && i < text.length) {
    const next = text.charCodeAt(i);
    if (next >= 0xdc00 && next <= 0xdfff) i += 1;
  }
  return i;
}

/**
 * 选区活动端（head）左右挪一个字符，锚点留在原地，相当于按住鼠标往左/右拖。
 * dir = -1 向左，1 向右。不跨行：到行首/行尾就停。
 */
function extendSelection(editor, dir) {
  const next = [];
  let changed = false;

  for (const sel of editor.listSelections()) {
    const head = sel.head;
    const text = editor.getLine(head.line);
    let ch = head.ch;

    if (dir < 0) {
      if (ch > 0) ch = charStartBefore(text, ch);
    } else if (ch < text.length) {
      ch = charEndAfter(text, ch);
    }

    if (ch === head.ch) {
      next.push(sel);
    } else {
      next.push({ anchor: sel.anchor, head: { line: head.line, ch } });
      changed = true;
    }
  }

  if (changed) editor.setSelections(next);
}

/**
 * 找光标所在的 [[ ... ]] 结构。
 * 光标在链接里、或紧贴在 ]] 右边（Obsidian 的候选补全可能把光标推出去）都算命中。
 */
function currentLink(editor) {
  const cur = editor.getCursor();
  const text = editor.getLine(cur.line);
  const open = text.lastIndexOf('[[', cur.ch);
  if (open < 0) return null;
  const found = text.indexOf(']]', open + 2);
  const close = found < 0 ? text.length : found; // 还没闭合时把行尾当链接尾
  if (cur.ch < open + 2) return null;
  return {
    line: cur.line,
    open,
    close,
    inner: text.slice(open + 2, close),
  };
}

/**
 * 按链接当前长相决定下一步，返回是否继续会话。
 * 不依赖会话里的 step：候选补全会把 [[]] 直接补成 [[路径|别名]]，
 * 这种时候光看“写到哪一步”会错，只能看链接现在长什么样。
 */
function advanceLink(editor) {
  const link = currentLink(editor);
  if (!link) return false;

  const { line, open, inner } = link;
  const bar = inner.indexOf('|');
  const nameEnd = bar >= 0 ? bar : inner.length;
  const namePart = inner.slice(0, nameEnd);
  const aliasPart = bar >= 0 ? inner.slice(bar + 1) : null;
  const hash = namePart.indexOf('#');

  const typeAt = (offset, text) => {
    const pos = { line, ch: open + 2 + offset };
    editor.replaceRange(text, pos, pos);
    editor.setCursor({ line, ch: pos.ch + text.length });
  };
  const dropAt = (offset) => {
    const pos = { line, ch: open + 2 + offset };
    editor.replaceRange('', pos, { line, ch: pos.ch + 1 });
    editor.setCursor(pos);
  };
  const jumpOut = () => {
    const text = editor.getLine(line);
    const o = text.lastIndexOf('[[', editor.getCursor().ch);
    const c = o >= 0 ? text.indexOf(']]', o + 2) : -1;
    editor.setCursor({ line, ch: c >= 0 ? c + 2 : text.length });
  };

  // 名字还空着：Tab 不推进
  if (namePart.length === 0) return true;

  if (bar < 0) {
    // 还没有别名
    if (hash < 0) {
      typeAt(nameEnd, '#'); // 名字写完 → 补 #
      return true;
    }
    if (namePart.length === hash + 1) {
      dropAt(hash); // # 后面没写 → 删掉，改补 |
      typeAt(hash, '|');
      return true;
    }
    typeAt(nameEnd, '|'); // 标题写了 → 补 |
    return true;
  }

  // 已经有别名（候选补全常常直接给 [[路径|别名]]）
  if (hash < 0) {
    if (aliasPart.length > 0) {
      typeAt(bar, '#'); // 在 | 前补 #
      return true;
    }
    dropAt(bar); // 别名为空 → 删 | 走人
    jumpOut();
    return false;
  }

  if (namePart.length === hash + 1) {
    dropAt(hash); // # 空着 → 删掉
  }
  jumpOut();
  return false;
}

/**
 * 光标紧贴成对符号的右半边时，Tab 越过它（LaTeX Suite 在数学里那种手感）。
 * 认半角 ) 和半角引号 " '；引号额外要求左边不是空白，免得把行首/空格后的引号也跳过。
 * 有选区或多个光标时一律不动。
 */
function escapeClosing(editor) {
  const sels = editor.listSelections();
  if (sels.length !== 1) return false;

  const sel = sels[0];
  if (sel.anchor.line !== sel.head.line || sel.anchor.ch !== sel.head.ch) return false;

  const cursor = sel.head;
  const line = editor.getLine(cursor.line);
  const next = line.charAt(cursor.ch);
  const prev = cursor.ch > 0 ? line.charAt(cursor.ch - 1) : '';

  const closing =
    next === ')' ||
    ((next === '"' || next === "'") && (prev === next || (prev !== '' && !/\s/.test(prev))));

  if (!closing) return false;

  editor.setCursor({ line: cursor.line, ch: cursor.ch + 1 });
  return true;
}

/** Alt+Enter：在光标行与下一行之间插一个空行，光标落到空行行首 */
function insertBlankLineBelow(editor) {
  const cur = editor.getCursor('head');
  const lineLen = editor.getLine(cur.line).length;
  editor.replaceRange('\n', { line: cur.line, ch: lineLen });
  editor.setCursor({ line: cur.line + 1, ch: 0 });
}

/**
 * 显示宽度：CJK、全角标点、emoji 占两列；组合符和零宽字符不占列。
 * 列对齐的宽度全靠它，不能用 String.length —— 一个汉字在 UTF-16 里长度是 1，显示占 2。
 */
function charWidth(cp) {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfe0f) return 0;
  return 1;
}

function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0));
  return width;
}

/** 把 Tab 展开成固定宽度（按 4 的列位对齐）；行首缩进不调用它，原样保留 */
function expandTabs(text, tabSize = 4) {
  if (text.indexOf('\t') < 0) return text;
  let out = '';
  let col = 0;
  for (const ch of text) {
    if (ch === '\t') {
      const n = tabSize - (col % tabSize);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col += charWidth(ch.codePointAt(0));
    }
  }
  return out;
}

/**
 * 列对齐：按行切分，每行按空白分词，逐列取最宽 token 补空格。
 * 空行、纯空白行原样保留；行首缩进保留；连续空白算一个分隔符；
 * 最后一列不补尾随空格；列数少的行不补空列。
 */
function alignText(text, tabSize = 4) {
  const lines = text.split('\n');
  const rows = lines.map((raw) => {
    const head = /^([ \t]*)([\s\S]*)$/.exec(raw);
    const indent = head[1];
    const body = head[2].replace(/[ \t]+$/, '');
    if (!body) return { blank: true, indent, tokens: [] };
    return {
      blank: false,
      indent,
      tokens: body.split(/[ \t]+/).map((token) => expandTabs(token, tabSize)),
    };
  });

  const widths = [];
  for (const row of rows) {
    if (row.blank) continue;
    row.tokens.forEach((token, i) => {
      const width = displayWidth(token);
      if (!widths[i] || width > widths[i]) widths[i] = width;
    });
  }

  return lines
    .map((raw, i) => {
      const row = rows[i];
      if (row.blank) return raw;
      let out = row.indent;
      row.tokens.forEach((token, j) => {
        out += token;
        if (j < row.tokens.length - 1) {
          out += ' '.repeat(widths[j] - displayWidth(token) + 1);
        }
      });
      return out;
    })
    .join('\n');
}

/** 选区按偏移量排序、合并重叠或首尾相接的段，返回 {from,to} */
function mergeRanges(editor, ranges) {
  const spans = [];
  for (const range of ranges) {
    const from = range.from || range.anchor;
    const to = range.to || range.head;
    let a = editor.posToOffset(from);
    let b = editor.posToOffset(to);
    if (a > b) {
      const swap = a;
      a = b;
      b = swap;
    }
    if (b > a) spans.push([a, b]);
  }
  spans.sort((x, y) => x[0] - y[0]);

  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged.map(([a, b]) => ({ from: editor.offsetToPos(a), to: editor.offsetToPos(b) }));
}

/** 区间差集：从 base 里挖掉 cut。一段被切中会裂成左右两段，空段丢掉 */
function subtractRanges(editor, base, cut) {
  const cutSpan = mergeRanges(editor, [cut]).length ? mergeRanges(editor, [cut])[0] : null;
  if (!cutSpan) return mergeRanges(editor, base);
  const a = editor.posToOffset(cutSpan.from);
  const b = editor.posToOffset(cutSpan.to);

  const pieces = [];
  for (const range of mergeRanges(editor, base)) {
    const s = editor.posToOffset(range.from);
    const e = editor.posToOffset(range.to);
    if (b <= s || a >= e) {
      pieces.push({ from: editor.offsetToPos(s), to: editor.offsetToPos(e) });
      continue;
    }
    if (s < a) pieces.push({ from: editor.offsetToPos(s), to: editor.offsetToPos(a) });
    if (b < e) pieces.push({ from: editor.offsetToPos(b), to: editor.offsetToPos(e) });
  }
  return mergeRanges(editor, pieces);
}

/** 用一段新文本替换 [fromLine, toLine] 整行范围（不含两端换行符） */
function replaceLineSpan(editor, fromLine, toLine, lines) {
  editor.replaceRange(
    lines.join('\n'),
    { line: fromLine, ch: 0 },
    { line: toLine, ch: editor.getLine(toLine).length }
  );
}

/** 选中整行（不含换行符） */
function selectLine(editor, line) {
  const range = { from: { line, ch: 0 }, to: { line, ch: editor.getLine(line).length } };
  editor.setSelection(range.from, range.to);
  try {
    editor.scrollIntoView(range, true);
  } catch (e) {
    /* ignore */
  }
}

/** 对调两行，中间的行原样带过去 */
function swapLines(editor, lineA, lineB) {
  if (lineA === lineB) return false;
  const last = editor.lastLine();
  if (lineA < 0 || lineB < 0 || lineA > last || lineB > last) return false;
  const from = Math.min(lineA, lineB);
  const to = Math.max(lineA, lineB);
  const middle = [];
  for (let i = from + 1; i < to; i += 1) middle.push(editor.getLine(i));
  replaceLineSpan(editor, from, to, [editor.getLine(to), ...middle, editor.getLine(from)]);
  return true;
}

/**
 * 把 [fromLine, toLine] 整块剪切，插到 targetLine 的下一行。
 * 整段只用一次 replaceRange，两次编辑会让后一次的坐标漂移。
 * 返回移动后的起始行号；目标在源块里（或本来就在下面）返回 null。
 */
function moveLineBlock(editor, fromLine, toLine, targetLine) {
  const last = editor.lastLine();
  if (fromLine < 0 || toLine > last || targetLine < 0 || targetLine > last) return null;
  if (fromLine > toLine) return null;
  if (targetLine >= fromLine && targetLine <= toLine) return null;
  if (targetLine === fromLine - 1) return null;

  const all = editor.getValue().split('\n');
  const block = all.slice(fromLine, toLine + 1);
  all.splice(fromLine, block.length);
  const dest = targetLine > toLine ? targetLine - block.length : targetLine;
  all.splice(dest + 1, 0, ...block);

  const low = Math.min(fromLine, targetLine);
  const high = Math.max(toLine, targetLine);
  editor.replaceRange(
    all.slice(low, high + 1).join('\n'),
    { line: low, ch: 0 },
    { line: high, ch: editor.getLine(high).length }
  );
  return dest + 1;
}
class AltQuickKeys extends Plugin {
  async onload() {
    // 7 个键挂成 Obsidian 命令，带默认 Alt 热键；设置 → 快捷键里能看到、能改
    for (const [key, action] of Object.entries(ACTIONS)) {
      this.addCommand({
        id: `alt-${key}-${action.type === 'text' ? 'insert' : 'jump'}`,
        name: action.name,
        hotkeys: [{ modifiers: ['Alt'], key: key.toUpperCase() }],
        // Obsidian 的快捷键调度默认丢掉按住时的重复 keydown（onTrigger 里只有
        // repeatable 的命令才会继续执行）。标上 repeatable，按住 Alt+K/L/O/P
        // 不放时系统连发几次 keydown，就连续跳几行，不用反复按。
        repeatable: action.type === 'line',
        editorCallback: (editor) => {
          if (action.type === 'text') insertSymbol(editor, action);
          else jumpLine(editor, action);
        },
      });
    }

    // Alt+T：选中多行，按空白分词后逐列对齐（中文按两列算）
    this.addCommand({
      id: 'alt-t-align-columns',
      name: '选中多行按列对齐',
      hotkeys: [{ modifiers: ['Alt'], key: 'T' }],
      editorCallback: (editor) => this.alignSelection(editor),
    });

    // 逗号/句号：按住 Alt 逐字扩选；标 repeatable 才能按住连选
    this.addCommand({
      id: 'alt-comma-extend-left',
      name: '向左扩选一个字',
      hotkeys: [{ modifiers: ['Alt'], key: ',' }],
      repeatable: true,
      editorCallback: (editor) => extendSelection(editor, -1),
    });

    this.addCommand({
      id: 'alt-period-extend-right',
      name: '向右扩选一个字',
      hotkeys: [{ modifiers: ['Alt'], key: '.' }],
      repeatable: true,
      editorCallback: (editor) => extendSelection(editor, 1),
    });

    // Alt+M：插入链接模板，之后用 Tab 逐段填（名字 → #标题/块 → |别名 → 跳出）
    // 键位由下面的 keydown 裸处理，命令只留在命令面板里
    this.addCommand({
      id: 'alt-m-link-template',
      name: '插入链接模板（Tab 逐段填充）',
      editorCallback: (editor) => this.startLink(editor),
    });

    // Alt+- / Alt+=：走 Obsidian 自己的历史记录，等价于“后退 / 前进”
    // 跳完再把上一篇的滚动位置还原回去，不然 Obsidian 会按光标位置重新对齐
    this.addCommand({
      id: 'alt-minus-go-back',
      name: '返回原界面（后退）',
      hotkeys: [{ modifiers: ['Alt'], key: '-' }],
      callback: () => this.goWithScroll('app:go-back'),
    });

    this.addCommand({
      id: 'alt-equal-go-forward',
      name: '返回跳转界面（前进）',
      hotkeys: [{ modifiers: ['Alt'], key: '=' }],
      callback: () => this.goWithScroll('app:go-forward'),
    });

    // 记录每篇笔记的滚动位置，返回时用
    this.scrollMemory = new Map();
    const onScroll = (ev) => this.onScroll(ev);
    document.addEventListener('scroll', onScroll, true);
    this.register(() => document.removeEventListener('scroll', onScroll, true));

    // 鼠标悬停在双链上时，轻按一下 Alt 直接跳过去
    this.altTap = null;
    this.pointer = null;

    // 双击 Alt 记下的「整行」；Alt+S 搬它，再双击 Alt 拿它和当前行对调
    this.linePick = null;
    // 上一次干净的 Alt 抬起时间，用来判双击 Alt
    this.lastCleanAltUp = 0;
    // 延迟执行的链接跳转（给双击 Alt 留判定窗口）
    this.pendingJump = 0;
    // Alt+< / Alt+> 的连按记录
    this.angleTap = null;
    // Alt/Shift 拖动状态
    this.drag = null;
    this.suppressClickUntil = 0;
    const onMouseMove = (ev) => this.onMouseMove(ev);
    document.addEventListener('mousemove', onMouseMove, true);
    this.register(() => document.removeEventListener('mousemove', onMouseMove, true));

    this.linkSession = false;

    // ---- Alt+D：输入法里有未上屏内容就清掉它，有内容就清空、空行就删掉这一行 ----
    // 这个键要区分输入法状态，Obsidian 的快捷键在组合期间又会被跳过，只能裸拦 keydown
    this.composition = null; // { field, text }
    this.pending = null; // { text, field, editor, tries }

    this.registerDomEvent(
      document,
      'compositionstart',
      (ev) => this.onCompositionStart(ev),
      true
    );
    this.registerDomEvent(
      document,
      'compositionupdate',
      (ev) => this.onCompositionUpdate(ev),
      true
    );
    this.registerDomEvent(
      document,
      'compositionend',
      () => {
        this.composition = null;
      },
      true
    );
    // 直接挂原生捕获监听：registerDomEvent 的 capture 参数在某些版本里不生效，
    // 那样 Tab 会先被 Obsidian/CodeMirror 处理掉，插件永远收不到。
    const onKeyDown = (ev) => this.onKeyDown(ev);
    const onKeyUp = (ev) => this.onKeyUp(ev);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    this.register(() => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    });

    // ---- Alt 拖动累加 / Shift 拖动减选 ----
    // 必须在捕获阶段先接管：CodeMirror 自己在 mousedown 时就会重设选区，
    // 晚一步拿到事件的话，原来的多段选区已经被它清掉了。
    const onMouseDown = (ev) => this.onDragStart(ev);
    const onMouseUp = (ev) => this.onDragEnd(ev);
    const onClick = (ev) => {
      if (Date.now() < this.suppressClickUntil) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    const onSelectStart = (ev) => {
      if (this.drag) ev.preventDefault();
    };
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('click', onClick, true);
    const onBlur = () => {
      this.drag = null; // 焦点被系统抢走时松手事件收不到，别让拖动状态挂着
    };
    window.addEventListener('blur', onBlur, true);
    window.addEventListener('selectstart', onSelectStart, true);
    this.register(() => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('selectstart', onSelectStart, true);
      window.removeEventListener('blur', onBlur, true);
    });

    // 记下的整行被编辑过就作废，免得 Alt+S / 双击 Alt 拿旧行号去搬现在的行
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor) => {
        const pick = this.linePick;
        if (!pick) return;
        if (pick.line > editor.lastLine() || editor.getLine(pick.line) !== pick.text) {
          this.linePick = null;
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.linePick = null;
      })
    );
  }

  onunload() {
    this.composition = null;
    this.pending = null;
    this.linkSession = false;
    this.altTap = null;
    this.linePick = null;
    this.drag = null;
    if (this.pendingJump) window.clearTimeout(this.pendingJump);
    this.pendingJump = 0;
  }

  /** 只记坐标，解析留到真要跳转时再做 */
  onMouseMove(ev) {
    this.pointer = { x: ev.clientX, y: ev.clientY };
    if (this.drag) this.dragMove(ev);
  }

  /**
   * 找到鼠标下的双链。
   * 第一步先用 DOM 卡“鼠标是不是真的压在链接上”——不能只看坐标落在这一行，
   * 否则同一行链接旁边的空白也会被当成链接。
   * 实时预览的双链是 span（cm-hmd-internal-link），DOM 上没有目标地址，
   * 所以认出链接后再用 CodeMirror 的 posAtCoords 回到源码里解析 [[...]]；
   * 阅读模式的 a.internal-link 带 href，直接用。
   */
  linkAtPointer() {
    const point = this.pointer;
    if (!point) return null;

    const el = document.elementFromPoint(point.x, point.y);
    const linkEl =
      el instanceof Element
        ? el.closest('.cm-hmd-internal-link, a.internal-link, .internal-link, [data-href]')
        : null;
    if (!linkEl) return null;
    if (linkEl.classList.contains('is-unresolved')) return null;

    const direct = linkEl.getAttribute('data-href') || linkEl.getAttribute('href');
    if (direct) return { href: direct };

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const cm = view && view.editor ? view.editor.cm : null;
    if (!cm || !cm.state || typeof cm.posAtCoords !== 'function') return null;

    let offset = null;
    try {
      offset = cm.posAtCoords({ x: point.x, y: point.y });
    } catch (e) {
      offset = null;
    }
    if (offset == null) return null;

    const line = cm.state.doc.lineAt(offset);
    const col = offset - line.from;
    const re = /\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = re.exec(line.text))) {
      const start = match.index;
      const end = start + match[0].length;
      if (col >= start - 2 && col <= end + 2) {
        const href = match[1].split('|')[0].trim();
        if (href) return { href };
      }
    }
    return null;
  }

  /** 真正动手跳转：按当前坐标重新解析一次，避免悬停重渲染后节点失效 */
  jumpToHovered() {
    const target = this.linkAtPointer();
    if (!target) return false;

    const source = this.app.workspace.getActiveFile()?.path ?? '';
    void this.app.workspace.openLinkText(target.href, source, false);
    return true;
  }

  /** 松开 Alt：单击 → 跳悬停链接（延迟，给双击让路）；连按两下 → 选整行 / 对调 */
  onKeyUp(ev) {
    if (ev.key !== 'Alt') return;
    const tap = this.altTap;
    this.altTap = null;
    if (!tap) return;
    if (tap.combo || tap.done) return;

    const now = Date.now();
    if (now - tap.at > 800) return;

    // 两次干净的 Alt 之间没别的键、间隔够短：算双击 Alt
    if (this.lastCleanAltUp && now - this.lastCleanAltUp <= 320) {
      this.lastCleanAltUp = 0;
      if (this.pendingJump) {
        window.clearTimeout(this.pendingJump);
        this.pendingJump = 0;
      }
      this.doubleAlt();
      ev.preventDefault();
      return;
    }
    this.lastCleanAltUp = now;

    // 悬停在双链上才需要跳；推迟到双击判定窗口结束再跳，
    // 否则第一下 Alt 就跳走，第二下永远等不到
    if (!this.linkAtPointer()) return;
    this.pendingJump = window.setTimeout(() => {
      this.pendingJump = 0;
      this.jumpToHovered();
    }, 330);
  }

  /**
   * 双击 Alt：记下光标所在整行并选中。
   * 已经记过另外一行、那行内容没变 → 把两行对调，选中换过来的那行。
   */
  doubleAlt() {
    const editor = this.editorForKey() || this.activeEditor();
    if (!editor) return;
    const head = editor.getCursor('head');
    const pick = this.linePick;

    if (
      pick &&
      pick.line !== head.line &&
      pick.line <= editor.lastLine() &&
      editor.getLine(pick.line) === pick.text
    ) {
      swapLines(editor, pick.line, head.line);
      this.linePick = { line: head.line, text: editor.getLine(head.line) };
      selectLine(editor, head.line);
      return;
    }

    this.linePick = { line: head.line, text: editor.getLine(head.line) };
    selectLine(editor, head.line);
  }

  /** Alt+S：把记下的整行（或当前整行选区）剪切，插到光标所在行的下一行 */
  cutLineToBelow(editor) {
    const head = editor.getCursor('head');
    const pick = this.linePick;
    let from;
    let to;

    if (pick && pick.line <= editor.lastLine() && editor.getLine(pick.line) === pick.text) {
      from = pick.line;
      to = pick.line;
    } else {
      const sel = editor.listSelections()[0];
      const range = sel ? toRange(sel) : { from: head, to: head };
      from = range.from.line;
      to = range.to.line;
      // 选区终点正好在下一行行首时，那一行不算被选中
      if (to > from && range.to.ch === 0) to -= 1;
    }

    // 目的地就在源块里：原地不动
    if (head.line >= from && head.line <= to) return;

    const start = moveLineBlock(editor, from, to, head.line);
    if (start == null) return;

    const endLine = start + (to - from);
    const range = { from: { line: start, ch: 0 }, to: { line: endLine, ch: editor.getLine(endLine).length } };
    this.linePick = { line: start, text: editor.getLine(start) };
    editor.setSelection(range.from, range.to);
    try {
      editor.scrollIntoView(range, true);
    } catch (e) {
      /* ignore */
    }
  }

  /** Alt+T：把主选区按列对齐后一次写回，撤销一步就能回去 */
  alignSelection(editor) {
    const text = editor.getSelection();
    if (!text || text.indexOf('\n') < 0) {
      new Notice('选中至少两行，再按 Alt+T');
      return;
    }

    const aligned = alignText(text);
    if (aligned === text) return;

    const from = editor.getCursor('from');
    const to = editor.getCursor('to');
    let written = false;
    if (typeof editor.transaction === 'function') {
      try {
        editor.transaction({ changes: [{ from, to, text: aligned }] });
        written = true;
      } catch (e) {
        written = false;
      }
    }
    if (!written) editor.replaceRange(aligned, from, to);

    const lines = aligned.split('\n');
    editor.setSelection(from, { line: from.line + lines.length - 1, ch: lines[lines.length - 1].length });
  }

  /** Alt+双击 < 选到文末，Alt+双击 > 选到行尾 */
  selectAngle(editor, key) {
    const head = editor.getCursor('head');
    let end;
    if (key === '<') {
      const last = editor.lastLine();
      end = { line: last, ch: editor.getLine(last).length };
    } else {
      end = { line: head.line, ch: editor.getLine(head.line).length };
    }
    editor.setSelection(head, end);
    try {
      editor.scrollIntoView({ from: head, to: end }, true);
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Alt 拖动 / Shift 拖动在 mousedown 就先接管。
   * 原生拖选一走，原来的多段选区立刻没了，所以必须拦在 CodeMirror 前面。
   */
  onDragStart(ev) {
    if (ev.button !== 0) return;
    if (!ev.altKey && !ev.shiftKey) return;
    if (ev.altKey && (ev.ctrlKey || ev.metaKey)) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.containerEl || !view.containerEl.contains(ev.target)) return;
    const editor = view.editor;
    const cm = editor && editor.cm;
    if (!cm || !cm.state || typeof cm.posAtCoords !== 'function') return;

    const offset = this.offsetAt(cm, ev.clientX, ev.clientY);
    if (offset == null) return;

    const base = editor
      .listSelections()
      .map(toRange)
      .filter((r) => r.from.line !== r.to.line || r.from.ch !== r.to.ch);

    // Shift 只有在已经有选区时才是「减选」，否则交还原生的 Shift 扩选
    if (ev.shiftKey && base.length === 0) return;

    ev.preventDefault();
    ev.stopPropagation();

    if (this.altTap) this.altTap.done = true; // 拖动不算轻按 Alt

    this.drag = {
      editor,
      cm,
      subtract: ev.shiftKey,
      base,
      start: offset,
      last: offset,
      moved: false,
    };
    try {
      editor.focus();
    } catch (e) {
      /* ignore */
    }
  }

  /** 坐标换成文档偏移；超上下边界时夹在文档范围内 */
  offsetAt(cm, x, y) {
    let offset = null;
    try {
      offset = cm.posAtCoords({ x, y });
    } catch (e) {
      offset = null;
    }
    if (offset == null) return null;
    const length = cm.state && cm.state.doc ? cm.state.doc.length : offset;
    return Math.max(0, Math.min(length, offset));
  }

  /** 拖动中：实时算并集/差集写回多段选区；靠近上下边缘时顺手滚一点 */
  dragMove(ev) {
    const drag = this.drag;
    if (!drag) return;

    const scroller = drag.cm.scrollDOM;
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      if (ev.clientY < rect.top + 24) scroller.scrollTop -= 18;
      else if (ev.clientY > rect.bottom - 24) scroller.scrollTop += 18;
    }

    const offset = this.offsetAt(drag.cm, ev.clientX, ev.clientY);
    if (offset == null) return;
    drag.last = offset;
    if (offset !== drag.start) drag.moved = true;

    const a = Math.min(drag.start, offset);
    const b = Math.max(drag.start, offset);
    const dragged = { from: drag.editor.offsetToPos(a), to: drag.editor.offsetToPos(b) };

    if (drag.subtract) {
      const ranges = subtractRanges(drag.editor, drag.base, dragged);
      if (!ranges.length) {
        // 减光了：光标落到拖动端点
        drag.editor.setSelection(dragged.to, dragged.to);
        ev.preventDefault();
        return;
      }
      drag.editor.setSelections(ranges.map((r) => ({ anchor: r.from, head: r.to })));
    } else {
      const ranges = mergeRanges(drag.editor, [...drag.base, dragged]);
      if (!ranges.length) return; // 还没拖出长度，先不动选区
      drag.editor.setSelections(ranges.map((r) => ({ anchor: r.from, head: r.to })));
    }
    ev.preventDefault();
  }

  /** 松开：没拖动就还原成普通点击，并拦掉随后那次 click 重置选区 */
  onDragEnd(ev) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    ev.preventDefault();
    ev.stopPropagation();
    this.suppressClickUntil = Date.now() + 120;

    if (!drag.moved && !drag.subtract) {
      // Alt + 单击没拖动：当普通点击处理；Shift 那一下没拖就保留原选区不破坏
      const pos = drag.editor.offsetToPos(drag.last);
      drag.editor.setSelection(pos, pos);
    }
    try {
      drag.editor.focus();
    } catch (e) {
      /* ignore */
    }
  }

  activeEditor() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view ? view.editor : null;
  }

  /** 滚动时记录当前笔记的滚动位置（编辑模式记 cm-scroller，阅读模式记预览容器） */
  onScroll(ev) {
    const el = ev.target;
    if (!(el instanceof Element)) return;
    const isScroller =
      el.classList.contains('cm-scroller') || el.classList.contains('markdown-preview-view');
    if (!isScroller) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file || !view.containerEl.contains(el)) return;
    // 只留最近 300 篇的滚动位置：Map 只增不删会随库里的笔记数一直长
    this.scrollMemory.delete(view.file.path);
    this.scrollMemory.set(view.file.path, el.scrollTop);
    while (this.scrollMemory.size > 300) {
      this.scrollMemory.delete(this.scrollMemory.keys().next().value);
    }
  }

  /** 执行后退/前进，等目标笔记的编辑器挂上再把滚动位置还原 */
  goWithScroll(commandId) {
    this.app.commands.executeCommandById(commandId);
    // 只赌 80ms / 260ms 两拍，笔记慢一点就还原失败；改成每 60ms 试一次，最多 10 次
    let tries = 0;
    const tick = () => {
      tries += 1;
      if (this.restoreScroll() || tries >= 10) return;
      window.setTimeout(tick, 60);
    };
    window.setTimeout(tick, 60);
  }

  restoreScroll() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return false;
    const el = view.containerEl.querySelector('.cm-scroller, .markdown-preview-view');
    if (!el) return false;
    const top = this.scrollMemory.get(view.file.path);
    if (typeof top !== 'number') return false;
    el.scrollTop = top;
    return true;
  }

  onCompositionStart(ev) {
    const target = ev.target;
    if (!target || typeof target.closest !== 'function') return;
    const field = target.closest('.cm-content');
    if (!field) return;
    this.composition = { field, text: ev.data || '' };
  }

  onCompositionUpdate(ev) {
    const comp = this.composition;
    if (!comp) return;
    const target = ev.target;
    if (target !== comp.field && !(target instanceof Node && comp.field.contains(target))) {
      return;
    }
    comp.text = ev.data || '';
  }

  /** 从 code 取字母，输入法转换中 key 可能是 "Process" */
  letterOf(ev) {
    if (typeof ev.code === 'string' && /^Key[A-Z]$/.test(ev.code)) {
      return ev.code.slice(3).toLowerCase();
    }
    if (typeof ev.key === 'string' && /^[a-zA-Z]$/.test(ev.key)) {
      return ev.key.toLowerCase();
    }
    return null;
  }

  /** 按键确实发生在当前 Markdown 编辑器里才返回 editor */
  editorForKey() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return null;
    const active = document.activeElement;
    if (!active || !view.containerEl) return null;
    if (!view.containerEl.contains(active)) return null;
    return view.editor;
  }

  /** Alt+M：插入链接模板并把会话挂上 */
  startLink(editor) {
    const selected = editor.getSelection();
    const from = editor.getCursor('from');

    if (selected.length > 0) {
      // 选中的文字当别名：[[|选中文字]]
      const alias = selected.replace(/\r?\n/g, ' ');
      editor.replaceSelection('[[' + '|' + alias + ']]');
    } else {
      editor.replaceSelection('[[]]');
    }

    editor.setCursor({ line: from.line, ch: from.ch + 2 });
    this.linkSession = true;
    this.linkLine = from.line;
  }

  onKeyDown(ev) {
    // 任何键按下都取消还没执行的链接跳转，免得打字打到一半界面跳走
    if (this.pendingJump) {
      window.clearTimeout(this.pendingJump);
      this.pendingJump = 0;
    }
    if (ev.key !== 'Alt') this.lastCleanAltUp = 0; // 中间按了别的键，双击 Alt 作废
    if (ev.key !== '<' && ev.key !== '>') this.angleTap = null;

    // 单独按下的 Alt：先记一笔，松手时再决定要不要跳转
    if (ev.key === 'Alt') {
      const hovered = this.linkAtPointer();
      const tap = { at: Date.now(), combo: false, done: false };
      this.altTap = tap;

      if (hovered) {
        ev.preventDefault();
        // 万一 keyup 被系统菜单吃掉，按住 350ms 也兜底跳一次
        window.setTimeout(() => {
          if (this.altTap !== tap || tap.combo || tap.done) return;
          tap.done = true;
          this.jumpToHovered();
        }, 350);
      }
      return;
    }
    // Alt + 连按两下 < / >：从光标选到文末 / 行尾。
    // 尖括号常要配 Shift，所以这里不看 shiftKey；第一次按下就要吞字符，
    // 否则 < 先落进正文，第二次按下时选区已经被改过。
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && (ev.key === '<' || ev.key === '>')) {
      const editor = this.editorForKey();
      if (!editor) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (this.altTap) this.altTap.combo = true; // 配了尖括号，不算轻按 Alt
      const now = Date.now();
      const first = this.angleTap;
      if (first && first.key === ev.key && now - first.at <= 400) {
        this.angleTap = null;
        this.selectAngle(editor, ev.key);
      } else {
        this.angleTap = { key: ev.key, at: now };
      }
      return;
    }

    if (this.altTap) this.altTap.combo = true; // 搭配了别的键 → 不算轻按 Alt

    // 链接模板会话中：Tab 按链接当前长相推进
    if (this.linkSession) {
      if (ev.key === 'Tab' && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
        const editor = this.activeEditor();
        const link = editor ? currentLink(editor) : null;
        const sameLine = editor && editor.getCursor().line === this.linkLine;

        if (!editor || !link || !sameLine) {
          // 光标跑到别的行/别的链接去了，会话作废，Tab 交回 Obsidian
          this.linkSession = false;
          return;
        }

        ev.preventDefault();
        ev.stopPropagation();

        try {
          this.linkSession = advanceLink(editor);
        } catch (err) {
          this.linkSession = false;
        }
        return;
      }
    }

    // 光标紧贴半角 ) 或成对引号的右半边时，Tab 直接越过去
    if (ev.key === 'Tab' && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
      const editor = this.activeEditor();
      if (editor && escapeClosing(editor)) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
    }

    if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;

    // Alt+Enter：在当前行和下一行之间插空行，光标移到空行
    if (ev.key === 'Enter') {
      const target = this.editorForKey();
      if (!target) return;
      ev.preventDefault();
      ev.stopPropagation();
      insertBlankLineBelow(target);
      return;
    }

    // Alt+M：插入链接模板（裸处理，不依赖快捷键系统是否接受这个组合）
    if (this.letterOf(ev) === 'm') {
      const target = this.editorForKey();
      if (!target) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.startLink(target);
      return;
    }

    // Alt+S：把记下的整行剪切，插到光标所在行的下一行
    if (this.letterOf(ev) === 's') {
      const target = this.editorForKey();
      if (!target) return;
      ev.preventDefault();
      ev.stopPropagation();
      this.cutLineToBelow(target);
      return;
    }

    if (this.letterOf(ev) !== 'd') return;

    // 输入法里有没上屏的内容：先清输入法，别的都不做
    const comp = this.composition;
    if (comp && comp.text) {
      ev.preventDefault();
      ev.stopPropagation();
      this.clearComposition(comp);
      return;
    }

    // 正在组合但没抓到内容，宁可不动，也别动这一行
    if (ev.isComposing) return;

    const editor = this.editorForKey();
    if (!editor) return;

    ev.preventDefault();
    ev.stopPropagation();
    handleCurrentLine(editor);
  }

  clearComposition(comp) {
    this.pending = {
      text: comp.text,
      field: comp.field,
      editor: this.activeEditor(),
      tries: 0,
    };
    try {
      // 让输入法把当前这次组合结束掉，编辑器状态和 DOM 才会重新同步
      comp.field.blur();
    } catch (e) {
      /* ignore */
    }
    this.tryFinishClear();
  }

  tryFinishClear() {
    window.setTimeout(() => {
      const p = this.pending;
      if (!p) return;

      if (this.erasePendingText(p)) {
        this.pending = null;
        this.focusBack(p.field);
        return;
      }

      if (p.tries >= 6) {
        this.pending = null;
        this.focusBack(p.field);
        return;
      }

      p.tries += 1;
      this.tryFinishClear();
    }, 45);
  }

  /** 上屏后的那串字还在光标前面、且内容和输入法里的一致，才删——防止误删正文 */
  erasePendingText(p) {
    const editor = p.editor || this.activeEditor();
    if (!editor) return false;

    const cur = editor.getCursor();
    const from = { line: cur.line, ch: cur.ch - p.text.length };
    if (from.ch < 0) return false;

    let value;
    try {
      value = editor.getRange(from, cur);
    } catch (e) {
      return false;
    }
    if (value !== p.text && value.toLowerCase() !== p.text.toLowerCase()) return false;

    try {
      editor.replaceRange('', from, cur);
    } catch (e) {
      return false;
    }
    return true;
  }

  focusBack(field) {
    try {
      field.focus();
    } catch (e) {
      /* ignore */
    }
  }
}

AltQuickKeys._pure = {
  insertSymbol,
  jumpLine,
  handleCurrentLine,
  extendSelection,
  currentLink,
  advanceLink,
  escapeClosing,
  insertBlankLineBelow,
  charWidth,
  displayWidth,
  expandTabs,
  alignText,
  mergeRanges,
  subtractRanges,
  swapLines,
  moveLineBlock,
  selectLine,
};

module.exports = AltQuickKeys;
