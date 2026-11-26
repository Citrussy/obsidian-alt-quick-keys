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

/** Alt+Q 按住后开始补行的延迟与每行间隔（毫秒） */
const HASH_HOLD_DELAY = 360;
const HASH_HOLD_INTERVAL = 120;

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

/** 两段以上真实选区时，cursor-smooth-jump 的次光标不再压暗；多光标仍保持原样 */
function markMultiSelection(list) {
  if (typeof document === 'undefined') return;
  const real = list.filter((range) => range.anchor.line !== range.head.line || range.anchor.ch !== range.head.ch).length;
  document.body.classList.toggle('altqk-multisel', real > 1);
}

/** 用 CodeMirror 的选区对象写回，并指定主选区；Obsidian 的 setSelections 会忽略主选区参数 */
function applySelections(editor, ranges, mainIndex) {
  const list = ranges.map((range) => ({ anchor: range.from, head: range.to }));
  if (!list.length) return;
  markMultiSelection(list);

  const cm = editor.cm;
  const Selection = cm && cm.state && cm.state.selection && cm.state.selection.constructor;
  if (Selection && typeof Selection.create === 'function' && typeof Selection.range === 'function') {
    try {
      const cmRanges = list.map((range) =>
        Selection.range(editor.posToOffset(range.anchor), editor.posToOffset(range.head))
      );
      const index = Math.max(0, Math.min(mainIndex == null ? 0 : mainIndex, cmRanges.length - 1));
      cm.dispatch({ selection: Selection.create(cmRanges, index) });
      return;
    } catch (e) {
      /* 老版本没有 dispatch 时退回 Editor API */
    }
  }
  editor.setSelections(list);
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

    // 上一次非空选区：光标移走/选区塌掉后，Alt+S 仍能搬这一行
    this.lastPick = null;
    // Alt+, / Alt+. 的连按记录
    this.angleTap = null;
    // Alt+Q 按住后补 # 列的计时器
    this.hashHold = null;

    // 多段选区由 Obsidian 画主选区、CodeMirror 画其余选区；统一底色，
    // 并把 cursor-smooth-jump 压暗的次光标提亮
    this.styleEl = document.createElement('style');
    this.styleEl.id = 'alt-quick-keys-style';
    this.styleEl.textContent = [
      '.altqk-on .cm-selectionBackground { background-color: var(--text-selection, rgba(59, 118, 113, 0.376)) !important; }',
      '.altqk-multisel .cj-caret-secondary { filter: none !important; opacity: 1 !important; }',
    ].join('\n');
    document.head.appendChild(this.styleEl);
    document.body.classList.add('altqk-on');
    this.register(() => {
      document.body.classList.remove('altqk-on');
      document.body.classList.remove('altqk-multisel');
      if (this.styleEl) this.styleEl.remove();
    });
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
    const onSelectionChange = () => {
      this.rememberSelection();
      this.syncMultiSelection();
    };
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('click', onClick, true);
    document.addEventListener('selectionchange', onSelectionChange);
    const onBlur = () => {
      this.drag = null; // 焦点被系统抢走时松手事件收不到，别让拖动状态挂着
      this.finishHashHold();
    };
    window.addEventListener('blur', onBlur, true);
    window.addEventListener('selectstart', onSelectStart, true);
    this.register(() => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mouseup', onMouseUp, true);
      window.removeEventListener('click', onClick, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('selectstart', onSelectStart, true);
      window.removeEventListener('blur', onBlur, true);
    });

    // 记下的整行被编辑过就作废，免得 Alt+S 拿旧行号去搬现在的行
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor) => {
        const pick = this.lastPick;
        if (!pick) return;
        if (pick.toLine > editor.lastLine()) {
          this.lastPick = null;
          return;
        }
        for (let i = pick.fromLine; i <= pick.toLine; i += 1) {
          if (editor.getLine(i) !== pick.lines[i - pick.fromLine]) {
            this.lastPick = null;
            return;
          }
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.lastPick = null;
        this.finishHashHold();
      })
    );
  }

  onunload() {
    this.finishHashHold();
    this.composition = null;
    this.pending = null;
    this.linkSession = false;
    this.altTap = null;
    this.lastPick = null;
    this.drag = null;
    document.body.classList.remove('altqk-on');
    if (this.styleEl) this.styleEl.remove();
  }

  /** 记下最近一次非空选区；Alt+S 在选区塌掉后还能搬它 */
  rememberSelection() {
    if (this.drag) return;
    const editor = this.activeEditor();
    if (!editor) return;

    const sel = editor.listSelections().find((item) => {
      const range = toRange(item);
      return range.from.line !== range.to.line || range.from.ch !== range.to.ch;
    });
    if (!sel) return;

    const range = toRange(sel);
    let toLine = range.to.line;
    if (toLine > range.from.line && range.to.ch === 0) toLine -= 1;
    const lines = [];
    for (let i = range.from.line; i <= toLine; i += 1) lines.push(editor.getLine(i));
    this.lastPick = { fromLine: range.from.line, toLine, lines };
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

  /** 松开 Alt：单击且鼠标停在双链上时跳过去 */
  onKeyUp(ev) {
    if (this.hashHold && (ev.key === 'q' || ev.code === 'KeyQ' || ev.key === 'Alt')) {
      this.finishHashHold();
    }
    if (ev.key !== 'Alt') return;
    const tap = this.altTap;
    this.altTap = null;
    if (!tap || tap.combo || tap.done) return;
    if (Date.now() - tap.at > 800) return;
    if (!this.linkAtPointer()) return;
    this.jumpToHovered();
  }

  /**
   * Alt+Q 按住：命令先插第一个 #；360ms 后每 120ms 补一行，按得越久列越长。
   * 松开 Q 或 Alt 会取消；按住期间不响应系统的重复 keydown，避免刷得太快。
   */
  startHashHold(editor) {
    this.finishHashHold();
    const hold = { editor, timer: 0 };
    const tick = () => {
      if (this.hashHold !== hold) return;
      if (this.activeEditor() !== editor) {
        this.finishHashHold();
        return;
      }
      try {
        editor.replaceSelection('\n#');
      } catch (err) {
        this.finishHashHold();
        return;
      }
      try {
        const cursor = editor.getCursor();
        editor.scrollIntoView({ from: cursor, to: cursor });
      } catch (err) {
        // 滚动失败不能终止整列输出
      }
      hold.timer = window.setTimeout(tick, HASH_HOLD_INTERVAL);
    };
    hold.timer = window.setTimeout(tick, HASH_HOLD_DELAY);
    this.hashHold = hold;
  }

  finishHashHold() {
    if (!this.hashHold) return;
    window.clearTimeout(this.hashHold.timer);
    this.hashHold = null;
  }

  /** 选区变化后同步多段高亮状态；没有编辑器时清掉 */
  syncMultiSelection() {
    if (typeof document === 'undefined') return;
    const editor = this.activeEditor();
    if (!editor) {
      document.body.classList.remove('altqk-multisel');
      return;
    }
    markMultiSelection(
      editor.listSelections().map((range) => ({ anchor: range.anchor, head: range.head }))
    );
  }

  /** 取 Alt+S 要搬的整行范围：当前主选区 → 最近记下的选区 → 任意非空段 → 当前行 */
  lineRangeForMove(editor, head) {
    const nonEmpty = (range) =>
      range && (range.from.line !== range.to.line || range.from.ch !== range.to.ch);

    const main = editor.listSelections()[0];
    const mainRange = main ? toRange(main) : null;
    if (nonEmpty(mainRange)) return mainRange;

    const pick = this.lastPick;
    if (pick && pick.toLine <= editor.lastLine()) {
      const same = pick.lines.every(
        (text, i) => editor.getLine(pick.fromLine + i) === text
      );
      if (same) {
        return {
          from: { line: pick.fromLine, ch: 0 },
          to: { line: pick.toLine, ch: editor.getLine(pick.toLine).length },
        };
      }
    }

    const any = editor.listSelections().map(toRange).find(nonEmpty);
    if (any) return any;

    return {
      from: { line: head.line, ch: 0 },
      to: { line: head.line, ch: editor.getLine(head.line).length },
    };
  }

  /** Alt+S：把选中的整行（或最近选过的那行）剪切，插到光标所在行的下一行 */
  cutLineToBelow(editor) {
    const head = editor.getCursor('head');
    const source = this.lineRangeForMove(editor, head);
    let from = source.from.line;
    let to = source.to.line;
    // 选区终点正好在下一行行首时，那一行不算被选中
    if (to > from && source.to.ch === 0) to -= 1;

    // 目的地就在源块里：原地不动
    if (head.line >= from && head.line <= to) return;

    const start = moveLineBlock(editor, from, to, head.line);
    if (start == null) return;

    const endLine = start + (to - from);
    const range = {
      from: { line: start, ch: 0 },
      to: { line: endLine, ch: editor.getLine(endLine).length },
    };
    applySelections(editor, [range], 0);

    const lines = [];
    for (let i = start; i <= endLine; i += 1) lines.push(editor.getLine(i));
    this.lastPick = { fromLine: start, toLine: endLine, lines };

    // 只保证移动后的块可见，不用 true 居中，避免整屏跳动
    try {
      editor.scrollIntoView(range);
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

  /** Alt+双击 , 选到当前行行首；Alt+双击 . 选到当前行行尾 */
  selectToEdge(editor, edge) {
    const head = editor.getCursor('head');
    const anchor = editor.getCursor('anchor');
    const line = head.line;
    const keep = anchor.line === line ? anchor : head;
    const end =
      edge === 'start'
        ? { line, ch: 0 }
        : { line, ch: editor.getLine(line).length };
    editor.setSelection(keep, end);
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

  /** 找到包含某个偏移的选区，用作主选区；找不到就回到第一段 */
  rangeIndexAt(editor, ranges, offset) {
    const index = ranges.findIndex((range) => {
      const from = editor.posToOffset(range.from);
      const to = editor.posToOffset(range.to);
      return offset >= from && offset <= to;
    });
    return index < 0 ? 0 : index;
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
      applySelections(drag.editor, ranges, this.rangeIndexAt(drag.editor, ranges, drag.last));
    } else {
      const ranges = mergeRanges(drag.editor, [...drag.base, dragged]);
      if (!ranges.length) return; // 还没拖出长度，先不动选区
      // 拖动端点所在的那段设为主选区，让它用原生高亮；旧选区交给 CM 画
      applySelections(drag.editor, ranges, this.rangeIndexAt(drag.editor, ranges, offset));
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
      // Alt + 单击没拖动：点在旧选区外就追加一个空光标，旧选区保留；
      // 点在旧选区里则照普通点击把选区收成一个光标。
      const pos = drag.editor.offsetToPos(drag.last);
      const inside = drag.base.some((range) => {
        return (
          drag.last >= drag.editor.posToOffset(range.from) &&
          drag.last <= drag.editor.posToOffset(range.to)
        );
      });
      if (drag.base.length && !inside) {
        const addition = { from: pos, to: pos };
        const ranges = [...drag.base, addition].sort(
          (a, b) => drag.editor.posToOffset(a.from) - drag.editor.posToOffset(b.from)
        );
        applySelections(drag.editor, ranges, ranges.indexOf(addition));
      } else {
        drag.editor.setSelection(pos, pos);
      }
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
    const isComma = ev.key === ',' || ev.code === 'Comma';
    const isPeriod = ev.key === '.' || ev.code === 'Period';
    const isQ = ev.key === 'q' || ev.code === 'KeyQ';
    if (this.hashHold && !isQ) this.finishHashHold();
    // 中间按了别的键，逗号/句号的连按作废
    if (!isComma && !isPeriod) this.angleTap = null;
    else if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) this.angleTap = null;

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
    // Alt + 连按两下 , / .：选到行首 / 行尾。
    // 第一次按下照旧逐字扩选；同键 400ms 内的第二次改成贴边。
    // 必须自己拦截：Obsidian 已把 Alt+, / Alt+. 绑成逐字扩选命令，
    // 放行的话第二次按键前选区已经被命令改过。
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && (isComma || isPeriod)) {
      const editor = this.editorForKey();
      if (!editor) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (this.altTap) this.altTap.combo = true; // 配了逗号/句号，不算轻按 Alt

      const edge = isComma ? 'start' : 'end';
      if (ev.repeat) {
        this.angleTap = null;
        return;
      }

      const now = Date.now();
      const first = this.angleTap;
      if (first && first.edge === edge && now - first.at <= 400) {
        this.angleTap = null;
        this.selectToEdge(editor, edge);
      } else {
        // 单击那一步交给已注册的 Alt+, / Alt+. 命令：Obsidian 的命令热键可能在本监听器
        // 之前或之后执行，自己再扩一次就会变成一次按键走两格。
        this.angleTap = { edge, at: now };
      }
      return;
    }

    // Alt+Q 长按：第一下交给命令插 #，按住后每 120ms 再补一行
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && isQ) {
      if (this.altTap) this.altTap.combo = true;
      if (ev.repeat) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      const editor = this.editorForKey();
      if (editor) this.startHashHold(editor);
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
  moveLineBlock,
};

module.exports = AltQuickKeys;