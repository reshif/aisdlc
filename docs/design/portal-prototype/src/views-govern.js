/* Govern: ledger, audit and catalogue. Configuration is views-config.js; agents, evals, models and integrations are
   views-quality.js; people, teams, roles and access explain are views-admin.js. */
(function () {
  const D = A.data;
  const esc = A.esc, j = A.j;

  /* ================================================================ small helpers */
  const hashStr = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = (seed) => { let s = hashStr(seed) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; }; };
  const hex = (seed, n = 64) => { const r = rng(seed); let o = ''; while (o.length < n) o += Math.floor(r() * 16).toString(16); return o; };
  const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
  const signed = (v, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}`;
  const delta = (v) => `<span class="gv-delta ${v > 0.005 ? 'up' : v < -0.005 ? 'down' : ''}">${signed(v)}</span>`;
  const mono = (s) => `<span class="mono gv-nw">${esc(s)}</span>`;
  const sub = (s) => `<div class="tiny faint">${s}</div>`;
  const stepGlyph = (s) => { const st = D.STEPS[s]; const kinds = st ? A.actorKinds(st[1]) : ['A']; return `<span class="gv-step" title="${esc(st ? st[2] : 'Handoff pack (D1)')}">${A.actors(kinds, 14)}<span class="mono">${esc(s)}</span></span>`; };
  const providerName = { anthropic: 'Anthropic', openai_compat: 'Codex (openai_compat)', deepseek: 'DeepSeek (openai_compat)', fake: 'fake' };
  const integrationOf = (p) => ({ anthropic: 'anthropic', openai_compat: 'codex', deepseek: 'deepseek', fake: 'fake' }[p] || p);
  const head = (o) => A.pageHead(o);
  const ago = (m) => (m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`);
  const confirmModal = ({ title, body, confirm, kind = 'primary', onConfirm }) => {
    const m = A.modal(`<div class="row between"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>${body}
      <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button><button class="btn ${kind}" data-ok>${confirm}</button></div>`);
    m.querySelector('[data-ok]').onclick = () => { A.closeOverlay(); onConfirm && onConfirm(); };
    return m;
  };

  /* ================================================================ access: who may open and change what (read at render time, never at load) */
  const FLEET = { type: 'Fleet' };
  const myBindings = () => A.bindingsOf(A.me());
  const isFleet = () => myBindings().some((b) => b.scope.kind === 'fleet');
  /** highest data class the signed-in person holds anywhere (fleet or project): what fleet-wide Quality text may show */
  const myDC = () => myBindings().reduce((m, b) => Math.max(m, A.access.DR[A.access.ROLE[b.role].data_class]), -1);
  /** quality.read: a fleet role, or any role with view level V2 on a project */
  const qualityRes = () => {
    if (A.can('quality.read', FLEET)) return FLEET;
    const p = D.PROJECTS.find((x) => A.canSeeProject(x.id) && A.viewLevel(x.id) >= 2);
    return p ? { type: 'Project', project: p.id } : FLEET;
  };
  const qualityAccess = () => ({ action: 'quality.read', res: qualityRes() });
  /** audit.read on the fleet, or on any project the person administers (V3) */
  const auditProjects = () => D.PROJECTS.filter((p) => A.can('audit.read', { type: 'Project', project: p.id }) && A.viewLevel(p.id) >= 3);
  const ledgerRes = () => { if (A.can('audit.read', FLEET)) return FLEET; const p = auditProjects()[0]; return p ? { type: 'Project', project: p.id } : FLEET; };
  const canLedger = () => A.can('audit.read', ledgerRes());
  const ledgerLink = (seq, pre = '#') => (canLedger() ? `<a class="mono" href="#ledger">${pre}${seq}</a>` : `<span class="mono" title="The ledger needs audit.read (V3)">${pre}${seq}</span>`);
  /** a change to fleet config (routes, keys, evals, integrations, catalogue): factory.admin proposes; an M1/M3 card follows */
  const propose = (label, attrs = '', o = {}) => A.act(label, 'config.propose', FLEET, { attrs, ...o });
  const keyOfRef = (s) => (String(s).match(/\b[WCLI]-\d+\b/) || [])[0];
  const seesRef = (s) => { const k = keyOfRef(s); return !k || !A.item(k) || A.canSeeProject(A.item(k).project); };
  const maskId = (id) => `${id.slice(0, 7)}••••`;
  const hiddenNote = (n, what) => (n ? `<div class="tiny faint gv-hidnote">${A.icon('lock', 11)} ${n} ${what} on projects you have no role on ${n === 1 ? 'is' : 'are'} not listed.</div>` : '');
  const needDC = (n, what) => `<div class="gv-hidden">${A.icon('lock', 14)}<span><b>Hidden: needs D${n}.</b> ${what} Your roles reach data class D${Math.max(0, myDC())}.</span><a class="btn sm ghost" href="#my-access">My access</a></div>`;

  /* agents, evals, models and routes, and integrations: views-quality.js */
  /* ================================================================ ledger */
  const MORE_LEDGER = [
    [18412, '07:44:10', 'agent.run', 'A3 · W-23 · 5.3', 'core-worker', 'artefact stored', 310], [18411, '07:31:56', 'gate.decision', 'G0+G1 · W-35', 'pm', 'approved', 310],
    [18410, '07:12:03', 'push.receipt', 'W-20 · agent/W-20/u2', 'codehost', 'pushed 9e1b44c', 310], [18409, '06:58:40', 'access.grant', 'M6 · rb design approver', 'lt', 'granted', 310],
    [18408, '06:40:12', 'config.publish', 'integrations.registry r9', 'rb', 'M1 approved', 309], [18407, '06:22:31', 'gate.decision', 'E3 · W-07 u4', 'pm', 'approved (+30%)', 309],
    [18406, '05:59:00', 'checkpoint', 'checkpoint 310 · 17,500–18,405', 'witness', 'co-signed', 310], [18405, '05:41:18', 'audit.export', 'export ax-0031 · Payments API', 'nf', 'written (WORM)', 309],
    [18404, '05:12:47', 'gate.decision', 'G4 · W-13', 'ar', 'approved (mode E)', 309], [18403, '04:50:09', 'erasure.execute', 'er-0007 · psn_4c2…', 'lt', 'tombstoned 3', 309],
    [18402, '04:31:55', 'kill.event', 'lane L4 · Web Checkout', 'mw', 'requested', 309], [18401, '04:30:20', 'gate.decision', 'Q1 · C-46', 'ks', 'released', 309],
    [18400, '03:12:02', 'config.publish', 'project payments r6 (gating profile)', 'pm', 'M1 approved', 308], [18399, '02:48:44', 'onboarding.card', 'card 1 · Mobile App', 'mw', 'decided', 308],
    [18398, '02:10:31', 'gate.decision', 'Q1 · I-11 token signer finding', 'ks', 'released', 308, 'identity'], [18397, '01:44:09', 'access.grant', 'M6 · ks security approver', 'lt', 'granted', 308, 'identity'],
    [18396, '01:20:55', 'gate.decision', 'G4 · L-07', 'so', 'approved (mode C)', 308], [18395, '00:58:12', 'gate.decision', 'G3d · C-49', 'mw', 'changes requested', 308],
    [18394, '00:31:40', 'push.receipt', 'L-08 · agent/L-08/main', 'codehost', 'pushed 2d7f0e1', 308], [18393, '00:12:05', 'config.publish', 'project.gating · Ledger Service r2', 'so', 'M1 approved', 308, 'ledger'],
  ].map(([seq, at, type, subj, actor, result, cp, p]) => ({ seq, at, type, subj, actor, result, cp, hash: hex('e' + seq, 8), p: p || ({ 18409: 'payments', 18405: 'payments' })[seq] }));
  const ENTRIES = [...D.LEDGER, ...MORE_LEDGER];
  const LT = { t: null };
  /** the project an entry belongs to (null: a fleet entry such as config, catalogue, checkpoint, erasure) */
  const projOf = (e) => {
    if (e.p !== undefined) return e.p;
    const k = keyOfRef(e.subj); if (k && A.item(k)) return A.item(k).project;
    const ses = (e.subj.match(/ses-[0-9a-f]+/) || [])[0]; if (ses) { const x = D.SESSIONS.find((y) => y.id === ses); if (x && A.item(x.item)) return A.item(x.item).project; }
    const pr = D.PROJECTS.find((x) => e.subj.includes(x.name)); return pr ? pr.id : null;
  };
  /** what the signed-in person may read: fleet auditors/admins all (confidential collapsed), project admins their projects only */
  const ledgerRows = () => {
    const fleet = A.can('audit.read', FLEET); const mine = auditProjects().map((p) => p.id);
    return ENTRIES.slice().sort((a, b) => b.seq - a.seq).map((e) => {
      const p = projOf(e);
      if (p && mine.includes(p)) return e;
      if (!fleet) return null;
      if (p && !A.canSeeProject(p)) return { ...e, subj: 'Confidential project · subject hidden', actor: '—', collapsed: true };
      return e;
    }).filter(Boolean);
  };
  const actorCell = (a) => (a === '—' ? '<span class="faint">—</span>' : D.PEOPLE[a] ? A.who(a) : `<span class="row" style="gap:7px;flex-wrap:nowrap">${A.glyph('D', 16)}<span class="mono small">${esc(a)}</span></span>`);
  const resultPill = (r) => { const k = /approved|co-signed|granted|written|released|decided|stored|pushed/.test(r) ? 'ok' : /pending|submitted|requested/.test(r) ? 'gate' : /tombstoned|rejected/.test(r) ? 'back' : 'mute'; return A.pill(r, k); };
  const canonical = (e) => {
    const payload = { actor: D.PEOPLE[e.actor] ? `principal:${e.actor}` : `service:${e.actor}`, at: `2026-11-10T${e.at}.000Z`, entry_type: e.type, ledger_seq: e.seq, payload_hash: `sha256:${hex('p' + e.seq)}`, policy_bundle: 'pdp-1.3.0.roles-1.1.0', prev_hash: `sha256:${prevHash(e)}`, result: e.result, subject: e.subj };
    const keys = Object.keys(payload).sort();
    return '{' + keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(payload[k])}`).join(',') + '}';
  };
  const fullHash = (e) => e.hash + hex('x' + e.seq, 56);
  const prevHash = (e) => { const pe = ENTRIES.find((x) => x.seq === e.seq - 1); return pe ? fullHash(pe) : hex('e' + (e.seq - 1)); };
  const merkle = (e) => { const r = rng('m' + e.seq); const depth = 9; return Array.from({ length: depth }, (_, i) => ({ side: r() > 0.5 ? 'L' : 'R', h: hex('mk' + e.seq + i, 16) })); };

  const ledgerDrawer = (e) => {
    A.drawer(`<div class="row between"><span class="eyebrow">ledger entry · checkpoint ${e.cp}</span><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      <div class="row"><span class="mono" style="font-size:20px;font-weight:600">#${e.seq.toLocaleString('en-US')}</span>${A.pill(e.type, 'plain')}${resultPill(e.result)}</div>
      <h3>${esc(e.subj)}</h3>
      ${A.kv([['Actor', actorCell(e.actor)], ['Time', `2026-11-10 ${e.at} UTC`], ['Entry hash', A.hash(fullHash(e), 16)], ['Prev hash', `${A.hash(prevHash(e), 16)} <span class="tiny faint">#${e.seq - 1}</span>`], ['Checkpoint', `${e.cp} <span class="tiny faint">Notary + Witness co-signed</span>`]])}
      ${e.collapsed ? `<div class="banner info gv-bn" style="margin:0">${A.icon('lock', 14)}<span><b>Confidential project.</b> Fleet roles see that the entry exists and that its hashes chain; subject, actor and payload need a role on the project (FD-D6).</span></div>` : `<div><div class="eyebrow" style="margin-bottom:6px">Canonical JSON (RFC 8785)</div><pre class="code gv-wrap">${esc(canonical(e))}</pre></div>`}
      <div><div class="eyebrow" style="margin-bottom:6px">Notary signature (ES256, kid notary-2026-10)</div><pre class="code gv-wrap">${hex('sig' + e.seq, 128)}</pre></div>
      <div><div class="eyebrow" style="margin-bottom:6px">Merkle inclusion proof → checkpoint ${e.cp} root</div><ol class="gv-proof">${j(merkle(e), (p, i) => `<li><span class="mono tiny faint">${i}</span><span class="pill plain ${p.side === 'L' ? 'info' : 'agent'}">${p.side}</span><span class="mono small">${p.h}…</span></li>`)}<li><span class="mono tiny faint">root</span><span class="pill plain gate">✓</span><span class="mono small">${hex('root' + e.cp, 16)}…</span></li></ol></div>
      <div class="banner info gv-bn" style="margin:0;flex-direction:column;align-items:flex-start"><b>Verify offline</b><span class="small">Needs only the database and the two public keys; no help from the factory.</span><pre class="code" style="width:100%">node dist/verify-ledger.js \\\n  --db $DATABASE_URL \\\n  --notary-key notary.pub.jwk \\\n  --witness-key witness.pub.jwk \\\n  --entry ${e.seq}</pre></div>
      <div class="row">${e.collapsed ? '' : `<button class="btn" data-toast="Copied canonical JSON (${canonical(e).length} bytes).">Copy JSON</button>`}<button class="btn" data-toast="Proof for #${e.seq} checked: recomputed root matches checkpoint ${e.cp}.">Check proof here</button></div>`);
  };

  A.view('ledger', {
    label: 'Ledger', group: 'Govern', icon: 'ledger',
    access: () => ({ action: 'audit.read', res: ledgerRes() }),
    deniedTitle: 'The ledger is for auditors and admins',
    render: () => {
      const rows = ledgerRows();
      const fleet = A.can('audit.read', FLEET);
      const mine = auditProjects();
      const types = [...new Set(rows.map((e) => e.type))];
      const collapsed = rows.filter((e) => e.collapsed).length;
      const scopeBanner = fleet
        ? `<div class="banner info gv-bn">${A.icon('ledger', 14)}<span><b>Whole factory.</b> You read every entry through ${esc(myBindings().find((b) => b.scope.kind === 'fleet').role)}.${collapsed ? ` ${collapsed} entr${collapsed === 1 ? 'y' : 'ies'} of a confidential project ${collapsed === 1 ? 'is' : 'are'} collapsed: hashes only.` : ''}</span></div>`
        : `<div class="banner warn gv-bn">${A.icon('lock', 14)}<span><b>Filtered to your projects:</b> ${esc(mine.map((p) => p.name).join(', '))}. You hold audit.read there as project admin (V3). Fleet entries (config, catalogue, checkpoints) and other projects are not listed; the verify run still checks the whole chain.</span></div>`;
      return `${head({ eyebrow: 'Govern · signed ledger', title: 'Ledger', sub: 'Every decision is an entry on the signed, hash-chained ledger. Each entry’s hash covers the one before it, and checkpoints are co-signed by an outside Witness, so nothing can be changed or removed without the offline check noticing.', actions: A.act('Run verify', 'audit.read', ledgerRes(), { cls: 'primary', icon: 'ledger', attrs: 'data-verify' }) })}
      ${scopeBanner}
      ${A.stats([
        { k: 'Head', v: '18,422', d: `${A.hash('9f12c0e7')} · 10:41:07 UTC` },
        { k: 'Last checkpoint', v: '312', d: 'entries 18,417–18,422 pending in 313' },
        { k: 'Witness co-sign', v: '<span style="color:var(--ok)">✓</span> 311', d: 'witness.acme-audit.net · 09:12 UTC', tone: 'ok' },
        fleet ? { k: 'Entries today', v: 58, d: '21 gate decisions · 4 config' } : { k: 'Your projects, today', v: rows.length, d: `${rows.filter((e) => e.type === 'gate.decision').length} gate decisions · of 58 in the factory` },
        { k: 'Verify status', v: '<span style="color:var(--ok)">intact</span>', d: 'last run 06:00 UTC (nightly)', tone: 'ok' },
      ])}
      <div style="height:16px"></div>
      <section class="card gv-verify" id="gv-verify"><div class="bd">
        <div class="row" style="gap:14px;align-items:flex-start">
          <span class="gv-vmark ok" id="gv-vmark">✓</span>
          <div style="flex:1;min-width:0"><div class="mono" id="gv-vline">verify-ledger: 18,422 entries, chain intact, 312 checkpoints</div>
            <div class="gv-vsteps" id="gv-vsteps">${j(['hash chain 1 → 18,422', 'Notary signatures', 'checkpoint roots', 'Witness co-signatures', 'head matches database'], (s) => `<span class="done">${s}</span>`)}</div>
            <div class="meter" style="margin-top:8px"><i id="gv-vbar" style="width:100%"></i></div></div>
        </div></div></section>
      <div style="height:16px"></div>
      <div class="stack">
          <div class="row" style="gap:8px"><span class="small muted">Type</span><div class="seg gv-seg" id="gv-filter"><button aria-pressed="true" data-t="">all</button>${j(types, (t) => `<button aria-pressed="false" data-t="${t}">${t}</button>`)}</div></div>
          ${A.card('', A.table([
            { h: 'Seq', r: (e) => `<b class="mono">${e.seq}</b>` },
            { h: 'Time', r: (e) => `<span class="mono small muted">${e.at}</span>` },
            { h: 'Type', r: (e) => `<span class="mono small">${e.type}</span>` },
            { h: 'Subject', r: (e) => (e.collapsed ? `<span class="faint">${A.icon('lock', 12)} ${esc(e.subj)}</span>` : esc(e.subj)) },
            { h: 'Actor', r: (e) => `<span class="gv-nw">${actorCell(e.actor)}</span>` },
            { h: 'Result', r: (e) => resultPill(e.result) },
            { h: 'Entry hash', r: (e) => A.hash(e.hash) },
            { h: 'Checkpoint', cls: 'r', r: (e) => `<span class="mono small">${e.cp}${e.cp === 312 ? ' <span class="faint">open</span>' : ' ✓'}</span>` },
          ], rows), { flush: true, id: 'gv-ltbl', actions: `<span class="tiny faint">${fleet ? '' : 'filtered to your projects · '}click an entry for its canonical form and proof</span>` })}
        </div>
        <div style="height:16px"></div>
        <div class="grid g3" style="align-items:start">
          ${A.card('Checkpoints', `<ul class="tl">${j([[312, '10:12', '18,417–18,422 · open'], [311, '09:12', '18,000–18,416'], [310, '05:59', '17,500–17,999'], [309, '01:02', '17,040–17,499'], [308, 'yesterday', '16,610–17,039']], ([n, t, r], i) => `<li><span class="when">${t}</span><span class="dot ${i ? 'g' : ''}"></span><div class="what"><div class="t mono">checkpoint ${n}</div><div class="m">${r} · ${i ? 'Notary + Witness' : 'Notary signed, Witness pending'}</div></div></li>`)}</ul>`)}
          ${A.card('Keys', A.kv([['Notary', `${mono('notary-2026-10')} ES256 · key custody: kms-local`], ['Witness', `${mono('witness-acme-1')} · outside the factory`], ['Chain hash', 'sha256 over RFC 8785 canonical JSON'], ['Lock order', 'gate lock → ledger lock → record → ledger entry last']]))}
          ${A.card('Check it yourself', `<p class="small muted" style="margin-bottom:8px">The bundle in <code>dist/</code> verifies from the database and the public keys alone.</p><pre class="code">node dist/verify-ledger.js \\\n  --db &lt;postgres-url&gt; \\\n  --notary-key &lt;jwk-file&gt; \\\n  --witness-key &lt;jwk-file&gt;</pre>`)}
        </div>
      </div>`;
    },
    mount: (root) => {
      const rows = ledgerRows();
      root.querySelectorAll('#gv-ltbl tbody tr').forEach((tr, i) => { tr.classList.add('click'); tr.dataset.type = rows[i].type; tr.onclick = () => ledgerDrawer(rows[i]); });
      root.querySelectorAll('#gv-filter button').forEach((b) => (b.onclick = () => { root.querySelectorAll('#gv-filter button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); root.querySelectorAll('#gv-ltbl tbody tr').forEach((tr) => { tr.hidden = !!b.dataset.t && tr.dataset.type !== b.dataset.t; }); }));
      const vb = root.querySelector('[data-verify]'); if (vb) vb.onclick = (ev) => {
        const btn = ev.currentTarget; if (LT.t) return; btn.disabled = true;
        const mark = root.querySelector('#gv-vmark'), line = root.querySelector('#gv-vline'), bar = root.querySelector('#gv-vbar'), steps = [...root.querySelectorAll('#gv-vsteps span')];
        mark.className = 'gv-vmark run'; mark.textContent = '…'; steps.forEach((s) => (s.className = '')); bar.style.width = '0%'; bar.style.background = 'var(--hand)';
        let n = 0; const total = 18422;
        LT.t = setInterval(() => {
          n = Math.min(total, n + 731); const p = n / total; bar.style.width = (p * 100).toFixed(1) + '%';
          line.textContent = `verify-ledger: checking entry ${n.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}…`;
          steps.forEach((s, i) => { if (p > (i + 1) / steps.length - 0.001) s.className = 'done'; else if (p > i / steps.length) s.className = 'now'; });
          if (n >= total) { clearInterval(LT.t); LT.t = null; btn.disabled = false; mark.className = 'gv-vmark ok pop'; mark.textContent = '✓'; bar.style.background = ''; line.textContent = 'verify-ledger: 18,422 entries, chain intact, 312 checkpoints'; A.toast('verify-ledger passed: 18,422 entries, chain intact, 312 checkpoints, Witness co-signatures valid.'); }
        }, 60);
      };
    },
    unmount: () => { if (LT.t) { clearInterval(LT.t); LT.t = null; } },
  });

  /* ================================================================ audit */
  A.view('audit', {
    label: 'Audit', group: 'Govern', icon: 'audit',
    access: () => ({ action: 'audit.read', res: FLEET }),
    deniedTitle: 'Audit is for the factory auditors',
    render: () => {
      const admins = A.access.BINDINGS.filter((b) => b.role === 'factory.admin' && !b.revoked).map((b) => D.PEOPLE[b.pid].name).join(', ');
      const isAdmin = A.can('identity.admin', FLEET);
      const adminAct = (label, attrs, o = {}) => A.act(label, 'identity.admin', FLEET, { attrs, ...o });
      const exportsT = A.table([
        { h: 'Export', r: (x) => mono(x[0]) }, { h: 'Ledger range', r: (x) => `<span class="mono small">${x[1]}</span>` }, { h: 'Scope', r: (x) => esc(x[2]) }, { h: 'Requested by', r: (x) => A.who(x[3]) },
        { h: 'Package hash', r: (x) => A.hash(hex('ax' + x[0])) }, { h: 'Store', r: () => '<span class="pill plain info">write-once</span>' }, { h: 'Signed', r: () => A.pill('Notary ✓', 'ok') }, { h: 'When', r: (x) => `<span class="small muted">${x[4]}</span>` },
      ], [['ax-0031', '17,500–18,405', 'Payments API · Q4 SOC 2 sample', 'nf', 'today 05:41'], ['ax-0030', '1–17,040', 'fleet · annual', 'nf', '9d ago'], ['ax-0029', '15,200–16,610', 'a confidential project · access review', 'lt', '21d ago'], ['ax-0028', '12,000–15,199', 'Web Checkout · PCI evidence', 'nf', '34d ago'], ['ax-0027', '11,402–12,000', 'Payments API · G4 mode-E sample (9.5)', 'nf', '41d ago'], ['ax-0026', '9,800–11,401', 'fleet · break-glass review (X4)', 'lt', '52d ago'], ['ax-0025', '8,120–9,799', 'Ledger Service · onboarding M4', 'nf', '60d ago']]);
      const erasure = A.table([
        { h: 'Request', r: (x) => mono(x[0]) }, { h: 'Subject', r: (x) => `<span class="mono small">${x[1]}</span>${sub(x[2])}` }, { h: 'Legal approval', r: (x) => x[3] }, { h: 'Payloads', cls: 'r', r: (x) => x[4] }, { h: 'Ledger', r: (x) => (x[5] ? ledgerLink(x[5]) : '<span class="faint">—</span>') }, { h: 'State', r: (x) => A.pill(x[6], { executed: 'ok', 'awaiting legal': 'gate', blocked: 'bad' }[x[6]]) },
      ], [['er-0007', 'psn_4c2e91a0', 'resolved by Luis Torres under LA-112', 'LA-112 · counsel', 3, 18403, 'executed'], ['er-0008', 'psn_77b0c3d4', 'pseudonym resolution needs legal approval', 'pending', 5, null, 'awaiting legal'], ['er-0006', 'psn_19aa02f7', 'blocked: subject under legal hold LH-04', 'LA-108 · counsel', 2, null, 'blocked']]);
      const retention = A.table([{ h: 'Class', r: (x) => mono(x[0]) }, { h: 'Keep for', r: (x) => x[1] }, { h: 'Applies to', r: (x) => `<span class="small">${x[2]}</span>` }, { h: 'Rows', cls: 'r', r: (x) => x[3] }],
        [['ledger', 'forever', 'ledger_entry, checkpoints (hash chain; payloads redactable)', '18,422'], ['decision_7y', '7 years', 'PDP decisions with log_allow, gate cards', '412,880'], ['access_3y', '3 years', 'PDP denies, step-up events, sessions', '1.9M'], ['record_2y', '2 years', 'record_event of closed items', '2.4M'], ['ops_90d', '90 days', 'loop health, integration health', '611k'], ['model_call_1y', '1 year', 'gateway.model_call (no text)', '842k']]);
      const holds = A.table([{ h: 'Hold', r: (x) => mono(x[0]) }, { h: 'Scope', r: (x) => esc(x[1]) }, { h: 'Set by', r: (x) => A.who(x[2]) }, { h: 'Since', r: (x) => `<span class="small muted">${x[3]}</span>` }, { h: 'State', r: (x) => A.pill(x[4], x[4] === 'active' ? 'warn' : 'mute') }],
        [['LH-04', 'Payments API · disputes 2026-Q3 (items W-08, W-10)', 'lt', '2026-10-02', 'active'], ['LH-03', 'principal psn_19aa02f7', 'lt', '2026-09-20', 'active'], ['LH-02', 'Web Checkout · 2026-07 incident', 'lt', '2026-07-14', 'released']]);
      const perm = [['18409', 'today 06:58', 'rb', 'project.design_approver', 'Payments API', 'lt', 'M6 granted'], ['18122', '4d ago', 'jm', 'project.exception_approver', 'Payments API', 'pm', 'M6 granted'], ['17790', '9d ago', 'dn', 'project.code_owner', 'Payments API', 'pm', 'removed'], ['17411', '12d ago', 'mw', 'project.admin', 'Web Checkout', 'lt', 'granted'], ['16988', '17d ago', 'ks', 'project.security_approver', 'Identity Hub', 'lt', 'granted'], ['16020', '30d ago', 'ar', 'project.code_owner', 'Payments API', 'pm', 'granted'], ['15877', '32d ago', 'lt', 'factory.admin', 'fleet', 'break-glass pair', 'granted']];
      const permT = A.table([{ h: 'Seq', r: (x) => ledgerLink(x[0]) }, { h: 'When', r: (x) => `<span class="small muted">${x[1]}</span>` }, { h: 'Principal', r: (x) => A.who(x[2]) }, { h: 'Role', r: (x) => mono(x[3]) }, { h: 'Scope', r: (x) => esc(x[4]) }, { h: 'By', r: (x) => (D.PEOPLE[x[5]] ? A.who(x[5]) : esc(x[5])) }, { h: 'Change', r: (x) => A.pill(x[6], x[6] === 'removed' ? 'back' : 'ok') }], perm);
      const roleAt = `<div class="row" style="gap:10px;margin-bottom:12px"><span class="small muted">Who held</span><select class="input" style="width:auto" id="gv-role"><option>project.code_owner</option><option>project.design_approver</option><option>project.exception_approver</option></select><span class="small muted">on</span><input class="input" style="width:auto" type="date" id="gv-date" value="2026-10-20"><button class="btn sm" id="gv-roleq">Ask</button></div><div id="gv-rolea" class="small"></div>`;
      const alog = A.table([{ h: 'Seq', r: (x) => mono(x[0]) }, { h: 'Event', r: (x) => mono(x[1]) }, { h: 'Who', r: (x) => (D.PEOPLE[x[2]] ? A.who(x[2]) : mono(x[2])) }, { h: 'Hash', r: (x) => A.hash(hex('al' + x[0])) }, { h: 'Prev', r: (x) => A.hash(hex('al' + (x[0] - 1))) }],
        [[4412, 'audit.read ledger range', 'nf'], [4411, 'export.write ax-0031', 'nf'], [4410, 'erasure.resolve er-0007', 'lt'], [4409, 'access.explain ar gate.decide', 'ar'], [4408, 'hold.check LH-04', 'audit-backend'], [4407, 'export.verify ax-0030', 'nf']]);
      return `${head({ eyebrow: 'Govern · audit backend', title: 'Audit', sub: 'Exports for auditors, erasure with pseudonyms, what is kept and for how long, legal holds and who held which role when. The audit backend signs its own log, so reading the record is itself on the record.', actions: A.act('Request an export', 'audit.read', FLEET, { cls: 'primary', attrs: 'data-export' }) })}
      ${isAdmin ? '' : `<div class="banner info gv-bn">${A.icon('lock', 14)}<span><b>You read and export; you do not erase.</b> As ${esc(myBindings().find((b) => b.scope.kind === 'fleet')?.role || 'auditor')} you can request signed exports. Erasure, pseudonym resolution and legal holds are factory.admin actions (${esc(admins)}).</span><span class="sp"></span><a class="btn sm ghost" href="javascript:void 0" data-switch>Switch account to try it</a></div>`}
      ${A.stats([
        { k: 'Exports', v: 31, d: 'signed, in the write-once store' },
        { k: 'Erasure requests', v: 3, d: '1 awaiting legal approval', tone: 'warn' },
        { k: 'Legal holds active', v: 2, d: 'erasure blocked inside a hold' },
        { k: 'Retention classes', v: 6, d: 'nightly sweep 02:00 UTC' },
        { k: 'Audit log head', v: '4,412', d: 'chain intact · own signing key', tone: 'ok' },
      ])}
      <div style="height:16px"></div>
      ${A.tabs('au', [
        { id: 'exp', label: 'Exports', n: 7, html: A.card('', exportsT, { flush: true, id: 'gv-exports', actions: '<span class="tiny faint">ledger type audit.export</span>' }) },
        { id: 'era', label: 'Erasure', n: 3, html: `${A.card('', erasure, { flush: true, actions: `${adminAct('Execute er-0008', 'data-erase', { cls: 'sm danger' })}` })}<div class="banner info gv-bn" style="margin-top:12px">${A.icon('lock', 14)}<span>Ledger entries carry pseudonyms (<code>psn_…</code>). Erasure tombstones the redactable payloads; the hash chain stays intact because entries bind payload hashes, not payloads. Resolving a pseudonym to a person needs a legal approval and is itself logged.</span></div>` },
        { id: 'ret', label: 'Retention', n: 6, html: A.card('', retention, { flush: true }) },
        { id: 'hold', label: 'Legal holds', n: 3, html: A.card('', holds, { flush: true, actions: `${adminAct('Release LH-03', 'data-toast="Release of LH-03 drafted: needs a second factory admin or counsel (two people)."', { cls: 'sm' })}${adminAct('Set a legal hold', 'data-hold', { cls: 'sm primary' })}` }) },
        { id: 'perm', label: 'Permission history', n: perm.length, html: `<div class="grid g2" style="align-items:start">${A.card('Role changes', permT, { flush: true })}${A.card('Who had which role when', roleAt)}</div>` },
        { id: 'log', label: 'Audit backend log', n: 4412, html: A.card('The audit backend’s own signed log', alog, { flush: true, actions: '<span class="tiny faint">sign_log_record · key audit-2026-09</span>' }) },
      ])}
      <div style="height:16px"></div>
      <div class="grid g3" style="align-items:start">
        ${A.card('Erasure er-0008 in progress', `<div class="gv-flow">${j(['Request', 'Legal approval', 'Resolve pseudonym', 'Tombstone', 'Ledger entry'], (st, i) => `<div class="gv-fs ${i < 1 ? 'done' : i === 1 ? 'now' : ''}"><i>${i < 1 ? '✓' : i + 1}</i><span class="tiny">${st}</span></div>`)}</div>
          <div class="small muted" style="margin-top:12px">Subject <span class="mono">psn_77b0c3d4</span> asked for erasure on 6 Nov. 5 redactable payloads found (request text of W-34, two Q&amp;A answers, two chat turns). Waiting on counsel; the pseudonym stays unresolved until then.</div>`, { foot: adminAct('Remind counsel', 'data-toast="Reminder sent to counsel (LA queue)."', { cls: 'sm' }) })}
        ${A.card('Last retention sweep', `<div class="stack" style="gap:10px">${j([['record_2y', 18240, 'rows tombstoned'], ['ops_90d', 96112, 'rows deleted'], ['access_3y', 0, 'nothing due'], ['skipped: legal hold', 412, 'rows kept (LH-03, LH-04)']], ([k, n, t]) => `<div class="row between small"><span class="mono">${k}</span><span><b class="num">${n.toLocaleString('en-US')}</b> <span class="faint">${t}</span></span></div>`)}</div><div class="tiny faint" style="margin-top:12px">Ran 02:00 UTC, 4m 12s. The ledger is never swept; its payloads are redacted, never its hashes.</div>`)}
        ${A.card('Audit activity', `<ul class="tl">${j([['10:02', 'h', 'Nora Field read ledger 18,000–18,422', 'audit.read · decision log 7y'], ['05:41', 'g', 'Export ax-0031 written', 'Notary signed · WORM bucket audit-exports'], ['04:50', 'b', 'Erasure er-0007 executed', '3 payloads tombstoned · ledger #18403'], ['yesterday', 'h', 'Alex Rivera asked access.explain', 'gate.decide on G3 · W-27: allow']], ([w, d, t, m]) => `<li><span class="when">${w}</span><span class="dot ${d}"></span><div class="what"><div class="t">${t}</div><div class="m">${m}</div></div></li>`)}</ul>`)}
      </div>`;
    },
    mount: (root) => {
      const answer = () => {
        const role = root.querySelector('#gv-role').value, d = root.querySelector('#gv-date').value;
        const who = { 'project.code_owner': d < '2026-11-01' ? ['ar', 'dn', 'so'] : ['ar', 'so'], 'project.design_approver': d < '2026-11-10' ? ['ar'] : ['ar', 'rb'], 'project.exception_approver': d < '2026-11-06' ? ['rb'] : ['jm', 'rb'] }[role];
        root.querySelector('#gv-rolea').innerHTML = `<div class="stack" style="gap:8px">${j(who, (w) => `<div class="row between">${A.who(w)}<span class="tiny faint">Payments API · from PermissionHistory</span></div>`)}<div class="tiny faint">Folded from ledger access entries up to ${esc(d)} 23:59 UTC; rebuildable.</div></div>`;
      };
      root.querySelector('#gv-roleq').onclick = answer; answer();
      const er = root.querySelector('[data-erase]'); if (er) er.onclick = () => confirmModal({ title: 'Execute erasure er-0008?', kind: 'danger', confirm: 'Execute erasure', body: `<p class="muted">Counsel has not approved LA-114 yet. Executing now resolves pseudonym <span class="mono">psn_77b0c3d4</span> and tombstones 5 payloads; the hash chain stays intact. A legal hold on the subject would refuse it.</p><label class="check"><input type="checkbox" checked> I confirm counsel approval LA-114 is attached</label>`, onConfirm: () => A.toast('Erasure er-0008 queued: waits for LA-114, then tombstones 5 payloads (ledger erasure.execute).') });
      const hd = root.querySelector('[data-hold]'); if (hd) hd.onclick = () => confirmModal({ title: 'Set a legal hold', confirm: 'Set hold', body: `<div class="field"><label>Scope</label><select class="input"><option>Payments API · items W-08, W-10, W-12</option><option>principal (pseudonym)</option><option>fleet · date range</option></select></div><div class="field"><label>Matter reference</label><input class="input" value="LA-115"></div><p class="small muted">While a hold is active, retention sweeps skip its rows and erasure inside it is refused.</p>`, onConfirm: () => A.toast('Legal hold LH-05 set. Retention skips its rows from the next sweep.') });
      const ex = root.querySelector('[data-export]'); if (ex) ex.onclick = () => confirmModal({ title: 'Request an audit export', body: `<div class="grid g2"><div class="field"><label>From seq</label><input class="input" value="18406"></div><div class="field"><label>To seq</label><input class="input" value="18422"></div></div><div class="field"><label>Scope</label><select class="input"><option>Payments API</option><option>fleet</option></select></div><p class="small muted">The package is signed by the Notary and written once; it cannot be changed or deleted, only superseded. Reading for an export is itself an audit log record.</p>`, confirm: 'Write export', onConfirm: () => { const tb = root.querySelector('#gv-exports tbody'); if (tb) tb.insertAdjacentHTML('afterbegin', `<tr><td>${mono('ax-0032')}</td><td><span class="mono small">18,406–18,422</span></td><td>Payments API</td><td>${A.who(A.me())}</td><td>${A.hash(hex('ax32'))}</td><td><span class="pill plain info">write-once</span></td><td>${A.pill('Notary ✓', 'ok')}</td><td><span class="small muted">just now</span></td></tr>`); A.toast('Export ax-0032 written: 17 entries, package signed. Ledger entry audit.export queued.'); } });
    },
  });

  /* ================================================================ catalogue */
  const CSTAGES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S8b', 'S9'];
  const F = 'full', P = 'partial', X = 'skipped', U = 'unspecified';
  const MODES = {
    L0: [F, X, X, X, X, F, F, F, F, F], L1: [F, X, P, X, P, F, F, F, F, F], L2: [F, X, P, X, P, F, F, F, F, F], L3: [F, X, P, X, P, F, F, F, F, F],
    L4: [F, P, F, F, F, F, F, F, F, F], L5: [F, P, F, F, F, F, F, F, F, F], L6: [F, F, F, F, F, F, F, F, F, F],
    L7: [F, P, X, X, X, P, X, X, X, P], L8: [F, U, U, U, U, U, F, F, U, U],
  };
  const gatesAfter = (lane) => { const m = MODES[lane]; const g = { S1: ['G0', 'G1'] }; if (lane === 'L6') g.S2 = ['G1f']; if (m[2] === F || m[2] === P) g.S3 = ['G2']; if (m[3] === F) g.S4 = ['G3d']; if (m[4] === F || m[4] === P) g.S5 = ['G3']; if (m[6] === F) g.S7 = ['G4']; if (m[8] === F) g.S8b = ['G5']; if (m[9] === F) g.S9 = ['G6']; return g; };
  const routeStrip = (lane) => {
    const m = MODES[lane], g = gatesAfter(lane); const step = 80, x0 = 28, w = x0 * 2 + step * (CSTAGES.length - 1) + 30, cy = 16, h = 46;
    let s = `<line x1="${x0}" x2="${x0 + step * (CSTAGES.length - 1)}" y1="${cy}" y2="${cy}" stroke="var(--belt)" stroke-width="3"/>`;
    CSTAGES.forEach((st, i) => {
      const cx = x0 + i * step; const mode = m[i]; const col = A.laneColor(lane);
      const fill = mode === F ? col : mode === P ? 'var(--panel)' : 'var(--sunk)';
      s += `<g><title>${st}: ${mode}</title><rect x="${cx - 21}" y="${cy - 11}" width="42" height="22" rx="4" fill="${fill}" stroke="${mode === U ? 'var(--warn)' : mode === X ? 'var(--line-2)' : col}" stroke-width="1.6" ${mode === X || mode === U ? 'stroke-dasharray="3 2"' : ''}/>${mode === P ? `<path d="M${cx - 21 + 4},${cy - 11} h17 v22 h-17 q-4,0 -4,-4 v-14 q0,-4 4,-4z" fill="${col}"/>` : ''}<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="gv-st ${mode}">${mode === U ? '?' : st}</text></g>`;
      const gs = g[st] || [];
      if (gs.length) { const gx = i === CSTAGES.length - 1 ? cx + 36 : cx + step / 2; s += `<g><title>${gs.map((x) => `${x} ${D.GATES[x]?.title || ''}`).join(' · ')}</title><rect x="${gx - 5}" y="${cy - 5}" width="10" height="10" fill="var(--gate)" stroke="var(--panel)" stroke-width="1.5" transform="rotate(45 ${gx} ${cy})"/><text x="${gx}" y="${h - 4}" text-anchor="middle" class="gv-gl">${gs.join('+')}</text></g>`; }
    });
    return `<svg class="gv-route" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="${lane} route">${s}</svg>`;
  };
  const BE = [
    ['B1', 'Missing info at 1.5', '≤2 rounds, park 5 bd', 'Abandoned'], ['B2', 'Intent ambiguous: G1 again', '2×', 'E4'], ['B3', 'Validator or critic fail', 'auto_rounds 3', 'ET8'], ['B4', 'Design reveals a spec gap: S3', '1×', '—'],
    ['B5', 'Plan changes requested', '2 rejections', 'a person writes the plan'], ['B6', 'Environment broken: BLOCKED → 6.1', 'no count (rework only)', '—'], ['B7', 'Build loop limits', 'ET3 3 · ET2 5 CI or 2× time', 'D1'], ['B8', 'Scope tripwire: split Unit, G3 again', '1×', 'D1'],
    ['B9', 'Verify fails: back to S6', 'ET3–ET6 limits (1.4.0: ET3 3)', 'D2'], ['B10', 'Spec ambiguous: G2 portion again', '1×', 'D2'], ['B11', 'Approach wrong: G3 again', '1×', 'D2'], ['B12', 'Locked test must change: E6', '1×', 'D2'],
    ['B13', 'G4 changes requested', 'ET7 2 rounds', 'D3'], ['B14', 'Mode-E approver unsure → mode C', 'switch, not a loop', '—'], ['B15', 'Base moved: clean rebase S7 again / conflict S6', 'B15a 2×', '—'], ['B16', 'Rollback', 'new linked item', '—'],
    ['B17', 'Requester rejects / incident', 'new L0/L1 item (ET13)', '—'], ['B18', 'Follow-up found', 'new linked item', '—'], ['B19', 'Mode-E audit misses', '>10% over ≥20 sampled', 'suspend mode E'], ['B20', 'Requester amends scope', '1×', '—'],
    ['B21', 'Gate SLA missed', '1 bd', 'backup approver (never auto-approve)'], ['B22', 'Declined at G0', 'ends the item', '—'], ['B23', 'Spec rejected', '2 rounds', 'E4'], ['B24', 'Design rejected', '2 rounds', 'E4'],
    ['B25', 'Exception denied: redesign', '1×', 'E4'], ['B26', 'Release held', 'no count (rework only)', '—'], ['B27', 'Injection flags on G0 card', 'a flag, not a loop', '—'], ['B28', 'Rework budget', '5 total · 10 bd (tune)', 'E4'],
  ];
  const ELIG = { census: { L8: 'e', L0: 'u', L2: 'u', L7: 'u' }, light: { L1: 'e', L2: 'e', L3: 'e', L8: 'e', L0: 'u', L7: 'u', L4: 'a', L5: 'a' }, full: { L0: 'e', L1: 'e', L2: 'e', L3: 'e', L4: 'e', L5: 'e', L6: 'e', L7: 'e', L8: 'e' } };
  const VERSIONS = [
    ['1.4.0', 'not released', 'PR #531 open', 0, '—', null, 'next'], ['1.3.0', '8c2e5b0d7a41…f1', '2026-11-06', 312, 'PR #498', null, 'current'], ['1.2.0', '4b7d10e2c9a8…3c', '2026-10-24', 41, 'PR #455', null, 'pinned'], ['1.1.0', 'e09a6f3341bd…72', '2026-10-09', 9, 'PR #402', null, 'pinned'], ['1.0.0', '2f04b9e17c63…5d', '2026-09-01', 0, 'PR #311', null, 'no items'],
  ];
  const DIFF = [
    ['~', 'lanes.L0.profile.default_envelope.budget_cents', 'null', '2000'], ['~', 'lanes.L1–L3.profile.default_envelope.budget_cents', 'null', '1500'], ['~', 'lanes.L4–L5.profile.default_envelope.budget_cents', 'null', '4000'], ['~', 'lanes.L6.profile.default_envelope.budget_cents', 'null', '12000'], ['~', 'lanes.L7.profile.default_envelope.budget_cents', 'null', '1000'],
    ['~', 'eligibility.by_level.light.L0', '"unspecified"', '"eligible"'], ['~', 'eligibility.by_level.full.L0', '"unspecified"', '"eligible"'], ['~', 'eligibility.by_level.{census,light,full}.L7', '"unspecified"', '"eligible"'],
    ['+', 'eligibility.area_override.light', '', '{ "lanes": ["L4","L5"], "requires": ["FF2", "design approver"] }'],
    ['~', 'limits.B9.et3_rounds', 'null', '3'], ['~', 'triggers.ET4.thresholds.limit', 'null', '3 (tune)'], ['-', 'lanes.L8.unspecified[2]', '"which of S2-S5 the lane carries…"', ''], ['~', 'flow.hash', '4b7d10e2…', '8c2e5b0d…'],
  ];

  A.view('catalogue', {
    label: 'Catalogue', group: 'Govern', icon: 'catalogue',
    render: () => {
      const lanes = Object.keys(D.LANES);
      const limitsCard = A.kv([
        ['auto_rounds (B3)', '<b>3</b> then ET8'], ['Rework budget (B28)', '<b>5</b> edges or <b>10</b> business days, then E4 <span class="tiny faint">counted: B2–B26 · survives relane and handoff</span>'],
        ['Envelope extension', '<b>1×</b>, at most <b>+50%</b>, via E3'], ['Clarify rounds (B1)', '<b>2</b>, park <b>5</b> bd'], ['Plan rejections (B5)', '<b>2</b>, then a person writes the plan'], ['G4 rounds (B13, ET7)', '<b>2</b> then D3'],
        ['Gate SLA (B21)', '<b>1</b> business day, backup approver'], ['D4 hand back', '<b>1×</b>'], ['X3 alternative', '<b>1×</b>, else D1'], ['ET1 budget', '<b>100%</b> → D1'], ['ET2', '<b>5</b> CI rounds or <b>2×</b> time'], ['ET14 breaker trip', '<b>3</b> counts since the last reset (R3, M5)'],
      ]);
      const elig = `<div class="tbl-wrap"><table class="tbl gv-elig"><thead><tr><th>Level</th>${j(lanes, (l) => `<th>${A.lane(l)}</th>`)}</tr></thead><tbody>${j(['census', 'light', 'full'], (lv) => `<tr><td><b>${lv[0].toUpperCase() + lv.slice(1)}</b></td>${j(lanes, (l) => { const v = ELIG[lv][l]; return `<td class="gv-ec ${v || 'n'}" title="${{ e: 'eligible', u: 'unspecified: treated as not eligible', a: 'eligible per area with FF2', n: 'not eligible' }[v || 'n']}">${{ e: '●', u: '?', a: '◐', n: '·' }[v || 'n']}</td>`; })}</tr>`)}</tbody></table></div>
        <div class="row tiny muted" style="gap:14px;padding:10px 16px"><span>● eligible</span><span>◐ per area (FF2)</span><span>? unspecified = not eligible</span><span>· not eligible</span><span class="sp"></span><span>T2 tier needs Full for L1–L6</span></div>`;
      const diffHtml = `<div class="gv-diff">${j(DIFF, ([op, path, a, b]) => `<div class="gv-dl ${op === '+' ? 'add' : op === '-' ? 'del' : 'chg'}"><span class="op">${op}</span><code>${esc(path)}</code><span class="vals">${a ? `<s>${esc(a)}</s>` : ''}${a && b ? ' → ' : ''}${b ? `<b>${esc(b)}</b>` : ''}</span></div>`)}</div>`;
      return `${head({ eyebrow: 'Govern · packages/catalogue', title: 'Catalogue', sub: 'The lifecycle as data: lanes, stage subsets, gates, back-edges and their limits, and which lanes each readiness level may run. A released catalogue never changes; every item keeps running on the version it pinned.', actions: '<span class="pill plain">code · CATALOGUE_VERSION 1.3.0</span>' })}
      <div class="banner info gv-bn">${A.icon('lock', 14)}<span><b>A change is a new version with a new snapshot, released by a repo PR.</b> No portal button changes it: the META gate M3 is not wired yet (M15.5), so a release is code review. Items pin <code>{version, hash}</code> at creation; <code>catalogueFor(ref)</code> checks the pin against the snapshot and the snapshot against its own hash, and fails closed otherwise.</span></div>
      ${A.stats([
        { k: 'Current', v: '1.3.0', d: '8c2e5b0d…f1 · released 2026-11-06 (PR #498)' },
        { k: 'Items on 1.3.0', v: 312, d: 'new items since release' },
        { k: 'Items on older pins', v: 50, d: '41 on 1.3.0 · 9 on 1.2.0' },
        { k: 'Lanes', v: 9, d: 'L0–L8' },
        { k: 'Back-edges', v: 28, d: 'B1–B28, each with its limit' },
      ])}
      <div style="height:16px"></div>
      ${A.tabs('cat', [
        { id: 'lanes', label: 'Lanes', n: 9, html: `<div class="stack"><div>${A.card('Lanes and their stage subsets (1.3.0)', `<div class="gv-lanes">${j(lanes, (l) => `<div class="gv-lane-row"><div class="gv-lane-h">${A.lane(l)}<div><b>${esc(D.LANES[l].label)}</b><div class="tiny faint">${esc(D.LANES[l].route)}</div></div></div><div class="gv-lane-strip">${routeStrip(l)}</div></div>`)}</div>`, { actions: '<span class="row tiny muted" style="gap:10px"><span class="gv-lg f"></span>full<span class="gv-lg p"></span>partial<span class="gv-lg x"></span>skipped<span class="gv-lg u"></span>unspecified<span class="gtag"><i></i></span>gate</span>' })}</div>
          <div class="grid g2" style="align-items:start">${A.card('Limits (limits.ts)', limitsCard)}${A.card('Always on', `<div class="small doc"><p>S7 steps 7.1–7.6 and <b>G4</b> are mandatory on every lane but L7, whose throwaway S6 ends in the spike report and goes straight to 9.3. G4 is never skipped.</p><p style="margin-top:8px">Action and exception gates hang off steps and are conditional on their trigger: G3o after 6.3 (oracle code deviates), X1 and X3 after 6.4, E2 after 4.5 and 7.5, E6 after 7.2, X2 after 7.4, X4 after 9.3 when break-glass was used.</p><p style="margin-top:8px">L0 opens a follow-up L1 item; if it is overdue after <b>5</b> business days, new agent items on the project are blocked.</p></div>`)}</div></div>` },
        { id: 'be', label: 'Back-edges', n: 28, html: A.card('', A.table([{ h: 'Edge', r: (b) => `<span class="gtag x"><i></i>${b[0]}</span>` }, { h: 'When', r: (b) => esc(b[1]) }, { h: 'Limit', r: (b) => `<span class="mono small">${esc(b[2])}</span>` }, { h: 'Then', r: (b) => (b[3] === '—' ? '<span class="faint">—</span>' : `<span class="small">${/^[DE]\d|ET/.test(b[3]) ? A.gate(b[3].split(' ')[0]) : esc(b[3])}</span>`) }], BE), { flush: true, actions: '<span class="tiny faint">B2–B26 each add 1 to the item rework counter</span>' }) },
        { id: 'elig', label: 'Eligibility', html: A.card('Eligibility by readiness level', elig, { flush: true }) },
        { id: 'ver', label: 'Versions', n: VERSIONS.length, html: A.card('', A.table([{ h: 'Version', r: (v) => `<b class="mono">${v[0]}</b>` }, { h: 'Hash', r: (v) => `<span class="hash">${v[1]}</span>` }, { h: 'Released', r: (v) => `<span class="small muted">${v[2]}</span>` }, { h: 'Items pinned', cls: 'r', r: (v) => v[3] }, { h: 'Released by', r: (v) => `<span class="mono small">${esc(v[4])}</span>` }, { h: '', r: (v) => A.pill(v[6], v[6] === 'current' ? 'ok' : v[6] === 'pinned' ? 'info' : v[6] === 'next' ? 'warn' : 'mute') }], VERSIONS), { flush: true, actions: '<span class="tiny faint">src/snapshots/&lt;version&gt;.json · immutable</span>' }) },
        { id: 'diff', label: 'Next: 1.3.0 → 1.4.0', n: DIFF.length, html: A.card('What 1.4.0 will change (PR #531, not released)', diffHtml, { actions: '<span class="tiny faint">decided 2026-11-11: L0 from Light, L7 from Census; items on 1.3.0 keep 1.3.0’s numbers</span>' }) },
      ])}`;
    },
  });

})();
