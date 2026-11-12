// @ts-check
'use strict';
const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./sessions');

const CLAUDE = path.join(os.homedir(), '.claude');
const tilde = p => (p && p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  // ponytail: the lists and names live in VS Code's own per-computer storage.
  // Move them to a JSON file when Claude itself has to mark a session finished.
  /** @type {{active: string[], finished: string[], names: Record<string, string>, seen: Record<string, number>}} */
  const st = Object.assign({ active: [], finished: [], names: {}, seen: {} }, context.globalState.get('state'));
  const save = () => context.globalState.update('state', st);

  /** @type {vscode.WebviewView | undefined} */
  let view;
  let sessions = new Map(), live = new Map(), pushed = '';
  const tails = new Map(), hist = {};
  /** Terminals this extension opened, by session id. @type {Map<string, {term: vscode.Terminal, sentAt: number}>} */
  const own = new Map();

  const history = () => S.readHistory(CLAUDE, hist);
  const post = m => { view?.webview.postMessage(m); };
  const listed = id => st.active.includes(id) || st.finished.includes(id);
  const nameOf = id => st.names[id] || sessions.get(id)?.title || S.oneLine(history().get(id)?.prompts[0]?.text ?? '', 60) || id.slice(0, 8);

  function tick() {
    if (!view) return;
    try {
      sessions = S.scan(CLAUDE, tails, history());
      live = S.readLive(CLAUDE);
      const row = id => {
        const s = sessions.get(id), l = live.get(id), mark = S.markOf(l, st.seen[id]);
        return { id, name: nameOf(id), mark, sub: S.subline(mark, s?.last, s?.cwd), t: l ? l.statusUpdatedAt || l.updatedAt : s?.mtime, gone: !s && !l };
      };
      const state = { type: 'state', total: sessions.size, active: st.active.map(row), finished: st.finished.map(row) };
      const json = JSON.stringify(state);
      if (json === pushed) return;
      pushed = json;
      post(state);
      const need = state.active.filter(r => r.mark === 'need').length;
      view.badge = need ? { value: need, tooltip: need === 1 ? '1 session needs you' : `${need} sessions need you` } : undefined;
    } catch (e) {
      console.error('claude-sessions:', e);
    }
  }

  const markSeen = id => { if (listed(id)) { st.seen[id] = Date.now(); save(); } };

  /** Returns a lookup from a claude process id to the terminal of this window that hosts it, if any. */
  async function terminalFinder() {
    const shells = new Map();
    for (const t of vscode.window.terminals) { const p = await t.processId; if (p) shells.set(p, t); }
    let parent = new Map();
    try {
      // claude runs inside the terminal's shell, so walking up its parents reaches the shell VS Code started.
      parent = new Map(execFileSync('ps', ['-A', '-o', 'pid=,ppid=']).toString().trim().split('\n').map(l => /** @type {[number, number]} */(l.trim().split(/\s+/).map(Number))));
    } catch { /* no ps: every open session will look like it lives outside this window */ }
    return pid => {
      for (let p = pid, i = 0; p > 1 && i < 10; i++, p = parent.get(p)) if (shells.has(p)) return shells.get(p);
    };
  }

  async function open(id) {
    markSeen(id);
    tick();
    const find = await terminalFinder(), l = live.get(id);
    if (l) {
      // Already open: go to it, never start a second program on the same conversation.
      const t = find(l.pid);
      if (t) t.show(); else post({ type: 'away', id, cwd: tilde(l.cwd) });
      return;
    }
    const s = sessions.get(id);
    if (!s) return void vscode.window.showWarningMessage('Claude Code has deleted the transcript of this session, so it cannot be resumed.');
    let mine = own.get(id);
    const taken = mine && [...live.values()].some(x => find(x.pid) === mine.term); // another session runs in that terminal now
    if (!mine || mine.term.exitStatus !== undefined || taken) {
      if (!s.cwd || !fs.existsSync(s.cwd)) return void vscode.window.showErrorMessage(`The folder this session was started in is gone: ${s.cwd}`);
      mine = { term: vscode.window.createTerminal({ name: nameOf(id), cwd: s.cwd, location: vscode.TerminalLocation.Panel }), sentAt: 0 };
      own.set(id, mine);
    }
    mine.term.show();
    if (Date.now() - mine.sentAt < 10000) return; // clicked twice: claude is still starting
    mine.term.sendText(`claude --resume ${id}`); // id passed the UUID check in onMessage
    mine.sentAt = Date.now();
  }

  /** Messages from the panel. It is a web page: check everything it sends. */
  async function onMessage(m) {
    const id = typeof m?.id === 'string' && S.UUID.test(m.id) ? m.id : undefined;
    switch (m?.type) {
      case 'ready': pushed = ''; return tick();
      case 'search': {
        const q = String(m.q ?? '');
        const where = h => (st.active.includes(h.id) ? 'active' : st.finished.includes(h.id) ? 'finished' : '');
        return post({ type: 'results', q, items: S.search(q, sessions, history(), nameOf).map(h => ({ ...h, name: nameOf(h.id), where: where(h) })) });
      }
      case 'open': return id && open(id);
      case 'reorder':
        if (!Array.isArray(m.ids) || m.ids.length !== st.active.length || new Set(m.ids).size !== m.ids.length || !m.ids.every(x => st.active.includes(x))) return;
        st.active = m.ids;
        break;
      case 'add':
        if (!id) return;
        st.finished = st.finished.filter(x => x !== id);
        if (!st.active.includes(id)) st.active.push(id);
        st.seen[id] = Date.now();
        break;
      case 'finish':
        if (!id) return;
        st.active = st.active.filter(x => x !== id);
        if (!st.finished.includes(id)) st.finished.unshift(id);
        break;
      case 'remove':
        if (!id) return;
        st.active = st.active.filter(x => x !== id);
        st.finished = st.finished.filter(x => x !== id);
        delete st.seen[id];
        break;
      case 'rename': {
        if (!id) return;
        const name = S.oneLine(m.name ?? '', 120);
        if (name) st.names[id] = name; else delete st.names[id]; // empty goes back to Claude's title
        break;
      }
      default: return;
    }
    save();
    tick();
  }

  function html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = f => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('panel.css')}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri('panel.js')}"></script>
</body>
</html>`;
  }

  const timer = setInterval(tick, 1000);
  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.window.registerWebviewViewProvider('claudeSessions.list', {
      resolveWebviewView(v) {
        view = v;
        pushed = '';
        v.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
        v.webview.html = html(v.webview);
        v.webview.onDidReceiveMessage(onMessage);
        v.onDidDispose(() => { if (view === v) view = undefined; });
      },
    }, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.onDidCloseTerminal(t => { for (const [id, m] of own) if (m.term === t) own.delete(id); }),
    // Switching to a session's terminal counts as having looked at its reply.
    vscode.window.onDidChangeActiveTerminal(async t => {
      if (!t || !st.active.some(id => live.has(id))) return;
      const find = await terminalFinder();
      for (const id of st.active) { const l = live.get(id); if (l && find(l.pid) === t) markSeen(id); }
      tick();
    }),
  );
}

module.exports = { activate, deactivate() {} };
