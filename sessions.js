// @ts-check
'use strict';
// Everything read from ~/.claude lives here, free of the vscode API, so `node test.js` can check it.
// These files are Claude Code internals, not a documented API: if a Claude Code update breaks the panel, look here first.
// ponytail: synchronous file reads on a one-second tick. Fine for tens of sessions; go async if the tick ever shows up in a profile.
const fs = require('fs');
const path = require('path');

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TAIL = 256 * 1024;

const ls = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
const oneLine = (s, max) => String(s).replace(/\s+/g, ' ').trim().slice(0, max);
/** Lower-case without accents, so "migracao" finds "Migração". */
const fold = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** How Claude Code names the folder that holds a project's transcripts. */
const enc = p => p.replace(/[^A-Za-z0-9]/g, '-');

/** The last TAIL bytes of a JSONL file, parsed. Transcripts reach hundreds of MB, so never read one whole. */
function readTail(file, size) {
  const len = Math.min(size, TAIL), buf = Buffer.alloc(len);
  let fd;
  try { fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, len, size - len); }
  catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (size > len) lines.shift(); // cut mid-line
  const out = [];
  for (const l of lines) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* a line still being written */ }
  }
  return out;
}

const endsOnQuestion = t => /\?$/.test(t.replace(/\S+:\/\/\S+/g, '').replace(/[\s*_`'")\]]+$/, ''));

const toolArg = input => {
  const i = input || {};
  return oneLine(i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description ?? i.prompt ?? '', 140);
};

/** Title, folders and the latest thing Claude did, from the end of a transcript. */
function describe(file, size) {
  let title, custom, last;
  const cwds = [];
  for (const e of readTail(file, size)) {
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    if (e.type === 'custom-title' && e.customTitle) custom = e.customTitle;
    if (typeof e.cwd === 'string' && !cwds.includes(e.cwd)) cwds.push(e.cwd);
    if (e.type !== 'assistant' || e.isSidechain || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b.type === 'tool_use') last = { tool: b.name, arg: toolArg(b.input) };
      else if (b.type === 'text' && b.text?.trim()) last = { text: oneLine(b.text, 140), asks: endsOnQuestion(b.text) };
    }
  }
  return { title: custom || title, cwds, last };
}

/** Every prompt typed on this computer, grouped by session. @returns {Map<string, {project?: string, prompts: {text: string, t: number}[]}>} */
function readHistory(claudeDir, cache) {
  const file = path.join(claudeDir, 'history.jsonl');
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return new Map(); }
  if (cache.mtime === mtime) return cache.map;
  const map = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || !e.sessionId || typeof e.display !== 'string') continue;
    let s = map.get(e.sessionId);
    if (!s) map.set(e.sessionId, s = { project: e.project, prompts: [] });
    s.prompts.push({ text: e.display, t: e.timestamp });
  }
  cache.mtime = mtime;
  cache.map = map;
  return map;
}

/** Every session that still has a transcript, so can be resumed. @returns {Map<string, {id: string, mtime: number, title?: string, cwd?: string, last?: any}>} */
function scan(claudeDir, cache, history) {
  const out = new Map(), root = path.join(claudeDir, 'projects');
  for (const dir of ls(root)) for (const f of ls(path.join(root, dir))) {
    const id = f.slice(0, -6);
    if (!f.endsWith('.jsonl') || !UUID.test(id)) continue;
    const file = path.join(root, dir, f);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    let c = cache.get(file);
    if (!c || c.mtime !== st.mtimeMs) {
      const d = describe(file, st.size);
      const folders = [...d.cwds, history?.get(id)?.project].filter(Boolean);
      // `claude --resume` only finds a session from the folder it was started in, which is the one this transcript folder is named after.
      const cwd = folders.find(p => enc(p) === dir) || c?.cwd || folders[0];
      c = { mtime: st.mtimeMs, title: d.title || c?.title, last: d.last || c?.last, cwd };
      cache.set(file, c);
    }
    out.set(id, { id, ...c });
  }
  return out;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Sessions open in a terminal right now, by session id. */
function readLive(claudeDir) {
  const out = new Map(), dir = path.join(claudeDir, 'sessions');
  for (const f of ls(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!d.sessionId || !Number.isInteger(d.pid) || !alive(d.pid)) continue; // a crash leaves the file behind
      const prev = out.get(d.sessionId);
      if (!prev || (d.updatedAt || 0) > (prev.updatedAt || 0)) out.set(d.sessionId, d);
    } catch { /* being written */ }
  }
  return out;
}

/** need = a prompt is open, or Claude ended its turn on a question · work = mid-turn · reply = answered, not looked at · open = idle in a terminal · closed */
function markOf(live, seenAt, last) {
  if (!live) return 'closed';
  if (live.status === 'waiting') return 'need';
  if (live.status === 'busy') return 'work';
  if (last?.asks) return 'need';
  return (live.statusUpdatedAt || 0) > (seenAt || 0) ? 'reply' : 'open';
}

const VERB = { Bash: 'Running', Edit: 'Editing', Write: 'Writing', Read: 'Reading', Grep: 'Searching', Glob: 'Searching', WebFetch: 'Fetching', WebSearch: 'Searching the web for', Agent: 'Delegating', Task: 'Delegating' };

/** The second line of a row. Only rows with news get one. */
function subline(mark, last, cwd) {
  const rel = a => (cwd && a.startsWith(cwd + path.sep) ? a.slice(cwd.length + 1) : a);
  if (mark === 'need') {
    // The status file only says "a dialog is open"; the last tool call is the best guess at what it is about.
    if (!last?.tool) return { text: last?.asks ? last.text : 'Waiting for your answer' };
    if (last.tool === 'Bash') return { text: 'Wants to run', code: last.arg };
    if (last.tool === 'AskUserQuestion') return { text: 'Asked you a question' };
    if (last.tool === 'ExitPlanMode') return { text: 'Wants you to review its plan' };
    return { text: `Wants to use ${last.tool}`, code: rel(last.arg) };
  }
  if (mark === 'work') return last?.tool ? { text: VERB[last.tool] || last.tool, code: rel(last.arg) } : { text: last?.text || 'Working' };
  if (mark === 'reply') return { text: last?.text || 'Replied' };
  return null;
}

/**
 * Sessions whose name or prompts contain q, newest first.
 * ponytail: searches names and what I typed, not what Claude answered. That is instant; transcripts are hundreds of MB.
 * Scan the transcripts (ripgrep) if this ever falls short.
 */
function search(q, sessions, history, nameOf) {
  const needle = fold(oneLine(q, 200));
  if (!needle) return [];
  const hits = [];
  for (const s of sessions.values()) {
    let count = fold(nameOf(s.id)).includes(needle) ? 1 : 0, snippet;
    for (const p of history.get(s.id)?.prompts || []) {
      // ponytail: offsets assume folding keeps string length, true for Latin text. Other scripts may get a shifted highlight.
      const text = oneLine(p.text, 4000).normalize('NFC'), i = fold(text).indexOf(needle);
      if (i < 0) continue;
      count++;
      const from = Math.max(0, i - 24), end = i + needle.length;
      snippet = { pre: (from ? '…' : '') + text.slice(from, i), hit: text.slice(i, end), post: text.slice(end, end + 80) };
    }
    if (count) hits.push({ id: s.id, count, snippet, t: s.mtime });
  }
  return hits.sort((a, b) => b.t - a.t).slice(0, 50);
}

module.exports = { UUID, oneLine, fold, enc, scan, readHistory, readLive, markOf, subline, search };
