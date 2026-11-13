# Alt Quick Keys

Alt-based editing shortcuts for [Obsidian](https://obsidian.md). Insert markup, jump between lines, extend a selection one character at a time, fill in a wikilink with Tab, clear a line without fighting the IME, and go back or forward without losing your scroll position.

**[中文说明](#中文说明)**

Every shortcut works on multiple cursors where it makes sense. Nothing here touches your notes unless you press a key.

## Requirements

- Obsidian 1.4.0 or newer
- Desktop app only (`isDesktopOnly: true`)

## Install

**Community plugins:** Settings → Community plugins → Browse → search "Alt Quick Keys". If it is not listed yet, install it manually:

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/Citrussy/obsidian-alt-quick-keys/releases/latest).
2. Create `<vault>/.obsidian/plugins/alt-quick-keys/`.
3. Drop both files in and enable the plugin in Settings → Community plugins.

## Keys

| Key | Action |
| --- | --- |
| `Alt+Q` | Insert `#` |
| `Alt+W` | Insert `*` |
| `Alt+E` | Insert `**` |
| `Alt+K` | Go to the start of the line below |
| `Alt+L` | Go to the end of the line below |
| `Alt+O` | Go to the start of the line above |
| `Alt+P` | Go to the end of the line above |
| `Alt+,` | Extend the selection one character left |
| `Alt+.` | Extend the selection one character right |
| `Alt+M` | Insert a wikilink template, then Tab through it |
| `Alt+Enter` | Insert a blank line below, caret at column 0 |
| `Alt+D` | Clear the current line, or delete it if it is already empty |
| `Alt+-` | Go back (previous note), keeping the scroll position |
| `Alt+=` | Go forward, keeping the scroll position |
| `Tab` | Skip over a closing `)` or closing quote |
| `Alt` (tap) | Open the wikilink under the pointer |

### Insert and jump

`Alt+Q/W/E` insert the text at every caret, or replace the current selection with it. `Alt+K/L/O/P` move line by line:

- Holding the key repeats the jump, no need to press it again.
- On the last line, `Alt+K` and `Alt+L` add a new line at the end of the document, like Enter.
- With a selection, a jump starts from the far end in the direction of travel, so a downward jump does not land inside the selected text.
- `Alt+K` and `Alt+O` land at column 0, before any leading `#`, and `Alt+L` / `Alt+P` land after the last character.

### Extend selection

`Alt+,` and `Alt+.` move the active end of the selection one character, like dragging the mouse. The anchor stays put, so both directions work from the same start. Both stop at the line edge instead of wrapping. Emoji and other surrogate pairs count as one character.

### Link template

`Alt+M` inserts `[[]]` with the caret inside. With text selected it inserts `[[|selected text]]` instead, so the selection becomes the alias.

Then press `Tab` to walk through the parts of the link:

1. Type the note name, press Tab → `#` is appended.
2. Type a heading or block reference, press Tab → `|` is appended.
3. Type an alias, press Tab → the caret jumps past `]]`.

Each Tab looks at what the link looks like right now, not at how many steps you have taken. Accept a suggestion that produces `[[Note|Alias]]` and Tab still moves to the right place, adding `#` in front of `|` when you have an alias but no heading. An empty name is left alone, and an empty `#` or `|` is removed when you leave it empty. Moving the caret to another line cancels the session.

### Clear line

`Alt+D` has two stages:

1. The line has text → the text is cleared and the caret returns to column 0. The line stays.
2. The line is already empty → the line itself is removed.

If an IME composition is pending, `Alt+D` discards the uncommitted text first and leaves the line alone. The plugin waits for the composition to settle, then deletes the uncommitted characters only if they are still directly in front of the caret and match what the IME was composing. That check is what keeps it from eating real text.

### Back and forward

`Alt+-` and `Alt+=` run Obsidian's own `app:go-back` and `app:go-forward`. The plugin records the scroll position of each note and restores it after the jump, so returning to a long note no longer lands you at the top.

### Tab out of brackets and quotes

When the caret sits just before a `)`, the Tab key steps over it. The same goes for a closing `"` or `'` pair. For quotes the character to the left must be non-whitespace, so a quote that opens a word is not skipped. Tab is left alone when there is a selection or more than one caret.

### Alt-tap a link

Hover a wikilink and press Alt by itself. The plugin opens the link, in Live Preview and in Reading view. It checks the DOM first to be sure the pointer is really over the link, then resolves the target. Unresolved links are skipped. Anything else pressed while Alt is down counts as a shortcut and cancels the jump. A 350 ms hold also fires, in case the system menu swallows the key release.

## How it works

The plugin is one hand-written CommonJS file with no build step, and most of its design comes from three constraints.

**Keys must be caught before CodeMirror sees them.** `Alt+M`, `Alt+Enter`, `Alt+D`, the Alt-tap and the Tab behaviours are handled on `window`'s `keydown` in the capture phase, using native listeners rather than `registerDomEvent`. On some Obsidian versions `registerDomEvent` cannot request capture, and then CodeMirror's own Tab handler consumes the key first. Everything that can be a normal editor command — the jumps, the inserts, back and forward — is registered as a command with a default hotkey, so it shows up in Settings → Hotkeys and works with multiple cursors.

**Editor changes go through the editor, not the DOM.** `insertSymbol` calls `editor.replaceSelection` for one caret; for several carets it walks the ranges backwards with `replaceRange` and re-applies each cursor offset, because replacing forwards shifts the positions of the ranges still to be edited. `editor.transaction` exists, but on the versions this plugin targets it does not commit the change synchronously, which breaks the "insert at every caret" sequence. The link template is a small state machine over the link's *current* text rather than a step counter, because the candidate suggester can replace `[[` with a complete `[[Note|Alias]]` in one keystroke; counting steps would then point at the wrong segment.

**IME text is not your text.** `Alt+D` while composing must clear the composition, not the line. The plugin records the composing text from `compositionstart`/`compositionupdate`, blurs the editor to commit or cancel the composition, polls up to six times at 45 ms, and only then removes the characters if the text immediately before the caret still equals what the IME was composing. The check is the point: blind deletion during composition is how plugins eat paragraphs.

The scroll restore for back and forward is a small `Map` from file path to `scrollTop`, captured from the editor's `.cm-scroller` (or `markdown-preview-view` in reading mode) before the navigation command runs and re-applied at 80 ms and 260 ms afterwards, since Obsidian's own restore can land after the first attempt.

## Hotkeys

The shortcuts above are registered as Obsidian commands, so every one of them can be changed in Settings → Hotkeys. Search for `Alt Quick Keys`.

`Alt+M`, `Alt+Enter`, `Alt+D`, the Alt-tap, and the Tab behaviours are handled directly on `keydown`. They cannot be remapped, because they have to run before Obsidian or the IME handles the same key.

## Notes

- Keys only act when a Markdown editor has focus.
- The Alt-tap jump needs the pane to be focused; it does nothing in the sidebar.
- No settings tab, no data file, no network access. The plugin keeps a scroll position per note in memory only.

## Repository layout

```
main.js        compiled plugin (plain CommonJS, no bundler)
manifest.json  plugin manifest
versions.json  minimum Obsidian version per release
LICENSE        MIT
```

There is no build step. `main.js` is hand-written, readable source. The pure helpers used by the keyboard handlers are exported on `AltQuickKeys._pure` — `insertSymbol`, `jumpLine`, `handleCurrentLine`, `extendSelection`, `currentLink`, `advanceLink`, `escapeClosing`, `insertBlankLineBelow` — so they can be tested without an Obsidian instance.

## 中文说明

Obsidian 桌面端的 Alt 键速写插件。给常用的 Markdown 符号、行跳转、扩选、双链模板各配一个 Alt 组合键，把「移动鼠标 → 定位 → 打字」压成一次按键。

### 能带来什么

- **手不离主键区**：插 `#`、`*`、`**`，上一行 / 下一行的行首行尾，全部在 Alt 层完成。
- **按住连跳**：`Alt+K` / `Alt+L` 支持按住不放连续跳行，跨十几行不用连按十几次。
- **多光标一起改**：插入符号和逐字扩选对所有光标生效，写列表、改表格时不用逐个处理。
- **双链不用记语法**：`Alt+M` 生成 `[[]]`，Tab 依次补标题、别名，再跳出。选中文字再按，选中的文字直接变成别名。
- **清行不误删**：`Alt+D` 第一次清空当前行，第二次才删行；输入法正在组字时先清输入法，不会把正文吃掉。
- **后退不丢位置**：`Alt+-` / `Alt+=` 后退前进之后回到原来的滚动位置，长笔记里不会被打回开头。
- **轻按 Alt 开链接**：鼠标悬停在双链上，轻按一下 Alt 直接打开，实时预览和阅读模式都可用。

### 按键

| 按键 | 作用 |
| --- | --- |
| `Alt+Q` | 插入 `#` |
| `Alt+W` | 插入 `*` |
| `Alt+E` | 插入 `**` |
| `Alt+K` | 下一行行首 |
| `Alt+L` | 下一行行尾 |
| `Alt+O` | 上一行行首 |
| `Alt+P` | 上一行行尾 |
| `Alt+,` | 选区向右扩一个字 |
| `Alt+.` | 选区向右扩一个字 |
| `Alt+M` | 插入双链模板，Tab 逐步补全 |
| `Alt+Enter` | 在下方插入空行，光标回行首 |
| `Alt+D` | 清空当前行；已空则删除该行 |
| `Alt+-` | 后退，保留滚动位置 |
| `Alt+=` | 前进，保留滚动位置 |
| `Tab` | 越过右括号或成对引号 |
| `Alt`（轻按） | 打开鼠标下的双链 |

### 实现原理

整个插件是一个手写的 CommonJS 文件，没有构建步骤。设计基本由三个限制决定。

**按键必须先于 CodeMirror 被捕获。** `Alt+M`、`Alt+Enter`、`Alt+D`、轻按 Alt、以及 Tab 相关行为都挂在 `window` 的 `keydown` 捕获阶段，用原生监听器而不是 `registerDomEvent`——部分 Obsidian 版本里 `registerDomEvent` 拿不到捕获阶段，Tab 会先被 CodeMirror 吃掉。其余能做成普通命令的键位（跳行、插符号、前进后退）都注册为命令并带默认热键，这样能在「设置 → 快捷键」里改，也天然支持多光标。

**改动通过编辑器 API，不碰 DOM。** 单光标插符号用 `editor.replaceSelection`；多光标则从后往前逐个 `replaceRange` 并修正光标偏移，因为从前往后改会让后面还没处理的区间位置整体漂移。`editor.transaction` 在这个插件支持的版本上不能同步提交，会破坏「每个光标都插入」的顺序，所以没用。双链模板是一个读取链接**当前文本**的小状态机，而不是按 Tab 次数计数：候选补全可能一次按键就把 `[[` 换成完整的 `[[Note|Alias]]`，按步数走会落到错误的分段。

**输入法里的字不是你的字。** 组字过程中按 `Alt+D` 要清掉的是输入法内容，不是整行。插件从 `compositionstart`/`compositionupdate` 记录正在组字的文本，先让编辑器失焦提交或取消组字，再以 45 ms 间隔轮询最多六次，只有光标前文本仍然等于输入法内容时才删除。这个校验是关键：组字期间盲删是插件吃掉整段正文的常见原因。

前进后退的滚动还原是一张「文件路径 → `scrollTop`」的 `Map`。导航命令执行前从编辑器的 `.cm-scroller`（阅读模式下是 `markdown-preview-view`）读位置，命令后 80 ms 和 260 ms 各还原一次，因为 Obsidian 自己的还原可能晚于第一次尝试。

### 热键

上表的键位都注册成了 Obsidian 命令，可在「设置 → 快捷键」里搜索 `Alt Quick Keys` 修改。`Alt+M`、`Alt+Enter`、`Alt+D`、轻按 Alt 和 Tab 行为直接走 `keydown`，不能改键，因为它们必须抢在 Obsidian 或输入法处理同一个键之前。

### 运维说明

只有 Markdown 编辑器获得焦点时生效；轻按 Alt 需要面板有焦点，侧边栏里不起作用。没有设置页、没有数据文件、不联网，滚动位置只存在内存里。仅桌面端，需要 Obsidian 1.4.0 以上。

## License

MIT
