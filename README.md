# Claude Sessions

A private VS Code extension: a panel in the right side bar that keeps a short list of the Claude Code sessions
you are continuing, shows which one needs you, and finds any old one.

## Install

```sh
npm run package                                   # builds claude-sessions-0.1.0.vsix (needs network the first time)
code --install-extension claude-sessions-0.1.0.vsix
```

On another computer, copy the `.vsix` over and run the second line. Needs VS Code 1.109 or newer.
The panel appears in the right (secondary) side bar: View › Appearance › Secondary Side Bar.

## Use

- **Find** a session by typing a word you used in it, then **Add to Active** and give it a name.
- **Click** a session: closed, it resumes in a terminal in the bottom panel; already open in this window, its terminal comes to the front.
- **Drag** rows to order them. Hover a row to rename it or mark it finished.
- A session that **needs you** jumps to the top until you answer.

The marks before a name: tall blinking block = needs you, asterisk = working, half block = new reply, underscore = open in a terminal, none = closed.

## Limits

- Search covers session names and the prompts you typed, not what Claude answered.
- A session open in another VS Code window or an outside terminal is shown, but cannot be jumped to.
- Claude Code deletes old transcripts; a session whose transcript is gone shows struck through and cannot be resumed.
- It reads Claude Code's own files in `~/.claude`, which are not a documented API. If a Claude Code update breaks the panel, `sessions.js` is where to look.

## Develop

No dependencies and no build step. `npm test` checks `sessions.js`.
