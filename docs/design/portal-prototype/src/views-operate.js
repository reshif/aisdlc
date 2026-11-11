/* Operate: scheduler (admission and capacity), sandboxes, controls, kill switch, health; Govern: notifications. */
(function () {
  const D = A.data;
  const E = A.esc;

  /* ---------------------------------------------------------------- small helpers */
  const hx = (s, n = 64) => { let h = 0x811c9dc5, out = ''; for (let k = 0; out.length < n; k++) { for (const c of String(s) + '#' + k) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } out += h.toString(16).padStart(8, '0'); } return out.slice(0, n); };
  const series = (seed, n, base, amp) => { let x = 0; for (const c of seed) x = (x * 31 + c.charCodeAt(0)) >>> 0; return Array.from({ length: n }, (_, i) => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return Math.max(0, +(base + amp * (Math.sin(i / 2.4 + (x % 7)) * 0.45 + ((x % 1000) / 1000 - 0.5))).toFixed(2)); }); };
  const key = (k) => { const it = A.item(k); return it ? `<a class="ichip" href="#item-${k}" title="${E(A.redactedTitle(it))}"><b style="background:${A.laneColor(it.lane)}">${k}</b></a>` : `<span class="mono">${E(k || '—')}</span>`; };
  const keyT = (k) => { const it = A.item(k); if (!it) return key(k); const hid = A.dataClass(it.project) < 1; return `<div class="row" style="gap:8px;flex-wrap:nowrap;min-width:0">${key(k)}<span class="small ${hid ? 'faint' : ''}" style="${hid ? '' : 'color:var(--fg-2);'}overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px">${E(A.redactedTitle(it))}</span></div>`; };

  /* ---------------------------------------------------------------- access helpers (read at render time, never at load) */
  const me = () => A.me();
  const PR = (project) => ({ type: 'Project', project });
  const FLEET = { type: 'Fleet' };
  const opsOK = (project) => !!project && A.can('ops.read', PR(project));
  const itemOK = (k) => { const it = A.item(k); return !!it && opsOK(it.project); };
  const isFleetReader = () => A.bindingsOf(me()).some((b) => b.scope.kind === 'fleet');
  const confidentialIds = () => D.PROJECTS.filter((p) => p.classification === 'confidential').map((p) => p.id);
  const projName = (id) => (A.project(id) ? A.project(id).name : id);
  /** the people (by id) the policy would allow to do an action on a resource */
  const whoCan = (action, res) => Object.keys(D.PEOPLE).filter((pid) => A.can(action, res, pid));
  const names = (ids) => (ids.length ? ids.map(nm).join(', ') : 'nobody');
  const switchHint = () => '<button class="op-hint" data-op-switch>Switch account to try it</button>';
  /** a designed "hidden: needs D2" placeholder with the reason and a request button */
  const needD2 = (what, project) => {
    const holders = whoCan('ops.read', PR(project)).filter((pid) => A.dataClass(project, pid) >= 2);
    const role = A.myRolesOn(project).length ? 'project.security_approver' : 'project.viewer';
    return `<div class="op-hidden">${A.icon('lock', 18)}<div style="min-width:0"><b>Hidden: ${E(what)} needs data class D2</b>
      <p class="small muted">Your roles on ${E(projName(project))} reach data class D${Math.max(0, A.dataClass(project))}. Transcripts, tool calls, Bash commands and tripwire evidence are D2: security approvers, factory admins and auditors see them (${E(names(holders))}). The server never sends this text to you.</p>
      <div class="row" style="gap:8px"><button class="btn sm" data-reqaccess="${E(JSON.stringify({ action: 'ops.read', res: PR(project), need: role + ' on ' + projName(project) }))}">Request ${role}</button>${switchHint()}</div></div></div>`;
  };
  const collapsed = (text) => `<div class="op-collapsed">${A.icon('lock', 13)}<span>${text}</span></div>`;
  const nm = (id) => (A.person(id) ? A.person(id).name : id);
  const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`);
  const nowClock = () => { const d = new Date(); return `${String(10 + Math.floor((45 + d.getMinutes() % 15) / 60)).padStart(2, '0')}:${String((45 + d.getMinutes() % 15) % 60).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
  // mount listeners go on a fresh wrapper each render, so they never pile up on <main>
  const view = (name, def) => A.view(name, { ...def, render: (p) => `<div class="op-v">${def.render(p)}</div>`, mount: def.mount && ((root, p) => def.mount(root.querySelector('.op-v'), p)) });
  let timers = [];
  let SEQ = 18423;
  const nextSeq = () => SEQ++;
  const every = (ms, fn) => timers.push(setInterval(fn, ms));
  const clearTimers = () => { timers.forEach(clearInterval); timers = []; };
  const ck = (state, label, title) => `<span class="op-ck ${state}" title="${E(title || '')}">${label}${state === 'pass' ? ' ✓' : state === 'fail' ? ' ✗' : ''}</span>`;

  /* ================================================================ 1. Scheduler: admission and capacity */
  const POD_CAP = 3;
  const PODS = [
    { pod: 1, item: 'W-31', unit: 'u2', of: 3, epoch: 4, ses: 'ses-7f21', min: 18, step: '6.4', grant: 'gr-W31-u2-4', env: [702, 1400], note: 'Re-admitted 10:23 after X1 (approved by Jonas Meyer); snapshot snap/W-31/u2/e3 rehydrated by 6.1' },
    { pod: 2, item: 'W-21', unit: 'main', of: 1, epoch: 1, ses: 'ses-7f19', min: 6, step: '6.5', grant: 'gr-W21-main-1', env: [260, 1500], note: 'Self-check and tripwires: oracles green, diff 84 lines of a 400-line L2 budget' },
    { pod: 3, item: 'W-38', unit: 'main', of: 1, epoch: 1, ses: 'ses-7f22', min: 2, step: '6.4', grant: 'gr-W38-main-1', env: [140, 1000], note: 'L7 spike: ends at 6.5 with a spike report, never pushes' },
  ];
  const QUEUE = [
    { pos: 1, item: 'W-22', unit: 'u1', of: 2, waited: 47, ck: ['pass', 'fail', 'pass', 'pass'], why: 'Session cap only (H2: 3 of 3 pods busy). First in line for the next free pod.', next: 'next free pod, est. 12 min (W-38 spike reaches 6.5)' },
    { pos: 2, item: 'C-47', unit: 'u1', of: 2, waited: 31, ck: ['pass', 'fail', 'pass', 'pass'], why: 'Session cap only (H2). Second in line.', next: 'after W-22' },
    { pos: 3, item: 'L-09', unit: 'main', of: 1, waited: 185, ck: ['pass', 'fail', 'pass', 'fail'], why: 'WIP: lease agent/L-09/main (epoch 3) is held by Sam Osei after an E4 takeover. Re-admits on D4 hand-back, which bumps the epoch to 4.', next: 'passed over until hand-back' },
    { pos: 4, item: 'L-08', unit: 'main', of: 1, waited: 130, ck: ['fail', 'fail', 'pass', 'pass'], why: 'H1 approver slot: the only code owner of proto/ (Sam Osei) is the requester, so 0 eligible G4 deciders (SoD). Needs an M6 approver grant.', next: 'passed over until an approver exists', act: 'Request M6 grant' },
    { pos: 5, item: 'W-18', unit: 'u3', of: 3, waited: 1580, ck: ['pass', 'fail', 'fail', 'pass'], why: 'H3 envelope: the item spent 4,000¢ of 4,000¢ (ET1), so no Unit envelope can be reserved. Waits on an E3 extension or Priya Menon\'s E4 choice.', next: 'passed over until E3 or E4' },
  ];
  const WAITS = [
    { item: 'W-29', unit: 'u2', gate: 'X1', on: 'jm', what: 'Irreversible migration: UPDATE charges SET merchant_category on 41M rows', released: '08:53', mins: 112, epoch: 3, snap: 'snap/W-29/u2/e3', env: [640, 1500] },
    { item: 'C-47', unit: 'u2', gate: 'X3', on: 'mw', what: 'New dependency @stripe/stripe-js 4.9.0 (runtime, MIT)', released: '10:12', mins: 33, epoch: 2, snap: 'snap/C-47/u2/e2', env: [380, 1200] },
  ];
  const SLOTS = [
    { role: 'G4 code owner', proj: 'payments', holders: ['ar', 'rb', 'dn'], elig: 3, reserved: ['W-31', 'W-21'], note: 'W-38 is L7 (no G4)' },
    { role: 'X-gate approver (X1, X2, X3)', proj: 'payments', holders: ['jm', 'ar'], elig: 2, reserved: ['W-29', 'W-31'], note: 'X1 for W-29 pending' },
    { role: 'G4 code owner', proj: 'web', holders: ['mw'], elig: 1, reserved: ['C-47'], note: '@acme/web-owners on the host' },
    { role: 'X-gate approver (X1, X2, X3)', proj: 'web', holders: ['mw'], elig: 1, reserved: ['C-47'], note: 'X3 for C-47 pending' },
    { role: 'G4 code owner', proj: 'ledger', holders: ['so'], elig: 0, reserved: [], note: 'SoD: Sam Osei is the requester of L-08', bad: true },
    { role: 'SECT approver', proj: 'fleet', holders: ['ks'], elig: 1, reserved: ['W-19'], note: 'Q1 quarantine: coding slot freed' },
  ];
  const ENVS = [
    { item: 'W-31', unit: 'u2', bg: 'bg/W-31/u2', res: 1400, spent: 702, tok: ['688k', '2.0M'], clock: 'running' },
    { item: 'W-21', unit: 'main', bg: 'bg/W-21/main', res: 1500, spent: 260, tok: ['241k', '1.5M'], clock: 'running' },
    { item: 'W-38', unit: 'main', bg: 'bg/W-38/main', res: 1000, spent: 140, tok: ['131k', '1.0M'], clock: 'running' },
    { item: 'W-29', unit: 'u2', bg: 'bg/W-29/u2', res: 1500, spent: 640, tok: ['602k', '1.5M'], clock: 'paused' },
    { item: 'C-47', unit: 'u2', bg: 'bg/C-47/u2', res: 1200, spent: 380, tok: ['344k', '1.2M'], clock: 'paused' },
    { item: 'W-18', unit: 'u3', bg: '—', res: 0, spent: 0, tok: ['0', '—'], clock: 'refused' },
  ];
  const OCC = [3, 3, 3, 2, 3, 3, 3, 3, 2, 2, 3, 3, 3, 3, 2, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 2, 2, 3, 3, 3, 3, 3, 3];
  const QLEN = [2, 3, 3, 1, 2, 4, 3, 2, 0, 0, 1, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 3, 4, 4, 5];

  const occChart = () => {
    const W = 720, H = 210, L = 30, R = 8, T = 12, B = 26, pw = W - L - R, ph = H - T - B, n = OCC.length, bw = pw / n, max = 5;
    const y = (v) => T + ph - (v / max) * ph;
    const grid = [0, 1, 2, 3, 4, 5].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="10.5" fill="var(--faint)" font-family="var(--mono)">${v}</text>`).join('');
    const bars = OCC.map((v, i) => { const h0 = 11 + Math.floor(i / 2), hh = String(h0 % 24).padStart(2, '0'), mm = i % 2 ? '30' : '00'; return `<rect x="${(L + i * bw + 1).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(T + ph - y(v)).toFixed(1)}" rx="1.5" fill="var(--agent)" opacity="${v === POD_CAP ? 0.9 : 0.6}"><title>${hh}:${mm} · ${v} of ${POD_CAP} pods busy · queue ${QLEN[i]}</title></rect>`; }).join('');
    const qpts = QLEN.map((v, i) => `${(L + i * bw + bw / 2).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const ticks = OCC.map((_, i) => (i % 6 === 0 ? `<text x="${(L + i * bw).toFixed(1)}" y="${H - 8}" font-size="10.5" fill="var(--faint)" font-family="var(--mono)">${String((11 + i / 2) % 24).padStart(2, '0')}:00</text>` : '')).join('');
    return `<svg class="op-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Coding pod occupancy over the last 24 hours">${grid}${bars}
      <line x1="${L}" x2="${W - R}" y1="${y(POD_CAP)}" y2="${y(POD_CAP)}" stroke="var(--gate)" stroke-width="1.4" stroke-dasharray="5 4"/>
      <text x="${W - R - 2}" y="${y(POD_CAP) - 5}" text-anchor="end" font-size="10.5" fill="var(--gate)" font-family="var(--mono)">CODING_SESSION_CAP 3</text>
      <polyline points="${qpts}" fill="none" stroke="var(--back)" stroke-width="2" stroke-linejoin="round"/>${ticks}
      <text x="${W - R}" y="${H - 8}" text-anchor="end" font-size="10.5" fill="var(--fg-2)" font-family="var(--mono)">now</text></svg>`;
  };

  const podCard = (p) => {
    const it = A.item(p.item), s = D.SESSIONS.find((x) => x.id === p.ses) || {};
    if (!itemOK(p.item)) return `<div class="op-pod op-pod-hid">
      <div class="op-pod-hd"><span class="op-pod-n">Pod ${p.pod}</span><span class="sp" style="flex:1"></span>${A.pill('busy', 'info')}</div>
      ${collapsed(A.canSeeProject(it.project) ? `A Unit of ${E(projName(it.project))}. Its details need ops.read (view level V2) there.` : 'A Unit of a project you cannot see. Only the fact that the pod is busy is shown.')}
      <div class="op-mrow"><span>time</span>${A.meter(p.min, 60)}<span class="r">${p.min}m / 60m</span></div></div>`;
    return `<div class="op-pod">
      <div class="op-pod-hd"><span class="op-pod-n">Pod ${p.pod}</span><span class="sp" style="flex:1"></span><span class="op-live">${p.ses}</span></div>
      <div class="row" style="gap:8px">${key(p.item)}${A.lane(it.lane)}<span class="mono small muted">${p.step}</span>${A.actors(['A'], 16)}<span class="tiny faint">${E(projName(it.project))}</span></div>
      <h4 class="${A.dataClass(it.project) < 1 ? 'faint' : ''}">${E(A.redactedTitle(it))}</h4>
      <div class="op-mini"><div><div class="k">Unit</div><div class="v">${p.unit}${p.of > 1 ? ` <span class="faint">of ${p.of}</span>` : ''}</div></div><div><div class="k">Lease epoch</div><div class="v">${p.epoch}</div></div><div><div class="k">In pod</div><div class="v" data-op-podmin="${p.pod}">${fmtMin(p.min)}</div></div></div>
      <div class="op-mrow"><span>time</span>${A.meter(p.min, 60)}<span class="r">${p.min}m / 60m</span></div>
      <div class="op-mrow"><span>envelope</span>${A.meter(p.env[0], p.env[1])}<span class="r">${p.env[0]}¢ / ${p.env[1]}¢</span></div>
      <div class="op-mrow"><span>cpu</span>${A.meter(s.cpu || 0, 100)}<span class="r">${s.cpu || 0}% of 2</span></div>
      <p class="small muted">${E(p.note)}</p>
      <div class="row small faint mono" style="gap:12px"><span>grant ${p.grant}</span><span>branch agent/${p.item}/${p.unit}</span></div>
    </div>`;
  };
  /** queue rows the person may read in full; others collapse to their position only */
  const queueRow = (q) => {
    if (itemOK(q.item)) return q;
    const it = A.item(q.item);
    return { ...q, hid: true, label: A.canSeeProject(it.project) ? `A Unit of ${projName(it.project)} (needs ops.read there)` : 'A Unit of a project you cannot see' };
  };

  view('capacity', {
    label: 'Scheduler', group: 'Operate', icon: 'capacity',
    access: () => ({ action: 'ops.read', res: PR(A.state.project) }),
    deniedTitle: 'You can’t open the scheduler',
    badge: () => ({ n: QUEUE.filter((q) => itemOK(q.item)).length }),
    render: () => {
      const busy = PODS.length, util = Math.round((OCC.reduce((a, b) => a + b, 0) / (OCC.length * POD_CAP)) * 100);
      const Q = QUEUE.map(queueRow), mineQ = Q.filter((q) => !q.hid);
      const waits = WAITS.filter((w) => itemOK(w.item)), envs = ENVS.filter((e) => itemOK(e.item));
      const slots = SLOTS.filter((s) => s.proj === 'fleet' || opsOK(s.proj));
      const fleet = isFleetReader();
      const scopeNote = fleet ? 'You read the whole factory (fleet role); confidential projects stay collapsed.' : `You see Units of ${A.visibleProjects().filter((p) => opsOK(p.id)).map((p) => `<b>${E(p.name)}</b>`).join(', ')}. Pods and queue positions of other projects show as busy, nothing more.`;
      return `${A.pageHead({ eyebrow: 'Operate · S6 6.0 admission', title: 'Scheduler', sub: 'Who holds a coding pod, who waits for one and why. Admission checks H1 (approver slot), H2 (session cap), H3 (envelope) and WIP (lease) for every Unit; the queue is first in, first out, and a Unit that fails anything but H2 is passed over, never blocking the line.', actions: `<button class="btn" data-toast="Admission dry-run: 0 Units would be admitted now (3 of 3 pods busy)">Dry-run admission</button>${A.act('Clamp or hold…', 'control.apply', PR(A.state.project), { href: '#controls' })}` })}
      <div class="op-scope-note">${A.icon('lock', 13)}<span>${scopeNote}</span></div>
      ${A.stats([
        { k: 'Coding pods busy', v: `${busy}<span class="faint" style="font-size:18px"> / ${POD_CAP}</span>`, d: 'CODING_SESSION_CAP 3 (local-prod runs 1)', tone: 'warn' },
        { k: 'Admission queue', v: Q.length, d: `${mineQ.length} you can read · oldest ${fmtMin(Math.max(...Q.map((q) => q.waited)))}` },
        { k: 'HUMAN-WAIT', v: waits.length, d: 'pods released, clocks paused' },
        { k: 'Envelope reserved', v: A.cents(envs.reduce((a, e) => a + e.res, 0)), d: `${A.cents(envs.reduce((a, e) => a + e.spent, 0))} spent across ${envs.filter((e) => e.res).length} Units` },
        { k: 'Pod utilisation 24h', v: `${util}%`, d: 'peak queue 5 at 10:30', tone: 'ok' },
      ])}
      <div style="height:16px"></div>
      <div class="op-pods">${A.j(PODS, podCard)}</div>
      <div style="height:16px"></div>
      ${A.card('Admission queue <span class="faint mono small" style="font-family:var(--mono)">FIFO</span>', A.table([
        { h: '#', r: (q) => `<span class="op-pos">${q.pos}</span>` },
        { h: 'Item · Unit', r: (q) => (q.hid ? `<span class="small faint">${A.icon('lock', 12)} ${E(q.label)}</span>` : `<div>${keyT(q.item)}<div class="mono tiny faint" style="margin-top:3px">${q.unit}${q.of > 1 ? ` of ${q.of}` : ''} · ${E(projName(A.item(q.item).project))}</div></div>`) },
        { h: 'Checks', r: (q) => (q.hid ? `<span class="op-checks">${ck(q.ck[1], 'H2', 'session cap')}</span>` : `<span class="op-checks">${ck(q.ck[0], 'H1', 'approver slot')}${ck(q.ck[1], 'H2', 'session cap')}${ck(q.ck[2], 'H3', 'envelope')}${ck(q.ck[3], 'WIP', 'lease')}</span>`) },
        { h: 'Why it waits', r: (q) => `<div class="small ${q.hid ? 'faint' : ''}" style="max-width:440px;min-width:240px">${q.hid ? 'Reason hidden: it names people and budgets of that project.' : E(q.why)}</div>` },
        { h: 'Waited', cls: 'r', r: (q) => `<span class="mono">${fmtMin(q.waited)}</span>` },
        { h: 'Next', r: (q) => (q.hid ? '<span class="faint small">—</span>' : `<div class="small muted" style="min-width:150px">${E(q.next)}</div>${q.act ? `<div style="margin-top:6px">${A.act(q.act, 'access.manage', PR(A.item(q.item).project), { cls: 'sm', attrs: 'data-toast="M6 approver grant requested for acme/ledger-svc proto/ (card sent to Luis Torres)"' })}</div>` : ''}`) },
      ], Q), { flush: true, actions: '<span class="small faint">checks run every 15 s and on every release</span>' })}
      <div style="height:16px"></div>
      <div class="grid g2">
        ${A.card('HUMAN-WAIT', `<p class="small muted" style="margin-bottom:12px">A human gate (G3o, X1, X3, E6) is pending in S6: the lease and the pod are released, a snapshot of the workspace is kept and the envelope clock stops. The decision re-admits the Unit through 6.1 at its old place in the queue.</p>
          <div class="list" style="margin:0 -16px">${waits.length ? A.j(waits, (w) => `<div class="li" data-peek="${w.item}">
            ${A.gate(w.gate)}
            <div style="min-width:0"><div class="row" style="gap:8px">${key(w.item)}<span class="mono small">${w.unit}</span><span class="small muted">waiting on <span style="color:var(--fg)">${E(nm(w.on))}</span></span></div>
              <div class="me">${A.dataClass(A.item(w.item).project) >= 1 ? E(w.what) : 'Gate subject hidden (needs D1)'}</div>
              <div class="row tiny faint mono" style="gap:12px;margin-top:4px"><span>pod released ${w.released}</span><span>epoch ${w.epoch} released</span><span>${w.snap} · ${hx(w.snap, 8)}</span></div></div>
            <div style="text-align:right"><div class="mono small">${fmtMin(w.mins)}</div><div class="tiny" style="color:var(--hand)">⏸ clock paused at ${w.env[0]}¢</div></div></div>`) : `<div class="li" style="cursor:default"><span></span><div class="me">No Unit you can read is waiting on a person.</div><span></span></div>`}
            ${itemOK('W-31') ? `<div class="li" style="opacity:.6;cursor:default"><span class="pill ok">readmitted</span><div><div class="row" style="gap:8px">${key('W-31')}<span class="mono small">u2</span></div><div class="me">X1 approved 10:22 by Jonas Meyer; epoch 3 → 4, snapshot rehydrated into pod 1</div></div><span class="mono small">10:23</span></div>` : ''}</div>`, { actions: `<span class="pill mute plain">${waits.length} waiting</span>` })}
        ${A.card('Approver slots (H1)', A.table([
          { h: 'Role', r: (s) => `<div class="small" style="min-width:150px">${E(s.role)}</div><div class="tiny faint mono">${E(s.proj === 'fleet' ? 'fleet' : A.project(s.proj).repo)}</div>` },
          { h: 'Holders', r: (s) => A.avatars(s.holders) },
          { h: 'Reserved', r: (s) => `<div style="min-width:110px">${A.meter(s.reserved.length, Math.max(s.elig, 1), { warnAt: 0.99, badAt: 2 })}<div class="tiny mono ${s.bad ? '' : 'faint'}" style="margin-top:4px;${s.bad ? 'color:var(--bad)' : ''}">${s.reserved.length} of ${s.elig} eligible</div></div>` },
          { h: 'Note', r: (s) => `<span class="tiny ${s.bad ? '' : 'muted'}" style="${s.bad ? 'color:#ff9d96' : ''}">${E(s.note)}</span>` },
        ], slots), { flush: true, actions: '<span class="small faint">counts, never names, in the grant</span>' })}
      </div>
      <div style="height:16px"></div>
      <div class="grid g2">
        ${A.card('Pod occupancy, last 24 hours', `${occChart()}<div class="op-legend"><span><i style="background:var(--agent)"></i>pods busy (30-min slots)</span><span><i style="background:var(--back)"></i>admission queue length</span><span><i style="background:var(--gate)"></i>session cap</span></div>`, { actions: '<span class="small faint">hover a bar for the slot</span>' })}
        ${A.card('Envelopes per Unit (H3)', envs.length ? A.table([
          { h: 'Item · Unit', r: (e) => `<div class="row" style="gap:6px;flex-wrap:nowrap">${key(e.item)}<span class="mono small">${e.unit}</span></div>` },
          { h: 'Budget group', r: (e) => `<span class="mono tiny">${e.bg}</span>` },
          { h: 'Spent / reserved', r: (e) => (e.res ? `<div style="min-width:130px">${A.meter(e.spent, e.res)}<div class="tiny mono faint" style="margin-top:4px">${e.spent}¢ of ${e.res}¢ · ${e.tok[0]} of ${e.tok[1]} tok</div></div>` : '<span class="tiny" style="color:#ff9d96">cannot reserve: item envelope spent</span>') },
          { h: 'Clock', r: (e) => A.pill(e.clock, { running: 'ok', paused: 'info', refused: 'bad' }[e.clock]) },
        ], envs) : A.empty('No Unit envelope you can read.'), { flush: true })}
      </div>`;
    },
    mount: (root) => {
      every(60000, () => PODS.forEach((p) => { p.min += 1; const el = root.querySelector(`[data-op-podmin="${p.pod}"]`); if (el) el.textContent = fmtMin(p.min); }));
    },
    unmount: clearTimers,
  });

  /* ================================================================ 2. Sandboxes */
  const MIB = 'MiB';
  const CLASSES = [
    { id: 'K', d: 'Third-party scanners. No execution of repo code.', net: 'none (no NIC)', repo: 'read-only', exec: false, key: false, cpu: 1, mem: 512, pids: 128, time: '300 s', out: '16 ' + MIB },
    { id: 'K-exec', d: 'Build and test probe. Repo code runs (DEC-18 repos only).', net: 'package mirror', repo: 'copy in /work', exec: true, key: false, cpu: 1, mem: 1024, pids: 256, time: '900 s', out: '16 ' + MIB },
    { id: 'P', d: 'Planning agents (S2 to S5). Per-job key.', net: 'gateway', repo: 'read-only', exec: false, key: true, cpu: 1, mem: 512, pids: 128, time: '600 s', out: '8 ' + MIB },
    { id: 'W', d: 'The coding worker of a Unit. Per-Unit key, runs code.', net: 'gateway + mirror', repo: 'copy in /work', exec: true, key: true, cpu: 2, mem: 2048, pids: 512, time: '3600 s', out: '32 ' + MIB },
    { id: 'O', d: 'Oracle runs (the oracles are tests). No key.', net: 'package mirror', repo: 'copy in /work', exec: true, key: false, cpu: 1, mem: 1024, pids: 256, time: '900 s', out: '16 ' + MIB },
    { id: 'V', d: 'Reviewers and verifiers (S7). Per-job key.', net: 'gateway', repo: 'read-only', exec: false, key: true, cpu: 1, mem: 512, pids: 128, time: '600 s', out: '8 ' + MIB },
  ];
  const cls = (id) => CLASSES.find((c) => c.id === id);
  const SESS = [
    ...D.SESSIONS.map((s) => ({ ...s, step: s.item ? A.item(s.item).step : '0.1', pids: s.state === 'running' ? Math.round(s.cpu * 1.3) + 14 : 0 })),
    { id: 'ses-7f23', cls: 'P', item: 'W-23', unit: null, agent: 'A3', state: 'running', since: '4m', cpu: 12, mem: 0.3, calls: 6, tokens: '58k', spend: 31, tripwires: 0, step: '5.3', pids: 9 },
    { id: 'ses-7f20', cls: 'V', item: 'W-20', unit: null, agent: 'A5', state: 'running', since: '9m', cpu: 8, mem: 0.2, calls: 9, tokens: '121k', spend: 44, tripwires: 0, step: '7.3', pids: 7 },
    { id: 'ses-7f1e', cls: 'O', item: 'W-21', unit: 'main', agent: null, state: 'finished', since: '11m', cpu: 0, mem: 0, calls: 0, tokens: '0', spend: 0, tripwires: 0, step: '6.3', pids: 0, note: 'oracles red on the baseline: 3 of 3' },
    { id: 'ses-7f24', cls: 'P', item: 'I-12', unit: null, agent: 'A3', state: 'running', since: '7m', cpu: 10, mem: 0.3, calls: 5, tokens: '44k', spend: 22, tripwires: 0, step: '5.3', pids: 8 },
    { id: 'ses-7f0b', cls: 'K-exec', item: null, unit: null, agent: null, state: 'refused', since: '58m', cpu: 0, mem: 0, calls: 0, tokens: '0', spend: 0, tripwires: 0, step: '0.1', pids: 0, note: 'build probe of acme/mobile-app: exec_not_allowed (not on the DEC-18 list)' },
  ];
  const projOfSess = (s) => (s.item ? A.item(s.item).project : 'mobile');
  const memCapGB = (s) => cls(s.cls).mem / 1024;

  const EVENTS = {
    'ses-7f21': [
      ['10:23:02', 'sys', 'provisioned · class W · repo copy acme/payments-api@4c01aa9 · Unit key uk_…7f21 (tools Read Grep Glob Edit Write Bash)'],
      ['10:23:05', 'sys', '6.1 rehydrate: snapshot <code>snap/W-31/u2/e3</code> restored after X1 approval · lease epoch 4'],
      ['10:23:41', 'tool', 'Read <code>src/sca/exemptions.ts</code>'],
      ['10:24:12', 'tool', 'Grep <code>"lowValueExemption"</code> in <code>src/</code> · 6 matches'],
      ['10:24:58', 'gw', 'gateway /v1/messages · claude-opus-5-5 · 18.2k in / 2.1k out · 9.4¢'],
      ['10:25:03', 'allow', 'PreToolUse Edit <code>src/sca/exemptions.ts</code> → allow (inside Unit scope src/sca/**)'],
      ['10:27:15', 'x1', 'Bash <code>npm test -- sca</code> → classified reversible (test run) → allow'],
      ['10:27:52', 'sys', 'tests: 14 passed, 2 failed (oracles u2-o3, u2-o4 still red)'],
      ['10:31:08', 'deny', 'PreToolUse Edit <code>test/sca/oracle-u2.test.ts</code> → deny: locked test (hash 9c1e40…), changing it needs E6 (B12)'],
      ['10:31:10', 'tool', 'agent re-plans: implement the TRA threshold instead of touching the oracle'],
      ['10:36:44', 'x1', 'Bash <code>psql $DATABASE_URL -c "ALTER TABLE sca_exemptions DROP COLUMN legacy"</code> → X1 irreversible (drop-column) → deny; the migration file route is the allowed one'],
      ['10:38:20', 'allow', 'PreToolUse Write <code>migrations/0042_sca_tra_threshold.sql</code> → allow (additive, reversible)'],
    ],
    'ses-7f12': [
      ['2d 08:41', 'sys', 'provisioned · class W · repo copy acme/payments-api@1f0c2d7'],
      ['2d 08:49', 'tool', 'Read <code>src/admin/cors.ts</code>'],
      ['2d 08:53', 'deny', 'PreToolUse Bash <code>cat ~/.aws/credentials</code> → deny · ET10 credential hunting'],
      ['2d 08:53', 'sys', 'tripwire ET10 → Q1 quarantine · session stopped and tainted · SECT card to Keiko Sato'],
      ['2d 08:54', 'sys', 'kill.requested session payments/ses-7f12 (pending_signature: KMS unreachable) · enforced at once'],
    ],
  };
  const LIVE = [
    ['tool', 'Read <code>src/sca/tra.ts</code>'],
    ['gw', 'gateway /v1/messages · claude-opus-5-5 · 21.4k in / 1.8k out · 10.1¢'],
    ['allow', 'PreToolUse Edit <code>src/sca/tra.ts</code> → allow (inside Unit scope)'],
    ['x1', 'Bash <code>npm test -- sca/tra</code> → classified reversible → allow'],
    ['sys', 'tests: 16 passed, 0 failed · oracle u2-o3 green'],
    ['x1', 'Bash <code>git push origin agent/W-31/u2</code> → deny: egress, pushes go through the Push Broker at 6.6'],
    ['x1', 'Bash <code>npm install fast-tra@2.1.0</code> → X3 new dependency → deny; X3 card would open (asked: no)'],
    ['allow', 'PreToolUse Glob <code>test/sca/**</code> → allow (read)'],
    ['x1', 'Bash <code>rm -rf /work/repo/node_modules/.cache</code> → reversible (inside /work) → allow'],
    ['gw', 'gateway /v1/messages · claude-opus-5-5 · 19.9k in / 3.2k out · 11.6¢'],
  ];
  const evRow = (e, isNew) => `<div class="${isNew ? 'new' : ''}"><span class="t">${e[0]}</span><span class="k ${e[1]}">${{ tool: 'tool', gw: 'gateway', allow: 'hook allow', deny: 'hook deny', x1: 'bash · X1', sys: 'session' }[e[1]]}</span><span class="m">${e[2]}</span></div>`;

  const sessDrawer = (id, rerender) => {
    const s = SESS.find((x) => x.id === id); const c = cls(s.cls); const ag = s.agent ? A.agent(s.agent) : null;
    const evs = EVENTS[id] || (s.state === 'running' ? [['10:3' + (id.charCodeAt(7) % 9) + ':0' + (id.charCodeAt(6) % 9), 'sys', `provisioned · class ${s.cls} · ${c.net}`], ['10:41:12', 'tool', `${ag ? ag.name : 'run'}: Read ${s.cls === 'V' ? 'pack/handoff.json' : 'docs/plan.md'}`], ['10:42:03', 'gw', `gateway /v1/messages · ${ag ? ag.model : '—'} · 12.0k in / 1.1k out`]] : [['—', 'sys', s.note || `session ${s.state}`]]);
    const pj = projOfSess(s), d2 = A.dataClass(pj) >= 2, canStop = A.can('session.stop', PR(pj));
    const el = A.drawer(`
      <div class="row between"><span class="eyebrow">Sandbox session · class ${s.cls} · ${E(projName(pj))}</span><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      <div class="row"><h2 class="mono" style="font-family:var(--mono);font-size:22px">${s.id}</h2>${A.pill(s.state, { running: 'ok', finished: 'mute', killed: 'bad', refused: 'bad' }[s.state])}${s.state === 'running' ? '<span class="op-live">live</span>' : ''}</div>
      ${A.kv([['Item', s.item ? keyT(s.item) : `<span class="muted">${E(s.note || 'no item')}</span>`], ['Step', `<span class="mono">${s.step}</span> ${E((D.STEPS[s.step] || [])[2] || '')}`], s.unit ? ['Unit · lease', `<span class="mono">${s.unit}</span>${s.item === 'W-31' ? ' · epoch 4' : ' · epoch 1'}`] : null, ['Agent', ag ? `${A.glyph('A', 16)} ${ag.id === 'coder' ? '' : E(ag.id) + ' '}${E(ag.name)} · <span class="mono small">${E(ag.model)}</span>` : '<span class="muted">none (deterministic run)</span>'], ['Network', c.net], ['Gateway', s.calls ? `${s.calls} calls · ${s.tokens} tokens · ${A.cents(s.spend)}` : '—'], ['Tripwires', s.tripwires ? A.pill(`${s.tripwires} fired`, 'bad') + (d2 ? '' : ' <span class="tiny faint">evidence needs D2</span>') : A.pill('none', 'ok')], ['Your data class', `<span class="mono">D${Math.max(0, A.dataClass(pj))}</span> on ${E(projName(pj))}`]])}
      <div><div class="lbl" style="margin-bottom:6px">Profile ceiling (contracts SANDBOX_PROFILES.${s.cls})</div>
        <div>${[`cpu ${c.cpu}`, `mem ${c.mem} MiB, no swap`, `pids ${c.pids}`, `time ${c.time}`, `/out ${c.out}`, 'read-only root', 'CapDrop ALL', 'no-new-privileges', 'uid 10002', 'seccomp default', c.key ? 'gateway key: this Unit only' : 'no key'].map((t) => `<span class="op-tag">${t}</span>`).join('')}</div></div>
      ${s.state === 'running' ? `<div class="grid g2" style="gap:10px"><div><div class="tiny faint">cpu</div><div class="op-cell-meter"><span data-op-dcpu>${A.meter(s.cpu, 100)}</span><span data-op-dcput>${s.cpu}%</span></div></div><div><div class="tiny faint">memory</div><div class="op-cell-meter"><span>${A.meter(s.mem, memCapGB(s))}</span><span>${s.mem} GB</span></div></div></div>` : ''}
      <div class="row between"><div class="lbl">Event stream</div><span class="tiny faint">tool calls, PreToolUse hook verdicts, X1 classification of Bash</span></div>
      ${d2 ? `<div class="op-ev" data-op-ev>${A.j(evs, (e) => evRow(e))}</div>` : needD2('the event stream, tool calls and Bash commands', pj)}
      ${s.state === 'running' && !canStop ? `<div class="row between" style="gap:10px"><span class="small muted" style="flex:1;min-width:200px">Stopping a session needs <span class="mono">session.stop</span> on ${E(projName(pj))}: ${E(names(whoCan('session.stop', PR(pj))))}.</span>${A.act('Stop session', 'session.stop', PR(pj), { cls: 'danger sm' })}</div>` : ''}
      ${s.state === 'running' && canStop ? `<div class="card" style="border-color:#6a2522"><div class="bd" style="display:flex;flex-direction:column;gap:10px">
        <div class="row between"><h4 style="color:#ff9d96">Stop session</h4><span class="tiny faint">kill scope: session</span></div>
        <p class="small muted">Kills the container now, revokes the ${s.cls === 'W' ? 'per-Unit' : 'per-job'} key at the gateway and releases the lease. ${s.item ? `${s.item} goes to a D1 handoff with the last snapshot.` : ''} The kill is signed in the kill switch journal; releasing it later needs two people.</p>
        <div class="field"><label for="op-stop-r">Reason (recorded and signed)</label><textarea class="input" id="op-stop-r" style="min-height:64px" placeholder="e.g. looping on the same failing test for 20 minutes"></textarea></div>
        <div class="row"><button class="btn danger" data-op-stop disabled>Stop ${s.id}</button><span class="tiny faint" data-op-stophint>a reason of 10 characters or more is needed</span></div></div></div>` : ''}`);
    if (s.state === 'running') {
      const ev = el.querySelector('[data-op-ev]'); let i = 0;
      if (ev) ev.scrollTop = ev.scrollHeight;
      const t = setInterval(() => {
        if (!el.isConnected) return clearInterval(t);
        const e = LIVE[i++ % LIVE.length]; if (ev) { ev.insertAdjacentHTML('beforeend', evRow([nowClock(), e[0], s.id === 'ses-7f21' ? e[1] : e[1].replace(/sca\/tra|sca/g, 'src')], true)); ev.scrollTop = ev.scrollHeight; }
        s.cpu = Math.max(4, Math.min(96, s.cpu + Math.round((Math.random() - 0.5) * 18)));
        const m = el.querySelector('[data-op-dcpu]'); if (m) { m.innerHTML = A.meter(s.cpu, 100); el.querySelector('[data-op-dcput]').textContent = s.cpu + '%'; }
      }, 2200);
      const ta = el.querySelector('#op-stop-r'), btn = el.querySelector('[data-op-stop]');
      if (!ta) return;
      let armed = false;
      ta.addEventListener('input', () => { btn.disabled = ta.value.trim().length < 10; armed = false; btn.textContent = `Stop ${s.id}`; el.querySelector('[data-op-stophint]').textContent = btn.disabled ? 'a reason of 10 characters or more is needed' : 'click to review what stops'; });
      btn.addEventListener('click', () => {
        if (!armed) { armed = true; btn.textContent = `Confirm: kill session ${projOfSess(s)}/${s.id}`; btn.classList.remove('danger'); btn.style.background = 'var(--quar)'; btn.style.color = '#fff'; el.querySelector('[data-op-stophint]').textContent = 'this applies immediately'; return; }
        if (!A.can('session.stop', PR(pj))) { A.closeOverlay(); A.explainDrawer('session.stop', PR(pj)); return; }
        s.state = 'killed'; s.cpu = 0; s.mem = 0; KILLS.unshift({ id: 'k-0' + (194 + KILLS.length), scope: 'session', ref: `${pj}/${s.id}`, project: pj, state: 'active', by: me(), at: 'just now', reason: ta.value.trim(), req: 2, appr: [] });
        JOURNAL.unshift([JOURNAL[0][0] + 1, 'kill.requested', `session ${pj}/${s.id}`, me(), nowClock(), 'ks:es256:2026-10', nextSeq(), pj]);
        A.closeOverlay(); A.toast(`Session ${s.id} killed. Key revoked, lease released; kill.requested signed in the journal.`); rerender();
      });
    }
  };

  const secob3Drawer = () => {
    const groups = [
      ['Network and egress, class K-exec (mirror only)', '1–11, 19–20', 13, 'DNS, external HTTP by name and IP, gateway without a key, metadata IP 169.254.169.254, the Docker host, other factory names, PUT to the mirror, other mirror ports'],
      ['Secrets and filesystem, K-exec', '12–18, 21', 8, 'env and /proc/*/environ, canary walk of 5,000+ files, writes outside /repo and /out, Docker socket search, uid 10002, CapEff 0, NoNewPrivs 1, seccomp 2'],
      ['The same 21 attempts in class K (no NIC)', '22–42', 21, 'everything above with no network interface at all: loopback only'],
      ['Output scan and canaries', '43–45', 3, 'a planted AISDLC_CANARY_ in /out and stdout quarantines the output; 4 host-side canaries found in no sandbox output'],
      ['Resource limits', '46–52', 7, 'pids 64 with EAGAIN, a real fork bomb, memory to OOM at 128 MiB, sleep past the limit, 1 GiB writes to capped tmpfs, links in /out skipped, no residue between sessions'],
      ['The proxy refuses what a compromised worker asks for', '53–74', 22, 'Privileged, host network and PID, CapAdd, devices, the socket bind, host root bind, seccomp unconfined, root user, writable root, no memory limit, other image, exec, build, pull, volumes, non-internal networks, peer alias tricks'],
    ];
    A.drawer(`<div class="row between"><span class="eyebrow">Evidence · docs/evidence/sec-ob-3.md</span><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      <h2>SEC-OB-3 hostile probe</h2>
      <div class="banner info" style="margin:0"><b>74 of 74 attempts contained, 0 escaped.</b><span class="sp"></span><span class="mono tiny">Docker 29.9.2 · aisdlc/sandbox:local</span></div>
      <p class="small muted">A synthetic hostile repository built by the test itself (no real repo code) tried to escape classes K-exec and K through DockerSandboxDriver and the allow-list docker-proxy. The host listener saw 0 connections; no container, network, volume or scratch directory was left behind.</p>
      <div class="list" style="border:1px solid var(--line);border-radius:var(--r)">${A.j(groups, (g) => `<div class="li" style="cursor:default;grid-template-columns:auto minmax(0,1fr) auto"><span class="pill ok plain">${g[2]}/${g[2]}</span><div><div class="ti small">${E(g[0])}</div><div class="me tiny">${E(g[3])}</div></div><span class="mono tiny faint">#${g[1]}</span></div>`)}</div>
      <div class="fence"><div class="src">what this does not show</div>VM-class isolation. A kernel or runtime escape is out of scope for any container; that is why DEC-18 is a human decision and why only listed repos run code here (ADR-0002).</div>
      ${A.kv([['Generated by', '<span class="mono small">services/sandbox-driver/test/sec-ob-3.test.ts</span>'], ['Twin', '<span class="mono small">docs/evidence/sec-ob-3.json</span> ' + A.hash(hx('sec-ob-3.json'))], ['Regenerate', '<span class="mono small">npm run evidence:sec-ob-3</span>'], ['Decided', 'DEC-18(b), 2026-11-09, M1 approved by Luis Torres']])}`);
  };

  const DEC18 = [
    ['acme/payments-api', 'allowed', 'r3 · 2026-11-09', 'lt'],
    ['acme/web-checkout', 'allowed', 'r3 · 2026-11-09', 'lt'],
    ['acme/ledger-svc', 'allowed', 'r4 · 2026-11-10', 'lt'],
    ['acme/identity-hub', 'not listed', 'confidential: VM-class only', null],
    ['acme/mobile-app', 'not listed', 'onboarding (S0); probe refused', null],
  ];

  const visSess = () => SESS.filter((s) => opsOK(projOfSess(s)));
  /** sessions of confidential projects a fleet role reads collapsed; for anyone else they do not exist */
  const confSess = () => (isFleetReader() ? SESS.filter((s) => confidentialIds().includes(projOfSess(s)) && !opsOK(projOfSess(s))) : []);
  view('sessions', {
    label: 'Sandboxes', group: 'Operate', icon: 'sessions',
    access: () => ({ action: 'ops.read', res: PR(A.state.project) }),
    deniedTitle: 'You can’t open the sandboxes',
    badge: () => ({ n: visSess().filter((s) => s.state === 'running').length }),
    render: () => {
      const VS = visSess(), run = VS.filter((s) => s.state === 'running'), conf = confSess();
      const calls = VS.reduce((a, s) => a + s.calls, 0), spend = VS.reduce((a, s) => a + s.spend, 0);
      const trip = VS.filter((s) => s.tripwires);
      const stopProjects = A.visibleProjects().filter((p) => A.can('session.stop', PR(p.id))).map((p) => p.name);
      return `${A.pageHead({ eyebrow: 'Operate · SandboxPort · docker-proxy', title: 'Sandboxes', sub: 'Every agent and test run happens in a container sandbox of one class. A class sets a ceiling no session can exceed: its network peers, CPU, memory, pids, time and output. Open a session to see its limits and, with D2, its tool calls and hook verdicts.', actions: `<button class="btn" data-op-evidence>SEC-OB-3 evidence</button>${killAllowed() ? `<a class="btn danger" href="#kill">${A.icon('kill', 14)} Kill switch</a>` : ''}` })}
      <div class="op-scope-note">${A.icon('lock', 13)}<span>${isFleetReader() ? 'You see sessions of every project (fleet role).' : 'You see sessions of the projects where you hold ops.read; sessions of other projects are not listed.'} ${stopProjects.length ? `You can stop sessions in <b>${E(stopProjects.join(', '))}</b>.` : 'You cannot stop sessions; the Stop buttons show who can.'} Transcripts need data class D2.</span></div>
      ${A.stats([
        { k: 'Running now', v: run.length, d: `${run.filter((s) => s.cls === 'W').length} W (coding) · ${run.length - run.filter((s) => s.cls === 'W').length} P/V` },
        { k: 'Gateway calls today', v: calls + (isFleetReader() ? 1146 : 980), d: `${A.cents(spend + (isFleetReader() ? 6120 : 5010))} metered · per-Unit keys` },
        trip.length ? { k: 'Tripwires 24h', v: trip.length, d: `ET10 on ${trip.map((s) => s.id + (s.item ? ` (${s.item})` : '')).join(', ')}, quarantined`, tone: 'bad' } : { k: 'Tripwires 24h', v: 0, d: 'none in your projects', tone: 'ok' },
        { k: 'Proxy refusals 24h', v: 3, d: 'all driver bugs in tests, 0 in production', tone: 'ok' },
        { k: 'Hostile probe', v: '74/74', d: 'SEC-OB-3 contained · 0 escaped', tone: 'ok' },
      ])}
      <div style="height:16px"></div>
      <div class="op-classes">${A.j(CLASSES, (c) => { const n = run.filter((s) => s.cls === c.id).length; return `<div class="op-cls ${n ? 'on' : ''}"><div class="row between"><span class="op-cls-id">${c.id}</span><span class="n">${n} running</span></div><p class="d">${E(c.d)}</p>
        <dl><dt>network</dt><dd>${c.net}</dd><dt>repo</dt><dd>${c.repo}</dd><dt>exec</dt><dd>${c.exec ? 'yes' : 'no'}</dd><dt>key</dt><dd>${c.key ? (c.id === 'W' ? 'per Unit' : 'per job') : 'none'}</dd><dt>cpu</dt><dd>${c.cpu}</dd><dt>memory</dt><dd>${c.mem} MiB</dd><dt>pids</dt><dd>${c.pids}</dd><dt>time</dt><dd>${c.time}</dd><dt>/out</dt><dd>${c.out}</dd></dl></div>`; })}</div>
      <p class="tiny faint" style="margin-top:8px">Every class: read-only root, CapDrop ALL, no-new-privileges, uid 10002, default seccomp, no Docker socket, no credential-shaped env name. The only network peers that exist are the gateway and the package mirror.</p>
      <div style="height:12px"></div>
      ${A.card('Sessions', A.table([
        { h: 'Session', r: (s) => `<button class="btn ghost sm mono" style="padding:2px 4px;font-family:var(--mono)" data-op-ses="${s.id}">${s.id}</button>` },
        { h: 'Class', r: (s) => `<span class="op-tag" style="margin:0">${s.cls}</span>` },
        { h: 'State', r: (s) => A.pill(s.state, { running: 'ok', finished: 'mute', killed: 'bad', refused: 'bad' }[s.state]) },
        { h: 'Item · step', cls: 'op-nw', r: (s) => (s.item ? `<div class="row" style="gap:6px;flex-wrap:nowrap">${key(s.item)}<span class="mono tiny faint">${s.step}${s.unit ? ' · ' + s.unit : ''}</span></div>` : `<span class="tiny muted" style="display:block;min-width:200px;max-width:240px;white-space:normal">${E(s.note || '')}</span>`) },
        { h: 'Agent', cls: 'op-nw', r: (s) => (s.agent ? `<span class="row" style="gap:5px;flex-wrap:nowrap">${A.glyph('A', 14)}<span class="small">${E(s.agent === 'coder' ? 'coder' : s.agent + ' ' + A.agent(s.agent).name)}</span></span>` : `<span class="row" style="gap:5px;flex-wrap:nowrap">${A.glyph('D', 14)}<span class="small muted">none</span></span>`) },
        { h: 'CPU', r: (s) => `<div class="op-cell-meter" data-op-cpu="${s.id}">${A.meter(s.cpu, 100)}<span>${s.cpu}%</span></div>` },
        { h: 'Memory', r: (s) => `<div class="op-cell-meter" data-op-mem="${s.id}">${A.meter(s.mem, memCapGB(s))}<span>${s.mem ? s.mem.toFixed(1) + 'G' : '—'}</span></div>` },
        { h: 'Pids', cls: 'r', r: (s) => `<span class="mono small" data-op-pids="${s.id}">${s.pids || '—'}</span><span class="tiny faint">/${cls(s.cls).pids}</span>` },
        { h: 'Gateway', cls: 'r op-nw', r: (s) => (s.calls ? `<span class="mono small">${s.calls} · ${s.tokens}</span><div class="tiny faint">${A.cents(s.spend)}</div>` : '<span class="faint">—</span>') },
        { h: 'Tripwires', r: (s) => (s.tripwires ? A.pill('ET10', 'bad') : '<span class="faint small">0</span>') },
        { h: 'Since', cls: 'r', r: (s) => `<span class="mono small">${s.since}</span>` },
        { h: '', r: (s) => (s.state === 'running' ? A.act('Stop…', 'session.stop', PR(projOfSess(s)), { cls: 'sm danger', attrs: `data-op-ses="${s.id}"` }) : '') },
      ], VS), { flush: true, actions: '<span class="op-live">meters live</span>' })}
      ${conf.length ? collapsed(`${conf.length} session${conf.length === 1 ? '' : 's'} in a confidential project: collapsed for fleet roles (FD-D6). Only people with a role on it see ids, items and meters.`) : ''}
      <div style="height:16px"></div>
      <div class="grid g2">
        ${A.card('Hostile-probe evidence SEC-OB-3', `<div class="row" style="gap:18px;align-items:flex-end"><div><div class="op-big-n" style="color:var(--ok)">74 / 74</div><div class="small muted">attempts contained · 0 escaped</div></div><div class="small muted" style="flex:1;min-width:200px">A synthetic hostile repo tried to reach the network, read secrets, write outside its tree, find the Docker socket, exhaust resources and ask the proxy for privileges.</div></div>
          <div class="op-probe" title="one square per attempt">${Array.from({ length: 74 }, (_, i) => `<i class="${i < 21 ? '' : i < 42 ? 'x' : i < 45 ? 'o' : i < 52 ? 'l' : 'p'}" title="#${i + 1} contained"></i>`).join('')}</div>
          <div class="op-legend" style="margin-top:0"><span><i style="background:var(--ok)"></i>K-exec 21</span><span><i style="background:var(--human)"></i>K 21</span><span><i style="background:var(--agent)"></i>output scan 3</span><span><i style="background:var(--warn)"></i>limits 7</span><span><i style="background:var(--hand)"></i>proxy refusals 22</span></div>`, { actions: '<button class="btn sm" data-op-evidence>Open evidence</button>', foot: '<span class="tiny faint" style="margin-right:auto">docs/evidence/sec-ob-3.md · container-class, not VM-class (ADR-0002)</span>' })}
        ${A.card('Where repo code may run (DEC-18)', `<p class="small muted" style="margin-bottom:10px">Config <span class="mono">sandbox.exec_allowed_repos</span>, factory layer, M1-gated. Classes that execute repo code (K-exec, W, O) refuse any repo not on this list, and the item is BLOCKED with <span class="mono">exec_not_allowed</span>. An unreadable value means nothing runs.</p>
          ${A.table([{ h: 'Repository', cls: 'op-nw', r: (r) => `<span class="mono small">${r[0]}</span>` }, { h: 'Execution', r: (r) => A.pill(r[1], r[1] === 'allowed' ? 'ok' : 'mute') }, { h: 'Revision', r: (r) => `<span class="tiny muted">${E(r[2])}</span>` }, { h: 'M1 by', cls: 'op-nw', r: (r) => (r[3] ? A.who(r[3]) : '<span class="faint">—</span>') }], DEC18.filter((r) => { const p = D.PROJECTS.find((x) => x.repo === r[0]); return !p || A.canSeeProject(p.id); }))}`, { actions: A.act('Propose change (M1)', 'config.propose', FLEET, { cls: 'sm', attrs: 'data-toast="Draft sandbox.exec_allowed_repos r5 created; the M1 card goes to another factory admin (you never decide your own proposal)"' }) })}
      </div>`;
    },
    mount: (root) => {
      const rerender = () => A.render();
      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-op-ses]'); if (b) return sessDrawer(b.dataset.opSes, rerender);
        if (e.target.closest('[data-op-evidence]')) secob3Drawer();
      });
      every(1500, () => SESS.filter((s) => s.state === 'running').forEach((s) => {
        s.cpu = Math.max(3, Math.min(97, s.cpu + Math.round((Math.random() - 0.5) * 14)));
        s.mem = Math.max(0.1, Math.min(memCapGB(s) * 0.95, +(s.mem + (Math.random() - 0.45) * 0.08).toFixed(2)));
        s.pids = Math.max(4, s.pids + Math.round((Math.random() - 0.5) * 4));
        const c = root.querySelector(`[data-op-cpu="${s.id}"]`); if (c) c.innerHTML = `${A.meter(s.cpu, 100)}<span>${s.cpu}%</span>`;
        const m = root.querySelector(`[data-op-mem="${s.id}"]`); if (m) m.innerHTML = `${A.meter(s.mem, memCapGB(s))}<span>${s.mem.toFixed(1)}G</span>`;
        const p = root.querySelector(`[data-op-pids="${s.id}"]`); if (p) p.textContent = s.pids;
      }));
    },
    unmount: clearTimers,
  });

  /* ================================================================ 3. Controls */
  const CONTROLS = [
    { id: 'ctl-4e1a', kind: 'hold', sk: 'lane', ref: 'payments/L6', origin: 'operator', by: 'pm', created: 'Nov 9 16:20', expires: 'Nov 12 18:00', state: 'active', ledger: 'ledgered', seq: 18391, note: 'No new L6 agent work until the settlement design review (W-32)' },
    { id: 'ctl-4e0f', kind: 'clamp', sk: 'project', ref: 'web', params: 'max_in_flight 1', origin: 'automation', by: 'R3 breaker', created: 'Nov 10 06:12', expires: 'Nov 12 06:12', state: 'active', ledger: 'ledgered', seq: 18402, note: 'R3: three B9 verify failures in 24 h on web-checkout' },
    { id: 'ctl-4df2', kind: 'halt', sk: 'release', ref: 'payments/rel-2026.11.3', origin: 'security', by: 'ks', created: 'Nov 8 09:01', expires: 'when SECT on W-19 is decided', state: 'active', ledger: 'ledgered', seq: 18288, note: 'No S8b release or G5 while the CORS quarantine is open' },
    { id: 'ctl-4dd0', kind: 'hold', sk: 'budget', ref: 'gw/provider/deepseek', origin: 'kill', by: 'killswitch', created: 'Nov 10 10:43', expires: 'while k-0193 is active', state: 'active', ledger: 'pending', seq: null, note: 'Mirror of kill k-0193 (model deepseek-v4): no new reservations' },
    { id: 'ctl-4dc7', kind: 'maintenance', sk: 'fleet', ref: 'fleet', origin: 'operator', by: 'lt', created: 'Nov 9 11:00', expires: 'Nov 14 04:00', state: 'active', ledger: 'ledgered', seq: 18350, note: 'Sat 02:00–04:00 UTC, Postgres 16.6 minor upgrade: timers frozen, work held like MM-2' },
    { id: 'ctl-4db1', kind: 'clamp', sk: 'budget', ref: 'bg/team-web/monthly', params: 'max_in_flight 2', origin: 'automation', by: 'gateway_triggers', created: 'Nov 7 14:40', expires: 'Dec 1 00:00', state: 'active', ledger: 'ledgered', seq: 18190, note: 'Team budget at 92% of the month' },
  ];
  const CTL_HIST = [
    { id: 'ctl-4c88', kind: 'hold', sk: 'project', ref: 'ledger', origin: 'operator', by: 'so', created: 'Nov 5 10:00', expires: 'lifted Nov 6 15:12 by Sam Osei', state: 'lifted', ledger: 'ledgered', seq: 18011, note: 'Journal partition work (L-07) in progress' },
    { id: 'ctl-4c41', kind: 'clamp', sk: 'fleet', ref: 'fleet', params: 'max_in_flight 1', origin: 'operator', by: 'lt', created: 'Nov 3 08:00', expires: 'expired Nov 3 20:00', state: 'expired', ledger: 'ledgered', seq: 17802, note: 'Host swap pressure during the M13.4 rollout' },
    { id: 'ctl-4bf0', kind: 'halt', sk: 'release', ref: 'web/rel-2026.10.9', origin: 'security', by: 'ks', created: 'Oct 30 17:30', expires: 'lifted Oct 31 09:02 by Keiko Sato', state: 'lifted', ledger: 'ledgered', seq: 17540, note: 'CVE-2026-0991 triage' },
  ];
  const BANNERS = [
    { id: 'bn-0912', sev: 'warning', target: 'banner', scope: 'fleet', text: 'Maintenance Sat 14 Nov 02:00–04:00 UTC: agent work pauses and timers freeze. Gates you have open stay open.', expires: 'Nov 14 04:00', by: 'lt' },
    { id: 'bn-0910', sev: 'info', target: 'banner', scope: 'project web', text: 'Web Checkout runs one agent session at a time (R3 clamp) until Thursday.', expires: 'Nov 12 06:12', by: 'R3 breaker' },
  ];
  const FLAGS = [
    { key: 'ops.admission.fifo_pass_over', val: true, owner: 'lt', exp: '2026-12-31', note: 'Pass over a Unit that fails H1, H3 or WIP instead of blocking the line' },
    { key: 'ops.sandbox.prewarm_w', val: true, owner: 'lt', exp: '2026-11-30', note: 'Keep one W image layer warm between sessions' },
    { key: 'ops.gateway.stream_redaction_v2', val: true, owner: 'ks', exp: '2026-11-15', note: 'Redact streamed text with secrets-rules 2.3', warn: true },
    { key: 'ops.floor.show_cost', val: false, owner: 'rb', exp: '2026-12-15', note: 'Show envelope spend on floor chips' },
    { key: 'ops.inbox.daily_digest', val: true, owner: 'pm', exp: '2027-01-31', note: 'Morning email digest of waiting gates' },
    { key: 'ops.kill.require_two_person_t1', val: true, owner: 'ks', exp: '2026-11-11', note: 'Two-person release for T1 kills too (normally T2 and fleet only)', warn: true },
  ];
  const REFS = {
    fleet: ['fleet'], team: ['payments', 'web', 'ledger', 'security'], project: ['payments', 'ledger', 'web', 'identity'],
    lane: ['payments/L0', 'payments/L4', 'payments/L6', 'web/L4', 'ledger/L2'], release: ['payments/rel-2026.11.3', 'web/rel-2026.11.2'], budget: ['bg/team-payments/monthly', 'bg/team-web/monthly'],
  };
  const live = (i) => !['done', 'declined'].includes(i.state);
  const itemsIn = (sk, ref) => {
    const L = D.ITEMS.filter(live);
    if (sk === 'fleet') return L;
    if (sk === 'project') return L.filter((i) => i.project === ref);
    if (sk === 'team') return L.filter((i) => A.project(i.project).team === ref);
    if (sk === 'lane') { const [p, l] = ref.split('/'); return L.filter((i) => i.project === p && i.lane === l); }
    if (sk === 'release') { const p = ref.split('/')[0]; return L.filter((i) => i.project === p && ['S8', 'S9'].includes(i.stage)); }
    if (sk === 'budget') { const t = ref.split('/')[1].replace('team-', ''); return L.filter((i) => A.project(i.project).team === t); }
    return [];
  };
  const VERB_HELP = { hold: 'Stops new agent work in the scope; items there become HELD.', clamp: 'Limits agent work in flight in the scope to a number.', halt: 'Stops releases in the scope (S8b, G5).', maintenance: 'Freezes timers and holds work like MM-2 for a window.' };
  /* the project a control scope belongs to (null = the factory): fleet, team and provider scopes are Fleet resources */
  const teamProject = (t) => (D.PROJECTS.find((p) => p.team === t && p.level !== 'Onboarding') || {}).id || null;
  const refProject = (sk, ref) => {
    if (sk === 'fleet' || sk === 'team') return null;
    if (sk === 'project') return ref;
    if (sk === 'lane' || sk === 'release') return ref.split('/')[0];
    if (sk === 'budget') return ref.startsWith('bg/team-') ? teamProject(ref.split('/')[1].replace('team-', '')) : null;
    return null;
  };
  const refRes = (sk, ref) => { const p = refProject(sk, ref); return p ? PR(p) : FLEET; };
  const ctlVisible = (c) => { const p = refProject(c.sk, c.ref); return !p || opsOK(p); };
  const canApplySomewhere = () => A.can('control.apply', FLEET) || A.visibleProjects().some((p) => A.can('control.apply', PR(p.id)));
  const allowedRefs = (sk) => REFS[sk].filter((r) => (!refProject(sk, r) || A.canSeeProject(refProject(sk, r))) && A.can('control.apply', refRes(sk, r)));
  const allowedKinds = () => Object.keys(REFS).filter((k) => allowedRefs(k).length);
  const BANNER_SCOPES = ['fleet', 'project payments', 'project web', 'project ledger', 'team payments'];
  const bannerRes = (scope) => { const [k, r] = scope.split(' '); return k === 'project' ? PR(r) : FLEET; };
  const bannerVisible = (b) => { const r = bannerRes(b.scope); return r.type === 'Fleet' || opsOK(r.project); };
  const ledgerCell = (c) => `<span class="op-ledger ${c.ledger}">${c.ledger === 'pending' ? '◌ pending' : `✓ #${Math.floor(c.seq).toLocaleString()}`}</span>`;
  const originPill = (o) => A.pill(o, { operator: 'human', security: 'bad', kill: 'bad', automation: 'agent' }[o]);
  const resLabel = (r) => (r.type === 'Fleet' ? 'Fleet' : `Project · ${projName(r.project)}`);
  const ctlCols = (actions) => [
    { h: 'Kind', r: (c) => `<span class="mono small" style="font-weight:600">${c.kind}</span>${c.params ? `<div class="tiny faint mono">${c.params}</div>` : ''}` },
    { h: 'Scope', r: (c) => `<span class="op-tag" style="margin:0">${c.sk}</span> <span class="mono small">${E(c.ref)}</span><div class="tiny muted" style="max-width:300px;min-width:200px;margin-top:3px">${E(c.note)}</div>` },
    { h: 'Origin', r: (c) => originPill(c.origin) },
    { h: 'Created by', r: (c) => `${A.person(c.by) ? A.who(c.by) : `<span class="mono small">${E(c.by)}</span>`}<div class="tiny faint">${c.created}</div>` },
    { h: 'Expires', r: (c) => `<span class="small">${E(c.expires)}</span>` },
    { h: 'Ledger', r: (c) => `<span data-op-ledger="${c.id}">${ledgerCell(c)}</span>` },
    ...(actions ? [{ h: 'Lift needs', cls: 'op-nw', r: (c) => `<div class="row" style="gap:8px;flex-wrap:nowrap">${A.act('Lift…', 'control.lift', refRes(c.sk, c.ref), { cls: 'sm', attrs: `data-op-lift="${c.id}"` })}<span class="tiny mono faint">${E(resLabel(refRes(c.sk, c.ref)))}</span></div>` }] : [{ h: 'State', r: (c) => A.pill(c.state, 'mute') }]),
  ];

  const ctlState = { step: 1, kind: 'hold', sk: 'project', ref: 'payments', exp: '4 hours', max: 1, reason: '' };
  /** the step-up the controls keep: valid -> run now, else the security-key modal first */
  const withStepUp = (why, fn) => (A.stepUpValid() ? fn() : A.stepUpModal(fn, why));
  const stepUpLine = () => (A.stepUpValid() ? `<div class="banner info" style="margin:0">${A.icon('lock')} Step-up valid for ${Math.max(1, Math.round((A.session.stepUpUntil - Date.now()) / 60000))} more minutes. The apply binds the preview nonce and the blast radius hash.</div>` : `<div class="banner warn" style="margin:0">${A.icon('lock')} Step-up needed: you confirm with your security key, then the control applies. The proof binds the preview nonce and the blast radius hash.</div>`);
  const ctlModal = (onDone) => {
    const s = ctlState;
    const kinds = allowedKinds();
    if (!kinds.includes(s.sk)) s.sk = kinds[0];
    if (!allowedRefs(s.sk).includes(s.ref)) s.ref = allowedRefs(s.sk)[0];
    const flow = `<div class="op-flow">${['1 Choose', '2 Preview', '3 Step-up'].map((t, i) => `<span class="${i + 1 === s.step ? 'on' : i + 1 < s.step ? 'done' : ''}">${t}</span>`).join('')}</div>`;
    let body = '';
    if (s.step === 1) {
      body = `<div class="field"><label>Verb</label><div class="seg" data-op-seg="kind">${['hold', 'clamp', 'halt', 'maintenance'].map((k) => `<button aria-pressed="${s.kind === k}" data-v="${k}">${k}</button>`).join('')}</div><span class="help">${VERB_HELP[s.kind]}</span></div>
        <div class="op-form">
          <div class="field"><label for="op-sk">Scope kind</label><select class="input" id="op-sk">${kinds.map((k) => `<option ${k === s.sk ? 'selected' : ''}>${k}</option>`).join('')}</select><span class="help">Only scopes where you hold control.apply are listed${A.can('control.apply', FLEET) ? '' : '; fleet and team scopes are factory admin only'}.</span></div>
          <div class="field"><label for="op-ref">Scope ref</label><select class="input" id="op-ref">${allowedRefs(s.sk).map((r) => `<option ${r === s.ref ? 'selected' : ''}>${r}</option>`).join('')}</select><span class="help">PDP resource: <span class="mono">${E(resLabel(refRes(s.sk, s.ref)))}</span></span></div>
          <div class="field"><label for="op-exp">Expires after</label><select class="input" id="op-exp">${['1 hour', '4 hours', '24 hours', '3 days', 'until lifted'].map((r) => `<option ${r === s.exp ? 'selected' : ''}>${r}</option>`).join('')}</select><span class="help">Expiry lifts the control; it never approves anything.</span></div>
          ${s.kind === 'clamp' ? `<div class="field"><label for="op-max">max_in_flight</label><input class="input" id="op-max" type="number" min="0" max="3" value="${s.max}"></div>` : '<div></div>'}
          <div class="field full"><label for="op-why">Reason</label><textarea class="input" id="op-why" style="min-height:60px" placeholder="Shown on every affected item and in the ledger">${E(s.reason)}</textarea></div>
        </div>
        <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-op-next>Preview blast radius →</button></div>`;
    } else if (s.step === 2) {
      const all = itemsIn(s.sk, s.ref), its = all.filter((i) => A.canSeeProject(i.project)), unseen = all.length - its.length;
      const inflight = its.filter((i) => SESS.some((x) => x.item === i.key && x.state === 'running') || i.pod);
      const ses = SESS.filter((x) => x.state === 'running' && x.item && its.some((i) => i.key === x.item));
      const overl = CONTROLS.filter((c) => c.state === 'active' && ctlVisible(c) && (c.sk === 'fleet' || c.ref === s.ref || c.ref.startsWith(s.ref + '/') || s.sk === 'fleet')).length;
      s.radius = hx(`${s.kind}|${s.sk}|${s.ref}|${all.map((i) => i.key).join(',')}`); s.nonce = hx('nonce' + Date.now(), 24);
      body = `<div class="op-radius"><div><b>${all.length}</b><span>active items</span></div><div><b>${inflight.length}</b><span>in flight</span></div><div><b>${ses.length}</b><span>sessions</span></div><div><b>${overl}</b><span>overlapping controls</span></div></div>
        <div><div class="lbl" style="margin-bottom:6px">Items this ${s.kind} would touch</div><div class="op-chips" data-peek-chips>${its.length ? A.j(its, (i) => A.chip(i, { full: true })) : '<span class="muted small">none right now; the control still applies to new work</span>'}</div>${unseen ? collapsed(`+${unseen} item${unseen === 1 ? '' : 's'} in a confidential project you cannot see. They are held too; their keys are not shown to you.`) : ''}</div>
        ${ses.length ? `<div><div class="lbl" style="margin-bottom:6px">Sessions</div>${A.j(ses, (x) => `<span class="op-tag">${x.id} · ${x.cls} · ${x.item}</span>`)}<div class="tiny faint">${s.kind === 'hold' || s.kind === 'maintenance' ? 'Running sessions finish their current step, then the item is HELD. Use the kill switch to stop them now.' : s.kind === 'clamp' ? 'In-flight work above the clamp finishes; no new admission until under it.' : 'Sessions are not affected by a release halt.'}</div></div>` : ''}
        ${A.kv([['Verb', `<span class="mono">control.${s.kind}</span> · class O-T · tier ${s.kind === 'halt' ? 'R' : 'L'}`], ['Scope', `<span class="mono">${s.sk}:${E(s.ref)}</span>`], ['PDP', `<span class="mono">control.apply · ${E(resLabel(refRes(s.sk, s.ref)))}</span> ${A.pill('allowed', 'ok')}`], ['Expires', E(s.exp)], ['blast_radius_hash', A.hash(s.radius, 16)], ['Preview nonce', `<span class="mono small">${s.nonce}</span> <span class="tiny faint">valid 5 min, single use</span>`]])}
        <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-op-back>← Back</button><button class="btn primary" data-op-next>Continue to step-up →</button></div>`;
    } else {
      body = `${stepUpLine()}
        <p class="small muted">The control applies first and is ledgered right after (OpsAction ledger_state pending → ledgered). If the Notary is down it is backfilled when it returns; the control does not wait.</p>
        <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-op-back>← Back</button><button class="btn primary" data-op-apply>${A.icon('lock', 14)} ${A.stepUpValid() ? 'Apply' : 'Step up and apply'} ${s.kind}</button></div>`;
    }
    const m = A.modal(`<div class="row between"><h2>New control</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>${flow}${body}`);
    const read = () => { if (s.step !== 1) return; s.sk = m.querySelector('#op-sk').value; s.ref = m.querySelector('#op-ref').value; s.exp = m.querySelector('#op-exp').value; s.reason = m.querySelector('#op-why').value; const mx = m.querySelector('#op-max'); if (mx) s.max = +mx.value; };
    const apply = () => {
      if (!A.can('control.apply', refRes(s.sk, s.ref))) { A.explainDrawer('control.apply', refRes(s.sk, s.ref)); return; }
      const id = 'ctl-' + hx(Date.now(), 4);
      CONTROLS.unshift({ id, kind: s.kind, sk: s.sk, ref: s.ref, params: s.kind === 'clamp' ? `max_in_flight ${s.max}` : '', origin: 'operator', by: me(), created: 'just now', expires: s.exp === 'until lifted' ? 'until lifted' : 'in ' + s.exp, state: 'active', ledger: 'pending', seq: nextSeq(), note: s.reason || VERB_HELP[s.kind], fresh: true });
      A.closeOverlay(); A.toast(`control.${s.kind} applied to ${s.sk}:${s.ref}. Ledger entry pending.`); Object.assign(s, { step: 1, reason: '' }); onDone(id);
    };
    m.addEventListener('click', (e) => {
      const sb = e.target.closest('[data-op-seg] button'); if (sb) { read(); s.kind = sb.dataset.v; return ctlModal(onDone); }
      if (e.target.closest('[data-op-next]')) { read(); s.step++; return ctlModal(onDone); }
      if (e.target.closest('[data-op-back]')) { s.step--; return ctlModal(onDone); }
      if (e.target.closest('[data-op-apply]')) withStepUp(`control.${s.kind} on ${s.sk}:${s.ref} is a privileged operation. The proof is bound to preview nonce ${s.nonce.slice(0, 12)}… and lasts 15 minutes.`, apply);
    });
    if (s.step === 1) m.querySelector('#op-sk').addEventListener('change', (e) => { read(); s.sk = e.target.value; s.ref = allowedRefs(s.sk)[0]; ctlModal(onDone); });
  };

  const bannerPreview = (sev, text, exp) => `<div class="banner ${sev === 'critical' ? 'bad' : sev === 'warning' ? 'warn' : 'info'}" style="margin:0;flex-wrap:nowrap;align-items:flex-start">${A.icon(sev === 'info' ? 'bell' : 'issues', 15)}<span style="flex:1;min-width:0">${E(text || 'Your banner text appears here.')}</span><span class="tiny" style="opacity:.8;white-space:nowrap">until ${E(exp)}</span></div>`;

  view('controls', {
    label: 'Controls', group: 'Operate', icon: 'controls',
    access: () => ({ action: 'ops.read', res: PR(A.state.project) }),
    deniedTitle: 'You can’t open the controls',
    badge: () => ({ n: CONTROLS.filter((c) => c.state === 'active' && ctlVisible(c)).length }),
    render: () => {
      const C = CONTROLS.filter(ctlVisible), H = CTL_HIST.filter(ctlVisible), BN = BANNERS.filter(bannerVisible);
      const active = C.filter((c) => c.state === 'active');
      const byKind = ['hold', 'clamp', 'halt', 'maintenance'].map((k) => [k, active.filter((c) => c.kind === k).length]).filter((x) => x[1]).map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`).join(' · ');
      const held = [...new Set(active.filter((c) => c.kind === 'hold' && c.sk !== 'fleet' && c.sk !== 'budget').flatMap((c) => itemsIn(c.sk, c.ref)).filter((i) => opsOK(i.project)).map((i) => i.key))];
      const halts = active.filter((c) => c.kind === 'halt');
      const bScopes = BANNER_SCOPES.filter((sc) => { const r = bannerRes(sc); return (r.type === 'Fleet' || A.canSeeProject(r.project)) && A.can('banner.publish', r); });
      const applyAny = canApplySomewhere();
      const myApply = [A.can('control.apply', FLEET) ? 'the whole factory' : '', ...A.visibleProjects().filter((p) => A.can('control.apply', PR(p.id))).map((p) => p.name)].filter(Boolean);
      const admins = whoCan('control.apply', PR(A.state.project));
      return `${A.pageHead({ eyebrow: 'Operate · OpsAction · OpsPreview', title: 'Controls', sub: 'Holds, clamps, release halts and maintenance windows, plus the banners people see. Every change is previewed first: you see exactly which items and sessions it touches before you apply it with step-up.', actions: applyAny ? '<button class="btn primary" data-op-new>New control</button>' : A.act('New control', 'control.apply', PR(A.state.project), { cls: 'primary' }) })}
      <div class="op-scope-note">${A.icon('lock', 13)}<span>${applyAny ? `You can apply and lift controls on <b>${E(myApply.join(', '))}</b>. ${A.can('control.apply', FLEET) ? '' : 'Fleet controls are factory admin only.'}` : `You can read the controls of your projects. Applying or lifting one on ${E(projName(A.state.project))} needs project.admin or factory.admin (${E(names(admins))}).`}</span>${applyAny ? '' : switchHint()}</div>
      ${A.stats([
        { k: 'Active controls', v: active.length, d: byKind || 'none' },
        { k: 'Items held by a control', v: held.length, d: held.length ? held.join(', ') : 'none in your projects', tone: held.length ? 'warn' : '' },
        { k: 'Releases halted', v: halts.length, d: halts.map((c) => c.ref).join(', ') || 'none', tone: halts.length ? 'bad' : '' },
        { k: 'Ledger pending', v: `<span data-op-pendn>${C.filter((c) => c.ledger === 'pending').length}</span>`, d: 'Notary up · backfilled when it returns', tone: C.some((c) => c.ledger === 'pending') ? 'warn' : '' },
        { k: 'Ops flags', v: FLAGS.length, d: '2 expire within 5 days' },
      ])}
      <div style="height:16px"></div>
      ${A.card('Controls', A.tabs('opctl', [
        { id: 'active', label: 'Active now', n: C.length, html: `<div data-op-ctltable>${A.table(ctlCols(true), C)}</div>` },
        { id: 'hist', label: 'Lifted and expired', n: H.length, html: H.length ? A.table(ctlCols(false), H) : A.empty('No lifted or expired controls in your projects.') },
      ]), { flush: true })}
      <div style="height:16px"></div>
      <div class="grid g2">
        ${A.card('Banners', `<div class="stack" style="gap:10px" data-op-banners>${BN.length ? A.j(BN, (b) => `<div>${bannerPreview(b.sev, b.text, b.expires)}<div class="row tiny faint" style="gap:10px;margin-top:5px"><span class="mono">${b.id}</span><span>${b.target} · ${E(b.scope)}</span><span>by ${E(nm(b.by))}</span><span class="sp" style="flex:1"></span>${A.act('Withdraw', 'banner.publish', bannerRes(b.scope), { cls: 'ghost sm', attrs: `data-op-bwd="${b.id}"` })}</div></div>`) : A.empty('No banner is showing in your projects.')}</div>
          <div class="hr" style="margin:16px 0"></div>
          ${bScopes.length ? `<h4 style="margin-bottom:10px">Publish a banner</h4>
          <div class="op-form">
            <div class="field"><label>Severity</label><div class="seg" data-op-bsev>${['info', 'warning', 'critical'].map((k, i) => `<button aria-pressed="${i === 1}" data-v="${k}">${k}</button>`).join('')}</div></div>
            <div class="field"><label for="op-btarget">Target</label><select class="input" id="op-btarget"><option>banner</option><option>channel</option><option>statuspage</option></select></div>
            <div class="field"><label for="op-bscope">Scope</label><select class="input" id="op-bscope">${A.j(bScopes, (sc) => `<option>${sc}</option>`)}</select><span class="help">Only scopes where you hold banner.publish.</span></div>
            <div class="field"><label for="op-bexp">Expires</label><select class="input" id="op-bexp"><option>Nov 10 18:00</option><option>Nov 11 09:00</option><option>Nov 14 04:00</option></select></div>
            <div class="field full"><label for="op-btext">Text (max 500)</label><textarea class="input" id="op-btext" maxlength="500" style="min-height:60px">The DeepSeek provider is stopped (kill k-0193). A10 shaping runs on Anthropic until it is released.</textarea></div>
          </div>
          <div class="lbl" style="margin:12px 0 6px">Preview</div><div class="op-banner-prev" data-op-bprev></div>` : `<div class="row between" style="gap:10px"><span class="small muted" style="flex:1;min-width:200px">Publishing a banner needs <span class="mono">banner.publish</span>: project admins for their project, factory admins for the fleet.</span>${A.act('Publish a banner', 'banner.publish', PR(A.state.project))}</div>`}`, { foot: bScopes.length ? '<button class="btn primary" data-op-bpub>Publish banner</button>' : '' })}
        ${A.card('Ops flags', A.table([
          { h: 'Flag', r: (f) => `<span class="mono small">${f.key}</span><div class="tiny muted" style="min-width:180px;max-width:280px">${E(f.note)}</div>` },
          { h: 'Value', r: (f) => A.pill(String(f.val), f.val ? 'ok' : 'mute') },
          { h: 'Owner', cls: 'op-nw', r: (f) => A.who(f.owner) },
          { h: 'Expires', cls: 'op-nw', r: (f) => `<span class="mono small" style="${f.warn ? 'color:var(--warn)' : ''}">${f.exp}</span>${f.warn ? '<div class="tiny" style="color:var(--warn)">renew or drop</div>' : ''}` },
        ], FLAGS), { flush: true, actions: A.act('Propose a flag change', 'config.propose', FLEET, { cls: 'sm', attrs: 'data-toast="Draft ops.flags revision created; an M1 card goes to another factory admin"' }) })}
      </div>`;
    },
    mount: (root) => {
      const txt = root.querySelector('#op-btext');
      const upd = () => { if (!txt) return; const sev = root.querySelector('[data-op-bsev] [aria-pressed="true"]').dataset.v; root.querySelector('[data-op-bprev]').innerHTML = bannerPreview(sev, txt.value, root.querySelector('#op-bexp').value); };
      upd();
      if (txt) { txt.addEventListener('input', upd); root.querySelector('#op-bexp').addEventListener('change', upd); }
      const redraw = (freshId) => {
        root.querySelector('[data-op-ctltable]').innerHTML = A.table(ctlCols(true), CONTROLS.filter(ctlVisible));
        if (freshId) {
          root.querySelector(`[data-op-ledger="${freshId}"]`)?.closest('tr')?.classList.add('op-row-new');
          setTimeout(() => { const c = CONTROLS.find((x) => x.id === freshId); if (!c) return; c.ledger = 'ledgered'; const cell = root.querySelector(`[data-op-ledger="${freshId}"]`); if (cell) cell.innerHTML = ledgerCell(c); const pn = root.querySelector('[data-op-pendn]'); if (pn) pn.textContent = CONTROLS.filter((x) => x.ledger === 'pending' && ctlVisible(x)).length; A.toast(`Ledgered: ops.action #${c.seq.toLocaleString()} (Notary signed)`); }, 1800);
          const pn = root.querySelector('[data-op-pendn]'); if (pn) pn.textContent = CONTROLS.filter((x) => x.ledger === 'pending' && ctlVisible(x)).length;
        }
      };
      root.addEventListener('click', (e) => {
        const sb = e.target.closest('[data-op-bsev] button'); if (sb) { root.querySelectorAll('[data-op-bsev] button').forEach((b) => b.setAttribute('aria-pressed', String(b === sb))); upd(); return; }
        if (e.target.closest('[data-op-new]')) { ctlState.step = 1; return ctlModal(redraw); }
        const wd = e.target.closest('[data-op-bwd]');
        if (wd) { const b = BANNERS.find((x) => x.id === wd.dataset.opBwd); if (b && A.can('banner.publish', bannerRes(b.scope))) { BANNERS.splice(BANNERS.indexOf(b), 1); A.render(); A.toast(`banner.withdrawn ${b.id}. Ledgered.`); } return; }
        if (e.target.closest('[data-op-bpub]')) {
          const scope = root.querySelector('#op-bscope').value;
          if (!A.can('banner.publish', bannerRes(scope))) return A.explainDrawer('banner.publish', bannerRes(scope));
          const sev = root.querySelector('[data-op-bsev] [aria-pressed="true"]').dataset.v, b = { id: 'bn-' + hx(Date.now(), 4), sev, target: root.querySelector('#op-btarget').value, scope, text: txt.value, expires: root.querySelector('#op-bexp').value, by: me() };
          BANNERS.unshift(b); A.render(); A.toast(`banner.published ${b.id} (${sev}) to ${b.scope}. Ledger pending → ledgered.`); return;
        }
        const lf = e.target.closest('[data-op-lift]');
        if (lf) {
          const c = CONTROLS.find((x) => x.id === lf.dataset.opLift), all = itemsIn(c.sk, c.ref), its = all.filter((i) => A.canSeeProject(i.project)), res = refRes(c.sk, c.ref);
          if (!A.can('control.lift', res)) return A.explainDrawer('control.lift', res);
          const m = A.modal(`<div class="row between"><h2>Lift ${c.kind}</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
            <p class="muted">${E(c.note)}</p>${A.kv([['Scope', `<span class="mono">${c.sk}:${E(c.ref)}</span>`], ['PDP', `<span class="mono">control.lift · ${E(resLabel(res))}</span> ${A.pill('allowed', 'ok')}`], ['Origin', originPill(c.origin)], ['Items released', its.length ? `<div class="op-chips">${A.j(its.slice(0, 18), (i) => A.chip(i, { full: true }))}</div>${all.length > its.length ? `<div class="tiny faint" style="margin-top:4px">+${all.length - its.length} in a confidential project</div>` : ''}` : 'none'], ['Preview nonce', `<span class="mono small">${hx('lift' + c.id, 24)}</span>`]])}
            ${c.origin === 'kill' ? '<div class="op-danger-box">This control mirrors an active kill. Lifting it does not release the kill: that needs two people on the Kill switch screen.</div>' : ''}
            ${stepUpLine()}
            <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-op-dolift>${A.icon('lock', 14)} ${A.stepUpValid() ? 'Lift' : 'Step up and lift'}</button></div>`);
          m.querySelector('[data-op-dolift]').onclick = () => withStepUp(`Lifting ${c.id} releases ${all.length} items. The proof is bound to this lift.`, () => { CONTROLS.splice(CONTROLS.indexOf(c), 1); CTL_HIST.unshift({ ...c, state: 'lifted', expires: `lifted just now by ${nm(me())}` }); A.closeOverlay(); A.render(); A.toast(`control.lift ${c.id}: ${all.length} items released. Ledgered.`); });
        }
      });
    },
  });

  /* ================================================================ 4. Kill switch */
  // project: the project a kill belongs to (null = a fleet resource: model, role, fleet)
  const KILLS = [
    { id: 'k-0193', scope: 'model', ref: 'deepseek/deepseek-v4', project: null, state: 'active', by: 'lt', at: 'today 10:43', reason: 'Provider returned another tenant\'s completion inside a tool_result (INC-2211). Stop every call until the vendor confirms isolation.', req: 2, appr: [] },
    { id: 'k-0192', scope: 'item', ref: 'payments/W-19', project: 'payments', state: 'release_pending', by: 'tripwire', at: 'Nov 8 08:53', reason: 'ET10: the coding session read ~/.aws/credentials. Requested automatically by the tripwire; quarantine until SECT triage is complete.', req: 2, appr: ['lt'] },
    { id: 'k-0191', scope: 'lane', ref: 'identity/L0', project: 'identity', state: 'active', by: 'ks', at: 'Nov 8 08:58', reason: 'No hotfix lane on Identity Hub while the signing key ceremony runs.', req: 2, appr: [] },
  ];
  const KILLS_DONE = [
    { id: 'k-0190', scope: 'session', ref: 'payments/ses-7f12', project: 'payments', state: 'released', by: 'ks', at: 'Nov 8 08:54', reason: 'Tainted session of W-19', req: 2, appr: ['rb', 'lt'], rel: 'today 10:20' },
    { id: 'k-0187', scope: 'project', ref: 'web', project: 'web', state: 'released', by: 'mw', at: 'Nov 4 15:02', reason: 'Wrong base branch configured; agents pushed to agent/* of the archived repo', req: 2, appr: ['lt', 'ks'], rel: 'Nov 4 16:40' },
  ];
  // [seq, event, subject, actor, at, signature, core ledger, project (null = fleet)]
  const JOURNAL = [
    [217, 'kill.requested', 'k-0193 · model deepseek/deepseek-v4', 'lt', '10:43:12', 'ks:es256:2026-10', null, null],
    [216, 'kill.released', 'k-0190 · session payments/ses-7f12', 'lt', '10:20:38', 'ks:es256:2026-10', 18419, 'payments'],
    [215, 'kill.release_approved', 'k-0190 (2 of 2)', 'lt', '10:20:37', 'ks:es256:2026-10', 'with #18,419', 'payments'],
    [214, 'kill.release_approved', 'k-0190 (1 of 2)', 'rb', 'Nov 9 18:05', 'ks:es256:2026-10', 18382, 'payments'],
    [213, 'kill.release_approved', 'k-0192 (1 of 2)', 'lt', 'Nov 9 17:40', 'ks:es256:2026-10', 18380, 'payments'],
    [212, 'kill.holders_synced', 'project payments · 2 holders', null, 'Nov 9 12:00', 'ks:es256:2026-10', 18341, 'payments'],
    [211, 'kill.signature_attested', 'names #209 (written while KMS was down)', null, 'Nov 8 09:12', 'ks:es256:2026-10', 18288, 'payments'],
    [210, 'kill.requested', 'k-0191 · lane identity/L0', 'ks', 'Nov 8 08:58', 'ks:es256:2026-10', 18270, 'identity'],
    [209, 'kill.requested', 'k-0190 · session payments/ses-7f12', 'ks', 'Nov 8 08:54', 'pending_signature', 18287, 'payments'],
    [208, 'kill.requested', 'k-0192 · item payments/W-19 (tripwire ET10)', null, 'Nov 8 08:53', 'ks:es256:2026-10', 18286, 'payments'],
  ];
  const killRes = (k) => (k.project ? PR(k.project) : FLEET);
  const killVisible = (k) => !k.project || A.canSeeProject(k.project);
  const sessStopProjects = () => A.visibleProjects().filter((p) => A.can('session.stop', PR(p.id))).map((p) => p.id);
  const killProjects = () => A.visibleProjects().filter((p) => A.can('kill.request', PR(p.id))).map((p) => p.id);
  /** page access: a kill or stop anywhere you can see, or the audit read (the auditor reads the journal) */
  const killAllowed = () => !!me() && (killProjects().length > 0 || sessStopProjects().length > 0 || A.can('kill.request', FLEET) || A.can('audit.read', FLEET) || A.visibleProjects().some((p) => A.can('audit.read', PR(p.id))));
  const killReadOnly = () => !killProjects().length && !sessStopProjects().length && !A.can('kill.request', FLEET);
  const SCOPES = [
    { s: 'session', what: 'One sandbox session: container killed, its key revoked, lease released, the item goes to handoff.', action: 'session.stop', fleet: false, refs: () => SESS.filter((x) => x.state === 'running' && sessStopProjects().includes(projOfSess(x))).map((x) => `${projOfSess(x)}/${x.id}`), projects: sessStopProjects },
    { s: 'item', what: 'Every session, key and admission of one work item. Gates stay open; nothing is approved.', action: 'kill.request', fleet: false, refs: () => D.ITEMS.filter((i) => live(i) && killProjects().includes(i.project)).map((i) => `${i.project}/${i.key}`), projects: killProjects },
    { s: 'lane', what: 'One lane of one project, for example no new L0 hotfixes: admissions, sessions and keys of that lane.', action: 'kill.request', fleet: false, refs: () => killProjects().flatMap((p) => (A.project(p).lanes || []).map((l) => `${p}/${l}`)), projects: killProjects },
    { s: 'project', what: 'All agent work in one project: sessions, gateway keys, pushes and new admissions.', action: 'kill.request', fleet: false, refs: () => killProjects(), projects: killProjects },
    { s: 'role', what: 'One agent role everywhere (e.g. coder or A5 review): its keys stop working at the gateway.', action: 'kill.request', fleet: true, refs: () => D.AGENTS.map((a) => `${a.id}`) },
    { s: 'model', what: 'One provider model at the gateway. Routes that need it fail closed (ET1 handoffs).', action: 'kill.request', fleet: true, refs: () => ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5', 'openai_compat/codex-2'] },
    { s: 'fleet', what: 'Everything stops. Every session, key, push and admission in every project.', action: 'kill.request', fleet: true, refs: () => ['fleet'], note: 'factory admin only (DEC-29)' },
  ];
  const scopeAllowed = (sc) => (sc.fleet ? A.can(sc.action, FLEET) : sc.projects().length > 0);
  const scopeWho = (sc) => (sc.fleet ? whoCan(sc.action, FLEET) : [...new Set(A.visibleProjects().flatMap((p) => whoCan(sc.action, PR(p.id))))]);
  const stopsFor = (scope, ref) => {
    const run = SESS.filter((x) => x.state === 'running');
    let ses = [], items = [], keys = 0;
    if (scope === 'fleet') { ses = run; items = D.ITEMS.filter(live); }
    else if (scope === 'project') { ses = run.filter((x) => projOfSess(x) === ref); items = D.ITEMS.filter((i) => live(i) && i.project === ref); }
    else if (scope === 'lane') { const [p, l] = ref.split('/'); items = D.ITEMS.filter((i) => live(i) && i.project === p && i.lane === l); ses = run.filter((x) => items.some((i) => i.key === x.item)); }
    else if (scope === 'session') { ses = run.filter((x) => ref.endsWith('/' + x.id)); items = ses.map((x) => A.item(x.item)).filter(Boolean); }
    else if (scope === 'item') { const k = ref.split('/')[1]; ses = run.filter((x) => x.item === k); items = [A.item(k)].filter(Boolean); }
    else if (scope === 'role') { ses = run.filter((x) => x.agent === ref); items = ses.map((x) => A.item(x.item)).filter(Boolean); }
    else if (scope === 'model') { const m = ref.split('/')[1]; const ags = D.AGENTS.filter((a) => a.model === m).map((a) => a.id); ses = run.filter((x) => ags.includes(x.agent)); items = ses.map((x) => A.item(x.item)).filter(Boolean); keys = ags.length; }
    keys = keys || ses.length;
    return { ses, items, keys };
  };
  const byLabel = (by) => (by === 'tripwire' ? 'the ET10 tripwire (automatic)' : nm(by));
  const killCard = (k) => {
    const cls = k.state === 'released' ? 'rel' : k.state === 'release_pending' ? 'pend' : '';
    const res = killRes(k), mine = k.by === me(), approved = k.appr.includes(me());
    const slots = Array.from({ length: k.req }, (_, i) => (k.appr[i] ? A.avatar(k.appr[i], 'sm') : `<span class="op-slot">${i + 1}</span>`)).join('');
    const eligible = whoCan('kill.release', res).filter((pid) => pid !== k.by && !k.appr.includes(pid));
    const short = k.state !== 'released' && eligible.length < k.req - k.appr.length;
    let act = '';
    if (k.state !== 'released') {
      if (killReadOnly()) act = '';
      else if (mine) act = '<button class="btn sm" disabled title="You requested this kill">Approve release</button><div class="tiny faint" style="margin-top:4px;max-width:220px">You requested this kill, so you cannot approve its release.</div>';
      else if (approved) act = '<button class="btn sm" disabled>You approved</button><div class="tiny faint" style="margin-top:4px;max-width:220px">A different second person must approve.</div>';
      else if (!A.can('kill.release', res)) act = A.act('Approve release', 'kill.release', res, { cls: 'sm' });
      else act = `<button class="btn sm good" data-op-approve="${k.id}">Approve release (${k.appr.length + 1} of ${k.req})</button>`;
    }
    return `<div class="op-kill-card ${cls}"><div style="min-width:0">
      <div class="row" style="gap:8px"><span class="mono" style="font-weight:600">${k.id}</span><span class="op-tag" style="margin:0">${k.scope}</span><span class="mono small">${E(k.ref)}</span>${A.pill(k.state.replace('_', ' '), k.state === 'released' ? 'ok' : k.state === 'release_pending' ? 'warn' : 'bad')}</div>
      <p class="small" style="margin-top:6px;color:var(--fg-2)">${E(k.reason)}</p>
      <div class="row tiny faint" style="gap:12px;margin-top:6px"><span>requested by ${E(byLabel(k.by))} · ${k.at}</span>${k.rel ? `<span>released ${k.rel} by ${E(names(k.appr))}</span>` : k.state === 'release_pending' ? '<span style="color:var(--warn)">still killing: only “released” stops a kill</span>' : ''}</div>
      ${k.state !== 'released' ? `<div class="tiny ${short ? '' : 'faint'}" style="margin-top:6px;${short ? 'color:var(--warn)' : ''}">Release needs <span class="mono">kill.release</span> on ${E(resLabel(res))} from two different people, never the requester. ${short ? `Only ${eligible.length} eligible (${E(names(eligible))}): ${k.project ? 'the project admin can delegate a kill holder' : 'a second factory.admin binding is needed (M6)'} before this can be released.` : `Eligible: ${E(names(eligible))}.`}</div>` : ''}</div>
      <div style="text-align:right"><div class="op-approvals" style="justify-content:flex-end;margin-bottom:8px"><span class="tiny faint">release</span>${slots}</div>${act}</div></div>`;
  };
  const killModal = (scopeId, rerender) => {
    const sc = SCOPES.find((x) => x.s === scopeId), refs = sc.refs();
    if (!refs.length) { A.toast(`Nothing you can ${sc.s === 'session' ? 'stop' : 'kill'} at scope ${sc.s} right now.`); return; }
    const st = { ref: refs[0], reason: '', step: 1 };
    const resOf = (ref) => (sc.fleet ? FLEET : PR(ref.split('/')[0]));
    const draw = () => {
      const st2 = stopsFor(sc.s, st.ref);
      const vis = st2.items.filter((i) => A.canSeeProject(i.project)), unseen = st2.items.length - vis.length;
      const res = resOf(st.ref);
      const releasers = whoCan('kill.release', res).filter((pid) => pid !== me());
      const flow = `<div class="op-flow danger">${['1 Scope and reason', '2 What stops', '3 Confirm'].map((t, i) => `<span class="${i + 1 === st.step ? 'on' : i + 1 < st.step ? 'done' : ''}">${t}</span>`).join('')}</div>`;
      let body = '';
      if (st.step === 1) body = `<div class="op-form"><div class="field"><label>Scope</label><input class="input mono" value="${sc.s}" disabled></div><div class="field"><label for="op-kref">Ref</label><select class="input" id="op-kref">${refs.map((r) => `<option ${r === st.ref ? 'selected' : ''}>${r}</option>`).join('')}</select><span class="help">Only refs where you hold <span class="mono">${sc.action}</span>.</span></div>
        <div class="field full"><label for="op-kwhy">Reason (signed into the journal)</label><textarea class="input" id="op-kwhy" style="min-height:70px" placeholder="What you saw and why it must stop now">${E(st.reason)}</textarea></div></div>
        <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn danger" data-op-knext>Show what stops →</button></div>`;
      else if (st.step === 2) body = `<div class="op-radius"><div><b style="color:#ff9d96">${st2.ses.length}</b><span>sessions killed</span></div><div><b style="color:#ff9d96">${st2.keys}</b><span>keys revoked</span></div><div><b>${st2.items.length}</b><span>items stopped</span></div><div><b>0</b><span>gates approved</span></div></div>
        ${st2.ses.length ? `<div>${A.j(st2.ses.filter((x) => A.canSeeProject(projOfSess(x))), (x) => `<span class="op-tag">${x.id} · ${x.cls} · ${x.item || '—'}</span>`)}</div>` : ''}
        ${vis.length ? `<div class="op-chips">${A.j(vis.slice(0, 40), (i) => A.chip(i, { full: true }))}${vis.length > 40 ? `<span class="small muted">+${vis.length - 40} more</span>` : ''}</div>` : '<p class="small muted">Nothing is running in this scope right now; the kill still blocks new work.</p>'}
        ${unseen ? collapsed(`+${unseen} items in a confidential project are stopped too; you do not see their keys.`) : ''}
        <ul class="small muted" style="margin:0;padding-left:18px"><li>Applies at once, at the gateway, core-worker admission, the Push Broker and the sandbox driver.</li><li>Signed by the kill switch's own key. If key custody is down, it is recorded unsigned and enforced anyway; a signed attestation follows.</li><li>Release needs two different people holding <span class="mono">kill.release</span> on ${E(resLabel(res))}, never you: ${E(names(releasers))}.${releasers.length < 2 ? ' <b style="color:var(--warn)">Fewer than two can release it today.</b>' : ''}</li></ul>
        <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-op-kback>← Back</button><button class="btn danger" data-op-knext>I understand →</button></div>`;
      else body = `${sc.s === 'fleet' ? '<div class="op-danger-box"><b>Every project stops.</b> All open gates stay open and no approval can be recorded until two different factory admins release it.</div>' : ''}
        <div class="field"><label for="op-kconf">Type <span class="mono" style="color:#ff9d96">${E(st.ref)}</span> to confirm</label><input class="input op-confirm-input" id="op-kconf" autocomplete="off" spellcheck="false"></div>
        <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-op-kback>← Back</button><button class="btn" style="background:var(--quar);border-color:var(--quar);color:#fff" data-op-kgo disabled>${A.icon('kill', 14)} Kill ${sc.s} now</button></div>`;
      const m = A.modal(`<div class="row between"><h2 style="color:#ff9d96">Kill ${sc.s}</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>${flow}<p class="small muted">${E(sc.what)}</p>${body}`);
      const read = () => { if (st.step === 1) { st.ref = m.querySelector('#op-kref').value; st.reason = m.querySelector('#op-kwhy').value; } };
      m.addEventListener('click', (e) => {
        if (e.target.closest('[data-op-knext]')) { read(); if (st.step === 1 && st.reason.trim().length < 6) { m.querySelector('#op-kwhy').style.borderColor = 'var(--quar)'; m.querySelector('#op-kwhy').placeholder = 'A reason is required'; return; } st.step++; draw(); }
        if (e.target.closest('[data-op-kback]')) { st.step--; draw(); }
        const go = e.target.closest('[data-op-kgo]');
        if (go && !go.disabled) {
          if (!A.can(sc.action, res)) { A.closeOverlay(); A.explainDrawer(sc.action, res); return; }
          const id = 'k-0' + (194 + KILLS.length + KILLS_DONE.length);
          const pj = sc.fleet ? null : st.ref.split('/')[0];
          KILLS.unshift({ id, scope: sc.s, ref: st.ref, project: pj, state: 'active', by: me(), at: 'just now', reason: st.reason.trim(), req: 2, appr: [] });
          const seq = JOURNAL[0][0] + 1; JOURNAL.unshift([seq, 'kill.requested', `${id} · ${sc.s} ${st.ref}`, me(), nowClock(), 'signing…', null, pj]);
          st2.ses.forEach((x) => { x.state = 'killed'; x.cpu = 0; x.mem = 0; });
          if (sc.s === 'fleet' || (sc.s === 'project' && st.ref === A.state.project)) A.state.killed = true;
          A.closeOverlay(); rerender(); A.toast(`Kill ${id} applied: ${st2.ses.length} sessions stopped, ${st2.keys} keys revoked.`);
          setTimeout(() => { const j = JOURNAL.find((r) => r[0] === seq); if (j) { j[5] = 'ks:es256:2026-10'; j[6] = nextSeq(); } if (location.hash === '#kill') rerender(); A.toast(`Journal #${seq} signed; core observed it and wrote a kill.event ledger entry.`); }, 1600);
        }
      });
      if (st.step === 3) { const inp = m.querySelector('#op-kconf'); inp.focus(); inp.addEventListener('input', () => { m.querySelector('[data-op-kgo]').disabled = inp.value.trim() !== st.ref; }); }
    };
    draw();
  };

  view('kill', {
    label: 'Kill switch', group: 'Operate', icon: 'kill',
    navAccess: () => killAllowed(),
    access: () => (killAllowed() ? null : { action: 'kill.request', res: PR(A.state.project) }),
    deniedTitle: 'You can’t open the kill switch',
    badge: () => ({ n: KILLS.filter((k) => k.state !== 'released' && killVisible(k)).length, hot: true }),
    render: () => {
      const act = KILLS.filter((k) => k.state !== 'released' && killVisible(k)), done = KILLS_DONE.filter(killVisible);
      const ro = killReadOnly(), fleetKill = act.find((k) => k.scope === 'fleet');
      const jr = JOURNAL.filter((j) => !j[7] || A.canSeeProject(j[7]));
      const holders = [];
      A.visibleProjects().filter((p) => p.level !== 'Onboarding').forEach((p) => {
        whoCan('kill.request', PR(p.id)).forEach((pid) => holders.push([pid, p.name, A.bindingsOf(pid).some((b) => b.role === 'factory.admin') ? 'factory admin' : A.bindingsOf(pid).some((b) => b.role === 'project.kill_holder' && b.scope.ref === p.id) ? 'kill holder' : 'project admin', 'kill']));
        whoCan('session.stop', PR(p.id)).filter((pid) => !A.can('kill.request', PR(p.id), pid)).forEach((pid) => holders.push([pid, p.name, 'security approver', 'session stop only']));
      });
      const hmap = {}; holders.forEach((h) => { const k = h[0] + h[2] + h[3]; (hmap[k] = hmap[k] || { pid: h[0], what: h[2], power: h[3], where: [] }).where.push(h[1]); });
      const myPow = [killProjects().length ? `kill items, lanes and projects in ${killProjects().map(projName).join(', ')}` : '', sessStopProjects().length ? `stop sessions in ${sessStopProjects().map(projName).join(', ')}` : '', A.can('kill.request', FLEET) ? 'kill roles, models and the fleet' : ''].filter(Boolean);
      return `${A.pageHead({ eyebrow: 'Operate · AR9 · services/killswitch', title: 'Kill switch', sub: 'Stop agent work now, at any scope from one session to the whole fleet. The kill switch is its own service with its own database and key; core only reads it. If it cannot be reached, every enforcement point treats that as a kill.' })}
      ${ro ? `<div class="banner info">${A.icon('lock', 15)} <b>Read-only: ${A.can('audit.read', FLEET) ? 'factory.auditor' : 'audit read'}.</b> You see every kill, the journal and its signatures. You cannot request, stop or release anything.</div>` : `<div class="op-scope-note">${A.icon('kill', 13)}<span>You can ${E(myPow.join('; '))}. Scopes you do not hold stay locked and say who does.</span>${A.can('kill.request', FLEET) ? '' : switchHint()}</div>`}
      <div class="op-kill-hero">
        <div><div class="op-kill-state"><div class="op-kill-orb ${fleetKill ? '' : 'calm'}">${A.icon('kill', 28)}</div><div><div class="eyebrow">Fleet</div><h2>${fleetKill ? `Fleet kill ${fleetKill.id} active` : 'No fleet kill'}</h2><p class="small muted">${fleetKill ? 'All agent work is stopped in every project.' : 'Agent work runs where no narrower kill covers it.'}</p></div></div>
          <div class="row" style="gap:28px;margin-top:18px"><div><div class="op-big">${act.length}</div><div class="small muted">active kills you can see</div></div><div><div class="op-big" style="color:var(--warn)">${act.filter((k) => k.state === 'release_pending').length}</div><div class="small muted">release pending (still killing)</div></div><div><div class="op-big" style="color:var(--fg)">${visSess().filter((s) => s.state === 'killed').length}</div><div class="small muted">sessions killed 48h</div></div></div></div>
        <div>${A.kv([['Service', `${A.health('ok')} <span class="mono small">killswitch</span> · reachable, read 3 s ago`], ['Store', '<span class="mono small">killswitch</span> database (not core)'], ['Signing key', '<span class="mono small">ks:es256:2026-10</span> · KMS ok'], ['Journal head', `#${JOURNAL[0][0]} ${A.hash(hx('ks' + JOURNAL[0][0]))}`], ['Enforced at', 'gateway (every call) · core-worker admitAgentWork · Push Broker · sandbox driver'], ['Fail closed', '<span style="color:#ff9d96">unreachable for &gt; 5 s = kill</span>']])}</div>
      </div>
      <div style="height:20px"></div>
      <div class="row between" style="margin-bottom:10px"><h3>Kill by scope</h3><span class="small faint">${ro ? 'who may kill at each scope' : 'pick a scope; you will see what stops before anything happens'}</span></div>
      <div class="op-scopes">${A.j(SCOPES, (sc) => { const ok = scopeAllowed(sc), res = sc.fleet ? FLEET : PR(A.state.project); return `<div class="op-scope ${sc.s === 'fleet' ? 'fleet' : ''} ${ok ? '' : 'off'}"><h4>${sc.s}</h4><p>${E(sc.what)}</p><div class="who"><span class="mono">${sc.action}</span> · ${sc.fleet ? 'Fleet' : 'Project'}${sc.note ? ` · ${sc.note}` : ''}<br>${E(names(scopeWho(sc)))}</div>${ro ? '' : ok ? `<button class="btn danger sm" data-op-kill="${sc.s}">${A.icon('kill', 13)} ${sc.s === 'session' ? 'Stop' : 'Kill'} ${sc.s}…</button>` : A.act(`Kill ${sc.s}`, sc.action, res, { cls: 'sm' })}</div>`; })}</div>
      <div style="height:20px"></div>
      <div class="split">
        <div class="stack">
          ${A.card('Active kills', `<div class="stack" style="gap:10px">${act.length ? A.j(act, killCard) : A.empty('No active kills in what you can see.')}</div><p class="tiny faint" style="margin-top:10px">KillReleaseApproval: a release needs two different people with kill.release on the kill's scope, and the person who requested the kill cannot be one of them.</p>`, { actions: `<span class="pill bad">${act.length} active</span>` })}
          ${A.card('Kill journal', A.table([
            { h: '#', r: (j) => `<span class="mono small">${j[0]}</span>` },
            { h: 'Event', r: (j) => `<span class="mono small" style="color:${j[1] === 'kill.requested' ? '#ff9d96' : j[1] === 'kill.released' ? 'var(--ok)' : 'var(--fg-2)'}">${j[1]}</span><div class="tiny muted" style="min-width:200px">${E(j[2])}</div>` },
            { h: 'Actor', r: (j) => (j[3] ? A.avatar(j[3], 'sm') : '<span class="mono tiny faint">system</span>') },
            { h: 'At', cls: 'op-nw', r: (j) => `<span class="mono small">${j[4]}</span>` },
            { h: 'prev → entry', r: (j) => `<span class="row" style="gap:4px;flex-wrap:nowrap">${A.hash(hx('ks' + (j[0] - 1)), 6)}<span class="faint">→</span>${A.hash(hx('ks' + j[0]), 6)}</span>` },
            { h: 'Signature', r: (j) => (j[5] === 'pending_signature' ? A.pill('pending_signature', 'warn') : j[5] === 'signing…' ? A.pill('signing…', 'warn') : `<span class="mono tiny">${j[5]}</span>`) },
            { h: 'Core ledger', r: (j) => (j[6] ? `<span class="op-ledger ledgered">${typeof j[6] === 'string' ? j[6] : '✓ #' + j[6].toLocaleString()}</span>` : '<span class="op-ledger pending">◌ observing</span>') },
          ], jr), { flush: true, actions: `<span class="small faint">${jr.length < JOURNAL.length ? 'rows of your projects · ' : ''}ES256, hash-chained</span>` })}
        </div>
        <div class="stack">
          ${A.card('Who can kill or stop', `<div class="list" style="margin:-14px -16px">${A.j(Object.values(hmap), (h) => `<div class="li" style="cursor:default">${A.avatar(h.pid)}<div><div class="ti small">${E(nm(h.pid))}${h.pid === me() ? ' <span class="tiny faint">(you)</span>' : ''}</div><div class="me tiny">${E(h.what)} · ${E(h.power)}</div></div><span class="tiny faint" style="text-align:right;max-width:140px">${E(h.where.join(', '))}</span></div>`)}</div>`, { actions: '<span class="tiny faint">from role bindings · synced 08:00</span>' })}
          ${A.card('Released recently', done.length ? `<div class="stack op-kill-narrow" style="gap:10px">${A.j(done, killCard)}</div>` : A.empty('Nothing released recently in your projects.'))}
          ${A.card('Enforcement points', A.j([['gateway', 'every /v1/messages call', '1.2 s'], ['core-worker', 'admitAgentWork before 6.0', '4 s'], ['codehost (Push Broker)', 'preflightPush', '9 s'], ['sandbox-driver', 'before create and every 5 s', '2 s']], (p) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span class="small"><span class="mono">${p[0]}</span><div class="tiny faint">${p[1]}</div></span><span class="row" style="gap:6px">${A.health('ok')}<span class="mono tiny faint">${p[2]}</span></span></div>`))}
        </div>
      </div>`;
    },
    mount: (root) => {
      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-op-kill]'); if (b) return killModal(b.dataset.opKill, () => A.render());
        const ap = e.target.closest('[data-op-approve]');
        if (ap) {
          const k = KILLS.find((x) => x.id === ap.dataset.opApprove), res = killRes(k);
          if (!A.can('kill.release', res) || k.by === me() || k.appr.includes(me())) return A.explainDrawer('kill.release', res);
          k.appr.push(me());
          const seq = JOURNAL[0][0] + 1; JOURNAL.unshift([seq, 'kill.release_approved', `${k.id} (${k.appr.length} of ${k.req})`, me(), nowClock(), 'ks:es256:2026-10', nextSeq(), k.project]);
          if (k.appr.length >= k.req) { k.state = 'released'; k.rel = 'just now'; KILLS.splice(KILLS.indexOf(k), 1); KILLS_DONE.unshift(k); JOURNAL.unshift([seq + 1, 'kill.released', `${k.id} · ${k.scope} ${k.ref}`, me(), nowClock(), 'ks:es256:2026-10', nextSeq(), k.project]); if (!KILLS.some((x) => x.scope === 'fleet' || (x.scope === 'project' && x.ref === A.state.project))) A.state.killed = false; A.toast(`${k.id} released (2 of 2). Work in ${k.ref} may be re-admitted.`); }
          else { k.state = 'release_pending'; A.toast(`Release approval recorded for ${k.id} (${k.appr.length} of ${k.req}). The kill still applies.`); }
          A.render();
        }
      });
    },
  });

  /* ================================================================ 5. Health */
  const T = (name, domain, state, sli, label, asof, note, base, amp) => ({ name, domain, state, sli, label, asof, note, base, amp });
  const TILES = [
    T('core', 'service', 'ok', '84 ms', 'p95 API', 6, '', 80, 30), T('core-worker', 'service', 'ok', '8/8', 'loops up', 4, '/healthz 200', 8, 0.4),
    T('notary', 'service', 'ok', '12 ms', 'p95 sign', 9, '', 12, 5), T('witness', 'service', 'ok', '1h 33m', 'since co-sign', 11, 'next at 11:12', 50, 30),
    T('kms-local', 'service', 'ok', '3 ms', 'p95 sign', 7, '', 3, 1), T('killswitch', 'service', 'ok', '4 ms', 'p95 read', 3, 'own DB, own key', 4, 2),
    T('gateway', 'service', 'ok', '0.21%', 'error rate', 5, '1 model killed', 0.3, 0.2), T('identity', 'service', 'ok', '41 ms', 'p95 token', 14, '', 40, 12),
    T('bff', 'service', 'ok', '62 ms', 'p95', 8, '', 60, 20), T('codehost', 'service', 'ok', '4,812', 'GitHub rate left', 12, 'of 5,000/h', 4800, 150),
    T('knowledge', 'service', 'degraded', '2', 'commits index lag', 21, 'web-checkout census running', 1, 1.5), T('web', 'service', 'ok', '100%', 'static served', 30, '', 100, 0.2),
    T('docker-proxy-cvw', 'sandbox', 'ok', '0', 'refusals 24h', 6, 'narrow: no networks', 0, 0.3), T('docker-proxy-coding', 'sandbox', 'ok', '3', 'refusals 24h', 6, 'session networks', 1, 1),
    T('package-mirror', 'sandbox', 'ok', '97%', 'cache hit', 18, 'read-only', 95, 3), T('sandbox-driver', 'sandbox', 'ok', '5', 'sandboxes up', 2, 'of 6 max', 4, 1.5),
    T('poll', 'loop', 'ok', '9 s', 'since last poll', 9, 'code host', 10, 4), T('relay', 'loop', 'ok', '0.4 s', 'outbox lag', 2, '', 0.5, 0.3),
    T('lifecycle', 'loop', 'ok', '1.1 s', 'command lag', 3, '', 1, 0.6), T('reconciler', 'loop', 'ok', '0', 'mismatches', 41, 'entries == events', 0, 0.01),
    T('checkpointer', 'loop', 'ok', '6', 'entries open', 25, 'cp 312 at 18,500', 40, 30), T('gate-lifecycle', 'loop', 'ok', '2', 'SLA near', 15, 'B21 at 75%', 2, 1),
    T('access-sync', 'loop', 'ok', '18 s', 'lag', 4, 'alert above 120 s', 20, 12), T('gateway_triggers', 'loop', 'ok', '1', 'ET1 today', 33, 'W-18 → D1', 0.5, 0.6),
    T('GitHub App', 'integration', 'ok', '4', 'installed repos', 19, 'acme-aisdlc, read + push', 4, 0.1), T('anthropic', 'integration', 'ok', '2.1 s', 'p95 first token', 7, '3 models routed', 2, 0.6),
    T('openai_compat', 'integration', 'degraded', '7.9 s', 'p95 first token', 10, 'codex-2 slow since 09:40', 5, 3), T('deepseek', 'integration', 'unknown', '—', 'no report', 184, 'killed: k-0193', 3, 1),
  ];
  const tileState = (t) => (t.asof > 120 ? 'unknown' : t.state);
  const tileHtml = (t) => { const st = tileState(t); const col = { ok: 'var(--ok)', degraded: 'var(--warn)', down: 'var(--bad)', unknown: 'var(--faint)' }[st]; return `<div class="op-tile ${st}"><div class="row between" style="flex-wrap:nowrap"><span class="nm">${E(t.name)}</span>${A.health(st)}</div>
    <div class="sli"><b>${t.sli}</b><span>${E(t.label)}</span></div>${A.spark(series(t.name, 24, t.base, t.amp), { w: 180, h: 26, color: col })}
    <div class="row between" style="flex-wrap:nowrap"><span class="note">${E(tileNote(t))}</span><span class="asof" data-op-asof="${E(t.name)}">${t.asof < 60 ? t.asof + ' s ago' : Math.floor(t.asof / 60) + 'm ' + (t.asof % 60) + 's ago'}</span></div></div>`; };
  const ACCESS = [14, 16, 15, 22, 19, 18, 17, 24, 31, 46, 38, 22, 19, 18, 21, 17, 16, 18, 19, 22, 20, 18, 17, 18];

  /** a tile note that names a project only for people who can see it */
  const PNOTE = { knowledge: ['web', 'web-checkout census running', 'a census is running'], gateway_triggers: ['payments', 'W-18 → D1', '1 item handed off'] };
  const tileNote = (t) => { const n = PNOTE[t.name]; return n ? (A.canSeeProject(n[0]) ? n[1] : n[2]) : t.note; };
  view('health', {
    label: 'Health', group: 'Operate', icon: 'health',
    access: () => ({ action: 'ops.read', res: PR(A.state.project) }),
    deniedTitle: 'You can’t open health',
    badge: () => { const n = TILES.filter((t) => tileState(t) !== 'ok').length; return n ? { n } : null; },
    render: () => {
      const cnt = (s) => TILES.filter((t) => tileState(t) === s).length;
      const grp = (d, title) => A.card(title, `<div class="op-tiles" data-op-grp="${d}">${A.j(TILES.filter((t) => t.domain === d), tileHtml)}</div>`, { actions: `<span class="small faint">${TILES.filter((t) => t.domain === d).length} tiles</span>` });
      const W = 520, H = 120, max = 140, y = (v) => H - 14 - (v / max) * (H - 24), bw = W / ACCESS.length;
      return `${A.pageHead({ eyebrow: 'Operate · HealthTile · HealthSnapshot (30 s)', title: 'Health', sub: 'Every service, loop and integration reports a snapshot every 30 seconds. A snapshot older than two minutes reads unknown: silence is never treated as healthy.', actions: '<button class="btn" data-toast="Snapshots refreshed from 29 reporters">Refresh</button>' })}
      <div class="op-scope-note">${A.icon('lock', 13)}<span>Health shows the factory's own machinery, never item content, so everyone with ops.read sees the same tiles. Notes that name a project only name the ones you can see.</span></div>
      <div class="banner ${cnt('down') ? 'bad' : 'warn'}"><b>${cnt('ok')} ok · ${cnt('degraded')} degraded · ${cnt('down')} down · ${cnt('unknown')} unknown.</b> openai_compat is slow (A5 review runs take longer); the knowledge index is 2 commits behind${A.canSeeProject('web') ? ' on web-checkout' : ' on one project'}; deepseek is silent because it is killed (k-0193).<span class="sp"></span>${killAllowed() ? '<a href="#kill" style="color:inherit;text-decoration:underline">Kill switch</a>' : ''}</div>
      <div class="grid g3">
        ${A.card('Ledger reconciler', `<div class="row" style="gap:16px;align-items:flex-end"><div><div class="op-big-n num">18,422</div><div class="tiny muted">ledger entries</div></div><div class="op-big-n" style="color:var(--ok)">=</div><div><div class="op-big-n num">18,422</div><div class="tiny muted">record events with an entry</div></div></div><div class="hr" style="margin:12px 0"></div>${A.kv([['Mismatches', A.pill('0', 'ok')], ['Last run', '41 s ago · every 60 s'], ['Backfilled', '0 pending (Notary up)']])}`)}
        ${A.card('Checkpoint and witness', `${A.kv([['Last checkpoint', '<span class="mono">311</span> · entries 18,000–18,416'], ['Root', A.hash(hx('cp311'), 16)], ['Witness co-sign', `${A.pill('co-signed', 'ok')} 09:12:44`], ['Open entries', '6 (18,417–18,422)'], ['Next', 'at 18,500 or 11:12, whichever first']])}<div class="row" style="margin-top:12px">${A.act('Open ledger', 'audit.read', PR(A.state.project), { cls: 'sm', href: '#ledger' })}<button class="btn sm" data-toast="verify-ledger: 18,422 entries, 311 checkpoints, chain and signatures OK">Verify now</button></div>`)}
        ${A.card('access-sync lag', `<div class="row between"><div><div class="op-big-n">18 s</div><div class="tiny muted">identity → PDP entities · alert above 120 s</div></div>${A.health('ok')}</div>
          <svg class="op-chart" viewBox="0 0 ${W} ${H}" style="margin-top:8px" role="img" aria-label="access-sync lag, last 12 hours">
            <line x1="0" x2="${W}" y1="${y(120)}" y2="${y(120)}" stroke="var(--bad)" stroke-dasharray="4 4"/><text x="${W - 2}" y="${y(120) - 4}" text-anchor="end" font-size="15" fill="var(--bad)" font-family="var(--mono)">alert 120 s</text>
            ${ACCESS.map((v, i) => `<rect x="${(i * bw + 1).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(H - 14 - y(v)).toFixed(1)}" rx="1.5" fill="var(--hand)" opacity=".75"><title>${v} s</title></rect>`).join('')}
            <text x="0" y="${H - 2}" font-size="14" fill="var(--faint)" font-family="var(--mono)">22:45</text><text x="${W}" y="${H - 2}" text-anchor="end" font-size="14" fill="var(--faint)" font-family="var(--mono)">now</text></svg>
          <p class="tiny faint">Peak 46 s at 03:15 (directory batch from the IdP). core-worker /healthz returns 503 while an access-sync alert is active.</p>`)}
      </div>
      <div style="height:16px"></div>
      <div class="stack">${grp('service', 'Services')}${grp('loop', 'core-worker loops')}${grp('sandbox', 'Sandbox plane')}${grp('integration', 'Integrations (registry)')}</div>`;
    },
    mount: (root) => {
      every(1000, () => TILES.forEach((t) => {
        t.asof = t.name === 'deepseek' ? t.asof + 1 : (t.asof + 1) % 31;
        const el = root.querySelector(`[data-op-asof="${CSS.escape(t.name)}"]`); if (el) el.textContent = t.asof < 60 ? t.asof + ' s ago' : Math.floor(t.asof / 60) + 'm ' + (t.asof % 60) + 's ago';
      }));
    },
    unmount: clearTimers,
  });

  /* ================================================================ 6. Notifications (Govern) */
  const TRIGGERS = [
    ['gate', 'A gate is waiting on me', 'G0 to G6, X1 to X4, E1 to E6, M1 to M6'],
    ['sla', 'An SLA is near', 'B21: at 75% of the 1-business-day gate SLA, and again at breach'],
    ['mention', 'I am mentioned', 'in an item thread or a card comment'],
    ['handoff', 'Work is handed to me', 'D1 to D5 handoff, E4 owner choice'],
    ['kill', 'A kill touches my projects', 'kill.requested and kill.released where I hold a role'],
    ['digest', 'Morning digest', 'one message at 08:30 with everything waiting'],
  ];
  const PREF_DEFAULT = { gate: [true, true, false], sla: [true, true, true], mention: [true, false, false], handoff: [true, true, false], kill: [true, true, true], digest: [false, false, true] };
  const PREFS_BY = {};
  const prefsOf = (pid) => (PREFS_BY[pid] = PREFS_BY[pid] || JSON.parse(JSON.stringify(PREF_DEFAULT)));
  const ROUTING = [
    ['ar', '@alex.rivera', 'alex.rivera@acme.example', 'gate, SLA, kill', '19:00–08:00', 'Slack, email'],
    ['pm', '@priya', 'priya.menon@acme.example', 'gate, handoff, digest', '20:00–08:00', 'Slack'],
    ['jm', '@jonas.m', 'jonas.meyer@acme.example', 'gate (X1 only), SLA', 'none', 'Slack, email'],
    ['ks', '@keiko', 'keiko.sato@acme.example', 'SECT, kill, mention', 'never quiet for kill', 'Slack, email'],
    ['lt', '@luis', 'luis.torres@acme.example', 'kill, health down, M1', 'none', 'Slack'],
    ['rb', '@rana', 'rana.begum@acme.example', 'access requests, B21 backup, kill', '19:00–08:00', 'Slack, email'],
    ['dn', '@daniel.n', 'daniel.novak@acme.example', 'S1 questions, G6, mention', '18:00–08:00', 'Slack'],
    ['nf', '—', 'nora.field@acme.example', 'weekly audit digest', 'none', 'email'],
    ['tb', '—', 'tom.becker@acme.example', 'weekly digest', '18:00–09:00', 'email'],
    ['ak', '—', 'amara.kone@acme.example', 'G6, mention', '18:00–09:00', 'email'],
  ];
  const DELIV = [
    ['nd-91a4', '10:41:09', 'slack', 'ar', 'G3 · W-23 decided (FYI to requester)', 'gate', 'suppressed', 'you decided it yourself'],
    ['nd-91a3', '10:43:14', 'slack', 'ks', 'kill k-0193 requested', 'kill', 'delivered', ''],
    ['nd-91a2', '10:43:14', 'email', 'rb', 'kill k-0193 requested', 'kill', 'delivered', ''],
    ['nd-91a1', '10:22:15', 'slack', 'dn', 'X1 · W-31 approved, Unit re-admitted', 'mention', 'delivered', ''],
    ['nd-91a0', '10:14:02', 'slack', 'rb', 'Access request: Tom Becker asks for project.requester', 'gate', 'delivered', ''],
    ['nd-919f', '10:12:40', 'slack', 'mw', 'X3 · C-47 waiting on you', 'gate', 'delivered', ''],
    ['nd-919e', '09:58:03', 'email', 'lt', 'M1 · gateway.routes r14 published', 'gate', 'failed', 'SMTP 451 greylisted; 3 retries failed. The M1 card is in the portal inbox'],
    ['nd-919d', '09:44:51', 'slack', 'jm', 'X1 · W-29 waiting on you (day 1)', 'gate', 'delivered', ''],
    ['nd-919c', '09:40:12', 'slack', 'ar', 'SLA near: G4 · W-24 at 75% of 1 bd', 'sla', 'delivered', ''],
    ['nd-919b', '09:12:50', 'slack', 'pm', 'E4 · W-18 handed to you (ET1)', 'handoff', 'delivered', ''],
    ['nd-919a', '08:55:20', 'email', 'ks', 'SECT · W-19 still pending (day 2)', 'sla', 'failed', 'mailbox full (552); portal inbox still has it'],
    ['nd-9199', '08:30:00', 'email', 'pm', 'Morning digest: 4 waiting', 'digest', 'delivered', ''],
    ['nd-9198', '07:10:31', 'slack', 'ar', 'G0+G1 · W-33 waiting on you', 'gate', 'suppressed', 'quiet hours until 08:00; sent at 08:00 as nd-9199b'],
    ['nd-9197', '06:12:05', 'slack', 'mw', 'R3 clamp on web-checkout', 'mention', 'delivered', ''],
    ['nd-9196', '02:14:44', 'teams', 'ar', 'G4 · W-24 waiting on you', 'gate', 'suppressed', 'Teams adapter deferred (on hold)'],
    ['nd-9195', 'Mon 08:00', 'email', 'tb', 'Weekly digest: Payments API (positions only)', 'digest', 'delivered', ''],
    ['nd-9194', 'Mon 08:00', 'email', 'nf', 'Weekly audit digest: 96 decisions, 0 integrity findings', 'digest', 'delivered', ''],
    ['nd-9193', 'Sun 22:10', 'slack', 'dn', 'S1 · W-36 has 3 questions for you', 'gate', 'failed', 'Slack user not found (renamed handle); portal inbox has it'],
  ];
  const statPill = (s) => A.pill(s, { delivered: 'ok', failed: 'bad', suppressed: 'mute' }[s]);
  const fullLog = () => A.can('identity.admin', FLEET) || A.can('audit.read', FLEET);
  const delivCols = (full) => [
    { h: 'Delivery', r: (d) => `<span class="mono small">${d[0]}</span>` },
    { h: 'At', cls: 'op-nw', r: (d) => `<span class="mono small">${d[1]}</span>` },
    { h: 'Channel', r: (d) => `<span class="op-tag" style="margin:0">${d[2]}</span>` },
    ...(full ? [{ h: 'To', cls: 'op-nw', r: (d) => A.who(d[3]) }] : []),
    { h: 'Card', r: (d) => `<span class="small">${E(d[4])}</span>` },
    { h: 'Trigger', r: (d) => `<span class="mono tiny">${d[5]}</span>` },
    { h: 'Status', r: (d) => `<span data-op-dstat="${d[6]}">${statPill(d[6])}</span>${d[7] ? `<div class="tiny faint" style="max-width:260px;min-width:160px;margin-top:3px">${E(d[7])}</div>` : ''}` },
    { h: '', r: (d) => (d[6] !== 'failed' ? '' : full ? A.act('Retry', 'identity.admin', FLEET, { cls: 'sm', attrs: `data-toast="Re-sent ${d[0]} by ${d[2]}: delivered"` }) : d[3] === me() ? `<button class="btn sm" data-toast="Re-sent ${d[0]} to you by ${d[2]}: delivered">Resend to me</button>` : '') },
  ];

  view('notifications', {
    label: 'Notifications', group: 'Govern', icon: 'notifications',
    navAccess: () => !!me(),
    access: () => null, // everyone signed in has their own preferences; the admin parts are guarded inside
    badge: () => ({ n: DELIV.filter((d) => d[6] === 'failed' && (fullLog() || d[3] === me())).length }),
    render: () => {
      const pid = me(), admin = A.can('identity.admin', FLEET), full = fullLog(), auditor = full && !admin;
      const P = prefsOf(pid), mine = DELIV.filter((d) => d[3] === pid);
      const rt = ROUTING.find((r) => r[0] === pid) || [pid, '—', A.person(pid).email, 'gate', 'none', 'email'];
      const L = full ? DELIV : mine, cnt = (st) => L.filter((d) => d[6] === st).length;
      const backup = pid === 'rb' ? 'Luis Torres' : 'Rana Begum';
      return `${A.pageHead({ eyebrow: 'Govern · NotificationPort', title: 'Notifications', sub: 'The portal inbox is the record of what waits on whom. Slack and email only nudge people toward it, so a failed or suppressed message never loses a decision. Choose what nudges you and where.', actions: '<a class="btn" href="#inbox">Open my inbox</a>' })}
      <div class="op-scope-note">${A.icon('lock', 13)}<span>${admin ? 'You administer the channels (identity.admin) and see every delivery.' : auditor ? '<b>Read-only: factory.auditor.</b> You see every delivery and the channel settings; you change only your own preferences.' : 'You see your own preferences and the messages sent to you. Channel settings and other people’s deliveries need identity.admin; auditors read them.'}</span>${full ? '' : switchHint()}</div>
      ${A.stats(full ? [
        { k: 'Sent 24h', v: 148, d: '96 Slack · 52 email' },
        { k: 'Delivered', v: '93.2%', d: '138 of 148', tone: 'ok' },
        { k: 'Failed', v: cnt('failed'), d: 'all still in the portal inbox', tone: 'bad' },
        { k: 'Suppressed', v: 8, d: 'quiet hours, self-actions, Teams deferred' },
        { k: 'Inbox entries open', v: A.waitingOnMe().length + 9, d: `${A.waitingOnMe().length} on you` },
      ] : [
        { k: 'Sent to you', v: mine.length, d: 'today and this week' },
        { k: 'Delivered', v: cnt('delivered'), d: E(rt[5]), tone: 'ok' },
        { k: 'Failed', v: cnt('failed'), d: cnt('failed') ? 'still in your portal inbox' : 'none', tone: cnt('failed') ? 'bad' : '' },
        { k: 'Suppressed', v: cnt('suppressed'), d: 'quiet hours, your own actions' },
        { k: 'Waiting on you', v: A.waitingOnMe().length, d: 'in the portal inbox' },
      ])}
      <div style="height:16px"></div>
      ${full ? `<div class="op-chans">
        <div class="op-chan auth"><div class="row between"><h4>Portal inbox</h4>${A.pill('authoritative', 'gate')}</div><p class="small muted">Every card lands here first. Decisions happen only here, with step-up.</p><div class="tiny mono faint">PortalInbox · fd_inbox_entry</div></div>
        <div class="op-chan"><div class="row between"><h4>Slack</h4>${A.health('ok')}</div><p class="small muted">Workspace acme · app AISDLC · DMs only, never a channel for gate content.</p><div class="tiny mono faint">integration notify.slack · r2 · 96 sent 24h</div><div>${A.act('Configure', 'identity.admin', FLEET, { cls: 'sm', attrs: 'data-toast="Draft notify.slack r3 created; publishing needs an M1 gate"' })}</div></div>
        <div class="op-chan"><div class="row between"><h4>Email</h4>${A.pill('degraded', 'warn')}</div><p class="small muted">SMTP relay smtp.acme.example. Links only, no item text in the body.</p><div class="tiny mono faint">integration notify.email · 2 failures 24h</div><div>${A.act('Configure', 'identity.admin', FLEET, { cls: 'sm', attrs: 'data-toast="Draft notify.email r5 created; publishing needs an M1 gate"' })}</div></div>
        <div class="op-chan def"><div class="row between"><h4>Teams</h4>${A.pill('deferred', 'mute')}</div><p class="small muted">On hold. The adapter resumes behind the same port; its cards become NotificationDelivery rows.</p><div class="tiny mono faint">TeamsBotAdapter · on hold (DM gap 16)</div></div>
      </div>
      <div style="height:16px"></div>` : ''}
      <div class="grid g2">
        ${A.card(`My routing: ${E(nm(pid))}`, `<div class="small muted" style="margin-bottom:10px">Slack <span class="mono">${E(rt[1])}</span> · email <span class="mono">${E(rt[2])}</span></div><div class="tbl-wrap"><table class="tbl op-matrix"><thead><tr><th>What nudges me</th><th class="c">Inbox</th><th class="c">Slack</th><th class="c">Email</th></tr></thead><tbody>
          ${A.j(TRIGGERS, (t) => `<tr><td><div class="small" style="font-weight:500">${E(t[1])}</div><div class="tiny faint">${E(t[2])}</div></td><td class="c"><input type="checkbox" checked disabled title="The inbox always gets it"></td>${P[t[0]].slice(1).map((v, i) => `<td class="c"><input type="checkbox" ${v ? 'checked' : ''} data-op-pref="${t[0]}:${i}" aria-label="${E(t[1])} by ${i ? 'email' : 'Slack'}"></td>`).join('')}</tr>`)}
          </tbody></table></div>
          <div class="op-form" style="margin-top:14px"><div class="field"><label for="op-qh">Quiet hours</label><select class="input" id="op-qh"><option>${E(rt[4] === 'none' ? 'none' : rt[4])}</option><option>22:00–07:00</option><option>none</option></select><span class="help">Held messages go out when quiet hours end. A kill always goes through.</span></div><div class="field"><label for="op-esc">If I miss an SLA</label><select class="input" id="op-esc"><option>Notify my backup (${backup})</option><option>Notify my manager</option></select><span class="help">B21 never auto-approves.</span></div></div>`, { foot: '<span class="tiny faint" style="margin-right:auto" data-op-prefst>saved</span><button class="btn primary" data-op-savepref>Save preferences</button>' })}
        ${full ? A.card('Team routing', A.table([
          { h: 'Person', cls: 'op-nw', r: (r) => A.who(r[0]) },
          { h: 'Slack · email', r: (r) => `<span class="mono tiny">${E(r[1])}</span><div class="mono tiny faint">${E(r[2])}</div>` },
          { h: 'Nudged for', r: (r) => `<span class="small">${E(r[3])}</span>` },
          { h: 'Quiet', r: (r) => `<span class="tiny muted">${E(r[4])}</span>` },
          { h: 'Channels', r: (r) => `<span class="tiny">${E(r[5])}</span>` },
        ], ROUTING), { flush: true, actions: `<span class="small faint">${auditor ? 'read-only' : 'each person sets their own'}</span>` })
        : A.card('Sent to me', mine.length ? A.table(delivCols(false), mine) : A.empty('Nothing was sent to you yet. Your portal inbox still lists everything that waits on you.'), { flush: true, actions: '<span class="small faint">NotificationDelivery · yours only</span>' })}
      </div>
      ${full ? `<div style="height:16px"></div>
      ${A.card('Delivery log', `<div class="row" style="padding:12px 16px;border-bottom:1px solid var(--line)"><div class="seg" data-op-dfilter>${['all', 'delivered', 'failed', 'suppressed'].map((k, i) => `<button aria-pressed="${i === 0}" data-v="${k}">${k}</button>`).join('')}</div><span class="sp" style="flex:1"></span><span class="tiny faint">NotificationDelivery · every person${auditor ? ' · read-only' : ''}</span></div>
        <div data-op-dlog>${A.table(delivCols(true), DELIV)}</div>`, { flush: true })}` : ''}`;
    },
    mount: (root) => {
      root.addEventListener('change', (e) => { if (e.target.matches('[data-op-pref],#op-qh,#op-esc')) { const [k, i] = (e.target.dataset.opPref || ':').split(':'); if (k) prefsOf(me())[k][+i + 1] = e.target.checked; root.querySelector('[data-op-prefst]').textContent = 'unsaved changes'; } });
      root.addEventListener('click', (e) => {
        if (e.target.closest('[data-op-savepref]')) { root.querySelector('[data-op-prefst]').textContent = 'saved just now'; A.toast('Routing preferences saved. Your inbox still gets everything.'); }
        const f = e.target.closest('[data-op-dfilter] button');
        if (f) { root.querySelectorAll('[data-op-dfilter] button').forEach((b) => b.setAttribute('aria-pressed', String(b === f))); root.querySelectorAll('[data-op-dlog] tbody tr').forEach((tr) => { const st = tr.querySelector('[data-op-dstat]').dataset.opDstat; tr.hidden = f.dataset.v !== 'all' && st !== f.dataset.v; }); }
      });
    },
  });

  /* the "Switch account to try it" dev hint opens the user menu */
  document.addEventListener('click', (e) => { if (!e.target.closest('[data-op-switch]')) return; e.preventDefault(); A.closeOverlay(); setTimeout(() => document.getElementById('me-btn')?.click(), 0); });
})();
