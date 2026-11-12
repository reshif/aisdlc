/* M14 screens: S7 checks 7.1-7.5 per item (verify service), the signed Evidence Pack of 7.6 (core), the gate-check run
   status on the pull request, and the gate screens S7 raises: Q1, E6, X2, X3, E2, and X4 for a bypass merge.
   Shapes follow docs/specs/verify-api.md, gate-check-api.md and contracts verify.ts / evidence.ts / gate-check.ts. */
(function () {
  const D = A.data, E = A.esc, J = A.j, X = A.dcx;
  const hx = X.hx, rules = (l) => X.rules(l.map(([k, h]) => [k, h]));
  const name = (id) => (D.PEOPLE[id] || { name: id }).name;

  /* ================================================================ items S7 raised gates on (Payments API) */
  const I = (key, lane, stage, step, state, title, more) => ({ key, lane, stage, step, state, title, project: 'payments', gate: null, wait: [], requester: 'dn', owner: 'pm', risk: 'medium', size: 'M', type: 'feature', age: '3d', updated: '20m ago', units: [1, 1], spend: [1200, 4000], backEdges: [], ...more });
  D.ITEMS.push(
    I('W-40', 'L4', 'S7', '7.2', 'quarantined', 'Partial refunds: validate the remaining amount', { gate: 'Q1', wait: ['ks'], waitWhat: 'ET10 at 7.2: the stub probe passed on the base (tests bent to pass)', requester: 'ak', spend: [1490, 4000] }),
    I('W-41', 'L4', 'S7', '7.2', 'waiting', 'Currency rounding for HUF and ISK refunds', { gate: 'E6', wait: ['jm'], waitWhat: 'E6 (B12): a locked test must change because its approved spec moved', spend: [1810, 4000] }),
    I('W-42', 'L3', 'S7', '7.4', 'waiting', 'Make the refunds team owner of api/refunds/', { gate: 'X2', wait: ['jm', 'so'], waitWhat: 'X2: the head changes CODEOWNERS (protected path); two approvers', type: 'change', size: 'XS', risk: 'low', requester: 'rb', spend: [210, 1500] }),
    I('W-43', 'L4', 'S7', '7.4', 'waiting', 'Validate payout contact phone numbers', { gate: 'X3', wait: ['jm'], waitWhat: 'X3: one new runtime dependency', requester: 'pm', spend: [1660, 4000] }),
  );
  const w25 = A.item('W-25'); Object.assign(w25, { step: '4.5', state: 'waiting', gate: 'E2', wait: ['jm', 'so'], waitWhat: 'E2: the design calls a host the constitution does not allow (C-EGRESS)' });
  X.extra = [{ kind: 'gate', gate: 'X4', key: 'merge-payments-417', p: 'payments', title: 'Bypass merge review', sub: 'acme/payments-api#417 · merged by Alex Rivera' }];
  X.KEY_PROJECT['merge-payments-417'] = 'payments'; X.SUBJ_REQ['merge-payments-417'] = 'ar';
  Object.assign(X.DUE, { 'gate-Q1-W-40': 210, 'gate-E6-W-41': 330, 'gate-X2-W-42': 400, 'gate-X3-W-43': 280, 'gate-E2-W-25': 150, 'gate-X4-merge-payments-417': 1300 });
  Object.assign(X.OPENED, { 'gate-Q1-W-40': '1h ago', 'gate-E6-W-41': '3h ago', 'gate-X2-W-42': '40m ago', 'gate-X3-W-43': '2h ago', 'gate-E2-W-25': '5h ago', 'gate-X4-merge-payments-417': '18h ago' });

  /* ================================================================ check results (VerifyRunResult per step, for the item's Unit head) */
  const P = 'passed', F = 'failed', RUN = 'running', RAISED = 'gate', TODO = 'not run';
  const R = (verdict, facts, findings = [], o = {}) => ({ verdict, facts, findings, ...o });
  const base = { '7.1': R(P, [['build', 'ok'], ['typecheck', 'ok'], ['lint', 'ok'], ['format-check', 'ok'], ['test', '412 passed']]), '7.2': R(P, [['locks', '6 of 6 locked oracles unchanged'], ['static stub probe', 'no stub test'], ['stub probe on the base', 'red, as at 6.3 (good)'], ['mutation score', '5 of 6 killed · 0.83 (min 0.5)'], ['holdout', 'holdout_none: no repo holdout store yet']]), '7.3': R(P, [['oracle binding', 'matches 6.3'], ['locked oracles on head', '6 green'], ['A5 spec_conformance', 'no high finding']]), '7.4': R(P, [['new secrets', '0 (rules v7, NEW only)'], ['new dependencies', 'none'], ['protected paths', 'none touched']]), '7.5': R(P, [['egress hosts in added lines', 'none new'], ['migrations added', 'none'], ['A5 constitution', 'no high finding']]) };
  const RESULTS = {
    'W-24': { unit: 'u3', head: '4c01aa9', base: '3f9c2ab', steps: { ...base, '7.2': R(P, [['locks', '4 of 4 unchanged'], ['static stub probe', 'no stub test'], ['stub probe on the base', 'red (good)'], ['mutation score', '6 of 6 killed · 1.00'], ['holdout', 'holdout_none']]) }, pack: true, pr: 'acme/payments-api#412' },
    'W-20': { unit: 'u2', head: '9e1b44c', base: '3f9c2ab', steps: { '7.1': base['7.1'], '7.2': base['7.2'], '7.3': R(RUN, [['oracle binding', 'matches 6.3'], ['locked oracles on head', '3 of 5 run'], ['A5 spec_conformance', 'running in a V session (ses-7f20)']]) } },
    'W-37': { unit: 'main', head: 'b71e0d2', base: '3f9c2ab', steps: { '7.1': R(RUN, [['build', 'ok'], ['typecheck', 'ok'], ['test', 'running']]) } },
    'W-40': { unit: 'main', head: 'e04f9a1', base: '3f9c2ab', steps: { '7.1': base['7.1'], '7.2': R(RAISED, [['locks', '5 of 5 unchanged'], ['static stub probe', 'test/refunds/partial.test.ts: assertion on a constant'], ['stub probe on the base', 'GREEN on the base: the oracle passes without the change']], [{ kind: 'stub_probe_passed', severity: 'critical', cls: 'hard_fail', rule: 'ET10', path: 'test/refunds/partial.test.ts', line: 41 }], { gate: 'Q1', note: 'ET10 before anything else ran: the session is tainted; SECT triage comes before any handoff.' }) } },
    'W-41': { unit: 'u1', head: '5a2c771', base: '3f9c2ab', steps: { '7.1': base['7.1'], '7.2': R(RAISED, [['locks', '1 locked oracle whose approved spec moved (G2 r2 → r3)'], ['mutation score', '0.67'], ['holdout', 'holdout_none']], [{ kind: 'locked_test_spec_moved', severity: 'high', cls: 'needs_gate', rule: 'B12', path: 'test/oracles/rounding.oracle.test.ts', line: 18 }], { gate: 'E6' }) } },
    'W-42': { unit: 'main', head: 'c3d9e20', base: '3f9c2ab', steps: { '7.1': base['7.1'], '7.2': base['7.2'], '7.3': base['7.3'], '7.4': R(RAISED, [['new secrets', '0'], ['new dependencies', 'none'], ['protected paths', 'CODEOWNERS (DEFAULT_PROTECTED_GLOBS)']], [{ kind: 'protected_path_changed', severity: 'high', cls: 'needs_gate', rule: 'X2', path: 'CODEOWNERS', line: 12 }], { gate: 'X2' }) } },
    'W-43': { unit: 'u2', head: '7f6e310', base: '3f9c2ab', steps: { '7.1': base['7.1'], '7.2': base['7.2'], '7.3': base['7.3'], '7.4': R(RAISED, [['new secrets', '0'], ['new dependencies', 'libphonenumber-js 1.11.x (runtime) [PLACEHOLDER version]'], ['protected paths', 'none']], [{ kind: 'dependency_unapproved', severity: 'high', cls: 'needs_gate', rule: 'X3', path: 'package.json', line: 31 }], { gate: 'X3' }) } },
    'I-11': { unit: 'main', head: '18aa0c4', base: '0b7e5c1', steps: { '7.1': R(RUN, [['build', 'ok'], ['test', 'running']]) } },
  };
  const STEP_T = { '7.1': ['Deterministic checks', 'O'], '7.2': ['Test integrity and oracle quality', 'O'], '7.3': ['Spec conformance', 'O + A5'], '7.4': ['Secrets and dependencies', 'O'], '7.5': ['Constitution check', 'A5'], '7.6': ['Pack assembly and sign', 'core'] };
  const vPill = (v, g) => (v === P ? A.pill('passed', 'ok') : v === RUN ? A.pill('running', 'info') : v === F ? A.pill('failed', 'bad') : v === RAISED ? `${A.pill('raised', 'gate')} ${A.gate(g)}` : A.pill('not run', 'mute'));
  const resultOf = (it) => RESULTS[it.key] || (['S8', 'S9'].includes(it.stage) ? { unit: 'main', head: hx(it.key, 7), base: '3f9c2ab', steps: base, pack: true } : null);
  const packId = (it) => hx('pack' + it.key);
  const packed = (it) => { const r = resultOf(it); return r && (r.pack || ['S8', 'S9'].includes(it.stage)); };
  /** gate-check verdicts on the PR head (GET /v1/verdicts?item=), newest first */
  const verdictsOf = (it) => {
    const r = resultOf(it); if (!r || !it.pr) return [];
    const out = [{ head: r.head, conclusion: 'success', reason: 'passed', at: '2h ago' }];
    if (it.backEdges.some((b) => b.id === 'B13')) out.push({ head: '1d77e3b', conclusion: 'failure', reason: 'head_moved', at: '1d ago' }, { head: '1d77e3b', conclusion: 'success', reason: 'passed', at: '2d ago' });
    return out;
  };

  const verifyTab = (it) => {
    if (it.lane === 'L7') return A.empty('Spikes never reach S7 or G4: 6.5 ends in a spike report, the branch is archived and nothing is pushed.');
    const r = resultOf(it);
    if (!r) return `<div class="banner info">${A.icon('evals', 14)}<span>S7 has not started: ${E(it.key)} is at ${E(it.step)}. It runs 7.1 to 7.5 on the Unit head in O sessions, then 7.6 signs the Evidence Pack.</span></div>`;
    const steps = ['7.1', '7.2', '7.3', '7.4', '7.5'].map((s) => ({ s, res: r.steps[s] || R(TODO, []) }));
    const raised = steps.find((x) => x.res.verdict === RAISED);
    const done = steps.filter((x) => x.res.verdict === P).length;
    const signed = packed(it);
    return A.stats([
      { k: 'Checks passed', v: `${done} of 5`, d: 'latest result per step for this head', tone: done === 5 ? 'ok' : '' },
      { k: 'Unit head', v: r.head, d: `Unit ${r.unit} · base ${r.base} (bound by G3)` },
      { k: '7.6 Evidence Pack', v: signed ? 'signed' : raised ? 'blocked' : 'not yet', d: signed ? `pack ${packId(it).slice(0, 10)}… · Notary evidence scope` : raised ? `${raised.res.gate} must be approved at ${raised.s}` : 'needs every step 7.1–7.5 passed', tone: signed ? 'ok' : raised ? 'warn' : '' },
    ]) + (raised ? `<div class="banner ${raised.res.gate === 'Q1' ? 'bad' : 'gate'}" style="margin-top:14px">${A.icon('lock', 14)}<span><b>${E(raised.s)} raised ${E(raised.res.gate)}.</b> ${E(raised.res.note || 'The result’s hash is bound into the gate; the item goes on to 7.6 only when it is approved at that step.')}</span><span class="sp"></span><a class="btn sm" href="#gate-${raised.res.gate}-${it.key}">Open ${E(raised.res.gate)}</a></div>` : '') +
      `<section class="card" style="margin-top:14px"><div class="hd"><h3>S7 checks</h3><span class="sp"></span><span class="tiny faint">verify service · POST /v1/checks · never the coder</span></div><div class="bd flush">${J(steps, ({ s, res }) => `<details class="m14-chk" ${res.verdict !== P ? 'open' : ''}><summary><span class="mono">${s}</span><b>${E(STEP_T[s][0])}</b><span class="tiny faint">${E(STEP_T[s][1])}</span><span class="sp"></span>${vPill(res.verdict, res.gate)}</summary>
        <div class="m14-body">${res.facts.length ? A.kv(res.facts.map(([k, v]) => [E(k), `<span class="small">${E(v)}</span>`])) : '<p class="small muted">Waits for the step before it.</p>'}
        ${res.findings.length ? `<div class="tbl-wrap" style="margin-top:8px"><table class="tbl"><thead><tr><th>Finding</th><th>Severity</th><th>Class</th><th>Rule</th><th>Where</th></tr></thead><tbody>${J(res.findings, (f) => `<tr><td class="mono small">${E(f.kind)}</td><td>${A.pill(f.severity, f.severity === 'critical' ? 'bad' : 'warn')}</td><td class="mono small">${E(f.cls)}</td><td class="mono small">${E(f.rule)}</td><td class="mono small">${E(f.path)}:${f.line}</td></tr>`)}</tbody></table></div>` : ''}
        ${res.verdict !== TODO ? `<div class="tiny faint" style="margin-top:6px">result ${A.hash(hx(it.key + s + res.verdict), 12)} · GET /v1/results/:sha</div>` : ''}</div></details>`)}
        <details class="m14-chk" ${signed ? '' : ''}><summary><span class="mono">7.6</span><b>Pack assembly and sign</b><span class="tiny faint">core</span><span class="sp"></span>${signed ? A.pill('signed', 'ok') : A.pill('waiting', 'mute')}</summary><div class="m14-body small muted">Every step met: the passing pack. A failed check goes back by B9 (to 6.4) or B11 (to 5.1) while the pinned catalogue leaves the edge a round, else D2; a check with no verdict is D2 (ET4); a raised gate not approved is D2 (ET6).</div></details>
      </div></section>` +
      (signed ? `<div class="grid g2" style="margin-top:14px;align-items:start">${A.card('Evidence Pack', A.kv([['Pack id', A.hash(packId(it), 16)], ['Format', '<span class="mono small">aisdlc-evidence-pack/1</span>'], ['Head', `<span class="mono">${r.head}</span>`], ['Signed', 'Notary · evidence scope · ES256']]), { foot: `<a class="btn sm primary" href="#pack-${it.key}">Open the pack</a>` })}
        ${it.pr ? A.card('gate-check on the PR', `<div class="m14-run ok"><span class="mono">aisdlc/gate</span> ${A.pill('success', 'ok')}<span class="small">on <span class="mono">${r.head}</span> · passed</span></div><p class="tiny faint" style="margin-top:8px">Written on the head commit by gate-check’s own App (checks:write only). A new push makes the old pass not apply (head_moved).</p>`, { foot: `<a class="btn sm" href="#pack-${it.key}">Verdict history</a>` }) : ''}</div>` : '');
  };
  A.m14 = { verifyTab, resultOf, packed: (it) => !!packed(it), packId };

  /* ================================================================ the Evidence Pack viewer */
  A.view('pack', {
    nav: false, parent: 'items', match: /^pack-(.+)$/,
    access: ([k]) => { const it = A.item(k); if (!it || !A.canSeeProject(it.project)) return null; return { action: 'item.view_floor', res: { type: 'Item', project: it.project, item: k } }; },
    render: ([k]) => {
      const it = A.item(k); if (!it || !A.canSeeProject(it.project)) return A.notFoundHtml();
      const r = resultOf(it);
      if (!r || !packed(it)) return A.pageHead({ crumbs: `<a href="#items">Items</a><span>›</span><a href="#item-${it.key}">${it.key}</a><span>›</span><span>Evidence Pack</span>`, eyebrow: '7.6', title: 'No Evidence Pack yet', sub: `${E(it.key)} is at ${E(it.step)}. 7.6 signs a pack only when the latest result of every step 7.1–7.5 for the Unit head passed and every gate a check raised was approved.` }) + `<a class="btn" href="#item-${it.key}">Back to ${E(it.key)}</a>`;
      if (A.viewLevel(it.project) < 2) return A.forbidden('ops.read', { type: 'Project', project: it.project }, 'The Evidence Pack needs view level V2');
      const id = packId(it); const vs = verdictsOf(it); const key = `evidence-packs/${id}`;
      const steps = ['7.1', '7.2', '7.3', '7.4', '7.5'];
      const cmd = `aisdlc-verify-pack --pack ${id.slice(0, 12)}….json --notary-key notary-evidence.jwk --head ${r.head}`;
      return A.pageHead({ crumbs: `<a href="#items">Items</a><span>›</span><a href="#item-${it.key}">${it.key}</a><span>›</span><span>Evidence Pack</span>`, eyebrow: `aisdlc-evidence-pack/1 · ${E(A.project(it.project).name)}`, title: `Evidence Pack · ${E(it.key)} Unit ${E(r.unit)}`, sub: 'Ids, hashes, verdicts and counts only: no message and no content. Its id is the sha256 of its canonical JSON; the Notary signs it, and the signed bytes live under their sha256 in the write-once bucket.', actions: `<button class="btn primary" data-m14verify>Verify offline</button><button class="btn" data-toast="Downloaded ${E(id.slice(0, 12))}….json (signed bytes)">Download signed pack</button>` }) +
        `<div class="split"><div class="stack">
          ${A.card('Binding', A.kv([['Pack id', A.hash(id, 24)], ['Item · Unit', `${A.ichip(it.key)} · <span class="mono">${E(r.unit)}</span>`], ['Head', `<span class="mono">${r.head}</span>`], ['Base (bound by G3)', `<span class="mono">${r.base}</span>`], ['Lane · tier', `${A.lane(it.lane)} · T1`], ['Gating profile', A.hash(hx('gp' + it.project), 12) + ' <span class="tiny faint">the item’s pinned profile</span>'], ['Catalogue', '<span class="mono small">1.3.0 · 8c2e…f1</span>'], ['Push receipt', `${A.hash(hx('push' + it.key), 12)} <span class="tiny faint">agent/${E(it.key)}/${E(r.unit)}</span>`], ['Oracle locks', `${(r.steps['7.2'].facts[0] || ['', ''])[1]}`]]))}
          ${A.card('Steps', A.table([{ h: 'Step', r: (s) => `<span class="mono">${s}</span> ${E(STEP_T[s][0])}` }, { h: 'Result hash', r: (s) => A.hash(hx(it.key + s + 'passed'), 12) }, { h: 'Verdict', r: (s) => vPill(r.steps[s].verdict) }, { h: 'Failing findings', r: () => '<span class="faint small">none</span>' }], steps), { flush: true })}
          ${A.card('Gates the item raised', A.table([{ h: 'Gate', r: (g) => A.gate(g[0]) }, { h: 'Decision', r: (g) => A.pill(g[1], 'ok') }, { h: 'Ledger', r: (g) => `<span class="mono">${g[2]}</span>` }], [['G0G1', 'approved', '17,902'], ['G2', 'approved', '18,041'], ['G3', 'approved', '18,166']].concat(it.key === 'W-24' ? [] : [])), { flush: true })}
        </div><aside class="stack">
          ${A.card('Signature', A.kv([['Signed by', 'Notary · evidence scope'], ['Message', '<span class="small">domain-separated, over the pack id</span>'], ['Journal', '<span class="mono small">notary.evidence_signature</span>'], ['Object', `<span class="mono tiny">${E(key.slice(0, 40))}…</span> <span class="pill plain">write-once</span>`], ['Recorded', `<span class="mono small">evidence.pack_signed</span> on evidence:${E(it.key)} + ledger entry`]]) + `<div data-m14out style="margin-top:10px"></div>`)}
          ${A.card('Verify it yourself', `<p class="small muted">Anyone with the Notary’s public key can check a pack without the factory: canonical form, object key, pack hash, signature, head and item.</p><pre class="code">${E(cmd)}</pre>`)}
          ${vs.length ? A.card('gate-check on ' + E(it.pr), `<ul class="tl">${J(vs, (v) => `<li><span class="when">${E(v.at)}</span><span class="dot ${v.conclusion === 'success' ? 'g' : 'x'}"></span><div class="what"><div class="t"><span class="mono">aisdlc/gate</span> ${A.pill(v.conclusion, v.conclusion === 'success' ? 'ok' : 'bad')}</div><div class="m">head <span class="mono">${E(v.head)}</span> · ${E(v.reason)}</div></div></li>`)}</ul><p class="tiny faint">GET /v1/verdicts?item=${E(it.key)}. Passes only when the PR head equals the pack’s head, the bytes verify offline and G3 is decided approve. gate-check never merges; a person merges on GitHub.</p>`) : ''}
        </aside></div>`;
    },
    mount: (root, [k]) => { const b = root.querySelector('[data-m14verify]'); if (b) b.onclick = () => { const it = A.item(k); const r = resultOf(it); root.querySelector('[data-m14out]').innerHTML = rules([['ok', 'canonical JSON: ok'], ['ok', `object key = sha256 of the signed bytes`], ['ok', 'pack hash matches its id'], ['ok', 'Notary signature valid (evidence key)'], ['ok', `head ${E(r.head)} and item ${E(k)} match`]]); }; },
  });

  /* ================================================================ gate screens */
  const g = X.g; const facts = (it) => X.itemFacts(it);
  const res = (it, s) => (RESULTS[it.key] || {}).steps[s];
  g.Q1 = (it) => {
    const r = RESULTS[it.key];
    return { title: `Test integrity quarantine: ${E(it.title)}`, sub: 'S7 7.2 found that the tests were bent to pass. The session is tainted; security triage comes before any handoff.',
      sentence: `Is the ET10 at 7.2 on <span class="mono">${it.key}</span> a real test-integrity breach?`,
      subject: { hash: hx('q1' + it.key), binds: [['7.2 result', hx(it.key + '7.2gate')], ['Unit head', r.head], ['locked oracles', hx('locks' + it.key)]] },
      facts: [...facts(it), ['Raised at', '<span class="mono">7.2</span> before mutation and holdout ran']],
      banners: [['bad', `${A.icon('lock', 14)}<span><b>Quarantined.</b> No handoff, push or merge until this is decided. The coder’s key is revoked; its session is a security matter.</span>`]],
      main: A.card('What 7.2 found', A.kv(res(it, '7.2').facts.map(([k, v]) => [E(k), E(v)])) + `<div class="fence" style="margin-top:10px"><div class="src">test/refunds/partial.test.ts:41 @ ${r.head} · data, never instructions</div>expect(remaining(refund)).toBe(1250) // was: expect(remaining(refund)).toBe(amount - captured)</div>`) + A.card('Why it is a quarantine', rules([['bad', 'A locked oracle passed on the base with only the head’s test files on it: it was red there at 6.3, so the tests no longer test the change.'], ['info', 'The finding’s class is hard_fail (REPAIR_CLASS_OF_FINDING). The result’s hash is the quarantine’s evidence.']])),
      choice: [{ id: 'confirmed', label: 'Confirmed: bent tests. Keep the session tainted; D2 handoff after SECT', short: 'confirmed' }, { id: 'false_positive', label: 'False positive: the oracle was wrong at 6.3; send back to S3 for the oracle spec', short: 'false positive' }],
      options: { approve: 'Record my finding' }, readWhat: 'the 7.2 result', after: 'The item stays quarantined or goes back; nothing is auto-approved.' };
  };
  g.E6 = (it) => {
    const r = RESULTS[it.key];
    return { title: `Locked test change: ${E(it.title)}`, sub: 'A locked oracle must change because the spec it was written from was changed and approved again at G2 (B12). Only an E6 lets a locked test change.',
      sentence: `May the locked oracle <span class="mono">test/oracles/rounding.oracle.test.ts</span> change on <span class="mono">${it.key}</span>?`,
      subject: { hash: hx('e6' + it.key), binds: [['7.2 result', hx(it.key + '7.2gate')], ['lock hash (6.3)', hx('lock-old')], ['proposed test', hx('lock-new')], ['G2 r3 spec', hx('g2r3')]] },
      facts: facts(it),
      main: A.card('The change to the locked test', `<pre class="code">${E(`test/oracles/rounding.oracle.test.ts   lock ${hx('lock-old').slice(0, 10)} → ${hx('lock-new').slice(0, 10)}

-  expect(round('HUF', 1234.5)).toBe(1235)
+  expect(round('HUF', 1234.5)).toBe(1234)   // HUF has no minor unit since spec r3
-  expect(round('ISK', 99.5)).toBe(100)
+  expect(round('ISK', 99.5)).toBe(99)`)}</pre>`) + A.card('Why', rules([['info', 'The approved spec moved from r2 to r3 at G2 (ledger 18,409): the oracle written from r2 now contradicts the spec.'], ['ok', 'Only the two assertions that the spec change touches differ; every other locked oracle is unchanged.'], ['warn', 'Approving re-locks the test with the new hash; 7.2 then runs again on the same head.']])),
      options: { approve: 'Approve the test change', changes: 'Ask for a smaller change', reject: 'Reject (D2)' }, readWhat: 'the test diff and the spec change', after: 'The test is re-locked and 7.2 runs again.' };
  };
  g.X2 = (it) => {
    const r = RESULTS[it.key]; const patch = hx('patch' + it.key);
    return { title: `Protected-path change: ${E(it.title)}`, sub: 'The head changes a protected path (DEFAULT_PROTECTED_GLOBS). Two different approvers decide X2; the patch hash binds exactly this diff.',
      sentence: `May the change to <span class="mono">CODEOWNERS</span> in <span class="mono">${r.head}</span> go on?`,
      subject: { hash: hx('x2' + it.key), binds: [['patch', patch], ['7.4 result', hx(it.key + '7.4gate')], ['Unit head', r.head]] },
      facts: [...facts(it), ['Patch hash', A.hash(patch, 16)], ['Protected glob', '<span class="mono">CODEOWNERS</span>']],
      main: A.card('The protected-path diff', `<pre class="code">${E(`CODEOWNERS   @ ${r.head}   patch sha256:${patch.slice(0, 16)}…

  /api/               @acme/payments
- /api/refunds/       @arivera
+ /api/refunds/       @acme/refunds @arivera
  /billing/           @acme/payments @sosei`)}</pre>`) + A.card('What it changes', rules([['warn', 'G4 for api/refunds/ moves to the refunds team on GitHub: the project’s g4 slot is codeowners, so new deciders appear for that path.'], ['info', 'The Push Broker refuses a protected-path write without an X2 approved at 6.6; here the change was found at 7.4, so X2 is decided on the pushed head.'], ['info', 'A later push changes the patch hash and needs X2 again.']])),
      options: { approve: 'Approve (1 of 2)', changes: 'Request changes', reject: 'Reject' }, readWhat: 'the diff and its patch hash', after: 'With the second approval, 7.4 records X2 approved and S7 goes on.' };
  };
  g.X3 = (it) => ({ title: `New dependency: ${E(it.title)}`, sub: 'S7 7.4 found a dependency the head adds that no X3 approved. You decide whether the factory may take it.',
    sentence: `May <span class="mono">${it.key}</span> add <span class="mono">libphonenumber-js</span> as a runtime dependency?`,
    subject: { hash: hx('x3' + it.key), binds: [['manifest diff', hx('man' + it.key)], ['7.4 result', hx(it.key + '7.4gate')]] },
    facts: facts(it),
    main: A.card('The package', A.kv([['Package', '<span class="mono">libphonenumber-js</span>'], ['Version', '<span class="mono">[PLACEHOLDER]</span> exact pin in package-lock.json'], ['Kind', 'runtime (dependencies)'], ['Licence', 'MIT [PLACEHOLDER: from the package metadata]'], ['Advisories', 'not checked: no advisory database is wired yet (verify-api §8)'], ['Size', '[PLACEHOLDER]'], ['Transitive additions', '0 new packages'], ['Where', '<span class="mono small">package.json:31</span>']])) + A.card('What X3 weighs', rules([['info', 'The factory checks only what was added and whether X3 approved it; advisories are a gap until an advisory source exists.'], ['info', 'An alternative may be asked for once; after that the item hands off (D1).']])),
    options: { approve: 'Approve the dependency', changes: 'Ask for an alternative (1×)', reject: 'Reject' }, readWhat: 'the package facts', after: '7.4 runs again with the dependency approved.' });
  g.E2 = (it) => ({ title: `Constitution exception: ${E(it.title)}`, sub: '4.5 ran the factory constitution on the design beside A5’s review. A rule is violated, so the item stops until an exception is decided (two people).',
    sentence: `May <span class="mono">${it.key}</span> call <span class="mono">api.payouts-partner.example</span>, a host the constitution does not allow?`,
    subject: { hash: hx('e2' + it.key), binds: [['constitution_report', hx('cr' + it.key)], ['factory.constitution v2', hx('const2')], ['design 4.2', hx('d42' + it.key)]] },
    facts: [...facts(it), ['Constitution', `<a class="mono small" href="#cfg-factory.constitution">factory.constitution v2</a>`]],
    main: A.card('Constitution report', A.table([{ h: 'Rule', r: (x) => `<span class="mono">${x[0]}</span>` }, { h: 'Kind', r: (x) => `<span class="mono small">${x[1]}</span>` }, { h: 'Finding', r: (x) => `<span class="small">${E(x[2])}</span>` }, { h: '', r: (x) => A.pill(x[3], x[3] === 'violation' ? 'bad' : 'ok') }], [['C-EGRESS', 'no_unapproved_egress', 'design 4.2 adds POST https://api.payouts-partner.example/v2/batches; allow_hosts has api.stripe.com, hooks.slack.com; no approval reference', 'violation'], ['C-MIGRATION', 'migrations_reversible_or_flagged', '0007_payout_batches.sql has a down section', 'ok']]), { flush: true }) + A.card('A5 review at 4.5', rules([['warn', 'High: the partner API carries merchant bank details (D2) to a new host.'], ['info', 'Approving records an approval reference for this design only; the host is not added to allow_hosts (that is a factory.constitution revision, M1).']])),
    options: { approve: 'Approve the exception (1 of 2)', changes: 'Redesign (B25)', reject: 'Reject' }, readWhat: 'the constitution report', after: 'With two approvals, S4 continues with the approval reference bound to the design.' });
  g.X4 = (it, key) => {
    const bp = (A.cfg.inForce('codehost.merge_bypass').doc['acme/payments-api'] || []);
    return { title: 'Bypass merge review: acme/payments-api#417', sub: 'gate-check saw a pull request merged without a passing aisdlc/gate. The merger is on the repo’s bypass list, so it is a bypass, not unauthorised; every bypass gets this X4 review.',
      sentence: 'Was the bypass merge of <span class="mono">acme/payments-api#417</span> by Alex Rivera justified?',
      subject: { hash: hx('x4' + key), binds: [['merge id', hx('merge417')], ['merged head', 'd41c2e9'], ['bypass list (factory r19)', hx('factory19')]] },
      facts: [['Pull request', '<span class="mono">acme/payments-api#417</span> · non-agent PR'], ['Merged by', `${A.who('ar')} <span class="mono tiny">@arivera</span>`], ['Merged', 'yesterday 22:14 · head <span class="mono">d41c2e9</span>'], ['aisdlc/gate on that head', A.pill('action_required: not_factory_work', 'warn')], ['Bypass list', bp.length ? `${J(bp, (b) => `<span class="mono small">@${E(b.login)}</span> `)} <a class="small" href="#cfg-codehost.merge_bypass">factory r19</a>` : 'empty'], ['Class', '<span class="mono">gatecheck.bypass_merge</span>']],
      main: A.card('What happened', rules([['info', 'A person wrote and merged this change on GitHub; the factory never pushed it, so no Evidence Pack applies (profile non_agent).'], ['ok', 'Laundering checks: not on an agent/ branch, no Push Broker head, no pack id cited, no factory trailers.'], ['info', 'Reason in the PR: “INC-2214: the 3DS retry hotfix W-37 was still in S7; stop double charges now.”']])) + A.card('Diff summary', `<pre class="code">api/src/three-ds/retry.ts   +6 −2\ntest/three-ds/retry.test.ts +14</pre><p class="tiny faint">Read the full diff on GitHub; the portal shows the stat only.</p>`),
      options: { approve: 'Accept the bypass', changes: 'Follow-up needed (opens an item)', reject: 'Not justified' }, readWhat: 'the merge facts', after: 'The review is recorded on the ledger. A follow-up opens a linked item; “not justified” is raised with the project admin.' };
  };
})();
