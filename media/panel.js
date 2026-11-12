// @ts-check
// The panel. Runs inside a VS Code webview: it only draws what the extension sends and reports what was clicked.
// Session names and prompts are other people's text: they go in with textContent (via `h`), never innerHTML.
(function () {
  'use strict';
  // @ts-ignore provided by VS Code
  const vscode = acquireVsCodeApi();

  const svg = (size, body, extra = '') => `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" ${extra} aria-hidden="true">${body}</svg>`;
  const ICON = {
    search: svg(14, '<circle cx="6" cy="6" r="4.2"/><path d="M9.2 9.2 12.6 12.6"/>', 'stroke-width="1.4"'),
    work: svg(13, '<path d="M6.5 1.2V11.8M1.2 6.5H11.8M2.75 2.75 10.25 10.25M10.25 2.75 2.75 10.25"/>', 'stroke-width="1.5"'),
    rename: svg(14, '<path d="M2.5 11.5V9.3L9.4 2.4l2.2 2.2-6.9 6.9Z"/>', 'stroke-width="1.3"'),
    finish: svg(14, '<path d="M2.5 7.4 5.8 10.6 11.5 3.6"/>', 'stroke-width="1.4"'),
    back: svg(14, '<path d="M5.5 2.5 2.5 5.5l3 3M2.5 5.5h5.5a3 3 0 0 1 0 6H6.5"/>', 'stroke-width="1.3"'),
    remove: svg(14, '<path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/>', 'stroke-width="1.4"'),
    chevron: svg(12, '<path d="M4.5 2.5 8 6 4.5 9.5"/>', 'stroke-width="1.4"'),
  };
  const LABEL = { need: 'Needs you', work: 'Working', reply: 'New reply', open: 'Open in a terminal' };

  /** Element builder. Strings become text nodes, so nothing passed here is ever parsed as HTML. */
  const h = (tag, cls, ...kids) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    e.append(...kids.flat().filter(k => k != null && k !== ''));
    return e;
  };
  const icon = name => { const t = document.createElement('template'); t.innerHTML = ICON[name]; return /** @type {Element} */ (t.content.firstChild); };
  const act = (name, label, fn) => {
    const b = h('button', 'ic', icon(name));
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', e => { e.stopPropagation(); fn(); });
    return b;
  };
  const send = m => vscode.postMessage(m);

  let state = { total: 0, active: [], finished: [] };
  let q = '', results = null, renaming = null, justAdded = null, away = null, sel = null, foldOpen = false, dragId = null, timer;

  const input = /** @type {HTMLInputElement} */ (h('input'));
  input.type = 'text';
  input.placeholder = 'Find in sessions';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Find in sessions');
  const list = h('div', 'list');
  document.getElementById('app').append(h('div', 'top', h('label', 'find', icon('search'), input)), list);

  function ago(t) {
    if (!t) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h';
    const days = Math.floor(s / 86400);
    if (days === 1) return 'yesterday';
    if (days < 7) return days + ' days';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function mark(m) {
    const s = h('span', 'mk ' + (m || 'closed'), m === 'work' ? icon('work') : LABEL[m] ? h('i') : null);
    if (LABEL[m]) { s.title = LABEL[m]; s.setAttribute('role', 'img'); s.setAttribute('aria-label', LABEL[m]); }
    else s.setAttribute('aria-hidden', 'true');
    return s;
  }

  const sub = s => h('span', 'sub', s?.text, s?.code ? [' ', h('code', '', s.code)] : null);

  /** The name, or the field to change it. */
  function nameCell(r) {
    if (renaming !== r.id) { const b = h('button', 'nm', r.name); b.title = r.name; return b; }
    const i = /** @type {HTMLInputElement} */ (h('input', 'rename'));
    i.type = 'text';
    i.value = r.name;
    i.spellcheck = false;
    i.setAttribute('aria-label', 'Session name');
    const done = keep => {
      if (renaming !== r.id) return; // Enter and the blur that follows both land here
      renaming = justAdded = null;
      if (keep) { send({ type: 'rename', id: r.id, name: i.value }); r.name = i.value.trim() || r.name; }
      render();
    };
    i.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
    i.addEventListener('blur', () => done(true));
    return i;
  }

  function openSession(id) {
    sel = id;
    away = null;
    send({ type: 'open', id });
    render();
  }

  const onRowClick = id => e => { if (!e.target.closest('.acts, .add, input')) openSession(id); };

  /** Drag a row to put the Active list in your own order. */
  function draggable(el, id) {
    if (renaming === id) return;
    el.draggable = true;
    el.addEventListener('dragstart', e => { dragId = id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); el.classList.add('dragging'); });
    el.addEventListener('dragend', () => { dragId = null; render(); });
    el.addEventListener('dragover', e => {
      if (!dragId || dragId === id) return;
      e.preventDefault();
      const r = el.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      el.classList.toggle('drop-after', after);
      el.classList.toggle('drop-before', !after);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragId || dragId === id) return;
      const ids = state.active.map(r => r.id).filter(x => x !== dragId);
      ids.splice(ids.indexOf(id) + (el.classList.contains('drop-after') ? 1 : 0), 0, dragId);
      state.active.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); // show it at once; the extension confirms
      send({ type: 'reorder', ids });
    });
  }

  function row(r, kind) {
    const fresh = r.mark === 'need' || r.mark === 'reply';
    const el = h('div', 'row' + (fresh ? ' fresh' : '') + (r.id === sel ? ' sel' : '') + (r.gone ? ' gone' : ''));
    const acts = kind === 'finished'
      ? [act('back', 'Back to Active', () => send({ type: 'add', id: r.id })), act('remove', 'Remove from the list', () => send({ type: 'remove', id: r.id }))]
      : [act('rename', 'Rename', () => { renaming = r.id; render(); }), act('finish', 'Mark finished', () => send({ type: 'finish', id: r.id }))];
    el.append(mark(r.mark), nameCell(r), h('span', 'end has-acts', h('span', 'age', ago(r.t)), h('span', 'acts', acts)));
    if (r.mark === 'need') el.append(h('div', 'ask', sub(r.sub), h('button', 'go', 'Answer')));
    else if (r.sub) el.append(sub(r.sub));
    el.addEventListener('click', onRowClick(r.id));
    if (kind === 'active') draggable(el, r.id);
    const out = [el];
    if (away && away.id === r.id) {
      out.push(h('div', 'away', h('strong', '', 'Open in a terminal outside this window.'),
        h('span', '', 'It was started in ', h('code', '', away.cwd || 'another folder'), '. Continue it there: a session is never opened twice.')));
    }
    return out;
  }

  function listRows() {
    // A session that needs you sits on top until you answer, then goes back to its place.
    const out = state.active.filter(r => r.mark === 'need').flatMap(r => row(r, 'lifted'));
    if (out.length) out.unshift(h('div', 'gap'));
    out.push(h('div', 'zone', 'Active'));
    if (!state.active.length) {
      out.push(h('div', 'empty', h('strong', '', 'Nothing in your list yet.'), h('span', '', state.total
        ? `${state.total} session${state.total === 1 ? ' was' : 's were'} found on this computer. Find the ones you want to continue and add them here.`
        : 'No Claude Code sessions were found on this computer yet.')));
    }
    out.push(...state.active.filter(r => r.mark !== 'need').flatMap(r => row(r, 'active')));
    if (state.finished.length) {
      const f = h('button', 'fold' + (foldOpen ? ' on' : ''), icon('chevron'), h('span', '', 'Finished'), h('span', 'n', String(state.finished.length)));
      f.setAttribute('aria-expanded', String(foldOpen));
      f.addEventListener('click', () => { foldOpen = !foldOpen; render(); });
      out.push(f);
      if (foldOpen) out.push(...state.finished.flatMap(r => row(r, 'finished')));
    }
    return out;
  }

  function resultRows() {
    if (!results.length) return [h('div', 'empty', h('strong', '', `Nothing mentions “${q}”.`), h('span', '', 'Try a ticket number or a file name.'))];
    return results.map(r => {
      const el = h('div', 'row' + (r.id === sel ? ' sel' : ''));
      const tag = r.where === 'active' ? 'In your list' : r.where === 'finished' ? 'Finished' : ago(r.t);
      el.append(mark(), nameCell(r), h('span', 'end', h('span', 'age', tag)));
      const text = justAdded === r.id ? h('span', 'sub', 'Added to Active. Press Enter to save the name.')
        : r.snippet ? h('span', 'sub', 'you: ' + r.snippet.pre, h('b', '', r.snippet.hit), r.snippet.post)
        : h('span', 'sub', 'The name matches.');
      if (r.where === 'active') el.append(text);
      else {
        const add = h('button', 'add', 'Add to Active');
        add.addEventListener('click', () => { send({ type: 'add', id: r.id }); r.where = 'active'; renaming = justAdded = r.id; render(); });
        el.append(h('div', 'ask', text, add));
      }
      el.addEventListener('click', onRowClick(r.id));
      return el;
    });
  }

  function render() {
    // Redrawing would throw away a name being typed or a row being dragged; the next message or blur redraws.
    if (dragId || (renaming && document.activeElement?.classList.contains('rename'))) return;
    list.replaceChildren(...(results ? resultRows() : listRows()));
    const field = /** @type {HTMLInputElement | null} */ (list.querySelector('.rename'));
    if (field) { field.focus(); field.select(); }
  }

  input.addEventListener('input', () => {
    q = input.value.trim();
    clearTimeout(timer);
    if (!q) { results = null; render(); return; }
    timer = setTimeout(() => send({ type: 'search', q }), 150);
  });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { input.value = ''; input.dispatchEvent(new Event('input')); } });

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'state') state = m;
    else if (m.type === 'results' && m.q === q) results = m.items;
    else if (m.type === 'away') away = m;
    else return;
    render();
  });
  setInterval(render, 30000); // keeps "4 min" honest
  send({ type: 'ready' });
})();
