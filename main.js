'use strict';

const { Plugin, MarkdownView } = require('obsidian');

/**
 * 一条键位对应一个动作。
 * type 'text'：插入文本。caretBack 表示插完光标回退几个字符。
 * type 'line'：跨行跳转。delta 是行偏移；where 'start' = 第 0 列（# 这类 Markdown 标记之前），
 *              'end' = 该行最后一个字符之后。已经到头（首行/末行）时原地不动。
 */
const ACTIONS = {
  q: { name: '插入 #', type: 'text', text: '#' },
  w: { name: '插入 *', type: 'text', text: '*' },
  e: { name: '插入 **', type: 'text', text: '**' },
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
 * 单光标走 replaceSelection（最基础、最稳的编辑器 API），多光标再逐个 replaceRange。
 * 早先用的 editor.transaction 在部分 Obsidian 版本上不生效，所以不用它。
 */
function insertSymbol(editor, action) {
  const text = action.text;
  const back = action.caretBack || 0;
  const sels = editor.listSelections();

  if (sels.length <= 1) {
    editor.replaceSelection(text);
    if (back > 0) {
      const cur = editor.getCursor();
      editor.setCursor({ line: cur.line, ch: Math.max(0, cur.ch - back) });
    }
    return;
  }

  // 多光标：从后往前插入，且插入的文本不含换行，只需要修正同一行上更靠后的位置
  const ranges = sels
    .map(toRange)
    .sort((a, b) => b.from.line - a.from.line || b.from.ch - a.from.ch);

  const cursors = [];
  for (const r of ranges) {
    editor.replaceRange(text, r.from, r.to);
    for (const pos of cursors) {
      if (pos.line === r.from.line && pos.ch >= r.from.ch) pos.ch += text.length;
    }
    cursors.push({ line: r.from.line, ch: r.from.ch + text.length - back });
  }

  editor.setSelections(
    cursors
      .sort((a, b) => a.line - b.line || a.ch - b.ch)
      .map((pos) => ({ anchor: pos, head: pos }))
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

  let caret = { line: 0, ch: 0 };

  for (const line of lines) {
    const text = editor.getLine(line);
    const lastLine = editor.lastLine();

    if (text.length > 0) {
      editor.replaceRange('', { line, ch: 0 }, { line, ch: text.length });
      caret = { line, ch: 0 };
    } else if (line < lastLine) {
      editor.replaceRange('', { line, ch: 0 }, { line: line + 1, ch: 0 });
      caret = { line, ch: 0 };
    } else if (line > 0) {
      const prevLen = editor.getLine(line - 1).length;
      editor.replaceRange('', { line: line - 1, ch: prevLen }, { line, ch: 0 });
      caret = { line: line - 1, ch: prevLen };
    } else {
      caret = { line: 0, ch: 0 };
    }
  }

  editor.setCursor({ line: Math.min(caret.line, editor.lastLine()), ch: caret.ch });
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
  }

  onunload() {
    this.composition = null;
    this.pending = null;
    this.linkSession = false;
    this.altTap = null;
  }

  /** 只记坐标，解析留到真要跳转时再做 */
  onMouseMove(ev) {
    this.pointer = { x: ev.clientX, y: ev.clientY };
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

  /** 松开 Alt 且这一按没搭配别的键：跳到鼠标悬停的双链 */
  onKeyUp(ev) {
    if (ev.key !== 'Alt') return;
    const tap = this.altTap;
    this.altTap = null;
    if (!tap) return;
    if (tap.combo || tap.done) return;
    if (Date.now() - tap.at > 800) return;
    if (this.jumpToHovered()) ev.preventDefault();
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
    this.scrollMemory.set(view.file.path, el.scrollTop);
  }

  /** 执行后退/前进，然后在两拍之后把目标笔记的滚动位置还原 */
  goWithScroll(commandId) {
    this.app.commands.executeCommandById(commandId);
    window.setTimeout(() => this.restoreScroll(), 80);
    window.setTimeout(() => this.restoreScroll(), 260);
  }

  restoreScroll() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return;
    const el = view.containerEl.querySelector('.cm-scroller, .markdown-preview-view');
    if (!el) return;
    const top = this.scrollMemory.get(view.file.path);
    if (typeof top === 'number') el.scrollTop = top;
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
};

module.exports = AltQuickKeys;
