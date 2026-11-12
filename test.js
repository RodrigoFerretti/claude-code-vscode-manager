// Self-check for sessions.js: `node test.js`. Builds a throwaway copy of the ~/.claude layout and reads it back.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./sessions');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-test-'));
const proj = '/tmp/my.proj_a';
const id = '11111111-2222-3333-4444-555555555555', dead = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const dir = path.join(root, 'projects', S.enc(proj));

try {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, 'sessions'));
  fs.writeFileSync(path.join(dir, id + '.jsonl'), jsonl([
    { type: 'user', cwd: proj + '/sub', message: { role: 'user', content: 'hi' } },
    { type: 'ai-title', aiTitle: 'Plan the data move' },
    { type: 'assistant', cwd: proj, isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] } },
    { type: 'assistant', cwd: proj, message: { content: [{ type: 'text', text: 'Let me\nrun the tests' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  ]) + '{"type":"assis'); // a line still being written
  fs.writeFileSync(path.join(dir, 'notes.jsonl'), '{}\n'); // not a session
  fs.writeFileSync(path.join(root, 'history.jsonl'), jsonl([
    { display: 'comece pela Migração dos dados', timestamp: 1, project: proj, sessionId: id },
    { display: 'migração too, but its transcript is gone', timestamp: 2, project: proj, sessionId: 'gone' },
  ]) + 'not json\n');
  fs.writeFileSync(path.join(root, 'sessions', '1.json'), JSON.stringify({ pid: process.pid, sessionId: id, status: 'waiting', statusUpdatedAt: 50 }));
  fs.writeFileSync(path.join(root, 'sessions', '2.json'), JSON.stringify({ pid: 2 ** 30, sessionId: dead, status: 'busy' })); // left by a crash
  fs.writeFileSync(path.join(root, 'sessions', '3.json'), '{"pid":'); // being written

  const history = S.readHistory(root, {});
  assert.strictEqual(history.get(id).prompts.length, 1);

  const sessions = S.scan(root, new Map(), history);
  assert.deepStrictEqual([...sessions.keys()], [id], 'only real transcripts are sessions');
  const s = sessions.get(id);
  assert.strictEqual(s.title, 'Plan the data move');
  assert.strictEqual(s.cwd, proj, 'the start folder is the one the transcript folder is named after, not the first seen');
  assert.deepStrictEqual(s.last, { tool: 'Bash', arg: 'npm test' }, 'sidechain and half-written lines are ignored');

  const live = S.readLive(root);
  assert.deepStrictEqual([...live.keys()], [id], 'a session file whose process died is not live');

  assert.strictEqual(S.markOf(undefined), 'closed');
  assert.strictEqual(S.markOf(live.get(id)), 'need');
  assert.strictEqual(S.markOf({ status: 'busy' }), 'work');
  assert.strictEqual(S.markOf({ status: 'idle', statusUpdatedAt: 50 }, 10), 'reply');
  assert.strictEqual(S.markOf({ status: 'idle', statusUpdatedAt: 50 }, 60), 'open');

  assert.deepStrictEqual(S.subline('need', s.last, proj), { text: 'Wants to run', code: 'npm test' });
  assert.deepStrictEqual(S.subline('work', { tool: 'Edit', arg: proj + '/src/a.ts' }, proj), { text: 'Editing', code: 'src/a.ts' });
  assert.deepStrictEqual(S.subline('reply', { text: 'Done.' }, proj), { text: 'Done.' });
  assert.strictEqual(S.subline('open', s.last, proj), null);

  const nameOf = x => sessions.get(x).title;
  const [hit, ...rest] = S.search('  MIGRACAO ', sessions, history, nameOf);
  assert.strictEqual(rest.length, 0, 'sessions without a transcript are never found');
  assert.strictEqual(hit.id, id);
  assert.deepStrictEqual(hit.snippet, { pre: 'comece pela ', hit: 'Migração', post: ' dos dados' });
  assert.strictEqual(S.search('plan', sessions, history, nameOf)[0].snippet, undefined, 'a name match has no snippet');
  assert.deepStrictEqual(S.search('zzz', sessions, history, nameOf), []);
  assert.deepStrictEqual(S.search('   ', sessions, history, nameOf), []);

  console.log('ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
