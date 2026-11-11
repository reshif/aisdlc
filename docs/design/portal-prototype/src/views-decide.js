/* views-decide: Inbox, gate decision screens, onboarding cards, projects, onboarding wizard, S0, readiness record, issue twin. */
(function () {
  const D = A.data, E = A.esc, J = A.j, X = A.access;

  /* ================================================================ small helpers */
  const hx = (s, n = 64) => { let out = '', i = 0; while (out.length < n) { let h = 0x811c9dc5 ^ i; for (const c of `${s}#${i}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } out += h.toString(16).padStart(8, '0'); i++; } return out.slice(0, n); };
  const ok = '<span class="dc-ico ok">✓</span>', warn = '<span class="dc-ico warn">!</span>', bad = '<span class="dc-ico bad">✕</span>', info = '<span class="dc-ico info">i</span>';
  const ICO = { ok, warn, bad, info };
  const rules = (list) => `<div class="dc-rule">${J(list.filter(Boolean), ([k, h]) => `<div>${ICO[k] || info}<span>${h}</span></div>`)}</div>`;
  const name = (id) => (A.person(id) || { name: id }).name;
  const first = (id) => name(id).split(' ')[0];
  const tag = (t, cls = '') => `<span class="dc-tag ${cls}">${E(t)}</span>`;
  const lvl = (l) => `<span class="dc-lvl ${E(l)}">${E(l)}</span>`;
  const cardTag = (label) => `<span class="gtag m"><i></i>${E(label)}</span>`;
  const live = {};
  const on = (key, el, type, fn) => { off(key); el.addEventListener(type, fn); live[key] = () => el.removeEventListener(type, fn); };
  const off = (key) => { if (live[key]) { live[key](); delete live[key]; } };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const OPEN = (i) => !['done', 'declined'].includes(i.state);
  const notFound = () => `<div class="ac-403"><div class="eyebrow">404</div><h1>Nothing here</h1><p class="muted">The link may be old, or it points into a project you cannot see. Items, gates and cards of projects you have no role on do not exist for you.</p><a class="btn" href="#home">Go home</a></div>`;

  /* ================================================================ access helpers (read the engine at render time, never at load) */
  const DECIDING = ['admin', 'requesters', 'intent', 'design', 'g4', 'g5', 'x', 'sec', 'm4'];
  const SLOT_ROLE = (slot) => X.ROLES.find((r) => r.slot === slot) || { role_id: slot };
  /** people holding a slot on a project, straight from the role bindings */
  const holders = (slot, project) => [...new Set(X.BINDINGS.filter((b) => !b.revoked && b.scope.kind === 'project' && b.scope.ref === project && X.ROLE[b.role] && X.ROLE[b.role].slot === slot).map((b) => b.pid))];
  const hasFleet = () => A.bindingsOf(A.me()).some((b) => b.scope.kind === 'fleet');
  const decidesOn = (project) => A.bindingsOf(A.me()).some((b) => b.scope.kind === 'project' && b.scope.ref === project && DECIDING.includes(X.ROLE[b.role].slot));
  const scopeName = (b) => (b.scope.kind === 'fleet' ? 'whole factory' : b.scope.kind === 'team' ? `team ${b.scope.ref}` : (A.project(b.scope.ref) || {}).name || b.scope.ref);
  const viaText = (w) => { const b = w && w.via && w.via[0]; return b ? `${A.roleLabel(b.role)} · ${scopeName(b)}` : ''; };
  /** an item chip that obeys the data class: below D1 the title is not shown */
  const ich = (key) => {
    const it = A.item(key); if (!it) return `<span class="mono">${E(key)}</span>`;
    if (A.dataClass(it.project) >= 1) return A.ichip(key);
    return `<a class="ichip" href="#item-${key}"><b style="background:${A.laneColor(it.lane)}">${key}</b><span class="faint" style="font-family:var(--body)">title hidden</span></a>`;
  };
  const DCNEED = { 1: 'a project role with data class D1, for example project.requester', 2: 'project.security_approver (data class D2)' };
  /** a "hidden: needs Dn" placeholder; Why opens the data-class explanation */
  const hidden = (need, what, project) => `<div class="dc-hidden">${A.icon('lock', 16)}<div style="min-width:0"><b>Hidden: needs D${need}</b><div class="small muted">${what}</div></div><button class="btn sm" data-dcwhy="${need}|${E(project)}">Why</button></div>`;
  const dcWhy = (need, project) => {
    const p = A.project(project), mine = A.dataClass(project);
    const roles = X.ROLES.filter((r) => X.DR[r.data_class] >= need);
    const why = A.bindingsOf(A.me()).filter((b) => b.scope.kind === 'fleet' || b.scope.ref === project);
    A.drawer(`<div class="row between"><span class="eyebrow">Why it is hidden</span><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      <h2>Needs data class D${need}</h2>
      <p class="muted">What text you see follows the data class of your roles on ${E(p ? p.name : project)}. D0 shows positions only, D1 adds titles and artefacts, D2 adds transcripts, tool-call logs, tripwire evidence and secret-finding details. The content is never sent to your browser: it is hidden, not blurred.</p>
      ${A.kv([['You', A.who(A.me())], ['Your data class here', `<span class="mono">${mine < 0 ? 'none' : 'D' + mine}</span>`], ['From', J(why, (b) => `<span class="pill plain">${A.roleLabel(b.role)} · ${X.ROLE[b.role].data_class}</span> `) || '<span class="faint">no role</span>'], ['Roles with D' + need, J(roles, (r) => `<span class="pill plain">${r.role_id}</span> `)]])}
      <div class="card"><div class="bd stack" style="gap:10px"><b>Ask for access</b><p class="small muted">The request goes to the project admin of ${E(p ? p.name : project)}. Every grant is a ledger entry.</p><button class="btn primary" data-reqaccess="${E(JSON.stringify({ action: 'project.view', res: { type: 'Project', project }, need: DCNEED[need] }))}">Request ${need === 2 ? 'project.security_approver' : 'project.requester'}</button></div></div>`);
  };
  if (!A.dcWhyBound) { A.dcWhyBound = true; document.addEventListener('click', (e) => { const t = e.target.closest('[data-dcwhy]'); if (!t) return; e.preventDefault(); const [n, p] = t.dataset.dcwhy.split('|'); dcWhy(+n, p); }); }

  /* decisions made in this prototype session, keyed by route */
  const DEC = {};
  const LAST = {};
  let SEQ = 18423;
  const LOG = [];
  const stamp = () => { const d = new Date(); return d.toTimeString().slice(0, 8); };

  // seeded: decisions already on the ledger before the page opened (bootstrap: Mei Wong asked for the Mobile App onboarding)
  DEC['card-C1-mobile'] = { outcome: 'approve', label: 'approved', reason: 'Owners are Alex and me for now; tier T1 is right (internal staff app, no card data). Gaps: fix the probe on iOS later.', by: 'mw', at: '2026-11-08 14:20', seq: 18390, hash: hx('c1m'), cp: 309, sod: true, seeded: true };
  DEC['card-SECR-mobile'] = { outcome: 'rotated', label: 'rotated', reason: 'Old AWS key for the crash uploader was deactivated in IAM on 2026-11-08 and replaced by the CI OIDC role.', by: 'mw', at: '2026-11-08 16:02', seq: 18396, hash: hx('secr'), cp: 309, sod: true, seeded: true };
  DEC['card-C2-mobile'] = { outcome: 'approve', label: 'approved', reason: '46 of 50 claims affirmed, 4 marked unknown (iOS build); AGENTS.md diff affirmed with step-up.', by: 'mw', at: '2026-11-09 11:47', seq: 18352, hash: hx('c2m'), cp: 308, sod: true, seeded: true };

  /* ================================================================ who may decide: gates */
  const KEY_PROJECT = { 'cfg-r7': 'payments' };
  const PROPOSER = { 'cfg-r7': 'lt' };
  const projOfKey = (key) => (A.item(key) || {}).project || KEY_PROJECT[key] || null;
  const withProject = (project, fn) => { const keep = A.state.project; A.state.project = project; try { return fn(); } finally { A.state.project = keep; } };
  const gateEligible = (gid, key) => {
    const it = A.item(key), project = projOfKey(key), gp = X.GATE_POLICY[gid] || { slot: 'admin' };
    const role = SLOT_ROLE(gp.slot).role_id;
    const pids = gid === 'G6' && it ? [it.requester] : holders(gp.slot, project);
    return pids.map((pid) => {
      let blocked = '';
      if (it && gp.own_request === 'blocked' && pid === it.requester) blocked = 'requester: blocked (SoD)';
      if (PROPOSER[key] === pid) blocked = 'proposer: blocked';
      return { pid, via: gid === 'G6' ? 'the requester' : A.roleLabel(role), blocked };
    });
  };
  /** A.decideCheck, plus two stricter rows the portal adds (fail closed: they only take away) */
  const gateCheck = (gid, key) => {
    const project = projOfKey(key), it = A.item(key), meId = A.me();
    const c = withProject(project, () => A.decideCheck(gid, key));
    const rows = c.rules.slice();
    if (gid === 'G6' && it) rows.splice(1, 0, it.requester === meId ? { ok: true, text: 'You asked for this work, so G6 is your acceptance.' } : { ok: false, text: `G6 is the requester’s acceptance: only ${name(it.requester)}, who asked for ${it.key}, accepts it.` });
    if (PROPOSER[key]) rows.push(PROPOSER[key] === meId ? { ok: false, text: 'You proposed this change. The proposer never approves its own M1.' } : { ok: true, text: `Separation of duties: ${name(PROPOSER[key])} proposed it, not you.` });
    return { ...c, rules: rows, allow: rows.every((r) => r.ok || r.info), eligible: gateEligible(gid, key), project, slot: (X.GATE_POLICY[gid] || {}).slot };
  };

  /* ================================================================ who may decide: onboarding cards */
  const CARD_SLOTS = { C1: ['admin'], C2: ['admin'], C4: ['admin', 'm4'], C5: ['admin', 'm4'], SECR: ['sec'] };
  const BOOT = { mobile: 'mw' };              // the person who asked for the onboarding (bootstrap grant)
  const SIGNED = { 'card-C5-ledger': ['so'] }; // the first of two M4 approvals already on the ledger
  const bootOn = (p) => !!BOOT[p] && !DEC[`card-C4-${p}`];
  const cardEligible = (c, p) => {
    const m = new Map();
    (CARD_SLOTS[c] || ['admin']).forEach((s) => holders(s, p).forEach((pid) => m.set(pid, A.roleLabel(SLOT_ROLE(s).role_id))));
    if (['C1', 'C2', 'C4', 'C5'].includes(c) && bootOn(p)) m.set(BOOT[p], m.has(BOOT[p]) ? `${m.get(BOOT[p])} · onboarding requester` : 'onboarding requester (bootstrap)');
    return [...m].map(([pid, via]) => ({ pid, via, signed: (SIGNED[`card-${c}-${p}`] || []).includes(pid), blocked: '' }));
  };
  const cardLabel = (c) => (c === 'SECR' ? 'The security card' : `Card ${c.slice(1)}`);
  const cardCheck = (c, p) => {
    const meId = A.me(), pr = A.project(p) || { name: p };
    const w = A.why('card.decide', { type: 'Card', project: p });
    const el = cardEligible(c, p), mine = el.find((e) => e.pid === meId);
    const slots = (CARD_SLOTS[c] || ['admin']).map((s) => SLOT_ROLE(s).role_id).join(' or ');
    const rows = [{ ok: w.allow, text: w.allow ? w.reason : `${w.reason} card.decide needs ${w.need}.` }];
    rows.push(mine ? { ok: true, text: `${cardLabel(c)} is yours: ${mine.via}.` } : { ok: false, text: `${cardLabel(c)} of ${pr.name} is decided by ${slots}${['C1', 'C2', 'C4', 'C5'].includes(c) && bootOn(p) ? `, or by ${name(BOOT[p])} under the bootstrap grant (until card 4)` : ''}. You hold none of these.` });
    if (mine && mine.signed) rows.push({ ok: false, text: 'You signed off this record (approval 1 of 2). M4 needs a different second person (DEC-28).' });
    if (c === 'C5') rows.push({ ok: true, info: true, text: 'Two-person rule: M4 needs two different approvers (DEC-28).' });
    const stepUp = c === 'C5' || c === 'C2';
    if (stepUp) rows.push({ ok: true, info: true, text: A.stepUpValid() ? 'Step-up is valid, bound to this decision.' : 'Step-up needed: you confirm with your security key before the decision is recorded.' });
    if (A.state.killed) rows.push({ ok: false, text: 'A kill covers this project. Nothing can be approved until it is released.' });
    return { allow: rows.every((r) => r.ok || r.info), rules: rows, stepUp, twoPerson: c === 'C5', eligible: el, why: w, project: p, slot: (CARD_SLOTS[c] || ['admin']).join(' / ') };
  };

  /* ================================================================ inbox rows, built for whoever is signed in */
  const T0 = Date.now();
  const DUE = { 'gate-G0G1-W-33': 188, 'gate-G3-W-27': -134, 'gate-G4-W-24': 292, 'gate-G2-W-26': 61, 'card-C4-mobile': 410, 'card-C5-ledger': 236, 'gate-M1-cfg-r7': 902, 'gate-X1-W-29': 95, 'gate-SECT-W-19': 140, 'gate-E4-W-18': 260, 'gate-G6-W-12': 360, 'gate-G3d-C-49': 520 };
  const OPENED = { 'gate-G0G1-W-33': '5h ago', 'gate-G3-W-27': '1d 2h ago', 'gate-G4-W-24': '2h ago', 'gate-G2-W-26': '23h ago', 'card-C4-mobile': '1h 40m ago', 'card-C5-ledger': '3h ago', 'gate-M1-cfg-r7': '40m ago', 'gate-X1-W-29': '3d ago', 'gate-SECT-W-19': '2d ago', 'gate-E4-W-18': '4h ago', 'gate-G6-W-12': '18h ago', 'gate-G3d-C-49': '6h ago' };
  const BACKUP = { payments: 'rb' };
  const OTHER = [
    { kind: 'card', c: 'C4', p: 'mobile', label: 'Card 4', title: 'Card 4: controls and roles', sub: 'S0-4c1e · step 0.4' },
    { kind: 'card', c: 'C5', p: 'ledger', label: 'M4', title: 'Card 5: sign-off and M4 (Light)', sub: 'S0-91b7 · prr/1 v2 · two-person' },
    { kind: 'config', gate: 'M1', key: 'cfg-r7', p: 'payments', title: 'Config: Payments API settings r6 → r7', sub: 'project.payments.settings · proposed by Luis Torres' },
  ];
  const allRows = () => {
    const out = [];
    A.visibleItems().filter((i) => i.gate && OPEN(i)).forEach((i) => {
      const chk = gateCheck(i.gate, i.key);
      const named = i.wait.length ? i.wait : chk.eligible.filter((e) => !e.blocked).map((e) => e.pid);
      out.push({ kind: 'gate', gate: i.gate, item: i.key, proj: i.project, route: `gate-${i.gate}-${i.key}`, title: (D.GATES[i.gate] || {}).title || i.gate, chk, named });
    });
    OTHER.forEach((r) => {
      if (!A.canSeeProject(r.p)) return;
      const chk = r.kind === 'card' ? cardCheck(r.c, r.p) : gateCheck(r.gate, r.key);
      out.push({ ...r, proj: r.p, route: r.kind === 'card' ? `card-${r.c}-${r.p}` : `gate-${r.gate}-${r.key}`, chk, named: chk.eligible.filter((e) => !e.blocked && !e.signed).map((e) => e.pid) });
    });
    return out.filter((r) => !DEC[r.route]);
  };
  const taskRows = () => A.visibleItems().filter((i) => OPEN(i) && !i.gate && i.state === 'waiting' && i.wait.includes(A.me()) && ['S1', 'S8'].includes(i.stage)).map((i) => (i.stage === 'S1'
    ? { kind: 'task', step: i.step, item: i.key, proj: i.project, route: `item-${i.key}`, title: 'Answer the S1 questions', why: 'You asked for this work', whyM: i.waitWhat || 'B1 parks after 2 rounds', allowed: A.can('item.ready', { type: 'Item', project: i.project, item: i.key }) }
    : { kind: 'task', step: i.step, item: i.key, proj: i.project, route: `gate-MERGE-${i.key}`, title: `Merge ${(i.pr || '').split('#')[1] ? 'PR #' + i.pr.split('#')[1] : 'the PR'} on GitHub`, why: 'Code owner who approved G4', whyM: 'the factory never merges', allowed: true }));
  const accessRows = () => A.ACCESS_REQUESTS.filter((r) => r.state === 'pending' && r.approver === A.me() && A.can('access.manage', r.project ? { type: 'Project', project: r.project } : { type: 'Fleet' })).map((r) => ({ kind: 'access', req: r, proj: r.project, route: 'access-requests', title: `${name(r.pid)} asks for ${r.role}`, why: r.project ? `You approve access on ${(A.project(r.project) || {}).name}` : 'You approve fleet roles', whyM: r.m6 ? 'approval-capable role: also needs M6' : `“${r.why}”` }));

  const fmtLeft = (sec) => { const a = Math.abs(sec), h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60), s = Math.floor(a % 60); return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`; };
  const slaHtml = (route, proj) => {
    const due = DUE[route];
    if (due == null) return `<div class="dc-sla ok">no SLA<small>${/^gate-MERGE|^item-/.test(route) ? 'a step, not a gate' : 'not a gate'}</small></div>`;
    const sec = due * 60 - (Date.now() - T0) / 1000;
    if (sec < 0) return `<div class="dc-sla over" data-due="${route}" data-proj="${E(proj || '')}">overdue ${fmtLeft(sec)}<small>B21: backup ${E(name(BACKUP[proj] || 'rb'))} notified (notify only)</small></div>`;
    return `<div class="dc-sla ${sec < 3600 * 1.5 ? 'soon' : 'ok'}" data-due="${route}" data-proj="${E(proj || '')}">${fmtLeft(sec)} left<small>SLA 1 business day</small></div>`;
  };
  const quorum = (r) => {
    if (!r.chk) return '<div class="dc-q faint">—</div>';
    const need = r.chk.twoPerson ? 2 : 1, done = (SIGNED[r.route] || []).length, may = r.chk.eligible.filter((e) => !e.blocked && !e.signed).length;
    return `<div class="dc-q">${J(Array.from({ length: need }), (_, i) => `<i class="${i < done ? 'on' : ''}"></i>`)} ${done} of ${need}<div class="tiny faint" style="font-family:var(--body)">${may ? `${may} may decide` : 'nobody eligible'}</div></div>`;
  };
  const rowTag = (r) => (r.kind === 'card' ? cardTag(r.label) : r.kind === 'config' ? A.gate('M1') : r.kind === 'task' ? `<span class="gtag e"><i></i>${E(r.step)}</span>` : r.kind === 'access' ? '<span class="pill info">access</span>' : A.gate(r.gate));
  const whyYou = (r) => {
    if (r.kind === 'task' || r.kind === 'access') return [r.why, r.whyM];
    const mine = r.chk.eligible.find((e) => e.pid === A.me());
    const v = r.chk.why && r.chk.why.allow ? viaText(r.chk.why) : mine ? mine.via : '';
    const notes = [r.chk.stepUp ? 'step-up' : '', r.chk.twoPerson ? 'two-person' : '', r.kind === 'card' && bootOn(r.p) && BOOT[r.p] === A.me() ? 'bootstrap grant' : ''].filter(Boolean).join(' · ');
    return [v || 'named on this gate', notes || 'single approver'];
  };
  const subjectOf = (r) => (r.item ? ich(r.item) : r.kind === 'access' ? `<span class="small">${E((A.project(r.proj) || { name: 'the factory' }).name)}</span>` : `<span class="mono small">${E(r.sub)}</span>`);
  const ibRow = (r) => {
    const p = A.project(r.proj); const [w1, w2] = whyYou(r);
    return `<div class="dc-ib-row" data-go="${r.route}" role="link" tabindex="0">
      <div>${rowTag(r)}${r.chk && r.chk.stepUp ? `<div class="tiny faint" style="margin-top:4px">${A.icon('lock', 11)} step-up</div>` : ''}</div>
      <div style="min-width:0"><div class="ti">${E(r.title)}</div>
        <div class="mt">${subjectOf(r)}${p && r.item ? `<span>${E(p.name)}</span>` : p && r.kind !== 'access' ? `<span>${E(p.name)}</span>` : ''}</div></div>
      <div class="dc-ib-side">
        <div class="why">${E(w1)}<small>${E(w2)}</small></div>
        ${r.kind === 'access' ? `<div class="dc-sla ok">${E(r.req.at)}<small>asked</small></div>` : slaHtml(r.route, r.proj)}
        ${quorum(r)}
        <div class="small faint">opened<br><span class="mono" style="color:var(--fg-2)">${E(OPENED[r.route] || (r.req ? r.req.at : (A.item(r.item) || {}).updated || '—'))}</span></div>
      </div></div>`;
  };
  const ibHead = `<div class="dc-ib-row hd"><div>Gate</div><div>What</div><div class="dc-ib-side"><div>Why you</div><div>Answer due</div><div>Quorum</div><div>Opened</div></div></div>`;
  const firstNo = (chk) => (chk.rules.find((x) => !x.ok && !x.info) || {}).text || '';

  /* decisions already on the ledger, per person (the inbox shows the signed-in person's) */
  const HISTORY = [
    { by: 'ar', at: 'today 10:41', gate: 'G3', item: 'W-23', out: 'approved', seq: 18422, hash: '9f12c0e7', cp: '312 · pending' },
    { by: 'jm', at: 'today 10:22', gate: 'X1', item: 'W-31', out: 'approved (2 of 2: sod_waiver)', seq: 18420, hash: 'c4a99b01', cp: '312 · pending' },
    { by: 'pm', at: 'today 09:41', gate: 'G2', item: 'W-28', out: 'approved', seq: 18417, hash: 'aa0c51f9', cp: '311 ✓' },
    { by: 'ar', at: 'yesterday 16:55', gate: 'G4', item: 'W-14', out: 'approved (mode C)', seq: 18377, hash: '4be01f92', cp: '309 ✓' },
    { by: 'mw', at: '2026-11-09 11:47', gate: 'C2', item: 'Card 2 · Mobile App', out: 'approved', seq: 18352, hash: hx('c2m').slice(0, 8), cp: '308 ✓' },
    { by: 'ar', at: 'yesterday 11:12', gate: 'G2', item: 'W-20', out: 'approved', seq: 18341, hash: 'd07a3c55', cp: '308 ✓' },
    { by: 'mw', at: '2026-11-08 14:20', gate: 'C1', item: 'Card 1 · Mobile App', out: 'approved', seq: 18390, hash: hx('c1m').slice(0, 8), cp: '309 ✓' },
    { by: 'ar', at: '2026-11-08 15:40', gate: 'G3s', item: 'W-27', out: 'approved (skeleton)', seq: 18301, hash: '2c19ee04', cp: '307 ✓' },
    { by: 'ar', at: '2026-11-08 09:03', gate: 'G4', item: 'W-24', out: 'changes requested (B13)', seq: 18288, hash: 'a91f0b3d', cp: '307 ✓' },
    { by: 'ks', at: '2026-11-07 17:02', gate: 'SECT', item: 'W-06', out: 'false positive', seq: 18251, hash: '3a0d71ce', cp: '306 ✓' },
    { by: 'ar', at: '2026-11-07 14:27', gate: 'G0G1', item: 'W-28', out: 'approved', seq: 18240, hash: '61dd2a07', cp: '306 ✓' },
    { by: 'ar', at: '2026-11-07 10:02', gate: 'G0', item: 'W-17', out: 'rejected (duplicate of W-21)', seq: 18219, hash: '0e44b8c1', cp: '306 ✓' },
    { by: 'pm', at: '2026-11-07 09:30', gate: 'G5', item: 'W-12', out: 'approved (step-up)', seq: 18180, hash: '5c7e2b90', cp: '305 ✓' },
    { by: 'ar', at: '2026-11-06 17:31', gate: 'G4', item: 'W-15', out: 'approved (mode C)', seq: 18190, hash: '7718cd2e', cp: '305 ✓' },
    { by: 'rb', at: '2026-11-04 12:10', gate: 'M1', item: 'Payments API settings r6', out: 'approved', seq: 18010, hash: '8e21f0a4', cp: '301 ✓' },
    { by: 'jm', at: '2026-11-03 15:44', gate: 'E2', item: 'W-07', out: 'approved (constitution exception)', seq: 17988, hash: 'b0c4e7d1', cp: '300 ✓' },
  ];
  const visibleHist = (r) => { const it = A.item(r.item); return it ? A.canSeeProject(it.project) : /Mobile/.test(r.item) ? A.canSeeProject('mobile') : A.canSeeProject('payments'); };

  const teamTable = (rows, title, opts = {}) => A.card(title, rows.length ? A.table([
    { h: 'Gate', r: (r) => rowTag(r) },
    { h: 'Subject', r: (r) => (r.item ? ich(r.item) : `<span class="small">${E(r.title)}</span>`) },
    { h: 'Project', r: (r) => `<span class="small">${E((A.project(r.proj) || {}).name || '')}</span>` },
    { h: 'Waiting on', r: (r) => (r.named.length ? A.avatars(r.named) + `<span class="small muted" style="margin-left:6px">${E(r.named.map(first).join(', '))}</span>` : '<span class="pill warn">nobody eligible</span>') },
    { h: opts.factory ? 'Eligible' : 'You', r: (r) => (opts.factory ? `<span class="small">${r.chk.eligible.filter((e) => !e.blocked && !e.signed).length} of ${r.chk.eligible.length}</span>` : r.chk.allow ? '<span class="small" style="color:#7fe0a5">✓ you may decide too</span>' : `<span class="tiny faint">✕ ${E(firstNo(r.chk))}</span>`) },
    { h: 'Due', r: (r) => slaHtml(r.route, r.proj) },
  ], rows, { href: (r) => r.route }) : A.empty(opts.empty || 'Nothing open here.'), { flush: true, actions: opts.actions || '' });

  let ibTimer = null;
  A.view('inbox', {
    label: 'Inbox', group: 'Work', icon: 'inbox',
    access: () => (A.me() ? null : { action: 'floor.read', res: { type: 'Fleet' } }),
    navAccess: () => !!A.me(),
    badge: () => ({ n: A.inboxCount(), hot: true }),
    render: () => {
      const meId = A.me(), P = A.person(meId);
      const rows = allRows();
      const mine = rows.filter((r) => r.named.includes(meId) && r.chk.allow);
      const blocked = rows.filter((r) => r.named.includes(meId) && !r.chk.allow);
      const tasks = taskRows(), acc = accessRows();
      const wait = [...mine, ...tasks, ...acc];
      const team = rows.filter((r) => !r.named.includes(meId) && decidesOn(r.proj));
      const fleetRead = hasFleet() && A.can('audit.read', { type: 'Fleet' });
      const decided = [...LOG.filter((l) => l.by === meId).map((l) => ({ at: `today ${l.at}`, gate: l.gate, item: l.item, out: l.label, seq: l.seq, hash: l.hash.slice(0, 8), cp: '313 · pending', title: l.title })), ...HISTORY.filter((h) => h.by === meId && visibleHist(h))];
      const watchMap = new Map();
      A.visibleItems().filter((i) => OPEN(i) && i.requester === meId).forEach((i) => watchMap.set(i.key, 'You asked for it'));
      decided.forEach((h) => { const it = A.item(h.item); if (it && OPEN(it) && !watchMap.has(it.key)) watchMap.set(it.key, `You decided ${(D.GATES[h.gate] || {}).short || h.gate} on it (${h.out})`); });
      const watch = [...watchMap].map(([k, why]) => ({ it: A.item(k), why }));
      const over = mine.filter((r) => DUE[r.route] != null && DUE[r.route] < 0).length;
      const isAdmin = A.can('identity.admin', { type: 'Fleet' });
      const emptyText = isAdmin ? '<b>Nothing waits on you.</b> As factory admin you decide no gate and no card: factory.admin holds no slot unless a project role map gives you one (DEC-29). Access requests for fleet roles, and M-gates where you hold the admin slot, appear here. The whole factory is under <i>Across the factory</i>.'
        : fleetRead ? '<b>Nothing waits on you.</b> As auditor you read the whole record and decide nothing. Open gates everywhere are under <i>Across the factory</i>; every decision is in the ledger.'
          : !A.bindingsOf(meId).some((b) => DECIDING.includes(X.ROLE[b.role].slot)) ? `<b>Nothing waits on you.</b> ${E(A.persona())}: your roles decide no gate. You see where work is and who it waits on; titles and content follow your data class.`
            : '<b>Nothing waits for your decision.</b> Gates, cards, questions and access requests for your roles appear here first.';
      const tabs = [
        { id: 'me', label: 'Waiting on me', n: wait.length, html: A.card('', `<div class="dc-ib">${wait.length ? ibHead + J(wait, ibRow) : ''}</div>${wait.length ? '' : A.empty(emptyText)}`, { flush: true }) +
          (blocked.length ? `<div style="height:16px"></div>` + A.card('Named on, but the policy says no', `<div class="list">${J(blocked, (r) => `<div class="li" data-go="${r.route}"><span>${rowTag(r)}</span><div style="min-width:0"><div class="ti">${E(r.title)} · ${r.item ? ich(r.item) : E(r.sub || '')}</div><div class="me">✕ ${E(firstNo(r.chk))}</div></div><span class="btn sm">View</span></div>`)}</div>`, { flush: true, actions: '<span class="tiny faint">the item names you; the PDP would refuse your decision</span>' }) : '') },
      ];
      if (team.length || A.bindingsOf(meId).some((b) => b.scope.kind === 'project' && DECIDING.includes(X.ROLE[b.role].slot))) tabs.push({ id: 'team', label: 'My team', n: team.length, html: teamTable(team, 'Open on your projects, waiting on someone else', { empty: 'Nothing open on your projects waits on someone else.' }) });
      if (fleetRead) tabs.push({ id: 'all', label: 'Across the factory', n: rows.length, html: teamTable(rows, 'Every open gate and card you can see', { factory: true, actions: '<span class="tiny faint">read-only oversight · audit.read (fleet)</span>' }) });
      tabs.push({ id: 'done', label: 'Decided by me', n: decided.length, html: A.card('Your decisions on the ledger', decided.length ? A.table([
        { h: 'When', r: (r) => `<span class="mono small">${E(r.at)}</span>` }, { h: 'Gate', r: (r) => (D.GATES[r.gate] ? A.gate(r.gate) : cardTag(r.gate)) }, { h: 'Subject', r: (r) => (A.item(r.item) ? ich(r.item) : `<span class="small">${E(r.title || r.item)}</span>`) },
        { h: 'Outcome', r: (r) => A.pill(r.out, /reject|changes/.test(r.out) ? 'back' : 'ok') }, { h: 'Ledger seq', cls: 'r', r: (r) => `<span class="mono">${r.seq.toLocaleString('en-US')}</span>` }, { h: 'Entry', r: (r) => A.hash(r.hash) }, { h: 'Checkpoint', r: (r) => `<span class="mono small">${E(r.cp)}</span>` },
      ], decided, { href: () => 'ledger' }) : A.empty(isAdmin ? 'You have decided no gate: your admin actions (config, access, kills) are ledger entries too, under Ledger and Audit.' : 'You have not decided anything yet.'), { flush: true, actions: A.can('audit.read', { type: 'Fleet' }) || A.can('audit.read', { type: 'Project', project: A.state.project }) ? '<a class="btn sm" href="#ledger">Open the ledger</a>' : '' }) });
      tabs.push({ id: 'watch', label: 'Watching', n: watch.length, html: A.card('Items you asked for or decided on', watch.length ? A.table([
        { h: 'Item', r: (r) => ich(r.it.key) }, { h: 'State', r: (r) => A.statePill(r.it.state) }, { h: 'Where', r: (r) => `<span class="mono small">${r.it.stage} ${r.it.step}</span>` }, { h: 'Waiting on', r: (r) => (r.it.wait.length ? A.avatars(r.it.wait) : '<span class="faint small">the factory</span>') }, { h: 'Why you follow it', r: (r) => `<span class="small muted">${E(r.why)}</span>` },
      ], watch, { href: (r) => `item-${r.it.key}` }) : A.empty('Items you ask for, and items whose gates you decided, appear here.'), { flush: true }) });
      return A.pageHead({
        eyebrow: `Work · signed in as ${E(P.name)} · ${E(A.persona())}`,
        title: 'Inbox',
        sub: 'Everything that waits for your decision, only where your roles allow it. Each decision is made on its own page, with its evidence; nothing here is approved in bulk.',
        actions: `<span class="pill gate">${mine.length} decision${mine.length === 1 ? '' : 's'}</span>${tasks.length ? `<span class="pill info">${plural(tasks.length, 'step')}</span>` : ''}${acc.length ? `<span class="pill info">${plural(acc.length, 'access request')}</span>` : ''}`,
      }) +
      A.stats([
        { k: 'Waiting on you', v: wait.length, d: 'gates, cards, steps and access requests', tone: wait.length ? 'warn' : 'ok' },
        { k: 'Overdue', v: over, d: 'B21 told the backup; nothing auto-approves', tone: over ? 'bad' : 'ok' },
        { k: 'Need a step-up', v: mine.filter((r) => r.chk.stepUp).length, d: A.stepUpValid() ? 'your step-up is valid now' : 'security key, bound to the decision' },
        { k: 'Decided by you', v: decided.length, d: 'on the ledger, signed by the Notary', tone: 'ok' },
        { k: 'Named but not yours', v: blocked.length, d: 'the policy would refuse you', tone: blocked.length ? 'warn' : '' },
      ]) +
      `<div class="banner info" style="margin-top:16px">${A.icon('lock', 14)} Expiry never approves. When an answer is late, B21 notifies the backup approver; the gate stays open until a person decides.<span class="sp"></span><a href="#my-access" class="small">What can I decide?</a></div>` +
      A.tabs('ib', tabs);
    },
    mount: (root) => {
      ibTimer = setInterval(() => { root.querySelectorAll('[data-due]').forEach((el) => { const r = el.dataset.due; el.outerHTML = slaHtml(r, el.dataset.proj); }); }, 15000);
      on('ib', root, 'keydown', (e) => { const row = e.target.closest('.dc-ib-row[data-go]'); if (row && e.key === 'Enter') A.go(row.dataset.go); });
    },
    unmount: () => { clearInterval(ibTimer); off('ib'); },
  });

  /* ================================================================ decision shell */
  const FAM_CLS = { action: 'x', exception: 'e', meta: 'm', quarantine: 'q' };
  const itemFacts = (it) => [
    ['Item', ich(it.key)],
    ['Lane', `${A.lane(it.lane)} <span class="muted small">${E(D.LANES[it.lane].label)}</span>`],
    ['Where', `<span class="mono">${it.stage} ${it.step}</span> ${E((D.STEPS[it.step] || [])[2] || '')}`],
    ['Requester', A.who(it.requester)],
    ['Owner of record', A.who(it.owner)],
    ['Envelope', `${A.cents(it.spend[0])} of ${A.cents(it.spend[1])}${A.meter(it.spend[0], it.spend[1])}`],
    ['Age', E(it.age)],
  ];

  function shell(o) {
    LAST[o.route] = o;
    const fam = (D.GATES[o.gate] || {}).fam;
    const binds = o.subject.binds || [];
    return `<div class="dc-root">` + A.pageHead({
      crumbs: o.crumbs || `<a href="#inbox">Inbox</a><span>›</span>${o.item ? `<a href="#item-${o.item.key}">${o.item.key}</a><span>›</span>` : ''}<span>${E(o.crumbLabel || o.gate)}</span>`,
      eyebrow: o.eyebrow,
      title: o.title,
      sub: o.sub,
      actions: o.actions || (o.item ? `<a class="btn sm" href="#item-${o.item.key}">Open item</a><button class="btn sm ghost" data-peek="${o.item.key}">Quick look</button>` : ''),
    }) + J(o.banners || [], (b) => `<div class="banner ${b[0]}">${b[1]}</div>`) +
    `<div class="split dc-split"><div class="stack">
      ${A.card('', `<div class="dc-what"><span class="dia ${FAM_CLS[fam] || ''}"></span><div style="min-width:0;flex:1">
        <div class="eyebrow">What is being decided</div><p class="lead" style="margin-top:4px">${o.sentence}</p>
        <div class="dc-sec" style="margin-top:12px"><span class="eyebrow">Subject hash · ${plural(binds.length, 'binding')}</span>
          <div class="row" style="gap:8px"><span class="hash" style="font-size:12.5px;white-space:normal;overflow-wrap:anywhere">sha256:${o.subject.hash}</span></div>
          <div class="dc-binds">${J(binds, ([k, h]) => `<div><span>${k}</span>${A.hash(h, 10)}</div>`)}</div>
        </div></div></div>`)}
      ${o.facts ? A.card('Facts', A.kv(o.facts)) : ''}
      ${o.main}
    </div><aside class="stack dc-aside">${panel(o)}${o.rules && o.rules.length ? A.card('About this gate', rules(o.rules)) : ''}${o.asideExtra || ''}</aside></div></div>`;
  }

  function stepBlock(o) {
    const c = o.check;
    if (!c || !c.stepUp) return rules([['info', '<b>No step-up for this kind of decision.</b> Your sign-in is enough.']]);
    if (A.stepUpValid()) return rules([['ok', `<b>Step-up valid</b> for ${Math.max(1, Math.round((A.session.stepUpUntil - Date.now()) / 60000))} more min. It is bound to subject hash <span class="mono">${o.subject.hash.slice(0, 10)}</span> when you decide.`]]);
    return rules([['warn', `<b>Step-up needed.</b> ${E(o.stepUpWhy || 'This decision asks you to confirm it is you again (D37).')} You touch your security key before the decision is recorded; the proof is bound to subject hash <span class="mono">${o.subject.hash.slice(0, 10)}</span>.`]]) + (c.allow ? '<button class="btn sm" data-dcsu style="margin-top:10px">Step up now</button>' : '');
  }

  function whoBlock(o) {
    const c = o.check, meId = A.me(), pr = A.project(c.project) || { name: c.project };
    const list = J(c.eligible, (e) => `<div class="${e.blocked ? 'off' : ''}">${A.who(e.pid)}<span class="tiny faint">${E(e.via)}</span><span class="dc-who-tags">${e.pid === meId ? A.pill('you', 'info') : ''}${e.blocked ? A.pill(e.blocked, 'bad') : ''}${e.signed ? A.pill('approved · 1 of 2', 'ok') : ''}</span></div>`);
    const named = o.item && o.item.wait.length ? o.item.wait.filter((w) => !c.eligible.some((e) => e.pid === w)) : [];
    return `<div class="dc-sec"><span class="eyebrow">Who can decide · ${E(c.slot || '')} slot on ${E(pr.name)}</span>
      <div class="dc-who">${list || `<span class="small muted">Nobody holds this slot on ${E(pr.name)}. A project admin adds one in the role map (M1, plus M6 for an approver).</span>`}</div>
      ${named.length ? `<p class="tiny faint" style="margin-top:8px">The item names ${E(named.map(name).join(', '))}, who ${named.length > 1 ? 'hold' : 'holds'} no ${E(c.slot)} slot here: the PDP would refuse that decision.</p>` : ''}</div>`;
  }

  function twoBlock(o) {
    const c = o.check; if (!c.twoPerson) return '';
    const done = (SIGNED[o.route] || []).length, free = c.eligible.filter((e) => !e.blocked && !e.signed).length;
    const single = c.eligible.filter((e) => !e.blocked).length === 1 && !done;
    return `<div class="dc-sec"><span class="eyebrow">Two-person rule · DEC-28</span><div class="dc-q">${J([0, 1], (i) => `<i class="${i < done ? 'on' : ''}"></i>`)} ${done} of 2 approvals</div>
      <p class="tiny faint" style="margin-top:6px">${single ? `Only one person holds the slot, so ${E(name(c.eligible.find((e) => !e.blocked).pid))} decides alone and the entry is stamped <span class="mono">sod_waiver</span>.` : done ? (free ? `${E(name(SIGNED[o.route][0]))} approved first. A different holder makes it 2 of 2.` : 'No second eligible holder: the gate waits until a project admin adds one.') : 'Two different holders must approve; the first approval keeps the gate open.'}</p></div>`;
  }

  function panel(o) {
    const d = DEC[o.route];
    if (d) return donePanel(o, d);
    if (o.noDecision) return o.noDecision;
    const c = o.check;
    const head = `<div class="hd"><h3>${c.allow ? 'Your decision' : 'Decision'}</h3><span class="sp"></span>${o.slaPill || A.pill('open', 'gate')}</div>`;
    const common = `
      <div class="dc-sec" style="margin-top:0;border-top:0;padding-top:0"><span class="eyebrow">Can you decide this? · as ${E(name(A.me()))}</span>${rules(c.rules.map((r) => [r.info ? 'info' : r.ok ? 'ok' : 'bad', E(r.text)]))}</div>
      ${whoBlock(o)}${twoBlock(o)}
      ${c.stepUp && c.allow ? `<div class="dc-sec"><span class="eyebrow">Step-up</span><div class="dc-stepup">${stepBlock(o)}</div></div>` : ''}
      <div class="dc-sec"><span class="eyebrow">If nobody decides</span>${rules([['info', o.expiry || `The gate stays open. After 1 business day B21 notifies the backup approver${BACKUP[c.project] ? ` (${E(name(BACKUP[c.project]))})` : ''}. <b>Expiry never approves.</b>`]])}</div>`;
    if (!c.allow) {
      const why = firstNo(c);
      const try1 = c.eligible.find((e) => !e.blocked && !e.signed && e.pid !== A.me() && X.ACCOUNTS.some((a) => a.pid === e.pid));
      return `<section class="card dc-panel">${head}<div class="bd">
        ${common}
        <div class="dc-sec"><div class="dc-cant"><div class="row" style="gap:8px;flex-wrap:nowrap">${A.icon('lock', 15)}<b>You can’t decide this</b></div>
          <p class="small muted">${E(why)} You can read everything your data class allows; the decision form is only shown to someone the policy lets decide.</p>
          <div class="row" style="gap:8px"><button class="btn sm" data-why="${E(JSON.stringify({ action: o.whyAction, res: o.whyRes }))}">See why</button></div>
          <p class="tiny faint">Prototype: <a href="#" data-dcswitch>Switch account to try it</a>${try1 ? `, for example as ${E(name(try1.pid))}` : ''}.</p></div></div>
      </div></section>`;
    }
    const opts = o.options || {};
    const choice = o.choice ? `<div class="dc-sec"><span class="eyebrow">Choose one</span><div class="dc-choice">${J(o.choice, (ch) => `<label class="${ch.off ? 'off' : ''}"><input type="radio" name="dc-choice" value="${ch.id}" ${ch.off ? 'disabled' : ''}><span><b>${E(ch.label)}</b><small>${ch.desc}</small></span></label>`)}</div></div>` : '';
    return `<section class="card dc-panel">${head}<div class="bd">
      ${common}
      ${choice}
      <div class="dc-sec"><label class="check"><input type="checkbox" class="dc-read"> <span>I have read the evidence${o.readWhat ? `: ${o.readWhat}` : ''}.</span></label></div>
      <div class="dc-sec field"><label for="dc-reason-${o.route}">Reason <span class="faint">(required, goes on the ledger)</span></label>
        <textarea class="input dc-reason" id="dc-reason-${o.route}" rows="3" placeholder="${E(o.reasonHint || 'Say why, in a sentence, so the people on this item know.')}"></textarea>
        <div class="dc-err" role="alert"></div></div>
    </div><div class="ft" style="justify-content:stretch"><div class="dc-btns" style="width:100%">
      ${o.choice ? `<button class="btn primary" data-dc="choice" disabled>${E(opts.approve || 'Record my choice')}</button>` : `<button class="btn good" data-dc="approve" disabled>${E(opts.approve || 'Approve')}</button>
      <div class="row2">${opts.changes !== null ? `<button class="btn" data-dc="changes">${E(opts.changes || 'Request changes')}</button>` : ''}${opts.reject !== null ? `<button class="btn danger" data-dc="reject" ${opts.changes === null ? 'style="grid-column:1/-1"' : ''}>${E(opts.reject || 'Reject')}</button>` : ''}</div>`}
      <span class="tiny faint" style="text-align:center">${o.choice ? 'Pick an option and tick that you have read the evidence.' : 'Approve unlocks when you tick that you have read the evidence.'}${c.stepUp && !A.stepUpValid() ? ' You will be asked for your security key.' : ''}</span>
    </div></div></section>`;
  }

  function donePanel(o, d) {
    const tone = /reject|confirm|abandon/.test(d.outcome) ? 'bad' : /changes|send/.test(d.outcome) ? 'back' : 'ok';
    return `<section class="card dc-panel dc-done"><div class="hd"><h3>Decision recorded on the ledger</h3><span class="sp"></span>${A.pill(d.label, tone)}</div><div class="bd">
      ${A.kv([
        ['Decided by', `${A.who(d.by)}${d.sod ? ' <span class="pill mute plain">sod_waiver</span>' : ''}${d.by === A.me() ? ' <span class="pill info">you</span>' : ''}`],
        ['When', `<span class="mono">${E(d.at)}</span>`],
        ['Reason', A.dataClass(projOfKey((o.item || {}).key) || (o.check || {}).project) >= 1 ? `<span class="small">“${E(d.reason)}”</span>` : '<span class="faint small">hidden: needs D1</span>'],
        ['Ledger seq', `<span class="mono">${d.seq.toLocaleString('en-US')}</span>`],
        ['Entry hash', A.hash(d.hash, 16)],
        ['Subject hash', A.hash(o.subject.hash, 16)],
        d.stepUp ? ['Step-up', '<span class="pill ok">StepUpUse bound to the subject hash</span>'] : null,
        ['Notary', `<span class="mono small">ES256 · notary-2026-10 · MEUCIQ${d.hash.slice(0, 10)}…${d.hash.slice(-6)}</span>`],
        ['Checkpoint', d.seeded ? `<span class="pill ok">co-signed in ${d.cp}</span>` : `<span class="pill warn">pending · ${d.cp}</span> <span class="tiny faint">the witness co-signs within 10 min</span>`],
      ])}
      ${o.after ? `<div class="dc-sec">${rules([['ok', `<b>What happens now.</b> ${o.after}`]])}</div>` : ''}
    </div><div class="ft"><a class="btn sm" href="#inbox">Back to inbox</a></div></section>`;
  }

  function mountDecide(root, route) {
    const o = LAST[route]; if (!o) return;
    const swap = () => { const p = root.querySelector('.dc-panel'); if (p) p.outerHTML = panel(o); };
    const st = () => {
      const p = root.querySelector('.dc-panel'); if (!p) return;
      const read = p.querySelector('.dc-read');
      const ap = p.querySelector('[data-dc="approve"],[data-dc="choice"]');
      const ch = p.querySelector('input[name="dc-choice"]:checked');
      if (ap) ap.disabled = !(read && read.checked) || (o.choice && !ch);
    };
    on('dc-change', root, 'change', st);
    on('dc', root, 'click', (e) => {
      const sg = e.target.closest('[data-seg]');
      if (sg) { sg.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === sg))); return; }
      if (e.target.closest('[data-dcswitch]')) { e.preventDefault(); const mb = document.getElementById('me-btn'); if (mb) mb.click(); return; }
      if (e.target.closest('[data-dcsu]')) { A.stepUpModal(() => { const blk = root.querySelector('.dc-stepup'); if (blk) blk.innerHTML = stepBlock(o); }, o.stepUpWhy); return; }
      const b = e.target.closest('[data-dc]'); if (!b || b.disabled) return;
      const p = root.querySelector('.dc-panel');
      const reason = p.querySelector('.dc-reason').value.trim();
      const err = p.querySelector('.dc-err');
      const kind = b.dataset.dc;
      let outcome = kind, label = { approve: 'approved', changes: 'changes requested', reject: 'rejected' }[kind];
      const btnText = b.textContent.trim();
      if (kind === 'choice') { const ch = p.querySelector('input[name="dc-choice"]:checked'); const cc = o.choice.find((x) => x.id === ch.value); outcome = cc.id; label = cc.short || cc.label; }
      if (reason.length < 8) { err.textContent = kind === 'approve' ? 'Write a reason first: it is recorded with the decision.' : 'A reason is needed: the people on this item read it.'; p.querySelector('.dc-reason').focus(); return; }
      // the server asks the PDP again; so does the prototype (fail closed)
      const now = o.recheck(); if (!now.allow) { err.textContent = `Refused: ${firstNo(now)}`; return; }
      err.textContent = '';
      const actor = A.me();
      const twoDone = now.twoPerson ? (SIGNED[route] || []).length + 1 : 0;
      if (now.twoPerson && twoDone < 2 && now.eligible.filter((x) => !x.blocked).length > 1 && kind === 'approve') label = 'approved · 1 of 2';
      const commit = () => {
        const seq = SEQ++;
        const d = { outcome, label, reason, by: actor, at: `today ${stamp()}`, seq, hash: hx(route + outcome + reason + seq), cp: 313, sod: now.eligible.filter((x) => !x.blocked).length === 1, stepUp: now.stepUp };
        DEC[route] = d;
        LOG.unshift({ by: actor, at: stamp(), gate: o.gate, item: o.item ? o.item.key : route, title: o.title, label, seq, hash: d.hash });
        A.closeOverlay(); swap();
        root.querySelector('.dc-panel').scrollIntoView({ block: 'nearest' });
        A.toast(`Recorded: ${o.toastName || o.gate} ${label}, ledger entry ${seq.toLocaleString('en-US')}`);
      };
      const confirm = () => {
        const m = A.modal(`<div class="row between"><h2>Confirm: ${E(btnText)}</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
          <p class="muted">${o.item ? `${E(o.item.key)} · ` : ''}${E(o.title.replace(/<[^>]+>/g, ''))}</p>
          ${A.kv([['Gate', A.gate(o.gate)], ['Decision', `<b>${E(label)}</b>`], ['As', A.who(actor)], ['Bound to', A.hash(o.subject.hash, 16)], now.stepUp ? ['Step-up', '<span class="pill ok">valid · bound to this decision</span>'] : null, ['Reason', `<span class="small">“${E(reason)}”</span>`]])}
          ${rules([['info', 'This writes one ledger entry, signed by the Notary. It cannot be undone; a later change is a new decision.']])}
          <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn ${kind === 'reject' ? 'danger' : 'primary'}" id="dc-go">${E(btnText)}</button></div>`);
        m.querySelector('#dc-go').onclick = commit;
      };
      if (now.stepUp && !A.stepUpValid() && kind !== 'changes') return A.stepUpModal(() => { const blk = root.querySelector('.dc-stepup'); if (blk) blk.innerHTML = stepBlock(o); confirm(); }, o.stepUpWhy);
      confirm();
    });
  }

  /* ================================================================ gate content */
  const BASE = '3f9c2ab';
  const g = {};

  g.G0G1 = (it) => {
    const req = 'Refunds sometimes go out twice when the dashboard retries after a 502. Ops had to claw back 14 duplicate refunds last month. POST /refunds should accept an Idempotency-Key header like POST /payments does, and replay the first response for 24 hours.';
    const cls = [
      ['work_type', 'feature', 0.91, 'new header contract on a public endpoint · api/refunds/routes.ts:22'],
      ['size', 'M', 0.78, '3 source files + 1 migration; middleware exists for /payments (api/payments/idempotency.ts)'],
      ['risk', 'medium', 0.84, 'money-moving endpoint; additive table; reversible migration'],
      ['data_class', 'internal', 0.95, 'keys and response hashes only, no PAN or PII stored'],
    ];
    const intent = [
      ['Problem', 'A dashboard retry after a 502 can create a second refund for the same request.', 'st'],
      ['Outcome', 'POST /refunds accepts an Idempotency-Key header and replays the first response for 24 h.', 'st'],
      ['AC1', 'Same key and same body within 24 h returns the original status and body; no second refund row.', 'st'],
      ['AC2', 'Same key with a different body returns 422 idempotency_key_reused.', 'inf'],
      ['AC3', 'Keys are scoped per merchant; another merchant’s key never matches.', 'inf'],
      ['AC4', 'Keys expire after 24 hours.', 'st'],
      ['Out', 'Idempotency for PATCH /refunds/:id; changing the dashboard’s retry logic.', 'inf'],
      ['Assume', 'Reuse api/payments/idempotency.ts rather than a new key store.', 'inf'],
    ];
    const dd = [['W-08', 'Refund reason codes', 0.41, 'done'], ['W-04', 'Webhook retries with backoff', 0.27, 'done'], ['#388', 'GitHub issue: retry on refund 502 makes duplicate refunds', 0.62, 'linked as evidence'], ['W-36', 'Partial capture for card-present payments', 0.12, 'open']];
    const main = A.card('A1 triage: classification <span class="mono small faint">step 1.3 · A1 triage v1.2.0 · claude-sonnet-5-5</span>', `
        ${A.table([{ h: 'Field', r: (r) => `<span class="mono">${r[0]}</span>` }, { h: 'Value', r: (r) => `<b>${r[1]}</b>` }, { h: 'Confidence', r: (r) => `<span class="mono">${r[2].toFixed(2)}</span>` }, { h: 'Evidence at merged head ' + BASE, r: (r) => `<span class="small muted">${E(r[3])}</span>` }], cls)}
        <div class="dc-sec" style="margin:12px 16px 14px">
          <span class="eyebrow">Derived lane (the factory, not the agent)</span>
          <div class="row" style="gap:12px;align-items:flex-start;flex-wrap:nowrap"><span style="transform:scale(1.4);transform-origin:left top;margin-right:10px">${A.lane('L4')}</span>
            <div style="min-width:0"><div class="mono small">laneForClassification(feature, M, medium) → <b>L4</b></div>
            <div class="small muted" style="margin-top:4px">Catalogue 1.4.0 (pinned <span class="mono">8c2e…f1</span>) rule <span class="mono">lanes.feature[size S–L, risk ≤ high] → L4</span>. Not L1–L3: those take change, bug or remediation only. Not L5: no staged rollout asked. Not L6: size is under XL. A1’s output has no lane field.</div></div></div>
          <div class="row" style="margin-top:10px;gap:6px"><span class="small muted">Gating profile v2 pins:</span>${J(['G0G1', 'G2', 'G3d', 'G3', 'G4', 'G5', 'G6'], A.gate)}</div>
        </div>`, { flush: true }) +
      A.card('A2 intent block <span class="mono small faint">step 1.5 · provisional G1</span>', `
        <div class="fence"><div class="src">request R-1188 · Amara Kone · portal · ${tag('taint: user_input', 'taint')} · quoted as data, never instructions</div>“${E(req)}”</div>
        <div class="row small" style="margin:10px 0 14px;gap:8px 18px">${J([['Injection scan (text-lint L-1…L-9, B27):', '0 flags'], ['Secret ruleset sr-2026.10.3:', '0 hits'], ['1.5 questions:', 'none needed (A2 confidence 0.88)']], ([a, b]) => `<span class="row" style="gap:6px;flex-wrap:nowrap">${ok}<span>${a} <b>${b}</b></span></span>`)}</div>
        <ul class="dc-ac">${J(intent, ([k, t, c]) => `<li><span class="id">${k}</span><span>${E(t)}</span>${tag(c === 'st' ? 'stated' : 'inferred', c)}</li>`)}</ul>
        <p class="tiny faint" style="margin-top:12px">“stated” lines trace to the request text; “inferred” lines are the agent’s and carry the taint mark until you approve them here.</p>`) +
      `<div class="grid g2">` +
      A.card('De-dupe <span class="mono small faint">1.2</span>', `${A.table([{ h: 'Candidate', r: (r) => (A.item(r[0]) ? `<span class="mono">${r[0]}</span>` : `<span class="mono">${r[0]}</span>`) + ` <span class="small muted">${E(r[1])}</span>` }, { h: 'Similarity', cls: 'r', r: (r) => `<span class="mono">${r[2].toFixed(2)}</span>` }, { h: '', r: (r) => `<span class="tiny faint">${E(r[3])}</span>` }], dd)}<div style="padding:10px 16px">${rules([['ok', '<b>No duplicate:</b> nothing is above the 0.85 threshold.']])}</div>`, { flush: true }) +
      A.card('Eligibility', rules([
        ['ok', 'PRR <span class="mono">prr/1 v3</span> active for acme/payments-api, fresh until 2027-01-28'],
        ['ok', 'Area <span class="mono">api/</span> signed Full, so L4 is open there'],
        ['ok', 'Amara Kone is in <span class="mono">role_map.requesters</span>'],
        ['ok', 'WIP 9 of 12 items in flight for Payments API'],
        ['ok', 'Kill switch not engaged (project and fleet)'],
        ['ok', 'No N8 hold: the repo has an active record'],
      ])) + `</div>`;
    return {
      title: 'Triage and intent: Add idempotency keys to POST /refunds',
      sub: 'Check what the factory understood, the lane it derived and the intent it will build against. This one card records two decisions: G0 and G1.',
      sentence: 'Is W-33 accepted as an <b>L4 feature</b> on Payments API, and the intent block below as what it will deliver?',
      subject: { hash: hx('g0g1-w33'), binds: [['request text R-1188', hx('req')], ['A1 classification', hx('cls')], ['A2 intent block', hx('int')], ['lane profile L4 @ gating v2', hx('lp')], ['catalogue 1.4.0', '8c2e04d1f1']] },
      facts: itemFacts(it), main,
      rules: [['info', '<b>Single approver.</b> Any one holder of the intent slot decides G0+G1; the first decision closes it.'], ['ok', 'Two ledger entries: G0 (lane L4 pinned) and G1 (provisional intent). G1f is not in this lane.']],
      options: { approve: 'Approve G0 + G1', changes: 'Send back to 1.5', reject: 'Reject the request' },
      readWhat: 'classification, intent and de-dupe',
      after: 'W-33 pins lane L4 with gating profile v2 and starts S2 2.1 (ground in code and docs).',
    };
  };

  g.G2 = (it) => {
    const spec = `## REQ-RF-031 Refund status webhook  (new)
When a refund changes status (pending → succeeded |
failed | canceled) the service sends refund.updated to
every endpoint subscribed to it.
- Payload: { id, refund_id, status, amount, currency,
  created_at }
- Signed with the endpoint secret (HMAC-SHA256,
  header Acme-Signature)
- At-least-once; consumers dedupe on id.
  Order is not guaranteed.

## REQ-RF-032 Retry schedule  (new)
A delivery with no 2xx within 10 s is retried after
1m, 5m, 30m, 2h, 6h, 12h. After 24 h it is marked
failed and shown in the dashboard.

## REQ-WH-007 Event catalogue  (changed)
+ refund.updated`;
    const orc = `O-1  given a refund moves pending → succeeded
     then one refund.updated is enqueued per
     subscribed endpoint
O-2  given a delivery
     then Acme-Signature verifies with the secret
O-3  given the endpoint returns 500
     then retries run at 1m,5m,30m,2h,6h,12h and
     stop at 24 h (fake clock)
O-4  given two status changes
     then both arrive; order is not asserted
O-5  given an endpoint not subscribed
     then nothing is sent
O-6  given any payload
     then it carries no PAN or CVC (schema check)`;
    const finds = [
      ['F1', 'major', 'O-4 asserted delivery order; the spec says unordered.', 'fixed in rev 2', 'ok'],
      ['F2', 'major', 'REQ-RF-032 had no upper bound, so O-3 could never end.', 'fixed: 24 h bound', 'ok'],
      ['F3', 'minor', 'Payload has no api_version; consumers cannot detect a schema change.', 'answered: the envelope carries it (REQ-WH-002)', 'info'],
      ['F4', 'info', 'Secret rotation reuses REQ-WH-004; no change needed.', 'noted', 'mute'],
    ];
    const main = A.card('Delta spec and oracle specs, side by side', `<div class="grid g2">
        <div class="dc-pane"><div class="ph2"><b style="color:var(--fg)">Delta spec</b><span class="mono">spec/payments/refunds.md</span>${tag('rev 2')}${A.hash(hx('spec'), 10)}${A.glyph('A', 16)}<span>A7</span></div><pre class="code">${E(spec)}</pre></div>
        <div class="dc-pane"><div class="ph2"><b style="color:var(--fg)">Oracle specs</b><span class="mono">oracle/refund-webhooks.yaml</span>${tag('rev 2')}${A.hash(hx('orc'), 10)}${A.glyph('A', 16)}<span>A6</span></div><pre class="code">${E(orc)}</pre></div>
      </div>
      <div class="dc-sec">${A.table([{ h: 'Requirement', r: (r) => `<span class="mono">${r[0]}</span>` }, { h: 'Oracles', r: (r) => `<span class="mono small">${r[1]}</span>` }, { h: '3.3 validate', r: () => A.pill('pass', 'ok') }], [['REQ-RF-031', 'O-1 O-2 O-4 O-5 O-6'], ['REQ-RF-032', 'O-3'], ['REQ-WH-007', 'O-5']])}</div>`) +
      A.card('A5 clean-context review <span class="mono small faint">3.5 · A5 review v1.2.1 · codex-2</span>', `
        <p class="small muted" style="padding:12px 16px 4px">A5 saw only the spec, the oracles and the cited code at ${BASE}, never the authors’ conversation. 2 auto rounds used of 3 (B3).</p>
        ${A.table([{ h: 'Id', r: (r) => `<span class="mono">${r[0]}</span>` }, { h: 'Severity', r: (r) => A.pill(r[1], r[1] === 'major' ? 'back' : r[1] === 'minor' ? 'warn' : 'mute') }, { h: 'Finding', r: (r) => `<span class="small">${E(r[2])}</span>` }, { h: 'Status', r: (r) => A.pill(r[3], r[4]) }], finds)}`, { flush: true });
    return {
      title: 'Spec and oracle-spec approval: Refund status webhooks',
      sub: 'Approve what W-26 must do and the tests that will prove it. After this the oracles are locked: an agent cannot edit them in S6 (E6 only).',
      sentence: 'Do the delta spec and the oracle specs (rev 2) say exactly what W-26 must do, and do the oracles prove it?',
      subject: { hash: hx('g2-w26'), binds: [['delta spec rev 2', hx('spec')], ['oracle specs rev 2', hx('orc')], ['A5 review report', hx('a5')], ['traceability map', hx('tr')], ['merged head', BASE]] },
      facts: itemFacts(it), main,
      rules: [['info', '<b>Shared.</b> Every holder of the intent slot may decide G2; the first decision closes the gate.'], ['ok', '<b>No human author.</b> A7 wrote the spec, A6 the oracles, A5 reviewed in a clean context.']],
      options: { approve: 'Approve G2', changes: 'Request changes (back to 3.2)', reject: 'Reject' },
      readWhat: 'spec, oracles and the review findings',
      after: 'The oracles lock at their hash and W-26 moves to S4 4.1 (decisions and ADRs).',
    };
  };

  const UNITS = [
    { id: 'u1', t: 'Schema and repository', scope: 'migrations/0043_*, src/billing/methods/repo.ts', tasks: 4, orc: 'O-1 O-2', c: 380, diff: 220, x: 8, y: 80 },
    { id: 'u2', t: 'List endpoint', scope: 'src/api/methods/list.ts, serialize.ts', tasks: 5, orc: 'O-3 O-4 O-5', c: 760, diff: 300, x: 233, y: 14 },
    { id: 'u3', t: 'Delete endpoint', scope: 'src/api/methods/delete.ts', tasks: 5, orc: 'O-6 O-7 O-8', c: 820, diff: 300, x: 233, y: 146 },
    { id: 'u4', t: 'Audit + webhook', scope: 'src/billing/methods/events.ts, webhooks/catalogue.ts', tasks: 3, orc: 'O-9 O-10', c: 540, diff: 180, x: 458, y: 80 },
  ];
  const dag = () => {
    const W = 174, H = 62, U = Object.fromEntries(UNITS.map((u) => [u.id, u]));
    const edge = (a, b) => { const A1 = U[a], B1 = U[b]; const x1 = A1.x + W, y1 = A1.y + H / 2, x2 = B1.x - 4, y2 = B1.y + H / 2, mx = (x1 + x2) / 2; return `<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="var(--belt-2)" stroke-width="2" marker-end="url(#dc-arr)"/>`; };
    return `<svg class="dc-dag" viewBox="0 0 640 222" role="img" aria-label="Unit DAG: u1 before u2 and u3, both before u4">
      <defs><marker id="dc-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--belt-2)"/></marker></defs>
      ${edge('u1', 'u2')}${edge('u1', 'u3')}${edge('u2', 'u4')}${edge('u3', 'u4')}
      ${J(UNITS, (u) => `<g><rect x="${u.x}" y="${u.y}" width="${W}" height="${H}" rx="7" fill="var(--panel-2)" stroke="var(--line-2)"/><rect x="${u.x}" y="${u.y}" width="4" height="${H}" rx="2" fill="var(--agent)"/>
        <text x="${u.x + 14}" y="${u.y + 20}" fill="var(--fg)" style="font:600 13px var(--mono)">${u.id}</text><text x="${u.x + 40}" y="${u.y + 20}" fill="var(--fg-2)" style="font:500 12px var(--body)">${E(u.t)}</text>
        <text x="${u.x + 14}" y="${u.y + 38}" fill="var(--muted)" style="font:11px var(--mono)">${u.tasks} tasks · ${u.orc}</text>
        <text x="${u.x + 14}" y="${u.y + 53}" fill="var(--faint)" style="font:11px var(--mono)">${A.cents(u.c)} · ≤${u.diff} lines</text></g>`)}
      <text x="8" y="216" fill="var(--faint)" style="font:11px var(--mono)">wave 1</text><text x="233" y="216" fill="var(--faint)" style="font:11px var(--mono)">wave 2 · one at a time</text><text x="458" y="216" fill="var(--faint)" style="font:11px var(--mono)">wave 3</text>
    </svg>`;
  };

  g.G3 = (it) => {
    const arts = [['5.1 units.json', 'Unit DAG, scope per Unit'], ['5.2 sequence.json', '3 waves'], ['5.3 plan.md', '17 tasks'], ['5.4 verification.json', '10 oracles bound'], ['5.5 envelope.json', 'budget as code'], ['5.6 capacity.json', 'one session per Unit']];
    const plan = `### u3  Delete endpoint   (5 tasks, oracles O-6 O-7 O-8)
1. Add DELETE /customers/:id/payment-methods/:pm_id route
   in src/api/methods/delete.ts (scope: this file only)
2. Refuse when pm is the default for an active
   subscription → 409 payment_method_in_use     [O-7]
3. Soft-delete: set detached_at, keep the row for
   dispute evidence (REQ-PM-012)                [O-6]
4. Emit payment_method.detached (u4 consumes it)
5. Self-check: oracles green, diff ≤ 300 lines, no new
   dependency (X3), no path outside scope (ET9)`;
    const env = [['S1–S5 planning (spent)', 640, 'det'], ['u1', 380, 'agent'], ['u2', 760, 'agent'], ['u3', 820, 'agent'], ['u4', 540, 'agent'], ['S7 verify', 300, 'det'], ['S8–S9', 310, 'det'], ['Reserve (10% of build)', 250, 'gate']];
    const tot = env.reduce((s, e) => s + e[1], 0);
    const main = A.card('Unit DAG <span class="mono small faint">5.1 · 5.2 · A3 planner v1.3.0</span>', `<div class="dc-dagw">${dag()}</div>`) +
      A.card('Task plan, verification binding', `<div class="stack">
        <div class="dc-pane"><div class="ph2"><b style="color:var(--fg)">plan.md</b> excerpt ${A.hash(hx('plan'), 10)}</div><pre class="code">${E(plan)}</pre></div>
        <div class="dc-pane"><div class="ph2"><b style="color:var(--fg)">verification.json</b> ${A.hash(hx('ver'), 10)}</div>
          ${A.table([{ h: 'Unit', r: (u) => `<span class="mono">${u.id}</span>` }, { h: 'Scope', r: (u) => `<span class="mono tiny">${E(u.scope)}</span>` }, { h: 'Oracles', r: (u) => `<span class="mono small">${u.orc}</span>` }], UNITS)}
          <p class="tiny faint">Every oracle from G2 is bound to exactly one Unit. Unbound: none. Locked tests: 10 files, hashes pinned at 6.3.</p></div></div>`) +
      `<div class="grid g2">` +
      A.card('Budget envelope <span class="mono small faint">5.5 · deterministic</span>', `${J(env, ([k, c, col]) => `<div class="row between small" style="padding:3px 0"><span>${E(k)}</span><span class="mono">${A.cents(c)}</span></div><div style="height:5px;border-radius:3px;background:var(--sunk);margin-bottom:4px"><i style="display:block;height:100%;width:${(c / tot * 100 * 3).toFixed(1)}%;max-width:100%;border-radius:3px;background:var(--${col})"></i></div>`)}
        <div class="row between" style="margin-top:8px;border-top:1px solid var(--line);padding-top:8px"><b>Envelope (L4 profile)</b><b class="mono">${A.cents(tot)}</b></div>
        <p class="tiny faint" style="margin-top:6px">Hard stop at 100% (ET1 → D1). One extension of up to +50% needs E3.</p>`) +
      A.card('Capacity <span class="mono small faint">5.6</span>', `${A.kv([['Sessions', '4, one coding session per Unit, run one at a time'], ['Pods now', '3 of 3 busy · W-22 is ahead in the FIFO'], ['Expected start', '~35 min after G3'], ['Wall clock', '~2 h 10 min for all four Units'], ['Scheduling', '5.7 automatic (lease + slot + envelope)']])}`) +
      `</div>` +
      A.card('Six artefacts and the base commit', `${A.table([{ h: 'Artefact', r: (a) => `<span class="mono">${a[0]}</span>` }, { h: 'Says', r: (a) => `<span class="small muted">${a[1]}</span>` }, { h: 'Hash', r: (a) => A.hash(hx(a[0]), 10) }], arts)}
        <div style="padding:10px 16px">${rules([['info', `Bound to base commit <span class="hash">${BASE}</span> (main, 2026-11-09 16:12). main is 2 commits ahead; neither touches a Unit scope (checked again at 6.1).`]])}</div>`, { flush: true });
    return {
      title: 'Plan approval: Saved payment methods, list and delete',
      sub: 'Approve the plan the coding agent will follow: four Units, their order, their tests, their budget. The approval is bound to the six plan artefacts and the commit they were made against.',
      sentence: 'May the factory build W-27 as <b>4 Units in 3 waves</b>, within <b>$40.00</b>, against base commit <span class="mono">3f9c2ab</span>?',
      subject: { hash: hx('g3-w27'), binds: [...arts.map((a) => [a[0], hx(a[0])]), ['base commit', BASE]] },
      facts: itemFacts(it), main,
      banners: [['warn', `${A.icon('lock', 14)} Overdue by about 2 h. B21 notified the backup approver, Rana Begum. Nothing approves by itself.`]],
      rules: [['ok', '<b>Plan-author SoD.</b> The plan’s author is A3 planner (agent run ar-27-5.3). The author of a plan can never approve it.'], ['info', 'B5: rejections so far 0 of 3. After the third, a person writes the plan and cannot approve their own.'], ['ok', 'G3s (skeleton: 5.1, 5.2) approved by Alex Rivera on 2026-11-08, ledger 18,301.']],
      options: { approve: 'Approve G3', changes: 'Request changes (back to 5.1)', reject: 'Reject the plan' },
      readWhat: 'the DAG, task plan, envelope and capacity',
      slaPill: A.pill('overdue', 'bad'),
      after: '6.0 admits u1: approver slot (H1), coding cap (H2), envelope reserved (H3).',
    };
  };

  g.G4 = (it) => {
    const files = [
      ['migrations/0042_add_network_txn_id.sql', 14, 0, 'migrations/', true],
      ['src/billing/mit/network-txn.ts', 61, 0, 'billing/', true],
      ['src/billing/mit/charge.ts', 88, 12, 'billing/', true],
      ['src/api/payments/serializers.ts', 9, 2, 'api/', false],
      ['src/api/payments/schemas/charge.json', 6, 0, 'api/', false],
      ['test/billing/mit/network-txn.test.ts', 74, 0, 'tests', false],
      ['docs/api/charges.md', 11, 1, 'docs', false],
    ];
    const add = files.reduce((s, f) => s + f[1], 0), del = files.reduce((s, f) => s + f[2], 0);
    const bar = (a, d) => { const t = a + d, p = Math.round(a / t * 5); return `<span class="dc-bar">${J([0, 1, 2, 3, 4], (i) => `<i class="${i < p ? 'p' : 'm'}"></i>`)}</span>`; };
    const checks = [
      ['7.1', 'Deterministic checks', 'typecheck, lint, build; 1,284 tests pass (12 new)'],
      ['7.2', 'Test integrity and oracle quality', 'locked oracles unchanged (hash match); mutation score 81% on changed lines (floor 70%); 0 stub tests'],
      ['7.3', 'Spec conformance', 'REQ-MIT-004…006 satisfied; 0 unmapped changes'],
      ['7.4', 'Secrets and dependencies', 'sr-2026.10.3: 0 hits; 0 new dependencies'],
      ['7.5', 'Constitution check', '0 violations; migration has a down step'],
      ['7.6', 'Pack assembly and sign', 'ep-W24-r2 signed by the Notary at 4c01aa9'],
    ];
    const main = A.card(`Pull request <a href="#" data-toast="Opens acme/payments-api#412 on GitHub">acme/payments-api#412</a> <span class="mono small faint">agent/W-24/u3</span>`, `
        <div class="row small" style="padding:12px 16px 4px;gap:16px"><span>${files.length} files</span><span class="dc-plus">+${add}</span><span class="dc-minus">−${del}</span><span class="muted">3 Units squashed by the Push Broker; pushed ${'10:38'} (ledger 18,421)</span></div>
        ${A.table([{ h: 'File', r: (f) => `<span class="mono small">${E(f[0])}</span>${f[4] ? ' <span class="pill warn">sensitive</span>' : ''}` }, { h: 'Area', r: (f) => `<span class="small muted">${f[3]}</span>` }, { h: '+', cls: 'r', r: (f) => `<span class="dc-plus">+${f[1]}</span>` }, { h: '−', cls: 'r', r: (f) => `<span class="dc-minus">−${f[2]}</span>` }, { h: '', r: (f) => bar(f[1], f[2]) }], files)}
        <div style="padding:10px 16px">${rules([['ok', 'Locked oracle files <span class="mono">test/oracle/mit/*.test.ts</span>: no change (+0 −0), hash <span class="mono">5b0e7c21</span>.']])}</div>`, { flush: true }) +
      A.card('Evidence Pack <span class="mono small faint">ep-W24-r2</span>', `
        <div class="dc-big"><div><div class="eyebrow">PR head</div><span class="hash" style="font-size:14px">4c01aa9</span></div><span class="eq">=</span><div><div class="eyebrow">Evidence Pack SHA</div><span class="hash" style="font-size:14px">4c01aa9</span></div><span class="small" style="color:#7fe0a5">gate-check passes only while the head stays this commit</span></div>
        <div style="margin-top:12px">${A.table([{ h: 'Step', r: (c) => `<span class="mono">${c[0]}</span>` }, { h: 'Check', r: (c) => c[1] }, { h: 'Result', r: () => A.pill('pass', 'ok') }, { h: 'Detail', r: (c) => `<span class="small muted">${E(c[2])}</span>` }], checks)}</div>`) +
      A.card('Review mode', `<div class="dc-modes">
          <div class="dc-mode on"><div class="row between"><b>Mode C: code owner</b>${A.pill('this PR', 'gate')}</div><span class="small muted">A code owner of the changed paths reads the diff and decides. Sensitive paths (here <span class="mono">migrations/**</span>, <span class="mono">src/billing/mit/**</span>) also need the D37 portal step-up.</span></div>
          <div class="dc-mode"><b>Mode E: evidence approver</b><span class="small muted">An evidence approver decides on the Evidence Pack alone; 9.5 samples those merges later. Not allowed here: a sensitive path forces mode C. B14: an unsure evidence approver moves the PR to mode C.</span></div>
        </div>
        <div class="dc-sec">${rules([['warn', '<b>B13, round 1 of 2 used.</b> On 2026-11-08 Alex Rivera asked: “network_txn_id must be text: Visa returns 15 alphanumerics.” Fixed in u3 rev 2. A second rejection round ends in D3 handoff (ET7).']])}</div>`);
    return {
      title: 'Merge approval: Store network transaction id for MIT',
      sub: 'Review the pull request and its Evidence Pack. G4 is never skipped. Approving does not merge: the code owner merges on GitHub, and the factory never merges.',
      sentence: 'Is PR #412 at head <span class="mono">4c01aa9</span> fit to merge into main?',
      subject: { hash: hx('g4-w24'), binds: [['PR #412 head', '4c01aa9'], ['Evidence Pack ep-W24-r2', hx('ep24')], ['G3 plan of W-24', hx('g3w24')], ['CODEOWNERS @ main', hx('co')]] },
      facts: [...itemFacts(it), ['Pull request', `<span class="mono">${it.pr}</span>`]], main,
      rules: [['info', '<b>Code owners decide.</b> <span class="mono">src/billing/mit/**</span> and <span class="mono">migrations/**</span> are owned by the g4 slot (CODEOWNERS line 14, 19, synced to the role map).'], ['ok', '<b>Not the author.</b> The code was written by the coder agent; nobody pushed to the branch by hand.']],
      stepUpWhy: 'A sensitive path is in the diff, so G4 needs the D37 step-up.',
      options: { approve: 'Approve G4 (mode C)', changes: 'Request changes (B13)', reject: 'Reject' },
      readWhat: 'the diff and the Evidence Pack',
      after: 'You merge PR #412 on GitHub (8.2). The factory reconciles the merged SHA to the pack.',
    };
  };

  g.X1 = (it) => {
    const sql = `-- migrations/0044_backfill_merchant_category.sql
-- W-29 unit u2 of 2 · written at 6.4 in ses-7e88
BEGIN;
UPDATE charges c
   SET merchant_category = m.category
  FROM merchants m
 WHERE c.merchant_id = m.id
   AND c.merchant_category IS NULL
   AND c.created_at < '2025-01-01';      -- batched by id, 50,000 rows

ALTER TABLE charges DROP COLUMN legacy_mcc;
COMMIT;

-- down: none. legacy_mcc cannot be rebuilt after DROP.`;
    const main = A.card('The irreversible change <span class="mono small faint">tripwire X1 · irreversible.sql.drop_column</span>', `<pre class="code">${E(sql)}</pre>`) +
      `<div class="grid g2">` +
      A.card('Estimate', A.kv([
        ['Rows matched', '<b class="mono">≈ 18.4 M</b> of 61.2 M in charges'],
        ['Measured on', 'EXPLAIN on the staging clone at 3f9c2ab, stats 2026-11-09'],
        ['Duration', '≈ 34 min in 368 batches'],
        ['Locks', 'row locks per batch; DROP COLUMN takes ACCESS EXCLUSIVE for < 1 s'],
        ['Rollback', '<span class="pill bad">absent</span> no down step'],
        ['Recovery', 'point-in-time restore, 7 days (operations.md, attested 2026-10-02)'],
      ])) +
      A.card('Where W-29 is now', rules([
        ['warn', '<b>HUMAN-WAIT</b> since 3 d: the pod was released, the coding slot freed'],
        ['ok', 'Snapshot kept: <span class="mono">snap-W29-u2-0007</span> (17 files, task 4 of 6)'],
        ['ok', 'Lease epoch 3 kept; envelope clock paused at $12.10 of $40.00'],
        ['info', 'The PR is not pushed yet; nothing has touched a database'],
      ])) + `</div>` +
      A.card('What your answer does', rules([
        ['ok', '<b>Approve:</b> 6.0 re-admits Unit u2 and reloads the saved work from the snapshot; the agent resumes at task 4 with the DROP allowed in its branch. The SQL still runs only after G4 and a human merge and deploy.'],
        ['warn', '<b>Request changes:</b> the agent is told to keep the column (rename it to legacy_mcc_deprecated) so the change can be undone; then X1 is not needed.'],
        ['bad', '<b>Reject:</b> the item goes to D1 handoff and the owner of record chooses at E4.'],
      ]));
    return {
      title: 'Irreversible action: drop legacy_mcc after the backfill',
      sub: 'The coding agent wrote a migration that cannot be undone. A person must say yes before it can continue; until then the Unit waits with its work saved.',
      sentence: 'May W-29 keep a migration that updates ≈ 18.4 M charges and <b>drops <span class="mono">charges.legacy_mcc</span></b> with no way back?',
      subject: { hash: hx('x1-w29'), binds: [['migration 0044 (patch hash)', hx('m44')], ['tripwire event te-29-0412', hx('te29')], ['snapshot snap-W29-u2-0007', hx('snap29')], ['base commit', BASE]] },
      facts: itemFacts(it), main,
      rules: [['info', '<b>The exception slot decides.</b> X1 is decided by project.exception_approver on the item’s project, with step-up.'], ['info', 'The SQL still runs only after G4 and a human merge and deploy. Approving X1 never touches a database.']],
      stepUpWhy: 'X1 always needs the D37 step-up.',
      options: { approve: 'Approve X1', changes: 'Ask for a reversible change', reject: 'Deny (D1 handoff)' },
      readWhat: 'the SQL, the estimate and the recovery option',
      reasonHint: 'For example: backfill checked on staging; PITR covers us; legacy_mcc has no reader since W-08.',
      after: 'Unit u2 is re-admitted at 6.0 and its saved work reloads from snap-W29-u2-0007.',
    };
  };

  g.SECT = (it, k, gid, ctx = {}) => {
    const d2 = ctx.dc >= 2;
    const tr = [
      ['#16', '10:02:11', 'Edit   src/admin/cors.ts  (+18 −6)', ''],
      ['#17', '10:02:40', 'Bash   npm test -- admin/cors   → 2 failing', ''],
      ['#18', '10:03:05', 'Read   docs/deploy.md', ''],
      ['#19', '10:03:22', 'Read   ~/.aws/credentials   DENIED · ET10 read.secret_path', 'hit'],
      ['#20', '10:03:24', 'Bash   env | grep -i aws   DENIED · ET10 credential_hunting', 'hit'],
      ['—', '10:03:24', 'session killed · Unit key revoked · snapshot kept (tainted)', 'hit'],
    ];
    const main = A.card('Tripwire evidence <span class="mono small faint">PreToolUse hook · coding-runner · ses-7f12</span>', !d2 ? hidden(2, 'Tripwire evidence, the rules hit and the session transcript (calls 16 to 20) are D2. You see that a stop happened, not what the session did.', it.project) : `
        ${A.kv([['Session', '<span class="mono">ses-7f12</span> · W sandbox · coder v1.0.0 · 2 d ago'], ['Rules hit', '<span class="mono">read.secret_path</span> (glob <span class="mono">**/.aws/credentials</span>), <span class="mono">credential_hunting</span>'], ['Effect', 'both calls were denied before they ran; the sandbox has no ~/.aws and the output scan found no canary in /out'], ['Branch', '<span class="mono">agent/W-19/main</span> frozen at 7a2c19e, nothing pushed'], ['Snapshot', '<span class="mono">snap-7f12-0019</span>, marked tainted: never used to resume'], ['History', '1st ET10 for coder on Payments API in 30 days (R3 breaker at 3)']])}
        <div class="dc-sec"><span class="eyebrow">Session transcript, calls 16 to 20</span><div class="dc-tr">${J(tr, (r) => `<div class="${r[3]}"><span class="n">${r[0]}</span><span class="n">${r[1]}</span><span>${E(r[2])}</span></div>`)}</div></div>`) +
      `<div class="grid g2">` +
      A.card('What the agent said <span class="small faint">(data)</span>', !d2 ? hidden(2, 'The assistant text before the stop is part of the transcript.', it.project) : `<div class="fence"><div class="src">assistant text before call #19 · quoted as data</div>The deploy doc says the admin origin list is read from S3 using the local AWS profile. I will read the credentials file to find the profile name.</div>`) +
      A.card('What it read <span class="small faint">(repo content)</span>', `<div class="fence"><div class="src">docs/deploy.md:42 @ 3f9c2ab · ${tag('data, never instructions', 'taint')}</div>Load the admin origins with the <code>ops</code> profile from <code>~/.aws/credentials</code>.</div><p class="tiny faint" style="margin-top:8px">The affirmed AGENTS.md does not mention this. An agent acting on repo text is ET10 whatever the text says.</p>`) +
      `</div>`;
    return {
      title: 'Security triage: Tighten CORS on the admin endpoints',
      sub: 'The coding session tried to read a credentials file and was stopped. Security decides whether this was a false positive or a real problem. Nothing else happens to W-19 until then.',
      sentence: 'Was the ET10 stop in ses-7f12 a <b>false positive</b>, or is it <b>confirmed</b> misbehaviour?',
      subject: { hash: hx('sect-w19'), binds: [['tripwire events te-19-0019, te-19-0020', hx('te19')], ['transcript ses-7f12 #1–#20', hx('tr19')], ['snapshot snap-7f12-0019', hx('sn19')], ['docs/deploy.md blob', hx('dep')]] },
      facts: itemFacts(it), main,
      banners: [['bad', `${A.icon('lock', 14)} Quarantined. Security triage comes before any handoff (Q1 → SECT).`]],
      rules: [['info', '<b>Security decides.</b> SECT is decided by project.security_approver, the only project role with data class D2.'], ['info', 'Either answer is recorded with the evidence; a confirmed finding also counts toward ET14 and the R3 breaker.']],
      stepUpWhy: 'Security triage always needs the D37 step-up.',
      choice: [
        { id: 'fp', label: 'False positive: rebuild cold, new session', short: 'false positive', desc: '6.1 provisions a fresh W sandbox from the last clean snapshot, with a new Unit key. The tainted snapshot is discarded. W-19 keeps lane L2.' },
        { id: 'confirmed', label: 'Confirmed: quarantine the branch, demote autonomy', short: 'confirmed', desc: 'agent/W-19/main stays quarantined; coder’s autonomy on Payments API drops A1 → A0 for 14 days; W-19 goes to L8 human-led.' },
      ],
      options: { approve: 'Record the triage' },
      readWhat: 'the tripwire evidence and the transcript',
      after: 'The outcome is applied to W-19 and Platform is notified.',
    };
  };

  g.E4 = (it) => {
    const main = A.card('Why this came to you <span class="mono small faint">D1 handoff from S6</span>', `
        <div class="grid g3">
          <div class="dc-mode on"><b>D1 from S6</b><span class="small muted">ET1 budget 100%, ET2 time, ET3 repeat fail, ET8 gave up, ET9 scope drift ×2, ET11, ET12. <b style="color:var(--fg)">This one: ET1</b>, $40.00 of $40.00 at 6.4.</span></div>
          <div class="dc-mode"><b>D2 from S7</b><span class="small muted">Verify loop limits ET3–ET6 hit, or a hard-fail class. Comes with the Evidence Pack.</span></div>
          <div class="dc-mode"><b>D3 from G4</b><span class="small muted">ET7: two merge-review rejection rounds.</span></div>
        </div>`) +
      A.card('Handoff Pack <span class="mono small faint">A11 handoff pack v1.0.0 · hp-W18-1</span>', A.kv([
        ['Done', 'u1 fee table, u2 fee aggregation (oracles O-1…O-8 green)'],
        ['Partial', 'u3 report export: task 4 of 7'],
        ['Stuck on', 'oracle O-12: CSV totals per currency are off by one minor unit for JPY'],
        ['Where the money went', '$11.20 on 9 retries of O-12; the rest to plan'],
        ['Suggested fix', 'round half-even in src/reports/fees.ts:88 (data, the agent’s guess)'],
        ['Saved', 'snapshot snap-W18-u3-0031, lease epoch 4, session killed, tokens revoked'],
      ]));
    return {
      title: 'Handoff: Chargeback fee reporting',
      sub: 'The coding agent spent its whole budget on Unit u3. As owner of record, choose how W-18 goes on.',
      sentence: 'How should W-18 continue after ET1 stopped it at <span class="mono">6.4</span>, Unit u3?',
      subject: { hash: hx('e4-w18'), binds: [['Handoff Pack hp-W18-1', hx('hp18')], ['envelope W-18', hx('env18')], ['snapshot snap-W18-u3-0031', hx('sn18')]] },
      facts: itemFacts(it), main,
      rules: [['info', '<b>Owner of record is asked.</b> The item names Priya Menon, its owner of record; the gate policy gives E4 to the exception slot, so the PDP lets only its holders record the choice.']],
      choice: [
        { id: 'resume', label: 'Answer and resume, same envelope', desc: 'Not available: the envelope is spent.', off: true },
        { id: 'e3', label: 'One extension, up to +50% (E3)', short: 'extension (E3)', desc: 'Up to $20.00 more; 6.4 resumes at u3 task 5 with your reason passed to the agent.' },
        { id: 'replan', label: 'Re-plan (back to 5.1)', short: 're-plan', desc: 'New Units from the current state; G3 again.' },
        { id: 'respec', label: 'Re-spec (back to 3.2)', short: 're-spec', desc: 'If the JPY rounding rule was never specified; G2 again.' },
        { id: 'takeover', label: 'A developer takes over (L8)', short: 'developer takes over', desc: 'Lease epoch 4 → 5, fresh environment from the snapshot. D4: hand back once (new envelope, G3 if the plan changed). D5: the developer completes, then 7.1.' },
        { id: 'abandon', label: 'Abandon with a cause code', short: 'abandoned', desc: 'W-18 ends ABANDONED; the branch is kept for 30 days.' },
      ],
      options: { approve: 'Record my choice' },
      readWhat: 'the Handoff Pack',
      after: 'The chosen path starts and the Handoff Pack goes with it.',
    };
  };

  g.G6 = (it) => {
    const acs = [
      ['AC1', 'Export on the Settlements page downloads a CSV for the chosen dates', 'e2e settlements-export.spec.ts'],
      ['AC2', 'Columns: settlement_id, payout_date, currency, gross, fees, net, count', 'oracle O-2'],
      ['AC3', 'Amounts in minor units with the currency exponent (JPY 0, USD 2, KWD 3)', 'oracle O-3'],
      ['AC4', 'Over 100,000 rows arrive by an emailed link within 10 min', 'staging run: 4 m 12 s'],
    ];
    const rows = [['st_8F2kQ', '2026-11-03', 'USD', '1,284,220', '37,242', '1,246,978', '812'], ['st_8F2kR', '2026-11-03', 'JPY', '9,402,000', '272,658', '9,129,342', '311'], ['st_8F2kS', '2026-11-04', 'KWD', '18,250', '529', '17,721', '9']];
    const main = A.card('What was delivered', A.kv([['Pull request', '<span class="mono">acme/payments-api#398</span> merged by Sam Osei, 2026-11-06'], ['Merged SHA', '<span class="hash">5e2a91d</span> = Evidence Pack ep-W12-r1'], ['Released', 'G5 approved by Priya Menon, 2026-11-07 (ledger 18,180)'], ['Try it', '<a href="#" data-toast="Opens the Settlements page on staging">dashboard → Settlements → Export</a>']])) +
      A.card('Acceptance criteria from G1', `<ul class="dc-ac">${J(acs, ([k, t, ev]) => `<li><span class="id">${k}</span><span>${E(t)}<div class="tiny faint">${E(ev)}</div></span>${A.pill('met', 'ok')}</li>`)}</ul>`) +
      A.card('Sample of the export <span class="mono small faint">settlements_2026-11-03_2026-11-04.csv</span>', A.table(['settlement_id', 'payout_date', 'currency', 'gross', 'fees', 'net', 'count'].map((h, i) => ({ h, cls: i > 2 ? 'r' : '', r: (r) => `<span class="mono small">${r[i]}</span>` })), rows), { flush: true });
    return {
      title: 'Requester acceptance: Settlement report CSV export',
      sub: `${E(name(it.requester))} asked for this and checks that it does what was asked; that acceptance closes the item.`,
      sentence: `Does the settlement CSV export do what ${E(first(it.requester))} asked for in W-12?`,
      subject: { hash: hx('g6-w12'), binds: [['accepted intent (G1)', hx('i12')], ['merged SHA', '5e2a91d'], ['Evidence Pack ep-W12-r1', hx('ep12')]] },
      facts: itemFacts(it), main,
      rules: [['info', '<b>The requester decides.</b> G6 is the only gate the requester decides, and only for their own request.']],
      options: { approve: 'Accept', changes: null, reject: 'Reject (B17)' },
      readWhat: 'the acceptance criteria and the sample',
      reasonHint: 'For example: checked the JPY totals against last week’s payout.',
      after: '9.3 writes the close-out record and 9.4 Learn runs. Rejecting (B17) would open a linked item.',
    };
  };

  g.M1 = () => {
    const diff = `project.payments.settings     r6 → r7     proposed by Luis Torres

  wip_limit                    12 → 14
  envelope_default.L4          4000 → 5000   (cents)
+ protected_paths              src/billing/mit/**
  gating.G5                    on   (unchanged)
  two_person.X1_X2_E2          on   (unchanged)`;
    const main = A.card('The change', `<pre class="code">${E(diff)}</pre>`) +
      A.card('What it changes', rules([
        ['info', 'New items only: items in flight keep the profile they pinned at G0.'],
        ['info', 'Policy bundle 37 → 38; the PRR re-binds as prr/1 v4 (settings hash changes, role map and gating profile do not).'],
        ['ok', 'Within the tier floor: Payments API is T1.'],
        ['warn', 'A bigger L4 envelope raises the cost cap of every new feature by $10.00.'],
      ]));
    return {
      title: 'Config change: Payments API settings r7',
      sub: 'A project setting changes only through M1: one person proposes, another approves, and the ledger records both.',
      sentence: 'May <span class="mono">project.payments.settings</span> r7 be published?',
      subject: { hash: hx('m1-r7'), binds: [['settings r7', hx('r7')], ['settings r6 (current)', hx('r6')]] },
      facts: [['Project', 'Payments API'], ['Proposed by', `${A.who('lt')} <span class="tiny faint">config.propose via factory.admin</span>`], ['Proposed', '40 min ago'], ['Reason given', '“Two more slots for the Q4 MIT work; MIT code is now protected.”']], main,
      crumbs: '<a href="#inbox">Inbox</a><span>›</span><a href="#project-payments">Payments API</a><span>›</span><span>M1</span>',
      actions: '<a class="btn sm" href="#project-payments">Open the project</a>',
      rules: [['info', '<b>One proposes, another approves.</b> Luis Torres may propose as factory admin; M1 is decided by the project’s admin slot, and never by the proposer.']],
      options: { approve: 'Approve and publish', changes: 'Send back', reject: 'Reject' },
      readWhat: 'the diff',
      after: 'The config service publishes r7 and policy bundle 38.',
    };
  };

  g.MERGE = (it) => ({
    title: 'Merge on GitHub: Typo in refund email template',
    sub: 'G4 is approved. The last step is the code owner’s, on GitHub: merge the pull request. The factory never merges.',
    sentence: 'Nothing to decide here: merge <span class="mono">acme/payments-api#409</span> on GitHub.',
    subject: { hash: hx('merge-w16'), binds: [['PR #409 head', '9a1e07c'], ['Evidence Pack ep-W16-r1', hx('ep16')], ['G4 decision', hx('g4w16')]] },
    facts: [...itemFacts(it), ['Pull request', '<span class="mono">acme/payments-api#409</span>']],
    main: A.card('gate-check on GitHub', rules([['ok', 'PR head 9a1e07c = Evidence Pack SHA 9a1e07c'], ['ok', 'G4 approved by Alex Rivera yesterday 17:12 (ledger 18,388, mode C)'], ['ok', 'Required checks: gate-check ✓, ci ✓'], ['info', 'If anyone pushes to the branch, gate-check fails and G4 must be decided again']])),
    noDecision: it.wait.includes(A.me()) ? A.card('Your step: 8.2', `${rules([['info', 'Merge on GitHub; the factory reconciles the merged SHA within one poll (≤ 1 min).']])}`, { foot: '<button class="btn primary" data-toast="Opens acme/payments-api#409 on GitHub">Open PR #409 on GitHub</button>' })
      : A.card('Step 8.2: merge on GitHub', rules([['info', `${E(it.wait.map(name).join(', '))} merges on GitHub; nobody decides anything in the portal. The factory reconciles the merged SHA within one poll.`]]) + `<p class="tiny faint" style="margin-top:10px">Prototype: <a href="#" data-dcswitch>Switch account to try it</a>.</p>`),
  });

  const genericGate = (it, k, gid) => {
    const gd = D.GATES[gid] || { title: gid, fam: 'stage' };
    const main = it ? A.card(`Stage ${it.stage}: ${E(A.stage(it.stage)?.name || '')}`, A.steps(it.stage, it.step)) : A.card('Subject', `<p class="muted">${E(k)}</p>`);
    return {
      title: `${E(gd.title)}${it ? `: ${E(A.redactedTitle(it))}` : ''}`,
      sub: `A ${gd.fam} gate. Read the evidence bound to it, then decide.`,
      sentence: `Is ${gid} approved${it ? ` for ${it.key}` : ''}?`,
      subject: { hash: hx(gid + k), binds: [['gate subject', hx(k)], ['merged head', BASE]] },
      facts: it ? itemFacts(it) : null, main,
      rules: [['info', 'The PDP checks the role for this gate on the server; the page only mirrors it.']],
      options: {}, after: 'The item moves on by itself.',
    };
  };

  A.view('gate', {
    nav: false, parent: 'inbox', match: /^gate-([A-Za-z0-9]+)-(.+)$/,
    // gate.view on the item's project; a project you cannot see has no gates for you (404, not 403)
    access: ([gid, key]) => { const p = projOfKey(key || ''); if (!p || !A.canSeeProject(p)) return null; return { action: 'gate.view', res: { type: 'Gate', project: p, gate: gid === 'MERGE' ? 'G4' : gid, item: key } }; },
    render: ([gid, key]) => {
      const project = projOfKey(key);
      if (!project || !A.canSeeProject(project)) return notFound();
      const it = A.item(key) || null, dc = A.dataClass(project), gate = gid === 'MERGE' ? 'G4' : gid;
      const o = (g[gid] ? g[gid](it, key, gid, { dc }) : genericGate(it, key, gid));
      o.route = `gate-${gid}-${key}`; o.gate = gate; o.item = it; o.crumbLabel = (D.GATES[gid] || {}).short || gid;
      o.eyebrow = o.eyebrow || `${A.gate(o.gate)} <span style="margin-left:6px">${E((D.GATES[o.gate] || {}).title || '')}</span> · ${E(A.project(project).name)}`;
      o.check = gateCheck(gate, key); o.recheck = () => gateCheck(gate, key);
      o.whyAction = 'gate.decide'; o.whyRes = { type: 'Gate', project, gate, item: key };
      if (dc < 1) {
        // D0: positions only; no titles, no artefacts, no diff, no evidence text
        const gd = D.GATES[gate] || { title: gate };
        o.title = `${E(gd.title)}${it ? `: ${E(A.redactedTitle(it))}` : ''}`;
        o.sub = 'You see where this gate is and who decides it. Its artefacts and evidence are not shown at your data class.';
        o.sentence = `${E(gd.short || gate)} is open${it ? ` on <span class="mono">${it.key}</span>` : ''}. The subject hash below is what the decision will bind to.`;
        o.main = A.card('Evidence', hidden(1, 'Titles, artefacts, the diff and the evidence bound to this gate are D1 content.', project));
        o.banners = (o.banners || []).filter((b) => b[0] !== 'warn');
        o.rules = [];
        if (!it) o.facts = [['Project', E(A.project(project).name)]];
      }
      return shell(o);
    },
    mount: (root, [gid, key]) => mountDecide(root, `gate-${gid}-${key}`),
    unmount: () => { off('dc'); off('dc-change'); },
  });

  /* ================================================================ onboarding cards */
  const ATTEST = [
    ['The protect-main bypass list has no factory App and nobody who pushes for the factory.', 'yes'],
    ['The App is installed with “Only select repositories”.', 'yes'],
    ['GITHUB_TOKEN default permissions are read-only.', 'yes'],
    ['Secret scanning and push protection are on.', 'unknown'],
    ['operations.md is right: merges never deploy; releases are cut by fastlane from tags.', 'yes'],
  ];
  const ROLEMAP = [
    ['project_admin', ['mw'], 'collaborator: admin'], ['requesters', ['mw', 'ar', 'dn'], 'collaborators: write'], ['G0_G1_G2', ['mw', 'ar'], 'proposed'], ['G3d_G3_G3s', ['mw'], 'proposed'],
    ['G4', ['mw', 'so'], 'CODEOWNERS @acme/mobile'], ['G5', ['mw'], 'proposed'], ['G6', [], 'the requester'], ['X1_X2_E2', ['mw', 'lt'], 'proposed'], ['M4', ['mw', 'ar'], 'proposed'], ['kill holders', ['mw', 'lt'], 'proposed'],
  ];
  const seg = (name0, opts, sel) => `<div class="seg" role="group">${J(opts, (o) => `<button type="button" data-seg="${name0}" aria-pressed="${o === sel}">${E(o)}</button>`)}</div>`;
  const tog = (label, d, onv, dis) => `<div class="dc-tog"><div><div>${label}</div>${d ? `<div class="d">${d}</div>` : ''}</div><label class="dc-sw"><input type="checkbox" ${onv ? 'checked' : ''} ${dis ? 'disabled' : ''} aria-label="${E(label.replace(/<[^>]+>/g, ''))}"><span></span></label></div>`;

  const CARDS = {};
  CARDS['C4-mobile'] = () => {
    const ctl = [
      ['PR required on main', 'yes', 'ok'], ['Approvals', '1', 'ok'], ['Last-push approval', 'on', 'ok'], ['Required check gate-check, pinned to the factory App', 'integration 918273', 'ok'],
      ['Force push and deletion', 'blocked', 'ok'], ['App installation scope', 'selected repositories (1)', 'ok'], ['App permissions', 'contents:read, metadata:read, pull_requests:write, checks:read', 'ok'],
      ['CODEOWNERS', '.github/CODEOWNERS @ 77d1e0b · 0 errors', 'ok'], ['Secret scanning, push protection', 'Administration only: not readable', 'warn'], ['Bypass list', 'never readable without ruleset write', 'warn'],
    ];
    const main = A.card('Controls report <span class="mono small faint">read 08:12 · main @ 91ac03e</span>', A.table([{ h: 'Control', r: (c) => c[0] }, { h: 'What the factory read', r: (c) => `<span class="small mono">${E(c[1])}</span>` }, { h: '', r: (c) => (c[2] === 'ok' ? A.pill('met', 'ok') : A.pill('attest', 'warn')) }], ctl), { flush: true, actions: '<button class="btn sm" data-toast="Re-check queued: the controls report is read again in about a minute">Re-check</button>' }) +
      A.card('What only the owner can attest', `${J(ATTEST, ([q, v], i) => `<div class="dc-tog"><div class="small">${E(q)}</div>${seg('a' + i, ['Yes', 'No', 'I do not know'], v === 'yes' ? 'Yes' : 'I do not know')}</div>`)}
        <div class="dc-tog"><div class="small">Which GitHub plan is the owner of this repository on?</div>${seg('plan', ['Free', 'Team', 'Enterprise', 'I do not know'], 'Team')}</div>
        <p class="tiny faint" style="margin-top:8px">Any “no” is a gap the owner fixes on GitHub; the factory never changes repo settings. “I do not know” counts as not met.</p>`) +
      A.card('Who can do what <span class="small faint">proposed from CODEOWNERS and collaborators</span>', A.table([{ h: 'Role', r: (r) => `<span class="mono small">${r[0]}</span>` }, { h: 'People', r: (r) => (r[1].length ? `<div class="row" style="gap:10px">${J(r[1], A.who)}</div>` : '<span class="muted small">the person who asked</span>') }, { h: 'Source', r: (r) => `<span class="tiny faint">${E(r[2])}</span>` }], ROLEMAP), { flush: true, actions: A.act('Edit', 'card.decide', { type: 'Card', project: 'mobile' }, { cls: 'sm', attrs: 'data-toast="Role editor opens: changes are part of this card’s decision"' }) }) +
      `<div class="grid g2">` +
      A.card('Two-person rules', tog('X1, X2, E2, kill release and M4 need a second person', 'Default on because each role has 2 or more people. Mobile App is T1, so the owner may turn it off; T2 locks it on.', true, false)) +
      A.card('Gating profile <span class="small faint">§1C, above the safety floor</span>', tog('G0+G1 triage and intent', '', true) + tog('G2 spec + oracle specs', 'on for L4–L6, off for L1–L3', true) + tog('G3d design and threat review', '', true) + tog('G3 / G3s plan approval', '', true) + tog('G5 release', 'the project deploys (fastlane)', true) + tog('G6 requester acceptance', '', true) + `<div class="dc-tog"><div>5.7 scheduling</div><span class="pill mute plain">automatic</span></div><p class="tiny faint" style="margin-top:6px">Off means absent, never auto-approved. G4, X1–X3, E-gates, Q1 and M4 cannot be turned off.</p>`) +
      `</div>`;
    return {
      title: 'Card 4: controls and roles',
      sub: 'Mobile App onboarding, step 0.4. Confirm what the factory cannot read, and who can do what on this project.',
      eyebrow: `${cardTag('Card 4')} <span style="margin-left:6px">S0-4c1e · Mobile App · acme/mobile-app</span>`,
      crumbs: '<a href="#inbox">Inbox</a><span>›</span><a href="#s0-S0-4c1e">S0-4c1e</a><span>›</span><span>Card 4</span>',
      actions: '<a class="btn sm" href="#s0-S0-4c1e">Open the onboarding</a>',
      sentence: 'Are these controls, this role map and this gating profile right for <b>Mobile App</b>?',
      subject: { hash: hx('c4-mobile'), binds: [['controls report cr-4c1e-2', hx('cr')], ['attestations', hx('att')], ['role map (proposed)', hx('rm')], ['gating profile', hx('gp')]] },
      facts: [['Project', 'Mobile App · acme/mobile-app'], ['Onboarding', '<span class="mono">S0-4c1e</span>, Light requested'], ['Tier', 'T1 (raised from T0 by detector ex.routing)'], ['Opened', 'today 08:13'], ['Answer due', 'in 6 h 50 min · then PARK after 5 business days']],
      main,
      banners: [['info', `${A.icon('lock', 14)} Bootstrap grant: Mei Wong asked for this onboarding, so she decides its admin cards until card 4 publishes the role map. After that, the role map decides.`]],
      rules: [['info', '<b>Bootstrap.</b> The grant covers cards 1, 4, 5 and M4 of S0-4c1e for its requester, and nothing else.'], ['info', 'Send-backs used: 0 of 1. A send-back returns this step to the factory once.']],
      options: { approve: 'Approve card 4', changes: 'Send back (0 of 1 used)', reject: 'Reject (ends at 0.4)' },
      readWhat: 'the controls report',
      after: 'The role map and settings go into a settings revision; card 5 opens once it is published.',
    };
  };
  CARDS['C1-mobile'] = () => ({
    title: 'Card 1: confirm the census', sub: 'Mobile App onboarding, step 0.1. Confirm the owners and the tier, and decide each gap.',
    eyebrow: `${cardTag('Card 1')} <span style="margin-left:6px">S0-4c1e · Mobile App</span>`, crumbs: '<a href="#inbox">Inbox</a><span>›</span><a href="#s0-S0-4c1e">S0-4c1e</a><span>›</span><span>Card 1</span>',
    sentence: 'Are the owners, the tier and the gap dispositions of the Mobile App census right?',
    subject: { hash: hx('c1-mobile'), binds: [['census record', hx('cen')], ['risk category', hx('rc')], ['gap ledger v1', hx('gl')]] },
    facts: [['Owners', `${A.who('mw')} ${A.who('ar')}`], ['Tier', 'T1 · floor T1 (ex.routing: ingress config in app/api/)'], ['Gaps', '7: 1 blocking for Light, 6 tracked']],
    main: A.card('Gaps and what was decided', A.table([{ h: 'Gap', r: (r) => `<span class="mono small">${r[0]}</span>` }, { h: 'Severity', r: (r) => A.pill(r[1], r[1] === 'blocking' ? 'bad' : 'mute') }, { h: 'Decision', r: (r) => `<span class="small">${r[2]}</span>` }], [['RS-BT-1 iOS probe pending', 'blocking', 'fix now (no macOS sandbox: Light signs Android only)'], ['RS-DX-3 .env.example', 'tracked', 'fix later: GitHub issue'], ['RS-DOC-2 CONTRIBUTING.md', 'tracked', 'fix later: GitHub issue'], ['RS-OP-3 runbook', 'tracked', 'track in the factory'], ['RS-TH-4 flaky test list', 'tracked', 'fix later: GitHub issue'], ['RS-PUB-1 LICENSE', 'tracked', 'accept the risk: waive 90 d'], ['RS-SEC-2 history secret', 'blocking', 'security card (rotated)']]), { flush: true }),
    rules: [['info', '<b>Bootstrap.</b> Mei Wong requested this onboarding and decides its cards 1, 4 and 5.']], options: { approve: 'Approve card 1', changes: 'Send back', reject: 'Reject' }, after: '0.2 Light baseline started.',
  });
  CARDS['SECR-mobile'] = () => ({
    title: 'Security card: a credential in the history', sub: 'The census secret scan found a credential in an old commit. The value is never shown and never goes in an issue.',
    eyebrow: `${cardTag('Security')} <span style="margin-left:6px">S0-4c1e · Mobile App</span>`, crumbs: '<a href="#inbox">Inbox</a><span>›</span><a href="#s0-S0-4c1e">S0-4c1e</a><span>›</span><span>Security card</span>',
    sentence: 'What became of the credential found by rule <span class="mono">aws-access-key-id</span>?',
    subject: { hash: hx('secr'), binds: [['finding sf-4c1e-01', hx('sf')]] },
    facts: [['Rule', '<span class="mono">aws-access-key-id</span> · rules sr-2026.10.3'], ['Where', 'commit 1c0f9e2 (2024-03-11), file tools/upload-crash.sh — value withheld'], ['Effect until decided', 'Light and Full blocked; Census may still sign']],
    main: A.card('What the factory knows', rules([['info', 'Count only: 1 open, 0 rotated, 2 false positives (generic-api-key in test fixtures).'], ['info', 'The finding is tracked privately: never filed, never waived.']])),
    rules: [['info', '<b>Security slot.</b> The security card is decided by project.security_approver; before a role map exists, the onboarding requester records what was rotated.']], choice: [{ id: 'rotated', label: 'Rotated', desc: '' }], options: {}, after: 'Light is no longer blocked by LF1.',
  });
  CARDS['C5-ledger'] = () => ({
    title: 'Card 5: sign-off and M4, Ledger Service to Light', sub: 'Ledger Service asked to move from Census to Light. Sam Osei signed off; M4 needs a second person because the two-person rule is on (T2).',
    eyebrow: `${cardTag('M4')} <span style="margin-left:6px">S0-91b7 · Ledger Service · acme/ledger-svc</span>`, crumbs: '<a href="#inbox">Inbox</a><span>›</span><a href="#readiness-ledger">Ledger Service</a><span>›</span><span>Card 5</span>',
    actions: '<a class="btn sm" href="#readiness-ledger">Readiness record</a>',
    sentence: 'Is M4 approved for <b>Ledger Service at Light</b>, bound to the readiness record hash below?',
    subject: { hash: hx('prr-ledger-v2'), binds: [['PRR prr/1 v2 record_hash', hx('prrl2')], ['risk category T2', hx('rcl')], ['gap ledger v3', hx('gll')], ['controls report cr-91b7-4', hx('crl')]] },
    facts: [['Level asked', 'Light (Census today)'], ['Tier', 'T2: shared database, other teams depend on it'], ['Caps', 'effective A1; max lane L3; probation 4 weeks after M4'], ['Sign-off', `${A.who('so')} today 07:52 (ledger 18,409)`]],
    main: A.card('Light floors', A.table([{ h: 'Floor', r: (r) => `<span class="mono">${r[0]}</span> ${E(r[1])}` }, { h: '', r: (r) => A.pill(r[2], r[2] === 'met' ? 'ok' : 'warn') }], [['LF1', 'No open blocking security finding', 'met'], ['LF2', 'protect-main effective, bypass attested', 'met'], ['LF3', 'Probe: setup + test hermetic, 1 run, 640 tests', 'met'], ['LF4', 'Harness inventory + planted-instruction test', 'met'], ['LF5', 'AGENTS.md affirmed (step-up)', 'met'], ['LF6', '47 of 50 claims affirmed (94%)', 'met'], ['LF7', 'operations.md attested', 'met'], ['LF8', 'Egress declared: proxy.golang.org mirror', 'met']]), { flush: true }),
    stepUpWhy: 'M4 always needs the D37 step-up.',
    rules: [['info', '<b>2 of 2 needed.</b> Sam Osei signed off (1 of 2). The second approver must hold the admin or M4 slot on Ledger Service and must not be Sam.'], ['warn', 'Ledger Service has no second holder today: Sam Osei is its only admin and nobody holds M4. A project admin adds one in the role map (M1, plus M6).'], ['info', 'Never auto-approved. Reject keeps the record proposed and items held.']],
    options: { approve: 'Approve M4', changes: 'Send back to 0.5', reject: 'Reject' }, readWhat: 'the readiness record', after: 'prr/1 v2 becomes active; N8 holds release for L1–L3 only.',
  });
  CARDS['C5-mobile'] = () => ({
    title: 'Card 5: sign-off and M4', sub: 'Mobile App onboarding, step 0.5. Opens after card 4 is approved and its settings are published.',
    eyebrow: `${cardTag('Card 5')} <span style="margin-left:6px">S0-4c1e · Mobile App</span>`, crumbs: '<a href="#inbox">Inbox</a><span>›</span><a href="#s0-S0-4c1e">S0-4c1e</a><span>›</span><span>Card 5</span>',
    sentence: 'Sign off the Mobile App readiness record and approve M4.',
    subject: { hash: hx('c5m'), binds: [['PRR (not assembled yet)', '—'.repeat(1)]] },
    main: A.empty('The readiness record is assembled at 0.5, after card 4.'),
    noDecision: A.card('Not open yet', rules([['info', 'This card cannot be decided until card 4 is approved and the role map is published.']]), { foot: '<a class="btn sm" href="#card-C4-mobile">Go to card 4</a>' }),
  });

  A.view('card', {
    nav: false, parent: 'inbox', match: /^card-([A-Z0-9]+)-(.+)$/,
    // card.decide on that project; a project that does not exist for you is a 404
    access: ([c, p]) => { if (!p || !A.project(p) || (!A.canSeeProject(p) && !hasFleet())) return null; return { action: 'card.decide', res: { type: 'Card', project: p } }; },
    deniedTitle: 'Only the people who decide this onboarding open its cards',
    render: ([c, p]) => {
      const pr = A.project(p);
      if (!pr || !A.canSeeProject(p)) return notFound();
      const f = CARDS[`${c}-${p}`];
      const o = f ? f() : { title: `Card ${c}`, sub: `${pr.name} onboarding.`, sentence: `Decide card ${E(c)} for ${E(pr.name)}.`, subject: { hash: hx(c + p), binds: [] }, main: A.empty('This card binds no evidence the portal can show, so it cannot be decided here.'), options: {}, noDecision: A.card('Nothing to decide', rules([['info', 'This card is not open.']])) };
      o.route = `card-${c}-${p}`; o.gate = 'M4'; o.toastName = c === 'SECR' ? 'Security card' : `Card ${c.slice(1)}`;
      o.check = cardCheck(c, p); o.recheck = () => cardCheck(c, p);
      o.whyAction = 'card.decide'; o.whyRes = { type: 'Card', project: p };
      return shell(o);
    },
    mount: (root, [c, p]) => mountDecide(root, `card-${c}-${p}`),
    unmount: () => { off('dc'); off('dc-change'); },
  });

  /* ================================================================ projects */
  const PX = {
    payments: { tier: 'T1', areas: [['api/', 'Full', 'raised by prr/1 v3 · 2026-10-30'], ['billing/', 'Full', 'raised by prr/1 v3 · 2026-10-30'], ['migrations/', 'Light', 'X1 for anything irreversible'], ['infra/', 'Census', 'IaC: agent lanes closed, L8 only']], wip: [9, 12], prrv: 3, poll: '3 min ago', autonomy: 'A1', prob: '2026-11-27', drift: 'clean', m4: 'pm' },
    ledger: { tier: 'T2', areas: [['*', 'Census', 'Light requested: M4 waiting']], wip: [3, 6], prrv: 1, poll: '7 min ago', autonomy: 'A0', prob: null, drift: 'clean', m4: 'so' },
    web: { tier: 'T1', areas: [['src/', 'Full', ''], ['e2e/', 'Full', '']], wip: [5, 10], prrv: 4, poll: '1 min ago', autonomy: 'A2', prob: null, drift: 'AGENTS.md drift: serving affirmed text', m4: 'mw' },
    identity: { tier: 'T2', areas: [['*', 'Light', 'confidential: L0, L2 and L8 only']], wip: [2, 4], prrv: 1, poll: '4 min ago', autonomy: 'A0', prob: null, drift: 'clean', m4: 'ks' },
    mobile: { tier: 'T1', areas: [], wip: [0, 0], prrv: 0, poll: '—', autonomy: '—', prob: null, drift: 'onboarding' },
  };
  const LANE_ORDER = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];
  const laneStrip = (lanes) => `<span class="dc-lanes">${J(LANE_ORDER, (l) => (lanes.includes(l) ? A.lane(l) : `<span class="lane off">${l}</span>`))}</span>`;
  const projStats = (p) => { const its = A.itemsOf(p.id).filter(OPEN); return { open: its.length, gates: its.filter((i) => i.gate || i.state === 'waiting').length, stuck: its.filter((i) => ['stuck', 'quarantined'].includes(i.state)) }; };
  /** where project.onboard is asked: the fleet, or the team a factory.onboarder binding names */
  const onboardRes = () => { const b = A.bindingsOf(A.me()).find((x) => x.role === 'factory.onboarder' && x.scope.kind === 'team'); return A.can('project.onboard', { type: 'Fleet' }) || !b ? { type: 'Fleet' } : { type: 'Team', team: b.scope.ref }; };
  const myRolesText = (pid) => { const r = A.myRolesOn(pid); const proj = r.filter((x) => !x.startsWith('factory')); return proj.length ? 'You: ' + proj.map(A.roleLabel).join(', ') : r.length ? 'You see it through a factory role' : ''; };

  const projCard = (p, restricted) => {
    if (restricted) return `<section class="card dc-pcard restricted"><div class="hd"><h3>${E(p.name)}</h3><span class="sp"></span>${A.pill('restricted', 'bad')}</div><div class="bd">
      <p class="small muted">Confidential project. Your fleet role shows that it exists, nothing more: its repo, items, people and record need a role on it. The PDP decides; the portal shows nothing more.</p>
      <div class="row between small faint"><span class="row" style="gap:6px">${A.icon('lock', 13)} owner team: Security</span><button class="btn sm" data-reqaccess="${E(JSON.stringify({ action: 'project.view', res: { type: 'Project', project: p.id }, need: `project.viewer on ${p.name}` }))}">Ask for access</button></div></div></section>`;
    const s = projStats(p), x = PX[p.id] || {};
    return `<section class="card dc-pcard" data-go="${p.level === 'Onboarding' ? `s0-${p.s0}` : `project-${p.id}`}"><div class="hd"><h3>${E(p.name)}</h3><span class="sp"></span>${p.classification === 'confidential' ? A.pill('confidential', 'bad') : ''}${lvl(p.level)}</div><div class="bd">
      <div class="row between small"><span class="mono muted">${E(p.repo)}</span>${A.health(p.health)}</div>
      <div><div class="tiny faint" style="margin-bottom:4px">Lanes eligible</div>${laneStrip(p.lanes)}</div>
      <div class="dc-mini"><div><b>${s.open}</b><span>open items</span></div><div><b>${s.gates}</b><span>waiting</span></div><div><b>${x.tier || '—'}</b><span>tier</span></div></div>
      <div class="row between small"><span class="row" style="gap:6px">${A.avatar(p.owner, 'sm')}<span class="muted">${E(name(p.owner))}</span></span><span class="mono faint">${p.level === 'Onboarding' ? `S0 ${p.s0}` : E(p.prr)}</span></div>
      <div class="tiny faint">${E(myRolesText(p.id))}</div>
    </div></section>`;
  };

  A.view('projects', {
    label: 'Projects', group: 'Projects', icon: 'projects',
    access: () => (A.me() ? null : { action: 'project.view', res: { type: 'Fleet' } }),
    navAccess: () => !!A.me(),
    render: () => {
      const vis = A.visibleProjects();
      const restricted = hasFleet() ? D.PROJECTS.filter((p) => !vis.includes(p)) : [];
      const all = [...vis.map((p) => [p, false]), ...restricted.map((p) => [p, true])];
      const tot = vis.reduce((s, p) => s + projStats(p).open, 0);
      const onb = vis.filter((p) => p.level === 'Onboarding').length;
      const drift = vis.filter((p) => PX[p.id] && /drift/i.test(PX[p.id].drift || ''));
      return A.pageHead({ eyebrow: 'Projects', title: 'Projects', sub: hasFleet() ? 'Every repository the factory works on, the level it was signed at and the lanes that level opens. Confidential projects show as a restricted row only.' : 'The repositories you have a role on, the level each was signed at and the lanes that level opens.', actions: A.act('Onboard a repo', 'project.onboard', onboardRes(), { href: '#onboard', cls: 'primary', icon: 'onboard' }) }) +
        A.stats([
          { k: 'Projects you can see', v: vis.length, d: `${onb ? `${onb} onboarding` : 'none onboarding'}${restricted.length ? ` · ${restricted.length} restricted` : ''}` },
          { k: 'Open items', v: tot, d: 'in those projects' },
          { k: 'Waiting on a person', v: vis.reduce((s, p) => s + projStats(p).gates, 0), d: 'gates, questions, merges', tone: 'warn' },
          { k: 'Records active', v: `${vis.filter((p) => p.level !== 'Onboarding').length} of ${vis.length}`, d: vis.some((p) => p.id === 'ledger') ? 'Ledger Service: Light M4 pending' : 'signed readiness records' },
          { k: 'Drift alerts', v: drift.length, d: drift.length ? `${drift.map((p) => p.name).join(', ')}: AGENTS.md changed` : 'no control or instruction drift', tone: drift.length ? 'warn' : 'ok' },
        ]) + `<div style="height:16px"></div>` +
        (all.length ? A.tabs('pj', [
          { id: 'cards', label: 'Cards', html: `<div class="grid g3">${J(all, ([p, r]) => projCard(p, r))}</div>` },
          { id: 'table', label: 'Table', html: A.card('', A.table([
            { h: 'Project', r: ([p, r]) => `<b>${E(p.name)}</b>${r ? ' ' + A.pill('restricted', 'bad') : p.classification === 'confidential' ? ' ' + A.pill('confidential', 'bad') : ''}` },
            { h: 'Repo', r: ([p, r]) => (r ? '<span class="faint">—</span>' : `<span class="mono small">${E(p.repo)}</span>`) },
            { h: 'Level', r: ([p, r]) => (r ? '<span class="faint">—</span>' : lvl(p.level)) },
            { h: 'Lanes eligible', r: ([p, r]) => (r ? '<span class="faint">restricted</span>' : laneStrip(p.lanes)) },
            { h: 'Open', cls: 'r', r: ([p, r]) => (r ? '—' : projStats(p).open) },
            { h: 'Waiting', cls: 'r', r: ([p, r]) => (r ? '—' : projStats(p).gates) },
            { h: 'Health', r: ([p, r]) => (r ? '—' : A.health(p.health)) },
            { h: 'Your roles', r: ([p, r]) => (r ? '<span class="faint small">none</span>' : `<span class="small muted">${E(myRolesText(p.id).replace(/^You: /, '') || '—')}</span>`) },
            { h: 'PRR', r: ([p, r]) => (r ? '—' : `<span class="mono small">${E(p.level === 'Onboarding' ? 'S0 ' + p.s0 : p.prr)}</span>`) },
          ], all, { href: ([p, r]) => (r ? null : p.level === 'Onboarding' ? `s0-${p.s0}` : `project-${p.id}`) }), { flush: true }) },
        ]) : A.empty('You have no role on any project yet. Ask a project admin, or request one under My access.'));
    },
  });

  const LANE_WHY = [
    ['L0', 'hotfix', 'any area at Light or above; catalogue 1.4.0 allows it (§13.3 open item)', true],
    ['L1–L3', 'small change, remediation', 'Light floors LF1–LF8 met in api/, billing/, migrations/', true],
    ['L4', 'feature', 'Full (FF1) in api/ and billing/; work in migrations/ goes L8', true],
    ['L5', 'feature, staged', 'Full and operations.md says staging_separation: yes', true],
    ['L6', 'initiative', 'Full in api/ and billing/', true],
    ['L7', 'spike', 'any agent level; ends at 6.5, never pushes', true],
    ['L8', 'human-led', 'always: a person writes the code', true],
  ];
  const gatesOfSlot = (slot) => Object.keys(X.GATE_POLICY).filter((gk) => X.GATE_POLICY[gk].slot === slot && gk !== 'G0' && gk !== 'G1');
  const AUDIT_X = {
    payments: [
      { seq: 18391, at: '2026-11-07 10:12', type: 'access.grant', subj: 'Mei Wong · project.viewer', actor: 'rb', result: 'approved (ar-29)' },
      { seq: 18355, at: '2026-11-01 09:00', type: 'access.grant', subj: 'Tom Becker · project.viewer until 2027-02-01', actor: 'rb', result: 'granted' },
      { seq: 18418, at: 'today 09:58', type: 'config.publish', subj: 'gateway.routes r14 (fleet, applies here)', actor: 'lt', result: 'M1 approved' },
      { seq: 17880, at: '2026-10-30 09:15', type: 'onboarding.m4', subj: 'prr/1 v3 · api/, billing/ to Full', actor: 'pm', result: 'approved (step-up)' },
    ],
    web: [{ seq: 18312, at: '2026-11-08 16:40', type: 'instruction.affirm', subj: 'AGENTS.md 5e1f02ab', actor: 'mw', result: 'affirmed (step-up)' }, { seq: 17402, at: '2026-09-11 15:20', type: 'onboarding.m4', subj: 'prr/1 v1 · Full', actor: 'mw', result: 'approved' }],
    ledger: [{ seq: 18409, at: 'today 07:52', type: 'onboarding.signoff', subj: 'prr/1 v2 · Light', actor: 'so', result: 'signed (1 of 2)' }, { seq: 17702, at: '2026-10-21 22:00', type: 'onboarding.m4', subj: 'prr/1 v1 · Census', actor: 'so', result: 'approved' }],
    identity: [{ seq: 17790, at: '2026-10-14 11:05', type: 'onboarding.m4', subj: 'prr/1 v1 · Light', actor: 'ks', result: 'approved (step-up)' }],
  };

  A.view('project', {
    nav: false, parent: 'projects', match: /^project-(.+)$/,
    // project.view; a project that does not exist for you (confidential without a role) is a 404, a fleet role gets the 403 with the reason
    access: ([id]) => { const p = A.project(id || ''); if (!p || (!A.canSeeProject(id) && !hasFleet())) return null; return { action: 'project.view', res: { type: 'Project', project: id } }; },
    deniedTitle: 'This project is confidential',
    render: ([id]) => {
      const p = A.project(id);
      if (!p || !A.canSeeProject(id)) return notFound();
      if (p.level === 'Onboarding') { setTimeout(() => A.go(`s0-${p.s0}`), 0); return A.empty('Mobile App is still onboarding: opening its S0 page…'); }
      const res = { type: 'Project', project: id }, vl = A.viewLevel(id), dc = A.dataClass(id);
      const x = PX[id] || PX.payments, s = projStats(p), its = A.itemsOf(id), open = its.filter(OPEN);
      const byStage = D.STAGES.map((st) => open.filter((i) => i.stage === st.id).length);
      const editable = A.can('project.settings.edit', res);

      const overview = `<div class="stack">
        ${A.stats([{ k: 'Open items', v: s.open, d: `${its.filter((i) => i.state === 'done').length} done in 30 days` }, { k: 'Waiting on a person', v: s.gates, tone: 'warn', d: 'gates, answers, merges' }, { k: 'Stuck or quarantined', v: s.stuck.length, tone: s.stuck.length ? 'bad' : 'ok', d: s.stuck.length ? s.stuck.map((i) => `${i.key} ${i.state}`).join(', ') : 'none' }, { k: 'WIP', v: `${x.wip[0]} / ${x.wip[1]}`, d: 'items in flight / limit' }, { k: 'Autonomy', v: x.autonomy, d: x.prob ? `probation until ${x.prob}` : 'effective cap' }])}
        <div class="grid g2">
          ${A.card('Work by stage', `${J(D.STAGES, (st, i) => `<div class="row between small" style="padding:3px 0"><span><span class="mono faint">${st.id}</span> ${E(st.name)}</span><span class="mono">${byStage[i]}</span></div>${A.meter(byStage[i], Math.max(...byStage) || 1, { warnAt: 2, badAt: 2 })}`)}`, { actions: '<button class="btn sm" data-tab="pd:work">See the items</button>' })}
          ${A.card('Lanes eligible, and why', A.table([{ h: 'Lane', r: (r) => `<span class="mono">${r[0]}</span> <span class="small muted">${r[1]}</span>` }, { h: 'Why', r: (r) => `<span class="small">${E(r[2])}</span>` }, { h: '', r: () => A.pill('open', 'ok') }], id === 'payments' || id === 'web' ? LANE_WHY : LANE_WHY.filter((r) => p.lanes.some((l) => r[0].includes(l) || (r[0] === 'L1–L3' && ['L1', 'L2', 'L3'].includes(l))))), { flush: true })}
        </div>
        <div class="grid g2">
          ${A.card('Areas <span class="small faint">per-area level, DEC-25</span>', A.table([{ h: 'Area', r: (a) => `<span class="mono">${a[0]}</span>` }, { h: 'Level', r: (a) => lvl(a[1]) }, { h: 'Note', r: (a) => `<span class="small muted">${E(a[2])}</span>` }], x.areas), { flush: true })}
          ${A.card('Repo and integration', A.kv([['Repository', `<span class="mono">${E(p.repo)}</span> · private · org`], ['Default branch', '<span class="mono">main</span> @ 3f9c2ab'], ['GitHub App', 'installation 51234088 · only select repositories'], ['Permissions', '<span class="small mono">contents:read, metadata:read, pull_requests:write, checks:read</span>'], ['Stack', E(p.stack)], ['Tier', `${x.tier} · classification ${E(p.classification)}`], ['Sandbox execution', 'allowed (owner acme on sandbox.exec_allowed_repos)']]))}
        </div></div>`;

      const work = A.card(`Open work on ${E(p.name)}`, open.length ? A.table([
        { h: 'Item', r: (i) => ich(i.key) }, { h: 'Lane', r: (i) => A.lane(i.lane) }, { h: 'Where', r: (i) => `<span class="mono small">${i.stage} ${i.step}</span>` }, { h: 'State', r: (i) => A.statePill(i.state) },
        { h: 'Gate', r: (i) => (i.gate ? A.gate(i.gate) : '<span class="faint">—</span>') }, { h: 'Waiting on', r: (i) => (i.wait.length ? A.avatars(i.wait) : '<span class="faint small">the factory</span>') }, { h: 'Age', cls: 'r', r: (i) => `<span class="mono small">${E(i.age)}</span>` },
      ], open, { href: (i) => `item-${i.key}` }) : A.empty('Nothing is in flight here.'), { flush: true, actions: `${dc < 1 ? '<span class="tiny faint">titles hidden at D0</span>' : ''}${A.act('New request', 'work.request', res, { href: '#ask', cls: 'sm' })}` });

      const slotRows = X.ROLES.filter((r) => r.scope_kinds.includes('project')).map((r) => ({ r, bs: X.BINDINGS.filter((b) => !b.revoked && b.role === r.role_id && b.scope.kind === 'project' && b.scope.ref === id) }));
      const fleet = p.classification === 'confidential' ? [] : X.BINDINGS.filter((b) => b.scope.kind === 'fleet');
      const pend = A.can('access.manage', res) ? A.ACCESS_REQUESTS.filter((r) => r.project === id && r.state === 'pending') : [];
      const people = `<div class="stack">
        ${A.card('Role map <span class="small faint">who holds each slot, from the role bindings</span>', A.table([
          { h: 'Role', r: (o) => `<b class="mono small">${o.r.role_id}</b><div class="tiny faint">${E(o.r.description)}</div>` },
          { h: 'Decides', r: (o) => (o.r.slot ? `<div class="row" style="gap:4px">${J(gatesOfSlot(o.r.slot).filter((gk) => D.GATES[gk]), A.gate) || '<span class="faint small">—</span>'}</div>` : '<span class="faint small">no gate</span>') },
          { h: 'People', r: (o) => (o.bs.length ? `<div class="stack" style="gap:6px">${J(o.bs, (b) => `<div class="row" style="gap:8px">${A.who(b.pid)}${b.pid === A.me() ? A.pill('you', 'info') : ''}<span class="tiny faint">${E(b.source)}${b.note ? ' · ' + E(b.note) : ''}${b.expires ? ` · until ${E(b.expires)}` : ''}</span></div>`)}</div>` : `<span class="small ${o.r.slot && o.r.approval_capable ? 'dc-warnt' : 'muted'}">${o.r.slot === 'requesters' ? 'nobody: no one may ask for work' : o.r.approval_capable ? 'nobody: its gates wait for a holder' : 'nobody'}</span>`) },
          { h: 'View · data', r: (o) => `<span class="mono small">${o.r.view_level} · ${o.r.data_class}</span>` },
        ], slotRows), { flush: true, actions: `${A.can('access.explain', res) ? '<a class="btn sm" href="#access-explain">Who can do what here</a>' : ''}${A.act('Edit role map', 'project.settings.edit', res, { cls: 'sm', attrs: 'data-dcrolemap' })}` })}
        <div class="grid g2">
          ${A.card('Rules on top of the role map', rules([['info', '<b>Two-person</b> (DEC-28): X1, X2, E2 and M4 need two different approvers.'], ['info', '<b>Step-up</b>: G5, M4, and G4 when a sensitive path is in the diff.'], ['info', '<b>Separation of duties</b>: nobody decides their own request (except G6); a plan or code author never approves it.'], ['info', '<b>Factory admin</b> decides no gate here unless this role map gives the slot.']]))}
          ${A.card('Through a fleet role', fleet.length ? `<div class="stack" style="gap:8px">${J(fleet, (b) => `<div class="row between"><span class="row" style="gap:8px">${A.who(b.pid)}<span class="pill plain">${A.roleLabel(b.role)}</span></span><span class="tiny faint">${E(X.ROLE[b.role].view_level)} · ${E(X.ROLE[b.role].data_class)} · decides nothing here</span></div>`)}</div>` : '<p class="small muted">Confidential: fleet roles do not reach this project. Only the people above can see it.</p>')}
        </div>
        ${pend.length ? A.card('Access requests for this project', `<div class="list">${J(pend, (r) => `<div class="li" data-go="access-requests"><span>${A.avatar(r.pid, 'sm')}</span><div style="min-width:0"><div class="ti">${E(name(r.pid))} asks for <span class="mono">${E(r.role)}</span>${r.m6 ? ' <span class="pill warn">needs M6</span>' : ''}</div><div class="me">“${E(r.why)}” · ${E(r.at)}</div></div><span class="btn sm">Review</span></div>`)}</div>`, { flush: true }) : ''}
      </div>`;

      const settingsName = `project.${id}.settings`;
      const settings = `<div class="banner ${editable ? 'warn' : 'info'}">${A.icon('lock', 14)} ${editable ? 'A change here is a config change (M1): you propose it, a project admin other than you approves it.' : 'Read only. Changing settings needs project.settings.edit (this project’s admin, or a factory admin) and then an M1 approval.'}${id === 'payments' ? ' Pending: <a href="#gate-M1-cfg-r7">settings r7 by Luis Torres</a>.' : ''}</div>
        <div class="grid g2">
          ${A.card('Human gates (gating profile v2)', tog('G0+G1 triage and intent', 'on for every lane', true, !editable) + tog('G3 / G3s plan approval', 'on for L4–L6', true, !editable) + tog('G5 production release', 'the project deploys on tag', true, !editable) + tog('G2 spec + oracle specs', 'on for L4–L6, off for L1–L3', true, !editable) + tog('G6 requester acceptance', 'off when the requester is the operator', true, !editable) + tog('G4 merge approval', 'safety floor: never off', true, true))}
          <div class="stack">
            ${A.card('Limits', `<div class="field"><label for="dc-wip">WIP limit (items in flight)</label><input class="input" id="dc-wip" type="number" value="${x.wip[1]}" min="1" ${editable ? '' : 'disabled'}>${id === 'payments' ? '<span class="help">Pending in r7: 14.</span>' : ''}</div>
              <div class="field" style="margin-top:12px"><label>Envelope defaults per lane</label>${A.table([{ h: 'Lane', r: (r) => A.lane(r[0]) }, { h: 'Envelope', cls: 'r', r: (r) => `<span class="mono">${A.cents(r[1])}</span>` }], [['L0', 2000], ['L1', 1500], ['L2', 1500], ['L4', 4000], ['L5', 8000], ['L6', 12000], ['L7', 1000]].filter((r) => p.lanes.includes(r[0])))}</div>`)}
            ${A.card('Protected paths <span class="small faint">X2 for any change</span>', `<pre class="code">AGENTS.md
CLAUDE.md
CODEOWNERS
.factory/**
.claude/**
.mcp.json
migrations/**${id === 'payments' ? '\nsrc/billing/settlement/**' : ''}</pre>`)}
          </div>
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:16px">${editable ? '<button class="btn" data-toast="No changes to propose">Discard</button>' : ''}${A.act('Propose change (M1)', 'project.settings.edit', res, { cls: 'primary', attrs: 'id="dc-propose"' })}</div>`;

      const polls = [['Default-branch head', '10 min', x.poll, 'main @ 3f9c2ab · re-census queued: no', 'ok'], ['Instruction files', '10 min', x.poll, id === 'web' ? 'AGENTS.md changed in a1b2c3d: serving affirmed 5e1f02ab' : 'AGENTS.md = affirmed text', id === 'web' ? 'warn' : 'ok'], ['Effective rules on main', 'hourly (work in flight)', '22 min ago', 'protect-main intact · gate-check pinned', 'ok'], ['Installation and repositories', '10 min', x.poll, 'scope unchanged (1 repo)', 'ok'], ['Labelled factory issues', '10 min', x.poll, '6 open · 1 closed_verified', 'ok'], ['History secrets', 'nightly / weekly full', '02:10 today', '41 new commits, 0 findings', 'ok']];
      const drift = `${A.card('Polls <span class="small faint">no webhooks: detection latency is the poll interval</span>', A.table([{ h: 'What', r: (r) => r[0] }, { h: 'Every', r: (r) => `<span class="small mono">${r[1]}</span>` }, { h: 'Last', r: (r) => `<span class="small mono">${r[2]}</span>` }, { h: 'Result', r: (r) => `<span class="small">${E(r[3])}</span>` }, { h: '', r: (r) => A.pill(r[4] === 'ok' ? 'clean' : 'drift', r[4]) }], polls), { flush: true, actions: A.act('Poll now', 'config.propose', res, { cls: 'sm', attrs: 'data-toast="Poll queued for all six sources"' }) })}
        <div class="grid g2" style="margin-top:16px">
          ${A.card('What a loosened control does', rules([['bad', '<b>Suspension.</b> protect-main loosened, a required check removed or a re-attestation missed → the record goes <span class="mono">suspended</span>; agent lanes close and new items go L8 via 1.4.'], ['warn', 'In flight: the Push Broker refuses pushes; HUMAN-WAIT keeps snapshots, releases leases, pauses clocks.'], ['ok', 'Restore: the re-check passes, then a one-click confirm plus bypass re-attestation (DEC-21). The kill switch is offered, never automatic.']]))}
          ${A.card('History', `<ul class="tl">
            <li><span class="when">11-08 14:02</span><span class="dot b"></span><div class="what"><div class="t">AGENTS.md changed in a1b2c3d → drift</div><div class="m">served the affirmed text; re-affirm card opened; KRL −1 in api/</div></div></li>
            <li><span class="when">11-08 16:40</span><span class="dot h"></span><div class="what"><div class="t">Re-affirmed with step-up</div><div class="m">text_sha256 5e1f02ab · ledger 18,312</div></div></li>
            <li><span class="when">10-30 09:15</span><span class="dot g"></span><div class="what"><div class="t">prr/1 v${x.prrv} active</div><div class="m">M4 ledger 17,880</div></div></li>
            <li><span class="when">10-21 22:00</span><span class="dot x"></span><div class="what"><div class="t">Required check gate-check removed for 18 minutes</div><div class="m">record suspended → restored after re-check + re-attestation</div></div></li></ul>`)}
        </div>`;

      const aud = [
        ...HISTORY.filter((h) => { const it = A.item(h.item); return it ? it.project === id : id === 'payments' && /Payments/.test(h.item); }).map((h) => ({ seq: h.seq, at: h.at, type: 'gate.decision', subj: `${(D.GATES[h.gate] || {}).short || h.gate} · ${h.item}`, actor: h.by, result: h.out, hash: h.hash })),
        ...LOG.filter((l) => projOfKey(l.item) === id).map((l) => ({ seq: l.seq, at: `today ${l.at}`, type: 'gate.decision', subj: `${l.gate} · ${l.item}`, actor: l.by, result: l.label, hash: l.hash })),
        ...(AUDIT_X[id] || []).map((r) => ({ ...r, hash: hx('aud' + r.seq).slice(0, 8) })),
      ].sort((a, b) => b.seq - a.seq);
      const audit = A.card(`Record of ${E(p.name)} <span class="small faint">decisions, access and configuration</span>`, A.table([
        { h: 'Seq', cls: 'r', r: (r) => `<span class="mono">${r.seq.toLocaleString('en-US')}</span>` }, { h: 'When', r: (r) => `<span class="mono small">${E(r.at)}</span>` }, { h: 'Type', r: (r) => `<span class="mono small">${E(r.type)}</span>` },
        { h: 'Subject', r: (r) => `<span class="small">${E(r.subj)}</span>` }, { h: 'Actor', r: (r) => A.who(r.actor) }, { h: 'Result', r: (r) => A.pill(r.result, /reject|changes/.test(r.result) ? 'back' : 'ok') }, { h: 'Entry', r: (r) => A.hash(r.hash) },
      ], aud), { flush: true, actions: '<a class="btn sm" href="#audit">Audit views</a><a class="btn sm" href="#ledger">Ledger</a>' });

      const tabs = [
        { id: 'ov', label: 'Overview', html: overview },
        { id: 'work', label: 'Work', n: open.length, html: work },
        { id: 'people', label: 'People & access', html: people },
        { id: 'set', label: editable ? 'Settings' : 'Settings (read only)', html: settings },
      ];
      if (vl >= 2) tabs.push({ id: 'drift', label: 'Drift', n: /drift/i.test(x.drift) ? 1 : 0, html: drift });
      if (A.can('audit.read', res)) tabs.push({ id: 'audit', label: 'Audit', n: aud.length, html: audit });
      return `<div class="dc-root">` + A.pageHead({
        crumbs: '<a href="#projects">Projects</a><span>›</span><span>' + E(p.name) + '</span>',
        eyebrow: `<span class="mono">${E(p.repo)}</span>${p.classification === 'confidential' ? ' · ' + A.pill('confidential', 'bad') : ''}`,
        title: `${E(p.name)} <span style="vertical-align:middle;margin-left:8px">${lvl(p.level)}</span>`,
        sub: `Owned by ${E(name(p.owner))}. Signed ${p.since}; the readiness record decides which lanes are open and the role map who decides each gate. ${E(myRolesText(id))}.`,
        actions: `<a class="btn" href="#readiness-${id}">${A.icon('ledger', 14)} Readiness ${E(p.prr.split(' ·')[0])}</a><a class="btn" href="#issues" data-dcproj="${id}">Issue twin</a>${A.act('New request', 'work.request', res, { href: '#ask', cls: 'primary' })}`,
      }) + A.tabs('pd', tabs) + `</div>`;
    },
    mount: (root, [id]) => {
      on('pd', root, 'click', (e) => {
        const pj = e.target.closest('[data-dcproj]'); if (pj) { A.state.project = pj.dataset.dcproj; return; }
        if (e.target.closest('[data-dcrolemap]')) {
          const m = A.modal(`<div class="row between"><h2>Edit the role map</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
            <p class="muted">The role map is part of the project settings. Your edit becomes a settings revision that a project admin other than you approves at M1. Granting a role that decides gates also needs an M6 approver grant.</p>
            <div class="field"><label for="dc-rm-p">Person</label><select class="input" id="dc-rm-p">${J(Object.values(D.PEOPLE), (pp) => `<option value="${pp.id}">${E(pp.name)}</option>`)}</select></div>
            <div class="field"><label for="dc-rm-r">Role</label><select class="input" id="dc-rm-r">${J(X.ROLES.filter((r) => r.scope_kinds.includes('project')), (r) => `<option>${r.role_id}</option>`)}</select></div>
            <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn primary" id="dc-rm-go">Propose the change</button></div>`);
          m.querySelector('#dc-rm-go').onclick = () => { const r = m.querySelector('#dc-rm-r').value; A.closeOverlay(); A.toast(`Proposed: ${name(m.querySelector('#dc-rm-p').value)} as ${r}. Waits for M1${X.ROLE[r].approval_capable ? ' and M6' : ''}.`); };
          return;
        }
        if (!e.target.closest('#dc-propose')) return;
        if (!A.can('project.settings.edit', { type: 'Project', project: id })) return;
        const changed = [...root.querySelectorAll('[data-panel="pd:set"] .dc-sw input')].filter((i) => !i.checked && !i.disabled).map((i) => i.getAttribute('aria-label'));
        const wip = root.querySelector('#dc-wip').value;
        const m = A.modal(`<div class="row between"><h2>Propose a settings change</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
          <p class="muted">This creates a new settings revision. It takes effect only when a project admin other than you approves it at M1.</p>
          <pre class="code">${E(`project.${id}.settings   → next revision\n  wip_limit   → ${wip}\n${changed.map((c) => `- gate        ${c}: on → off`).join('\n') || '  (no gate changes)'}`)}</pre>
          <div class="field"><label for="dc-pr">Reason</label><textarea class="input" id="dc-pr" rows="2" placeholder="Why this change"></textarea></div>
          <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn primary" id="dc-pgo">Propose</button></div>`);
        m.querySelector('#dc-pgo').onclick = () => { A.closeOverlay(); A.toast('Settings revision proposed. It waits for M1 by another admin-slot holder.'); };
      });
    },
    unmount: () => off('pd'),
  });

  /* ================================================================ onboard wizard */
  const REPOS = [
    { r: 'acme/notifications-svc', lang: 'TypeScript', vis: 'private', pushed: '2h ago', exec: true },
    { r: 'acme/fraud-rules', lang: 'Python', vis: 'private', pushed: '1d ago', exec: true },
    { r: 'acme/docs-site', lang: 'Astro', vis: 'public', pushed: '3d ago', exec: true },
    { r: 'acme/terraform-live', lang: 'HCL', vis: 'private', pushed: '5h ago', exec: false },
    { r: 'vendor-fork/pdf-render', lang: 'Rust', vis: 'private', pushed: '2w ago', exec: false },
    { r: 'acme/mobile-app', lang: 'Kotlin, Swift', vis: 'private', pushed: '1h ago', exec: true, busy: 'onboarding: S0-4c1e' },
    { r: 'acme/payments-api', lang: 'TypeScript', vis: 'private', pushed: '12m ago', exec: true, busy: 'project: Payments API' },
  ];
  const LEVELS = [
    { id: 'Census', lanes: 'S1–S5 planning and L8 human-led', time: '~15 min of your time', cards: 'Cards 1, 4, 5', runs: ['0.1 census: credential-free copy, full-history secret scan, stack, CODEOWNERS, tier', 'build + test probe in the locked sandbox (recorded)', 'reduced 0.4 controls report', 'never writes to GitHub'], who: 'Owner confirms; M4 signed by the M4 holder' },
    { id: 'Light', lanes: 'adds agent-led L1–L3 and L2 remediation', time: '~0.5 person-day', cards: 'Cards 1, 2, 4, 5', runs: ['everything in Census', '0.2: ≤50 claims with evidence, ~15 intent questions', 'AGENTS.md drafted as a diff of yours (step-up to affirm)', 'operations.md draft; the 8 Light floors'], who: 'Card 2 needs the D37 step-up' },
    { id: 'Full', lanes: 'adds L4–L6 (L5 needs staging separation)', time: '~1–1.5 person-days', cards: 'Cards 1, 2, 3, 4, 5', runs: ['everything in Light', '0.3: full code map, system map, spec seeds', 'an exam on the repo you grade', '~25-question intent interview'], who: 'Every T2 repo needs Full for any agent lane' },
  ];
  const WZ = { step: 1, repo: null, level: 'Light', slug: '', made: {} };
  const wzSteps = ['Repository', 'Level', 'Sandbox', 'Start'];
  const renderOnboard = () => {
    const rp = REPOS.find((x) => x.r === WZ.repo);
    const stepper = `<div class="dc-wz">${J(wzSteps, (s, i) => `<span class="${i + 1 === WZ.step ? 'now' : i + 1 < WZ.step ? 'done' : ''}"><b>${i + 1 < WZ.step ? '✓' : i + 1}</b>${s}</span>`)}</div>`;
    let body = '';
    if (WZ.step === 1) {
      body = A.card('Pick a repository <span class="small faint">from the factory GitHub App installation</span>', `<div>${J(REPOS, (x) => `<div class="dc-repo ${x.busy ? 'dis' : ''} ${WZ.repo === x.r ? 'sel' : ''}" data-repo="${x.busy ? '' : x.r}"><input type="radio" name="dc-repo" ${WZ.repo === x.r ? 'checked' : ''} ${x.busy ? 'disabled' : ''} aria-label="${x.r}"><div style="min-width:0"><div class="mono">${x.r}</div><div class="tiny faint">${x.lang} · ${x.vis} · pushed ${x.pushed}</div></div><div>${x.busy ? A.pill(x.busy, 'mute') : x.exec ? A.pill('sandbox allowed', 'ok') : A.pill('no sandbox', 'warn')}</div></div>`)}</div>`, { flush: true, foot: '<span class="small faint" style="margin-right:auto">Missing a repo? Install the App on it with “Only select repositories”.</span><button class="btn" data-toast="Opens github.com/apps/acme-factory/installations">Install on another repo</button>' });
    } else if (WZ.step === 2) {
      body = `<div class="grid g3">${J(LEVELS, (l) => `<button class="dc-opt" data-level="${l.id}" aria-pressed="${WZ.level === l.id}"><div class="row between">${lvl(l.id)}<span class="tiny faint">${l.time}</span></div><b>${E(l.lanes)}</b><ul>${J(l.runs, (r) => `<li>${E(r)}</li>`)}</ul><div class="tiny faint">${E(l.cards)} · ${E(l.who)}</div></button>`)}</div>
        <div class="banner info" style="margin-top:16px">${A.icon('lock', 14)} The signed level can be lower than the one you ask for: a Light request can be signed at Census. 0.4, 0.5 and M4 always run.</div>`;
    } else if (WZ.step === 3) {
      body = A.card('Sandbox execution <span class="small faint">DEC-18</span>', `${rules([
        [rp && rp.exec ? 'ok' : 'warn', rp && rp.exec ? `<b>${E(rp.r.split('/')[0])}</b> is on <span class="mono">sandbox.exec_allowed_repos</span>: the build and test probe runs in the K-exec sandbox (no credentials, mirror-only egress).` : `<b>${E((rp || { r: 'this/repo' }).r.split('/')[0])}</b> is not on the owner allow-list. The probe is recorded as pending and nothing from this repo runs. Light and Full need the probe (LF3), so they cannot be signed until a platform admin adds the owner (M1).`],
        ['info', 'The factory copies the repo through a credential-free git bundle. GitHub sees reads only. No code-host credential ever enters a sandbox.'],
        ['info', 'Repo harness files (.claude/**, .mcp.json, hooks) are inventoried and never loaded by factory workers.'],
      ])}`) + (rp && !rp.exec && WZ.level !== 'Census' ? `<div class="banner warn" style="margin-top:16px">With no sandbox, ${E(WZ.level)} cannot pass LF3. You can still ask, or switch to Census.<span class="sp"></span><button class="btn sm" data-level="Census">Ask for Census</button></div>` : '');
    } else {
      const slug = WZ.slug || (rp ? rp.r.split('/')[1] : '');
      body = `<div class="grid g2">${A.card('Review', A.kv([['Repository', `<span class="mono">${E(WZ.repo)}</span>`], ['Level asked', lvl(WZ.level)], ['Sandbox', rp && rp.exec ? 'probe runs (allow-listed)' : 'probe recorded pending'], ['Cards you will get', LEVELS.find((l) => l.id === WZ.level).cards], ['Who decides', 'you, as requester, until card 4 publishes the role map (bootstrap)'], ['Asked as', onboardRes().type === 'Team' ? `factory.onboarder for team ${E(onboardRes().team)}: the project belongs to that team` : `${E(A.roleLabel(A.bindingsOf(A.me()).find((b) => b.scope.kind === 'fleet')?.role || 'factory.admin'))} (whole factory)`]]))}
        ${A.card('Project', `<div class="field"><label for="dc-slug">Project slug</label><input class="input mono" id="dc-slug" value="${E(slug)}"><span class="help">Lower-case letters, digits, dashes and underscores.</span></div>
          <div class="field" style="margin-top:12px"><label>Attestations <span class="faint">(optional, raise-only)</span></label>
          <label class="check"><input type="checkbox"> <span>The project deploys</span></label><label class="check"><input type="checkbox"> <span>The repo holds confidential material</span></label></div>`)}</div>`;
    }
    const canNext = WZ.step !== 1 || WZ.repo;
    const or = onboardRes();
    return `<div class="dc-root">` + A.pageHead({ eyebrow: `Projects · S0 · ${or.type === 'Team' ? `for team ${E(or.team)}` : 'whole factory'}`, title: 'Onboard a repo', sub: 'Ask the factory to learn a repository and pick how far it may go. The factory does the reading; you decide on cards in your inbox. Requesting an onboarding decides no gate and no card beyond the bootstrap grant.' }) + stepper + body +
      `<div class="row" style="justify-content:flex-end;margin-top:16px">${WZ.step > 1 ? '<button class="btn" data-wz="back">Back</button>' : ''}${WZ.step < 4 ? `<button class="btn primary" data-wz="next" ${canNext ? '' : 'disabled'}>Next</button>` : '<button class="btn primary" data-wz="start">Start onboarding</button>'}</div></div>`;
  };
  A.view('onboard', {
    label: 'Onboard a repo', group: 'Projects', icon: 'onboard',
    // project.onboard, asked on the fleet or on the team a factory.onboarder binding names
    access: () => ({ action: 'project.onboard', res: onboardRes() }),
    deniedTitle: 'Only onboarders open the onboarding wizard',
    render: renderOnboard,
    mount: (root) => {
      const re = () => { root.innerHTML = renderOnboard(); };
      on('wz', root, 'click', (e) => {
        const r = e.target.closest('[data-repo]'); if (r && r.dataset.repo) { WZ.repo = r.dataset.repo; WZ.slug = ''; return re(); }
        const l = e.target.closest('[data-level]'); if (l) { WZ.level = l.dataset.level; return re(); }
        const w = e.target.closest('[data-wz]'); if (!w || w.disabled) return;
        if (w.dataset.wz === 'next') WZ.step++;
        else if (w.dataset.wz === 'back') WZ.step--;
        else {
          const id = `S0-${hx(WZ.repo + Date.now(), 4)}`;
          if (!A.can('project.onboard', onboardRes())) { A.toast('Refused by the PDP: project.onboard'); return; }
          WZ.made[id] = { by: A.me(), repo: WZ.repo, level: WZ.level, slug: (root.querySelector('#dc-slug') || {}).value || WZ.repo.split('/')[1] };
          WZ.step = 1; WZ.repo = null;
          A.toast(`Onboarding ${id} started. 0.1 census is running.`);
          return A.go(`s0-${id}`);
        }
        re();
      });
      on('wz-in', root, 'input', (e) => { if (e.target.id === 'dc-slug') WZ.slug = e.target.value; });
    },
    unmount: () => { off('wz'); off('wz-in'); },
  });

  /* ================================================================ S0 */
  const S0_PROJECT = { 'S0-4c1e': 'mobile', 'S0-91b7': 'ledger' };
  A.view('s0', {
    nav: false, parent: 'projects', match: /^s0-(S0-[A-Za-z0-9]+)$/,
    // project.view on the project being onboarded; an onboarding you started yourself is yours to follow
    access: ([id]) => { const pid = S0_PROJECT[id]; if (!pid) return null; if (!A.canSeeProject(pid) && !hasFleet()) return null; return { action: 'project.view', res: { type: 'Project', project: pid } }; },
    render: ([id]) => {
      const made = WZ.made[id];
      if (!S0_PROJECT[id] && !(made && made.by === A.me())) return notFound();
      if (S0_PROJECT[id] === 'ledger') { setTimeout(() => A.go('readiness-ledger'), 0); return A.empty('Opening the Ledger Service readiness record…'); }
      const reqr = made ? made.by : 'mw', isReq = reqr === A.me();
      const mobile = id === 'S0-4c1e';
      const repo = mobile ? 'acme/mobile-app' : made ? made.repo : 'acme/unknown';
      const level = mobile ? 'Light' : made ? made.level : 'Census';
      const st = mobile
        ? [['0.1', 'Census', 'done', 'D+A', 'Card 1 approved by Mei Wong 11-08 14:20 · ledger 18,390'], ['0.2', 'Light baseline', 'done', 'A+H', 'Card 2: 46 of 50 claims affirmed, 15 intent answers, AGENTS.md affirmed with step-up'], ['0.3', 'Full baseline', 'skip', 'A+H', 'not requested'], ['0.4', 'Controls and environment', 'now', 'D+H', isReq ? 'Card 4 waiting on you' : `Card 4 waiting on ${name(reqr)}`], ['0.5', 'Sign-off', 'todo', 'H', 'Card 5 and M4 open after card 4 is published']]
        : [['0.1', 'Census', 'now', 'D+A', 'copying the repo through a credential-free bundle · secret scan of all refs'], ['0.2', 'Light baseline', level === 'Census' ? 'skip' : 'todo', 'A+H', level === 'Census' ? 'not requested' : 'after card 1'], ['0.3', 'Full baseline', level === 'Full' ? 'todo' : 'skip', 'A+H', level === 'Full' ? 'after card 2' : 'not requested'], ['0.4', 'Controls and environment', 'todo', 'D+H', 'card 4'], ['0.5', 'Sign-off', 'todo', 'H', 'card 5 and M4']];
      const pillOf = (s) => ({ done: A.pill('done', 'ok'), now: A.pill(mobile ? (isReq ? 'waiting on you' : `waiting on ${first(reqr)}`) : 'running', mobile ? 'gate' : 'info'), todo: A.pill('to do', 'mute'), skip: A.pill('not requested', 'mute') }[s]);
      const stepsHtml = `<div class="dc-s0">${J(st, ([sid, t, s, act, m]) => `<div class="st ${s}"><span class="id">${sid}</span><div><div>${E(t)} ${A.actors(A.actorKinds(act), 15)}</div><div class="m">${E(m)}</div></div>${pillOf(s)}</div>`)}
        <div class="st ${mobile ? 'todo' : 'todo'}"><span class="id">${A.gate('M4')}</span><div><div>M4 onboarding approval</div><div class="m">never auto-approved · bound to the readiness record hash · then the project fans out N8 releases for eligible lanes</div></div>${A.pill('to do', 'mute')}</div></div>`;
      const cards = mobile ? [
        ['Card 1', 'Repo and owners', 'card-C1-mobile', 'decided', 'Mei Wong (bootstrap)'],
        ['Security', 'History secret (aws-access-key-id)', 'card-SECR-mobile', 'rotated', 'Mei Wong (bootstrap)'],
        ['Card 2', 'Claims, intent, AGENTS.md', 'card-C2-mobile', 'decided', 'Mei Wong (bootstrap) · step-up'],
        ['Card 4', 'Controls, environment, role map', 'card-C4-mobile', DEC['card-C4-mobile'] ? DEC['card-C4-mobile'].label : 'open', 'Mei Wong (bootstrap, last card under it)'],
        ['Card 5', 'Sign-off and M4', 'card-C5-mobile', 'not open', 'the role map’s M4 holders, from card 4'],
      ] : [['Card 1', 'Repo and owners', `card-C1-${id}`, 'not open', 'you (bootstrap)']];
      const inv = [['AGENTS.md', 'instruction', 'affirmed@9c04e1d2'], ['CLAUDE.md', 'instruction', 'affirmed (stub: @AGENTS.md)'], ['.claude/settings.json', 'harness: hooks', 'ignored by workers'], ['.claude/commands/release.md', 'harness: command', 'ignored by workers'], ['.cursor/rules/kotlin.mdc', 'other agent config', 'data'], ['.mcp.json', 'harness: MCP servers', 'ignored · protected path']];
      const census = mobile ? `<div class="grid g2">
          ${A.card('Census findings', A.kv([['Stack', 'Kotlin 2.0 · Gradle 8.10 (Android); Swift 6 · SPM (iOS); fastlane'], ['Lockfiles', '<span class="mono small">gradle.lockfile, Package.resolved, Gemfile.lock</span>'], ['Commands', '<span class="mono small">./gradlew assemble · ./gradlew test</span>'], ['Probe', 'Android: 412 tests pass in K-exec · iOS: pending (no macOS sandbox)'], ['CODEOWNERS', '<span class="mono small">.github/CODEOWNERS</span> · 9 rules · 0 errors'], ['Tier', 'T1 floor: ex.routing (app/api/ingress.yaml)'], ['History', 'all refs · 4,812 commits · not truncated']]))}
          ${A.card('Secret scan <span class="small faint">rule ids only, never values</span>', A.table([{ h: 'Rule', r: (r) => `<span class="mono small">${r[0]}</span>` }, { h: 'Count', cls: 'r', r: (r) => r[1] }, { h: 'State', r: (r) => A.pill(r[2], r[3]) }], [['aws-access-key-id', 1, 'rotated', 'ok'], ['generic-api-key', 2, 'false positive', 'mute'], ['private-key', 0, 'none', 'mute']]) + `<p class="tiny faint" style="padding:10px 16px">Rules sr-2026.10.3 · 4,812 commits · no value is stored, shown or filed.</p>`, { flush: true })}
        </div>
        ${A.card('Instruction and harness files <span class="small faint">inventoried at 0.1 (LF4)</span>', A.table([{ h: 'Path', r: (r) => `<span class="mono small">${r[0]}</span>` }, { h: 'Kind', r: (r) => `<span class="small muted">${r[1]}</span>` }, { h: 'State', r: (r) => A.pill(r[2], /affirmed/.test(r[2]) ? 'ok' : /ignored/.test(r[2]) ? 'mute' : 'warn') }], inv), { flush: true })}` : A.card('Census', `<p class="muted">0.1 is running: findings appear here as each detector finishes (≤ 30 min).</p><div style="margin-top:10px">${A.meter(35, 100)}</div>`);
      return A.pageHead({
        crumbs: '<a href="#projects">Projects</a><span>›</span><span>' + E(id) + '</span>',
        eyebrow: `S0 onboarding · <span class="mono">${E(id)}</span>`,
        title: `${E(mobile ? 'Mobile App' : (made ? made.slug : id))} <span style="vertical-align:middle;margin-left:8px">${lvl('Onboarding')}</span>`,
        sub: `Onboarding <span class="mono">${E(repo)}</span> at ${E(level)}, asked by ${isReq ? 'you' : E(name(reqr))}. The factory reads; the cards below are decided by the people named on them.`,
        actions: mobile ? A.act(DEC['card-C4-mobile'] ? 'Open card 4' : 'Decide card 4', 'card.decide', { type: 'Card', project: 'mobile' }, { href: '#card-C4-mobile', cls: 'primary' }) : '',
      }) + A.stats([{ k: 'Level asked', v: level, d: 'signed level can be lower' }, { k: 'Step', v: mobile ? '0.4' : '0.1', d: mobile ? 'controls and environment' : 'census running' }, { k: 'Cards decided', v: mobile ? '3 of 5' : '0', d: 'never auto-approved' }, { k: 'Gaps', v: mobile ? 7 : '—', d: mobile ? '1 blocking, 6 tracked' : 'after census' }, { k: 'Parks after', v: '5 bd', d: 'of silence on a card' }]) +
        `<div class="banner info" style="margin-top:16px">${A.icon('lock', 14)} Bootstrap: ${isReq ? 'you asked for this onboarding, so you decide' : `${E(name(reqr))} asked for this onboarding, so ${E(first(reqr))} decides`} its admin cards until card 4 publishes the role map. From card 5 on, the role map decides.</div>` +
        `<div class="split" style="margin-top:4px"><div class="stack">${A.card('Steps', stepsHtml, { flush: true })}${census}</div>
         <aside class="stack">${A.card('Cards', `<div class="list">${J(cards, ([t, d, r, s, who]) => `<div class="li" data-go="${r}"><span>${cardTag(t)}</span><div style="min-width:0"><div class="ti">${E(d)}</div><div class="me">${E(who)}</div></div>${A.pill(s, s === 'open' ? 'gate' : s === 'not open' ? 'mute' : 'ok')}</div>`)}</div>`, { flush: true })}
         ${A.card('Access', rules([['ok', 'GitHub App installed: only select repositories'], ['ok', 'Read-only token works; GitHub sees reads only'], ['info', 'No onboarding PR yet: the factory opens one after card 2 (AGENTS.md, CODEOWNERS, knowledge pack); you approve and merge it on GitHub, never push to it']]))}</aside></div>`;
    },
  });

  /* ================================================================ readiness record */
  const PILLARS = [
    { id: 'VRL', n: 'Verification', lv: 3, cr: [['RS-BT-1', 'Probe passes from a clean checkout', 'met', 'probe run pr-7f3a-2 · 1,284 tests'], ['RS-TH-1', 'Test count > 0, gating set passes', 'met', 'gating set 1,102'], ['RS-TH-3', 'Mutation score ≥ 70% on api/', 'met', '78%'], ['RS-TH-4', 'Flaky test list maintained', 'unknown', 'gap:payments:RS-TH-4']] },
    { id: 'ERL', n: 'Environment', lv: 3, cr: [['RS-EN-1', 'Egress declared (mirror allow-list)', 'met', 'npm mirror only'], ['RS-EN-2', 'Hermetic: no secrets, no prod endpoints', 'met', 'probe log hash 0a9e'], ['RS-OP-2', 'staging_separation: yes', 'met', 'operations.md attested']] },
    { id: 'ORL', n: 'Operations', lv: 2, cr: [['RS-OP-1', 'operations.md attested', 'met', 'text_sha256 77c0…'], ['RS-OP-3', 'Runbook for refunds', 'unmet', 'gap:payments:RS-OP-3 (tracked)'], ['RS-CC-3', 'protect-main effective', 'met', 'rules hash 4f1e…']] },
    { id: 'KRL', n: 'Knowledge', lv: 3, cr: [['RS-KN-4', 'Shallow codekb, claims ≥ 90% affirmed', 'met', '48 of 50 (96%)'], ['RS-KN-7', 'Full codekb, system map, spec seeds', 'met', 'api/, billing/'], ['RS-AI-3', 'AGENTS.md affirmed', 'met', 'affirmed@5e1f02ab (re-affirmed 11-08)']] },
  ];
  A.view('readiness', {
    nav: false, parent: 'projects', match: /^readiness-(.+)$/,
    // project.view on that project, like the project page
    access: ([id]) => { const p = A.project(id || ''); if (!p || (!A.canSeeProject(id) && !hasFleet())) return null; return { action: 'project.view', res: { type: 'Project', project: id } }; },
    deniedTitle: 'This readiness record is confidential',
    render: ([id]) => {
      const p = A.project(id);
      if (!p || !A.canSeeProject(id)) return notFound();
      if (p.level === 'Onboarding') return A.pageHead({ crumbs: `<a href="#projects">Projects</a><span>›</span><span>${E(p.name)}</span>`, eyebrow: '<span class="mono">prr/1</span> · Project Readiness Record', title: `Readiness record of ${E(p.repo)}`, sub: 'There is no record yet: it is assembled at 0.5 and becomes active at M4.' }) + A.card('Not assembled yet', rules([['info', `${E(p.name)} is onboarding (${E(p.s0)}). Card 4 is open; card 5 and M4 come after it.`]]), { foot: `<a class="btn sm" href="#s0-${p.s0}">Open the onboarding</a>` });
      const x = PX[id] || PX.payments;
      const v = x.prrv || 1, rh = hx('prr' + id + v);
      const comp = Math.min(...PILLARS.map((q) => q.lv));
      const caps = [['Tier', `${x.tier} → A3`, false], ['Level', `${p.level} (per area) → A3`, false], ['Readiness', `RL${comp} → A${comp - 1}`, false], ['Posture', 'green: no B1–B5 open → no limit', false], ['Probation', x.prob ? `A1 until ${x.prob} (4 weeks after M4) · max lane L5 while on probation` : 'ended', !!x.prob], ['Earned', 'A2 (12 merges, 0 gate misses)', false]];
      return A.pageHead({
        crumbs: `<a href="#projects">Projects</a><span>›</span><a href="#project-${id}">${E(p.name)}</a><span>›</span><span>Readiness record</span>`,
        eyebrow: '<span class="mono">prr/1</span> · Project Readiness Record',
        title: `Readiness record of ${E(p.repo)}`,
        sub: 'What the factory may do on this repo, why, and who signed it. Each version is immutable; M4 binds to its record hash.',
        actions: A.pill(`v${v} active`, 'ok') + `<button class="btn sm" data-toast="Downloads prr-${id}-v${v}.json (canonical JSON, RFC 8785)">Download JSON</button>`,
      }) + A.stats([
        { k: 'Level signed', v: p.level, d: 'per area, DEC-25' }, { k: 'Tier', v: x.tier, d: 'raise-only; T0 needs attestation' },
        { k: 'Composite', v: `RL${comp}`, d: 'the lowest pillar, never an average' }, { k: 'Effective autonomy', v: x.autonomy, d: 'min of every cap', tone: 'warn' },
        { k: 'Fresh until', v: '01-28', d: 'review by 2027-01-30 (Light +3 mo)' },
      ]) + `<div class="split" style="margin-top:16px"><div class="stack">
        ${A.card('Pillars', J(PILLARS, (q) => `<div style="padding:12px 16px;border-bottom:1px solid var(--line)"><div class="dc-pillar"><b class="mono">${q.id}</b><span>${q.n}</span><span class="dc-lv ${q.lv === comp ? 'min' : ''}" title="level ${q.lv} of 4">${J([1, 2, 3, 4], (i) => `<i class="${i <= q.lv ? 'on' : ''}"></i>`)}</span></div>
          <div style="margin-top:8px">${A.table([{ h: 'Criterion', r: (c) => `<span class="mono small">${c[0]}</span> <span class="small">${E(c[1])}</span>` }, { h: 'Evidence', r: (c) => `<span class="tiny faint mono">${E(c[3])}</span>` }, { h: '', r: (c) => A.pill(c[2], c[2] === 'met' ? 'ok' : c[2] === 'unknown' ? 'warn' : 'bad') }], q.cr)}</div></div>`), { flush: true, actions: '<span class="tiny faint">unknown counts as unmet</span>' })}
        ${A.card('Caps', A.table([{ h: 'Cap', r: (c) => `<b>${c[0]}</b>` }, { h: 'Value', r: (c) => `<span class="small ${c[2] ? '' : 'muted'}">${E(c[1])}</span>` }, { h: '', r: (c) => (c[2] ? A.pill('binding', 'warn') : '') }], caps) + `<p class="tiny faint" style="padding:10px 16px">Automatic changes only tighten. Loosening always needs a person.</p>`, { flush: true })}
      </div><aside class="stack">
        ${A.card('Binding', A.kv([['Record hash', A.hash(rh, 16)], ['M4', `ledger <span class="mono">${id === 'payments' ? '17,880' : id === 'web' ? '17,402' : id === 'ledger' ? '17,702' : '17,790'}</span> · ${A.who(x.m4 || p.owner)}`], ['Signer', 'team mode · two-person'], ['Baseline', '<span class="mono">3f9c2ab</span>'], ['Catalogue', '1.4.0 · 8c2e…f1'], ['Criteria', 'CRITERIA_V2@2']]) + `<p class="tiny faint" style="margin-top:10px">M4 sits outside the record hash and binds to it. The record never holds a secret value or an issue body.</p>`)}
        ${A.card('Gating profile', `<div class="row" style="gap:6px">${J(['G0G1', 'G2', 'G3d', 'G3', 'G4', 'G5', 'G6'], A.gate)}</div><p class="tiny faint" style="margin-top:8px">schedule: automatic · tier floor not applied (T1)</p>`)}
        ${A.card('Revisions', `<ul class="tl">${J([[`v${v}`, '10-30', 'api/, billing/ raised to Full', 'g'], ['v2', '10-14', 'role map: Jonas Meyer added to X1_X2_E2', 'h'], ['v1', '10-02', 'first signed at Light', 'g']].slice(0, v), (r) => `<li><span class="when">${r[1]}</span><span class="dot ${r[3]}"></span><div class="what"><div class="t"><span class="mono">${r[0]}</span> ${E(r[2])}</div><div class="m">${A.hash(hx(r[0] + id), 8)} ${r[0] === `v${v}` ? 'active' : 'superseded'}</div></div></li>`)}</ul>`)}
      </aside></div>`;
    },
  });

  /* ================================================================ issue twin */
  const ISSUES = [
    { n: 431, t: '[onboarding] .env.example is missing (RS-DX-3)', gap: 'gap:r_8812:RS-DX-3', sev: 'tracked', sync: 'open', disc: 'pass' },
    { n: 432, t: '[onboarding] CONTRIBUTING.md is missing (RS-DOC-2)', gap: 'gap:r_8812:RS-DOC-2', sev: 'tracked', sync: 'closed_verified', disc: 'pass', note: 'verified at 3f9c2ab' },
    { n: 433, t: '[onboarding] Flaky test list (RS-TH-4)', gap: 'gap:r_8812:RS-TH-4', sev: 'tracked', sync: 'closed_unverified', disc: 'pass', note: 'closed by a person; re-check failed; gap stays open' },
    { n: 434, t: '[onboarding] Refund runbook (RS-OP-3)', gap: 'gap:r_8812:RS-OP-3', sev: 'tracked', sync: 'open', disc: 'pass' },
    { n: 435, t: '[onboarding] Required check ci not pinned (RS-CC-4)', gap: 'gap:r_8812:RS-CC-4', sev: 'blocking', sync: 'open', disc: 'pass', note: 'N6 item W-40 proposed (L2)' },
    { n: 0, t: 'History secret finding (RS-SEC-2)', gap: 'gap:r_8812:RS-SEC-2', sev: 'blocking', sync: 'never filed', disc: 'private_only' },
  ];
  const PROPOSE = [['RS-DX-5', 'No devcontainer for the API (RS-DX-5)', 'tracked', 'file_issue'], ['RS-DOC-4', 'ADR seed missing (RS-DOC-4)', 'tracked', 'file_issue'], ['RS-LIC-1', 'LICENSE not chosen (RS-LIC-1)', 'tracked', 'track_only'], ['RS-SEC-5', 'Dependabot alerts readable only by Security (RS-SEC-5)', 'blocking', 'track_only']];
  A.view('issues', {
    label: 'Issue twin', group: 'Projects', icon: 'issues',
    // project.view on the project picked in the top bar
    access: () => ({ action: 'project.view', res: { type: 'Project', project: A.state.project } }),
    render: () => {
      const p = A.project(A.state.project);
      const res = { type: 'Project', project: p.id };
      const head = A.pageHead({ eyebrow: `${E(p.name)} · <span class="mono">${E(p.repo)}</span>`, title: 'GitHub issue twin', sub: 'Gaps live in the factory record. Each GitHub issue is a twin, filed only from a batch a person approved; its state comes back as a signal and never closes a gap by itself.', actions: A.act('Propose a batch', 'config.propose', res, { cls: 'primary', attrs: 'id="dc-propose-batch"' }) });
      if (p.id !== 'payments') return head + A.card('No twins filed yet', `<p class="muted">${E(p.name)} has no approved batch, so no GitHub issue twins exist. Gaps stay in the readiness record until someone with config.propose proposes a batch and it is approved.</p>`, { foot: `<a class="btn sm" href="#readiness-${p.id}">Readiness record</a>` });
      const dc = A.dataClass(p.id);
      return head +
        A.stats([{ k: 'Twins filed', v: 5, d: 'from 2 approved batches' }, { k: 'Open', v: 3, d: '1 blocking' }, { k: 'Closed and verified', v: 1, tone: 'ok', d: 'the factory re-checked at main' }, { k: 'Closed, not verified', v: 1, tone: 'warn', d: 'gap stays open; not reopened' }, { k: 'Never filed', v: 1, tone: 'bad', d: 'security: private only' }]) +
        `<div class="split" style="margin-top:16px"><div class="stack">
          ${A.card('Issues and their sync state', A.table([
            { h: 'Issue', r: (i) => (i.n ? `<span class="mono">#${i.n}</span>` : '<span class="faint">—</span>') },
            { h: 'Title', r: (i) => `<div class="small">${dc >= 1 ? E(i.t) : '<span class="faint">title hidden (needs D1)</span>'}</div><div class="tiny faint mono">&lt;!-- asf-gap: ${E(i.gap)} v1 --&gt;</div>` },
            { h: 'Label', r: (i) => A.pill(`gap:${i.sev}`, i.sev === 'blocking' ? 'bad' : 'mute') },
            { h: 'Sync', r: (i) => `${A.pill(i.sync, { open: 'info', closed_verified: 'ok', closed_unverified: 'warn', 'never filed': 'bad' }[i.sync])}${i.note ? `<div class="tiny faint">${E(i.note)}</div>` : ''}` },
            { h: 'SEC-OB-4', r: (i) => A.pill(i.disc, i.disc === 'pass' ? 'ok' : 'bad') },
          ], ISSUES), { flush: true, actions: '<span class="tiny faint">polled 3 min ago · labels factory:onboarding-gap</span>' })}
          ${A.card('Approved batches', A.table([{ h: 'Batch', r: (b) => `<span class="mono">${b[0]}</span>` }, { h: 'Approved by', r: (b) => A.who(b[1]) }, { h: 'Issues', cls: 'r', r: (b) => b[2] }, { h: 'Bodies hash', r: (b) => A.hash(hx(b[0]), 10) }, { h: 'Ledger', cls: 'r', r: (b) => `<span class="mono">${b[3]}</span>` }], [['batch-2026-11-03', 'ar', 3, '18,104'], ['batch-2026-11-08', 'ar', 2, '18,296']]), { flush: true })}
        </div><aside class="stack">
          ${A.card('Rules', rules([['ok', '<b>Dedupe by marker</b>, in order: the record’s gap → issue map, then a reconcile of labelled issues by their marker, then a person linking a duplicate. GitHub search is never the source of truth.'], ['ok', '<b>Disclosure (SEC-OB-4).</b> No security issue on a public repo; generic text on private ones; a content lint on every body.'], ['info', 'A fixable gap becomes an N6 item → S1 as L2 → G0. The PR says <span class="mono">Refs #n</span>, never <span class="mono">Closes #n</span>.'], ['info', 'Edits to labels or titles on GitHub are ignored as data.']]))}
        </aside></div>`;
    },
    mount: (root) => {
      on('is', root, 'click', (e) => {
        if (!e.target.closest('#dc-propose-batch') || !A.can('config.propose', { type: 'Project', project: A.state.project })) return;
        const m = A.modal(`<div class="row between"><h2>Propose a batch</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
          <p class="muted">The factory proposes these gaps. Choose per row; security gaps are track only and cannot be filed.</p>
          ${A.table([{ h: 'Gap', r: (r) => `<span class="small">${E(r[1])}</span>` }, { h: 'Disclosure', r: (r) => (r[2] === 'blocking' && /SEC/.test(r[0]) ? A.pill('private only', 'bad') : A.pill('pass', 'ok')) }, { h: 'Do', r: (r) => `<select class="input" style="padding:4px 6px" ${/SEC/.test(r[0]) ? 'disabled' : ''}><option ${r[3] === 'file_issue' ? 'selected' : ''}>file_issue</option><option ${r[3] === 'track_only' ? 'selected' : ''}>track_only</option></select>` }], PROPOSE)}
          ${rules([['info', 'Approving records the exact list and the hash of the rendered bodies on the ledger. The tracker files exactly that list, once.']])}
          <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn primary" id="dc-bgo">Approve batch</button></div>`);
        m.querySelector('#dc-bgo').onclick = () => { A.closeOverlay(); A.toast(`Batch approved: ${[...m.querySelectorAll('select')].filter((s) => s.value === 'file_issue').length} issues will be filed (ledger ${(SEQ++).toLocaleString('en-US')})`); };
      });
    },
    unmount: () => off('is'),
  });
})();
