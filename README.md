# Alt Quick Keys

Alt-based editing shortcuts for [Obsidian](https://obsidian.md). Insert markup, jump between lines, extend a selection one character at a time, fill in a wikilink with Tab, clear a line without fighting the IME, and go back or forward without losing your scroll position.

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
LICENSE        MIT
```

There is no build step. `main.js` is hand-written, readable source. The pure helpers used by the keyboard handlers are exported on `AltQuickKeys._pure` — `insertSymbol`, `jumpLine`, `handleCurrentLine`, `extendSelection`, `currentLink`, `advanceLink`, `escapeClosing`, `insertBlankLineBelow` — so they can be tested without an Obsidian instance.

## 中文说明

Obsidian 桌面端的 Alt 键速写插件。Alt+Q/W/E 插符号；Alt+K/L/O/P 跳行（按住连跳，末行按 Enter 逻辑补行）；Alt+, / Alt+. 逐字扩选；Alt+M 插 `[[]]` 模板，Tab 依次补标题、别名、再跳出；Alt+Enter 在光标行后插空行；Alt+D 两段式清行，输入法未上屏时先清输入法；Alt+- / Alt+= 后退前进并还原滚动位置；Tab 越过 `)` 和成对引号；鼠标悬停双链时轻按 Alt 直接跳转。

所有键位的命令都在「设置 → 快捷键」里可改。仅桌面端，需要 Obsidian 1.4.0 以上。

## License

MIT
