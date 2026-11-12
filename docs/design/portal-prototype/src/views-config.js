/* Govern › Configuration: the index of every registered key, the one setting page (A.cfg pattern), and the M1 card of a
   revision. Area screens (Integrations, Models and routes, project settings, Sandboxes, Notifications) link into it. */
(function () {
  const D = A.data, E = A.esc, J = A.j, C = A.cfg, I = C._internal;
  const FLEET = { type: 'Fleet' };
  const name = (id) => (id === 'seed' ? 'the seed' : (D.PEOPLE[id] || { name: id }).name);
  const rulesHtml = (list) => `<div class="dc-rule">${J(list, ([k, h]) => `<div><span class="dc-ico ${k}">${{ ok: '✓', warn: '!', bad: '✕', info: 'i' }[k]}</span><span>${h}</span></div>`)}</div>`;
  const projName = (p) => (p === 'factory' ? 'Factory' : (A.project(p) || { name: p }).name);

  /* ---------------------------------------------------------------- pending revisions as inbox rows */
  C.inboxRows = () => Object.values(C.L).flat().filter((r) => r.state === 'pending').map((r) => {
    C.register(r);
    const p = C.projOfRev(r); const keys = Object.keys(r.changes);
    return { kind: 'config', gate: 'M1', key: r.id, p, title: `Config: ${keys.map((k) => C.KEYS[k].label).join(', ')} (${p === 'factory' ? 'factory' : projName(p)} r${r.rev})`, sub: `${keys.join(', ')} · proposed by ${name(r.proposer)}` };
  });

  /* ---------------------------------------------------------------- the M1 card of a revision (rendered by the gate view's shell) */
  const m1Gate = (it, key) => {
    const r = C.revById(key);
    if (!r) return null;
    const p = C.projOfRev(r), factory = p === 'factory';
    const keys = Object.keys(r.changes);
    const diffs = keys.map((k) => { const scope = factory ? null : p; const base = r.state === 'pending' ? C.inForce(k, scope).doc : (C.L[r.layer].filter((x) => x.state === 'published' && x.rev < r.rev && k in x.changes).sort((a, b) => b.rev - a.rev)[0] || { changes: { [k]: C.KEYS[k].def } }).changes[k]; return { k, d: C.diffHtml(k, base, r.changes[k]), errs: C.validate(k, scope, r.changes[k]) }; });
    const errs = diffs.flatMap((x) => x.errs); const hard = errs.filter((e) => e.level === 'error');
    const main = A.card('The change', J(diffs, (x) => `<div style="margin-bottom:12px"><div class="row between small" style="margin-bottom:6px"><a class="mono" href="${C.href(x.k, p)}">${E(x.k)}</a><span class="faint">${x.d.changed ? `+${x.d.adds} −${x.d.dels} lines` : 'no change'}</span></div>${x.d.html}</div>`), { actions: '<span class="tiny faint">canonical JSON, keys sorted (RFC 8785)</span>' }) +
      A.card('Checks run on the proposal', rulesHtml([
        [hard.length ? 'bad' : 'ok', hard.length ? `<b>${hard.length} problem${hard.length === 1 ? '' : 's'}</b>: ${E(hard.map((e) => e.m).join('; '))}. The server would refuse this proposal.` : 'Schema and cross-key rules pass (ConfigRegistry.validate: the same functions the server runs).'],
        ...errs.filter((e) => e.level === 'warn').map((e) => ['warn', E(e.m)]),
        ['ok', 'Secret ruleset over the whole document: no finding. Credentials appear only as file: references.'],
        ['info', `Parent: ${factory ? 'factory' : 'project'} r${r.parent} (the published head when it was proposed). If the head moves first, publish is refused (stale_parent).`],
        ['info', 'Items in flight keep the settings they pinned; readers follow the new revision from their next read, with no restart.'],
      ]));
    const facts = [['Layer', factory ? 'factory (one document for the fleet)' : `project · ${E(projName(p))}`], ['Revision', `<span class="mono">r${r.rev}</span> · ${A.hash(r.hash, 12)}`], ['Keys', J(keys, (k) => `<a class="mono small" href="${C.href(k, p)}">${E(k)}</a> `)], ['Proposed by', `${A.who(r.proposer)} <span class="tiny faint">${factory ? 'config.propose' : 'project.settings.edit'}</span>`], ['Proposed', E(r.at)], ['Reason given', r.reason ? `“${E(r.reason)}”` : '<span class="faint">none</span>']];
    const state = r.state;
    const noDecision = state === 'pending' ? null : A.card('This revision is not open', rulesHtml([[state === 'published' ? 'ok' : 'info', state === 'published' ? `Published: M1 approved by ${E(name(r.decider))}, ledger ${C.ledgerRef(r.ledger)}.` : state === 'superseded' ? 'Superseded: a newer proposal on the same layer replaced it before anyone decided it. Each layer has at most one pending revision.' : `Closed: ${E(state)} by ${E(name(r.decider))}. Nothing changed.`]]));
    return {
      title: `Config change: ${E(keys.map((k) => C.KEYS[k].label).join(', '))}`,
      sub: factory ? 'A factory setting changes only through M1: one factory admin proposes, a different factory admin approves, and the ledger records both.' : `A project setting changes only through M1: someone proposes, the admin slot of ${E(projName(p))} approves, never the proposer.`,
      sentence: `May <span class="mono">${factory ? 'factory' : E(p)}</span> r${r.rev} be published?`,
      subject: { hash: r.hash, binds: [[`${factory ? 'factory' : 'project'} r${r.rev} (proposed)`, r.hash], [`r${r.parent} (head)`, C.hx(r.layer + r.parent)]] },
      facts, main, noDecision,
      crumbs: `<a href="#inbox">Inbox</a><span>›</span>${factory ? '<a href="#config">Configuration</a>' : `<a href="#project-${p}">${E(projName(p))}</a>`}<span>›</span><span>M1 r${r.rev}</span>`,
      actions: `<a class="btn sm" href="${C.href(keys[0], p)}">Open the setting</a>`,
      rules: [['info', factory ? '<b>One proposes, another approves.</b> Decided 2026-11-11: a factory admin other than the proposer. Which role and how many people is itself a setting (factory.m1_policy, not built).' : '<b>One proposes, another approves.</b> The project’s admin slot decides M1; the proposer is barred, a sole holder is stamped sod_waiver (never at T2).'], ['info', '<b>No step-up</b> for M1, and expiry never approves.']],
      options: { approve: 'Approve and publish', changes: 'Send back', reject: 'Reject' },
      readWhat: 'the diff',
      after: 'The config service publishes the revision; consumers follow it by revision (NOTIFY plus a poll).',
      onDecided: (d) => { C.publish(r, d.by, d.outcome); },
    };
  };
  if (A.dcx) A.dcx.g.M1 = m1Gate;
  C.inboxRows();

  /* ---------------------------------------------------------------- the setting page: the one pattern */
  const DRAFTS = {};
  const parseRoute = (s) => { const [key, scope] = String(s).split('@'); return { key, scope: scope || null }; };
  const decidersBlock = (key, scope) => {
    const fake = { layer: C.layerOf(key, scope), proposer: A.me(), rev: 0 };
    const c = C.m1Check(fake, '__nobody__');
    const free = c.eligible.filter((e) => !e.blocked);
    return `<div class="stack" style="gap:8px">${J(c.eligible, (e) => `<div class="row between" style="flex-wrap:nowrap;gap:8px">${A.who(e.pid)}<span class="tiny ${e.blocked ? 'cf-bad' : 'faint'}">${e.blocked ? 'you: barred as the proposer' : E(e.via)}</span></div>`) || '<span class="small muted">Nobody holds the slot: nobody could decide a proposal.</span>'}
      <p class="tiny muted">${C.KEYS[key].layer === 'factory' ? 'Gate M1, factory layer. Default decider (PLAN §7a, 2026-11-11): a factory admin other than the proposer.' : `Gate M1 at the admin slot of ${E(projName(scope))}. The bootstrap requester decided the first one at card 4.`} ${free.length ? `${free.length} could decide your proposal.` : '<b>Nobody else could decide your proposal.</b>'}</p></div>`;
  };
  const historyBlock = (key, scope, canProp) => {
    const hs = C.historyOf(key, scope);
    if (!hs.length) return A.empty('No revision has set this key: the registry default is in force.');
    const head = C.inForce(key, scope).rev;
    return `<ul class="tl cf-tl">${J(hs, (r) => `<li><span class="when">r${r.rev}</span><span class="dot ${r.state === 'published' ? (head && r.rev === head.rev ? 'g' : 'h') : r.state === 'pending' ? 'b' : 'x'}"></span><div class="what"><div class="t">${E(r.state)}${head && r.rev === head.rev ? ' · in force' : ''} <span class="faint small">${E(r.at)}</span></div>
      <div class="m">${r.genesis ? 'seed, GenesisEligibility' : `${E(name(r.proposer))} → ${r.decider ? 'M1 ' + E(name(r.decider)) : r.state === 'pending' ? 'M1 open' : '—'}`}<br>ledger ${C.ledgerRef(r.ledger)}${r.reason ? `<br>“${E(r.reason)}”` : ''}</div>
      ${r.state === 'pending' ? `<a class="small" href="#gate-M1-${r.id}">Open M1 r${r.rev}</a>` : r.state === 'published' && head && r.rev !== head.rev && canProp ? `<button class="btn ghost sm" data-rollback="${r.rev}">Draft a rollback to r${r.rev}</button>` : ''}</div></li>`)}</ul><p class="tiny faint">Rollback is a new revision whose document equals an older one. Nothing is edited in place.</p>`;
  };
  const errList = (errs) => (errs.length ? `<ul class="cf-errs">${J(errs, (e) => `<li class="${e.level}"><span class="dc-ico ${e.level === 'error' ? 'bad' : 'warn'}">${e.level === 'error' ? '✕' : '!'}</span><span>${e.p && e.p.length ? `<span class="mono">${E(e.p.join('.'))}</span>: ` : ''}${E(e.m)}</span></li>`)}</ul>` : `<div class="dc-rule"><div><span class="dc-ico ok">✓</span><span>Schema and rules pass. The server runs the same checks again on propose.</span></div></div>`);
  const lockBtn = (label, reason) => `<button class="btn primary locked" aria-disabled="true" data-cflock="${E(reason)}" title="${E(reason)}">${A.icon('lock', 13)} ${E(label)}</button>`;

  const settingPage = (key, scope) => {
    const k = C.KEYS[key];
    const f = C.inForce(key, scope); const layer = C.layerOf(key, scope); const pend = C.pendingOf(layer);
    const res = C.resOf(key, scope); const act = C.proposeAction(key);
    const can = A.can(act, res) && !k.planned && !k.readOnly;
    const dk = `${key}|${scope || ''}`;
    if (!DRAFTS[dk]) DRAFTS[dk] = { doc: I.clone(f.doc), reason: '', base: f.rev ? f.rev.rev : 0 };
    const dr = DRAFTS[dk];
    const errs = C.validate(key, scope, dr.doc); const hard = errs.filter((e) => e.level === 'error');
    const diff = C.diffHtml(key, f.doc, dr.doc);
    const project = k.layer === 'project' ? A.project(scope) : null;
    const crumbs = project ? `<a href="#projects">Projects</a><span>›</span><a href="#project-${scope}">${E(project.name)}</a><span>›</span><a href="#project-${scope}" data-tabgo="pd:set">Settings</a><span>›</span><span>${E(k.label)}</span>` : `<a href="#config">Configuration</a><span>›</span><span>${E(k.area)}</span><span>›</span><span class="mono">${E(key)}</span>`;
    const banners = [];
    if (k.planned) banners.push(`<div class="banner warn">${A.icon('lock', 14)}<span><b>Not built yet.</b> ${E(k.planned)} The form shows the decided shape so the screen is ready; Propose stays locked until the key is registered.</span></div>`);
    if (k.readOnly) banners.push(`<div class="banner info">${A.icon('lock', 14)}<span><b>Code, not a form.</b> ${E(k.readOnly)}</span></div>`);
    if (k.layer === 'factory' && !k.planned) banners.push(`<div class="banner info">${A.icon('config', 14)}<span><b>Factory M1 is decided, not built.</b> A factory admin other than the proposer approves (PLAN §7a). Until M15 builds the decider and a factory propose route, this screen is the design; today only the seed decides factory revisions.</span></div>`);
    if (pend) banners.push(`<div class="banner ${key in pend.changes ? 'gate' : 'warn'}">${A.icon('inbox', 14)}<span><b>r${pend.rev} is pending on this layer</b> (${E(Object.keys(pend.changes).join(', '))}), proposed by ${E(name(pend.proposer))}. ${key in pend.changes ? 'It changes this key.' : 'It changes another key of the same layer.'} Proposing now <b>supersedes</b> it: each layer has one pending revision at a time (gap 4).</span><span class="sp"></span><a class="btn sm" href="#gate-M1-${pend.id}">Open M1 r${pend.rev}</a></div>`);
    const proposeBtn = k.planned ? lockBtn('Propose (opens M1)', `Not built: ${k.planned}`) : k.readOnly ? lockBtn('Propose (opens M1)', k.readOnly) : !A.can(act, res) ? A.act('Propose (opens M1)', act, res, { cls: 'primary' }) : `<button class="btn primary" data-cfpropose ${hard.length || !diff.changed ? 'disabled' : ''}>Propose (opens M1)</button>`;
    const consumer = k.consumer ? k.consumer(f.doc) : null;
    const draftCard = A.card(can ? `Draft a change <span class="small faint">from r${dr.base || 0}${f.rev ? '' : ' (default)'}</span>` : 'The form (read only for you)', `<form class="cf-form" data-cfform onsubmit="return false">${C.renderField(k.schema, dr.doc, [], errs, !can, k.schema.label || k.label)}</form>`, { actions: can ? '<button class="btn ghost sm" data-cfreset>Discard draft</button>' : '' });
    return `<div class="cf-root">` + A.pageHead({
      crumbs, eyebrow: `${k.layer === 'factory' ? 'factory layer' : 'project layer · ' + E(project.name)} · ${E(k.schemaName || 'schema')}`,
      title: E(k.label), sub: E(k.desc), actions: C.statusPill(k),
    }) + banners.join('') +
    `<div class="split cf-split"><div class="stack">
      ${A.card('In force', `${A.kv([
        ['Value', `<span class="cf-brief">${E(C.brief(key, scope))}</span>`],
        ['Comes from', f.rev ? `${f.source} layer · revision <span class="mono">r${f.rev.rev}</span> · ${A.hash(f.rev.hash, 10)}` : 'the registry default (no layer sets it)'],
        f.rev ? ['Proposed by', f.rev.genesis ? 'the seed (genesis)' : A.who(f.rev.proposer)] : null,
        f.rev ? ['M1 decided by', f.rev.genesis ? 'the seed (GenesisEligibility)' : `${A.who(f.rev.decider)} · approve`] : null,
        f.rev ? ['Ledger', `${C.ledgerRef(f.rev.ledger)} · ${E(f.rev.at)}`] : null,
      ])}<details class="cf-json"><summary>Document in force (canonical JSON)</summary><pre class="code">${E(I.lines(f.doc).join('\n'))}</pre></details>`)}
      ${draftCard}
      ${A.card('Diff against what is in force', `<div data-cfdiff>${diff.html}</div>`)}
      ${A.card('Checks', `<div data-cferrs>${errList(errs)}</div>`)}
      <section class="card cf-propose"><div class="bd stack" style="gap:10px">
        <div class="field"><label for="cf-reason">Reason <span class="faint">(goes on the M1 card and the ledger)</span></label><textarea class="input" id="cf-reason" rows="2" data-cfreason ${can ? '' : 'disabled'} placeholder="Why this change">${E(dr.reason)}</textarea></div>
        <div class="row" style="justify-content:flex-end;gap:8px"><span class="tiny faint" style="margin-right:auto">${can ? 'Nothing changes until a person other than you decides the M1 card.' : k.planned || k.readOnly ? '' : 'You can read this setting. Proposing needs ' + E(act) + '.'}</span>${proposeBtn}</div>
      </div></section>
    </div><aside class="stack">
      ${A.card('Who decides', decidersBlock(key, scope))}
      ${consumer ? A.card('What the reader answers', `<div class="small"><div class="mono tiny faint" style="margin-bottom:6px">${E(consumer.who)} · ${E(consumer.route)}</div>${J(consumer.lines, (l) => `<div class="cf-cline">${E(l)}</div>`)}</div>`) : ''}
      ${A.card('About this key', A.kv([['Key', `<span class="mono">${E(key)}</span>`], ['Layer', k.layer === 'factory' ? 'factory (fleet, not overridable)' : 'project'], ['Schema', `<span class="mono small">${E(k.schemaName || '—')}</span> <span class="tiny faint">contracts</span>`], ['Registered by', `<span class="small">${E(k.registeredBy || 'not registered yet')}</span>`], ['Read by', `<span class="small">${E(k.readBy || '—')}</span>`], ['Proposes', `<span class="mono small">${E(act)}</span>`], ['Backend', `${C.statusPill(k)}<div class="tiny faint" style="margin-top:4px">${E(k.milestone || '')}</div>`]]))}
      ${A.card('History', historyBlock(key, scope, can))}
    </aside></div></div>`;
  };
  const settingMount = (root, key, scope) => {
    const k = C.KEYS[key]; const dk = `${key}|${scope || ''}`; const dr = DRAFTS[dk];
    const f = C.inForce(key, scope);
    const refreshSide = () => {
      const errs = C.validate(key, scope, dr.doc); const d = C.diffHtml(key, f.doc, dr.doc);
      root.querySelector('[data-cfdiff]').innerHTML = d.html; root.querySelector('[data-cferrs]').innerHTML = errList(errs);
      const b = root.querySelector('[data-cfpropose]'); if (b) b.disabled = errs.some((e) => e.level === 'error') || !d.changed;
    };
    const rerenderForm = () => {
      const fid = document.activeElement && document.activeElement.id;
      const errs = C.validate(key, scope, dr.doc);
      root.querySelector('[data-cfform]').innerHTML = C.renderField(k.schema, dr.doc, [], errs, false, k.label);
      refreshSide();
      if (fid) { const el = document.getElementById(fid); if (el) el.focus(); }
    };
    const readVal = (el) => { const t = el.dataset.t; if (t === 'bool') return el.checked; if (t === 'int') return el.value === '' ? undefined : parseInt(el.value, 10); if (t === 'num') return el.value === '' ? undefined : parseFloat(el.value); if (el.value === '' && t === 'enum') return undefined; return el.value; };
    root.addEventListener('input', (e) => { const el = e.target.closest('[data-p]'); if (el) { const p = JSON.parse(el.dataset.p); const v = readVal(el); if (v === undefined) { if (p.length) I.delAt(dr.doc, p); } else dr.doc = I.setAt(dr.doc, p, v); if (el.dataset.t === 'bool') { const sp = el.parentElement.querySelector('span'); if (sp) sp.textContent = v ? 'on' : 'off'; } refreshSide(); } if (e.target.matches('[data-cfreason]')) dr.reason = e.target.value; });
    root.addEventListener('change', (e) => {
      const el = e.target.closest('[data-p]'); if (el) { rerenderForm(); return; }
      const one = e.target.closest('[data-oneof]'); if (one) { const p = JSON.parse(one.dataset.oneof); const s = I.schemaAt(k.schema, p, dr.doc); const tag = s.tag || 'kind'; const c = s.cases[one.value]; const nv = { [tag]: one.value }; Object.entries(c.fields).forEach(([fk, fs]) => { if (!fs.optional) nv[fk] = I.blank(fs); }); dr.doc = I.setAt(dr.doc, p, nv); rerenderForm(); }
    });
    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-add],[data-del],[data-mapadd],[data-setdef],[data-cfreset],[data-cfpropose],[data-rollback]'); if (!t) return;
      e.preventDefault();
      if (t.dataset.add) { const p = JSON.parse(t.dataset.add); const s = I.schemaAt(k.schema, p, dr.doc); let arr = I.getAt(dr.doc, p); if (!Array.isArray(arr)) { arr = []; dr.doc = I.setAt(dr.doc, p, arr); } arr.push(s.add ? s.add() : I.blank(s.of)); rerenderForm(); return; }
      if (t.dataset.del) { I.delAt(dr.doc, JSON.parse(t.dataset.del)); rerenderForm(); return; }
      if (t.dataset.setdef) { const p = JSON.parse(t.dataset.setdef); { const sc = I.schemaAt(k.schema, p, dr.doc); dr.doc = I.setAt(dr.doc, p, sc && sc.t === 'list' ? (sc.add ? [sc.add()] : []) : I.blank(sc)); } rerenderForm(); return; }
      if (t.dataset.mapadd) { const p = JSON.parse(t.dataset.mapadd); const inp = t.parentElement.querySelector('.cf-newkey'); const nk = (inp && inp.value || '').trim(); if (!nk) { A.toast('Name the new entry first.'); return; } const s = I.schemaAt(k.schema, p, dr.doc); let obj = I.getAt(dr.doc, p); if (!obj || typeof obj !== 'object') { obj = {}; dr.doc = I.setAt(dr.doc, p, obj); } if (nk in obj) { A.toast(`${nk} is already there.`); return; } obj[nk] = s.add ? s.add() : I.blank(s.of); rerenderForm(); return; }
      if (t.hasAttribute('data-cfreset')) { DRAFTS[dk] = null; A.render(); return; }
      if (t.dataset.rollback) { const r = C.L[C.layerOf(key, scope)].find((x) => x.rev === +t.dataset.rollback); dr.doc = I.clone(r.changes[key]); dr.reason = `Roll back to r${r.rev}.`; A.render(); A.toast(`Draft set to the document of r${r.rev}. Review the diff, then propose.`); return; }
      if (t.hasAttribute('data-cfpropose')) {
        if (!A.can(C.proposeAction(key), C.resOf(key, scope))) return;
        const errs = C.validate(key, scope, dr.doc); if (errs.some((x) => x.level === 'error')) return;
        const reason = (root.querySelector('[data-cfreason]').value || '').trim();
        if (reason.length < 8) { A.toast('Write a reason first: it goes on the M1 card.'); root.querySelector('[data-cfreason]').focus(); return; }
        const pend = C.pendingOf(C.layerOf(key, scope));
        const go = () => { const { rev, superseded } = C.propose(key, scope, dr.doc, reason); DRAFTS[dk] = null; A.closeOverlay(); A.render(); A.toast(`Proposed r${rev.rev}. M1 opened for ${C.KEYS[key].layer === 'factory' ? 'a factory admin other than you' : 'the admin slot'}${superseded ? `; r${superseded.rev} is superseded` : ''}. Nothing changes until it is decided.`); };
        const m = A.modal(`<div class="row between"><h2>Propose this change</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
          <p class="muted">This records <span class="mono">config.proposed</span> for the full ${C.KEYS[key].layer} document and opens an M1 card. You cannot decide it.</p>
          ${pend ? `<div class="banner warn" style="margin:0">r${pend.rev} (${E(Object.keys(pend.changes).join(', '))}, by ${E(name(pend.proposer))}) is pending on this layer. Proposing supersedes it.</div>` : ''}
          ${C.diffHtml(key, f.doc, dr.doc).html}
          <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn primary" id="cf-go">Propose and open M1</button></div>`);
        m.querySelector('#cf-go').onclick = go;
      }
    });
  };
  A.view('cfg', {
    nav: false, parent: 'config', match: /^cfg-([a-z0-9_.]+(?:@[a-z0-9-]+)?)$/,
    access: ([s]) => { const { key, scope } = parseRoute(s); const k = C.KEYS[key]; if (!k) return null; if (k.layer === 'project') { if (!scope || !A.project(scope) || !A.canSeeProject(scope)) return null; return { action: 'project.view', res: { type: 'Project', project: scope } }; } return { action: A.can('config.propose', FLEET) ? 'config.propose' : 'audit.read', res: FLEET }; },
    deniedTitle: 'Factory configuration is for factory admins and auditors',
    render: ([s]) => { const { key, scope } = parseRoute(s); const k = C.KEYS[key]; if (!k || (k.layer === 'project' && (!scope || !A.project(scope) || !A.canSeeProject(scope)))) return A.notFoundHtml(); return settingPage(key, k.layer === 'project' ? scope : null); },
    mount: (root, [s]) => { const { key, scope } = parseRoute(s); if (C.KEYS[key] && root.querySelector('[data-cfform]')) settingMount(root, key, C.KEYS[key].layer === 'project' ? scope : null); },
  });

  /* ---------------------------------------------------------------- Govern › Configuration: the index */
  A.view('config', {
    label: 'Configuration', group: 'Govern', icon: 'config',
    access: () => ({ action: A.can('config.propose', FLEET) ? 'config.propose' : 'audit.read', res: FLEET }),
    deniedTitle: 'Factory configuration is for factory admins and auditors',
    badge: () => ({ n: Object.values(C.L).flat().filter((r) => r.state === 'pending' && r.layer === 'factory').length, hot: false }),
    render: () => {
      const keys = Object.values(C.KEYS);
      const fac = keys.filter((k) => k.layer === 'factory');
      const pend = Object.values(C.L).flat().filter((r) => r.state === 'pending' && (r.layer === 'factory' || A.canSeeProject(C.projOfRev(r))));
      const recent = Object.values(C.L).flat().filter((r) => r.state === 'published' && (r.layer === 'factory' || A.canSeeProject(C.projOfRev(r)))).sort((a, b) => (b.ledger || 0) - (a.ledger || 0)).slice(0, 8);
      const canProp = A.can('config.propose', FLEET);
      const row = (k) => `<div class="cf-irow" data-go="${C.href(k.key).slice(1)}" tabindex="0" role="link" aria-label="${E(k.label)}"><div class="cf-in"><a class="cf-tk" href="${C.href(k.key)}">${E(k.label)}</a><div class="mono tiny faint">${E(k.key)}</div></div>
        <div class="cf-iv small">${k.planned ? '<span class="muted">not built yet</span>' : E(C.brief(k.key))}</div><div class="tiny cf-is">${k.planned ? `<span class="muted">${E(k.milestone)}</span>` : C.setBy(k.key)}</div><div class="cf-ip">${C.pendingOf('factory') && k.key in C.pendingOf('factory').changes ? A.pill('pending', 'gate') : C.statusPill(k)}</div></div>`;
      const projRows = A.visibleProjects().filter((p) => p.level !== 'Onboarding');
      return A.pageHead({ eyebrow: 'Govern · @aisdlc/config', title: 'Configuration', sub: 'Every setting the factory reads at run time, as revisions of a layer. Each one opens the same screen: what is in force and which approved change set it, a draft form built from the contract schema, the diff, and Propose, which opens an M1 card someone else decides.', actions: canProp ? '' : '<span class="pill plain">read only: audit.read</span>' }) +
        A.stats([
          { k: 'Factory keys', v: fac.filter((k) => !k.planned).length, d: `${fac.filter((k) => k.planned).length} more decided, not built` },
          { k: 'Project keys', v: keys.filter((k) => k.layer === 'project' && !k.planned).length, d: 'per project: role map, two-person, gating, kill delegations' },
          { k: 'Pending M1', v: pend.length, d: pend.map((r) => `${r.layer === 'factory' ? 'factory' : C.projOfRev(r)} r${r.rev}`).join(', ') || 'none', tone: pend.length ? 'warn' : 'ok' },
          { k: 'Factory head', v: `r${Math.max(...C.L.factory.filter((r) => r.state === 'published').map((r) => r.rev))}`, d: 'one document for the fleet' },
        ]) +
        `<div class="banner info" style="margin-top:16px">${A.icon('lock', 14)}<span><b>Not config, on purpose:</b> secret values (only file: references), deployment bounds (GATEWAY_SECRET_REFS, GATEWAY_EGRESS_HOSTS, session policy), agent prompts and contracts, a released catalogue, the safety floors, the eval store, GitHub repo settings. Each is shown read-only where it lives.</span></div>` +
        `<div class="split cf-split" style="margin-top:16px"><div class="stack">${J(C.AREAS.filter((a) => a !== 'Project'), (area) => { const ks = fac.filter((k) => k.area === area); return ks.length ? A.card(E(area), `<div class="cf-index">${J(ks, row)}</div>`, { flush: true }) : ''; })}
          ${A.card('Project settings', projRows.length ? `<div class="cf-index">${J(projRows, (p) => `<div class="cf-irow" data-go="project-${p.id}" data-tabgo="pd:set" tabindex="0" role="link" aria-label="${E(p.name)} settings"><div class="cf-in"><a class="cf-tk" href="#project-${p.id}" data-tabgo="pd:set">${E(p.name)}</a><div class="mono tiny faint">${E(p.repo)}</div></div><div class="cf-iv small">${E(C.brief('project.gating_profile', p.id))}</div><div class="tiny cf-is">${C.setBy('project.gating_profile', p.id)}</div><div class="cf-ip">${C.pendingOf('project:' + p.id) ? A.pill('pending', 'gate') : A.pill('tier ' + C.tierOf(p.id), 'plain')}</div></div>`)}</div>` : A.empty('No project you can see.'), { flush: true })}
        </div><aside class="stack">
          ${A.card('Pending M1', pend.length ? `<div class="list">${J(pend, (r) => `<div class="li" tabindex="0" data-go="gate-M1-${r.id}"><span>${A.gate('M1')}</span><div style="min-width:0"><div class="ti">${E(Object.keys(r.changes).join(', '))}</div><div class="me">${r.layer === 'factory' ? 'factory' : E(projName(C.projOfRev(r)))} r${r.rev} · ${E(name(r.proposer))} · ${E(r.at)}</div></div></div>`)}</div>` : A.empty('Nothing is waiting for an M1 decision.'), { flush: true })}
          ${A.card('Recently published', `<ul class="tl">${J(recent, (r) => `<li><span class="when">r${r.rev}</span><span class="dot g"></span><div class="what"><div class="t">${E(Object.keys(r.changes).join(', '))}</div><div class="m">${r.layer === 'factory' ? 'factory' : E(projName(C.projOfRev(r)))} · ${r.genesis ? 'seed' : `${E(name(r.proposer))} → ${E(name(r.decider))}`}<br>ledger ${C.ledgerRef(r.ledger)}</div></div></li>`)}</ul>`)}
          ${A.card('How a change goes', `<ol class="small muted cf-steps"><li><b>Propose</b>: the full layer document is validated and recorded (<span class="mono">config.proposed</span>).</li><li><b>M1 opens</b> with the revision hash as subject; a newer proposal on the layer supersedes it.</li><li><b>Decide</b>: one approver, never the proposer, no step-up.</li><li><b>Publish</b> only with an approve of exactly that hash on the ledger; readers follow by revision.</li><li><b>Rollback</b> is a new revision equal to an older one.</li></ol>`)}
        </aside></div>`;
    },
  });

  document.addEventListener('click', (e) => { const t = e.target.closest('[data-cflock]'); if (!t) return; e.preventDefault(); A.drawer(`<div class="row between"><span class="eyebrow">Why this is locked</span><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div><h2>Not changed here</h2><div class="banner info" style="margin:0">${E(t.dataset.cflock)}</div><p class="small muted">The portal shows it so you know what is in force. Unknown means unmet: anything the backend does not support is refused (fail closed).</p>`); }, true);
  /* tab deep links: a link with data-tabgo="group:id" opens that tab after the route renders */
  document.addEventListener('click', (e) => { const t = e.target.closest('[data-tabgo]'); if (!t) return; A.pendingTab = t.dataset.tabgo; }, true);
  window.addEventListener('hashchange', () => { if (!A.pendingTab) return; const want = A.pendingTab; A.pendingTab = null; setTimeout(() => { const b = document.querySelector(`[data-tab="${want}"]`); if (b) b.click(); }, 0); });
})();
