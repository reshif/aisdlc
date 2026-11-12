/* Quality: Agents (the registry as code), one agent, Evals (run history only), Models and routes, Integrations.
   Reads come from the agent registry (packages/agents), the eval run history (core.eval_run) and the effective config
   (A.cfg); every change goes through the configuration pattern or, for an agent itself, a repo PR plus the eval gate. */
(function () {
  const D = A.data, E = A.esc, J = A.j, C = A.cfg;
  const FLEET = { type: 'Fleet' };
  const name = (id) => (D.PEOPLE[id] || { name: id }).name;
  const rules = (list) => `<div class="dc-rule">${J(list, ([k, h]) => `<div><span class="dc-ico ${k}">${{ ok: '✓', warn: '!', bad: '✕', info: 'i' }[k]}</span><span>${h}</span></div>`)}</div>`;
  const mono = (s) => `<span class="mono">${E(s)}</span>`;
  const sgn = (v, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}`;
  const qualityRes = () => { if (A.can('quality.read', FLEET)) return FLEET; const p = D.PROJECTS.find((x) => A.canSeeProject(x.id) && A.viewLevel(x.id) >= 2); return p ? { type: 'Project', project: p.id } : FLEET; };
  const qualityAccess = () => ({ action: 'quality.read', res: qualityRes() });
  const canChange = () => A.can('config.propose', FLEET);
  const stepTitle = (s) => (D.STEPS[s] || [])[2] || (s === 'D1' ? 'Handoff pack' : '');
  const stepChip = (s, spec) => { const st = D.STEPS[s]; return `<span class="ql-step ${spec ? 'spec' : ''}" title="${E(stepTitle(s))}${spec ? ' (specialist: a deterministic step calls it in)' : ''}">${st ? A.actors(A.actorKinds(st[1]), 13) : ''}<span class="mono">${E(s)}</span></span>`; };
  const prodModel = (a) => { const r = C.inForce('gateway.routes').doc.find((x) => x.environment === 'prod' && x.data_class === a.dc); return r ? r.model_id : null; };
  const scoreHtml = (a) => (a.score == null ? `<span class="faint small">${a.unbound ? 'never run' : 'no eval suite'}</span>` : `<b class="num">${a.score.toFixed(2)}</b> <span class="ql-d ${a.delta > 0.005 ? 'up' : a.delta < -0.005 ? 'down' : ''}">${sgn(a.delta)}</span>`);

  /* ================================================================ eval run history (core.eval_run, recorded by the aisdlc-evals CLI) */
  const RUNS = [
    { id: 'er-0418', agent: 'A3', prompt: 'a3_planner@1.1.0 (PR #529)', provider: 'anthropic', model: 'claude-sonnet-5-5', suite: 'planning', cases: 48, k: 5, pass: 0.81, base: 0.86, lo: -0.08, hi: -0.02, gate: 'fail', why: 'significant regression −0.05 (90% CI −0.08 … −0.02)', at: 'today 08:40', candidate: true },
    { id: 'er-0417', agent: 'A6', prompt: 'a6_test@1.2.0 (PR #533)', provider: 'anthropic', model: 'claude-sonnet-5-5', suite: 'coding', cases: 30, k: 5, pass: 0.9, base: 0.88, lo: -0.01, hi: 0.05, gate: 'pass', at: 'today 07:55', candidate: true },
    { id: 'er-0416', agent: 'A5', prompt: 'a5_review@1.0.0', provider: 'anthropic', model: 'claude-sonnet-5-5', suite: 'review', cases: 40, k: 5, pass: 0.92, base: 0.88, lo: 0.01, hi: 0.07, gate: 'pass', at: 'yesterday 18:10' },
    { id: 'er-0415', agent: 'A5', prompt: 'a5_review@1.0.0', provider: 'codex', model: 'codex', suite: 'review', cases: 40, k: 5, pass: 0.87, base: null, lo: null, hi: null, gate: 'fail', why: 'no baseline for provider codex', at: 'yesterday 17:40' },
    { id: 'er-0414', agent: 'A1', prompt: 'a1_triage@1.0.0', provider: 'anthropic', model: 'claude-sonnet-5-5', suite: 'planning', cases: 36, k: 5, pass: 0.94, base: 0.92, lo: -0.01, hi: 0.05, gate: 'pass', at: 'yesterday 11:02' },
    { id: 'er-0413', agent: 'A2', prompt: 'a2_intent@1.0.0', provider: 'anthropic', model: 'claude-sonnet-5-5', suite: 'planning', cases: 28, k: 5, pass: 0.91, base: 0.91, lo: -0.03, hi: 0.03, gate: 'pass', at: '2026-11-10' },
    { id: 'er-0412', agent: 'coder', prompt: 'coder@1.0.0', provider: 'anthropic', model: 'claude-sonnet-5-5', suite: 'coding', cases: 24, k: 3, pass: 0.81, base: 0.78, lo: -0.02, hi: 0.08, gate: 'pass', at: '2026-11-10' },
    { id: 'er-0411', agent: 'A9', prompt: 'a9_reverse_engineering@1.0.0', provider: 'anthropic', model: 'claude-sonnet-5-5', suite: 'knowledge', cases: 22, k: 3, pass: 0.87, base: 0.87, lo: -0.04, hi: 0.04, gate: 'pass', at: '2026-11-09' },
    { id: 'er-0410', agent: 'A12', prompt: 'a12_extraction@1.0.0', provider: 'anthropic', model: 'claude-sonnet-5-5', suite: 'knowledge', cases: 20, k: 3, pass: 0.84, base: 0.85, lo: -0.05, hi: 0.03, gate: 'pass', at: '2026-11-09' },
    { id: 'er-0409', agent: 'A11', prompt: 'a11_handoff_pack@1.0.0', provider: 'anthropic', model: 'claude-sonnet-5-5', suite: 'handoff', cases: 18, k: 5, pass: 0.95, base: 0.95, lo: -0.02, hi: 0.02, gate: 'pass', at: '2026-11-08' },
    { id: 'er-0408', agent: 'A6', prompt: 'a6_test@1.1.0', provider: 'anthropic', model: 'claude-sonnet-5-5', suite: 'coding', cases: 30, k: 5, pass: 0.88, base: 0.88, lo: -0.03, hi: 0.03, gate: 'pass', at: '2026-11-07' },
    { id: 'er-0407', agent: 'A3', prompt: 'a3_planner@1.0.0', provider: 'anthropic', model: 'claude-sonnet-5-5', suite: 'planning', cases: 48, k: 5, pass: 0.86, base: 0.89, lo: -0.06, hi: 0.004, gate: 'pass', why: 'not significant: the interval crosses 0', at: '2026-11-06' },
  ];
  const BASELINES = [['anthropic', 'baselines/anthropic.json', '2026-10-30', 'signed ES256 · dev:eval-store'], ['codex', '—', '—', 'none: every run on codex fails the gate (no baseline)'], ['deepseek', '—', '—', 'none']];
  const gatePill = (g) => A.pill(g === 'pass' ? 'gate pass' : 'gate fail', g === 'pass' ? 'ok' : 'bad');
  const ci = (r) => { if (r.lo == null) return '<span class="faint small">no baseline</span>'; const x = (v) => 50 + v * 400; return `<svg width="110" height="16" viewBox="0 0 110 16" role="img" aria-label="90% interval ${sgn(r.lo)} to ${sgn(r.hi)}"><line x1="55" x2="55" y1="1" y2="15" stroke="var(--line-2)"/><line x1="${x(r.lo) + 5}" x2="${x(r.hi) + 5}" y1="8" y2="8" stroke="${r.gate === 'fail' ? 'var(--bad)' : 'var(--fg-2)'}" stroke-width="2"/><circle cx="${x(r.pass - (r.base ?? r.pass)) + 5}" cy="8" r="3.2" fill="${r.gate === 'fail' ? 'var(--bad)' : 'var(--fg)'}"/></svg>`; };
  const lastRun = (id) => RUNS.find((r) => r.agent === id && !r.candidate && r.provider === 'anthropic');

  /* ================================================================ Agents */
  A.view('agents', {
    label: 'Agents', group: 'Quality', icon: 'agents', access: qualityAccess,
    badge: () => ({ n: RUNS.filter((r) => r.candidate && r.gate === 'fail').length, hot: false }),
    render: () => {
      const bound = D.AGENTS.filter((a) => !a.unbound);
      const failing = RUNS.filter((r) => r.candidate && r.gate === 'fail');
      return A.pageHead({ eyebrow: 'Quality · packages/agents', title: 'Agents', sub: 'The agent registry is code: definitions, the steps each may act at, contracts, tools, data class and prompts pinned by hash. It changes by a reviewed pull request that passes the eval gate, never here. From the portal you see how each agent scores and which model serves it.', actions: `<a class="btn" href="#evals">${A.icon('evals', 14)} Evals</a><a class="btn" href="#models">${A.icon('gateway', 14)} Models and routes</a>` }) +
        A.stats([
          { k: 'Agents in the registry', v: D.AGENTS.length, d: `${bound.length} bound to steps · A7, A8, A10 unbound` },
          { k: 'Contracts', v: new Set(bound.map((a) => a.schema)).size, d: 'output schemas (Zod → JSON Schema)' },
          { k: 'Prompts pinned', v: new Set(D.AGENTS.map((a) => a.prompt)).size, d: 'prompts.lock.json · aisdlc-prompts-lock/v1' },
          { k: 'Candidate gates failing', v: failing.length, d: failing.map((r) => `${r.agent} ${r.prompt.split(' ')[0]}`).join(', ') || 'none', tone: failing.length ? 'warn' : 'ok' },
        ]) +
        (failing.length ? `<div class="banner warn" style="margin-top:16px">${A.icon('evals', 14)}<span><b>${E(failing[0].prompt)}</b> fails its eval gate: ${E(failing[0].why)}. The PR should not merge; the pinned prompt stays <span class="mono">${E(A.agent(failing[0].agent).prompt)}</span>.</span></div>` : '') +
        `<div style="height:16px"></div>` +
        A.card('Registry', A.table([
          { h: 'Agent', r: (a) => `<div class="row" style="gap:9px;flex-wrap:nowrap">${A.glyph('A', 20)}<div><b class="mono">${a.id}</b> ${a.name ? E(a.name) : '<span class="faint">unbound</span>'}<div class="tiny faint mono">${E(a.prompt)}</div></div></div>` },
          { h: 'Acts at', r: (a) => (a.steps.length ? `<div class="ql-steps">${J(a.steps, (s) => stepChip(s))}${J(a.spec, (s) => stepChip(s, true))}</div>` : '<span class="faint small">no step: never run, never gets a key</span>') },
          { h: 'Contract', r: (a) => `${mono(a.cv)}<div class="tiny faint mono">${E(a.schema)}</div>` },
          { h: 'Prompt sha256', r: (a) => A.hash(a.sha, 12) },
          { h: 'Tools', r: (a) => (a.tools.length ? `<div class="ql-tags">${J(a.tools, (t) => `<span class="ql-tag">${t}</span>`)}</div>` : `<span class="faint small">none${a.id === 'A1' ? ' (A1 may not have tools or retrieval)' : ''}</span>`) },
          { h: 'Data class', r: (a) => `<span class="pill plain">${a.dc}</span>` },
          { h: 'Model (prod)', r: (a) => (a.unbound ? '<span class="faint">—</span>' : `<span class="mono small">${E(prodModel(a) || 'no route')}</span>`) },
          { h: 'Eval score', cls: 'r', r: scoreHtml },
        ], D.AGENTS, { href: (a) => `agent-${a.id}` }), { flush: true, actions: '<span class="tiny faint">click an agent for its contract and history</span>' }) +
        `<div class="grid g3" style="margin-top:16px">
          ${A.card('Change an agent', rules([['info', '<b>Prompt, contract, tools, limits:</b> a PR to the factory repo. <span class="mono">npm run gen -w @aisdlc/agents</span> regenerates the lock; a test fails when a prompt moves without it.'], ['info', '<b>Before it merges:</b> the eval gate, by the holder of the eval store: <span class="mono">aisdlc-evals run</span>, <span class="mono">compare</span>, <span class="mono">gate</span>. A failing gate is a reason not to merge.'], ['info', '<b>Which model serves it:</b> a route, per environment and data class, for every agent at that class: Models and routes.']]))}
          ${A.card('Not available yet', rules([['warn', '<b>Switching an agent off.</b> An agent is bound to a step by code; kill and control scopes have no agent kind (gap 14, M19).'], ['warn', '<b>Autonomy promotion (M5)</b> from evals and outcomes (M15.5).'], ['info', 'A4 and coder share the S6 contract; the work driver runs coder (DM §8 gap 17).']]))}
          ${A.card('Legend', `<div class="stack small" style="gap:8px"><div class="row">${A.glyph('A', 16)} agent ${A.glyph('D', 16)} deterministic ${A.glyph('H', 16)} person</div><div class="row"><span class="ql-step"><span class="mono">3.4</span></span> primary step <span class="ql-step spec"><span class="mono">6.3</span></span> specialist</div><div class="muted">A score is the last eval run of the pinned prompt against its provider’s signed baseline.</div></div>`)}
        </div>`;
    },
  });

  /* ================================================================ one agent */
  A.view('agent', {
    nav: false, parent: 'agents', match: /^agent-(.+)$/, access: qualityAccess,
    render: ([id]) => {
      const a = A.agent(id); if (!a) return A.notFoundHtml();
      const pm = prodModel(a); const allowed = pm && a.models.includes(pm);
      const runs = RUNS.filter((r) => r.agent === id);
      const lr = lastRun(id);
      const items = A.visibleItems().filter((i) => a.steps.includes(i.step) && !['done', 'declined'].includes(i.state));
      const [tok, usd, ttl] = a.budget;
      return A.pageHead({ crumbs: '<a href="#agents">Agents</a><span>›</span><span>' + E(a.id) + '</span>', eyebrow: `agent · ${E(a.prompt)} · contract ${E(a.cv)}`, title: `<span class="row" style="gap:12px">${A.glyph('A', 34)} ${E(a.id)} ${a.name ? E(a.name) : '<span class="faint">(unbound)</span>'}</span>`, sub: a.unbound ? 'The specs name this id and nothing else: no name, role or step. It has no step, so it is never run and never gets a key, until a spec gives it one.' : E(a.note || `Acts at ${a.steps.join(', ')}. Its contract fixes the tools its gateway key carries, the data class and the budget.`) }) +
        (a.unbound ? '' : A.stats([
          { k: 'Eval score', v: a.score == null ? '—' : a.score.toFixed(2), d: lr ? `${sgn(lr.pass - (lr.base ?? lr.pass))} vs the anthropic baseline` : 'no eval suite for this agent', tone: a.delta <= -0.03 ? 'warn' : '' },
          { k: 'Last gate', v: lr ? (lr.gate === 'pass' ? 'pass' : 'fail') : '—', d: lr ? `${lr.id} · ${lr.at}` : 'no run recorded', tone: lr && lr.gate === 'fail' ? 'bad' : 'ok' },
          { k: 'Model in prod', v: pm || 'no route', d: allowed ? `route prod · ${a.dc}; on the contract allow-list` : 'not on the contract allow-list: model_not_allowed', tone: allowed ? '' : 'bad' },
          { k: 'In flight now', v: items.length, d: 'items at its steps you can see' },
        ])) +
        `<div class="split" style="margin-top:16px"><div class="stack">
          ${A.card('Definition', A.kv([
            ['Steps', a.steps.length ? `<div class="stack" style="gap:4px">${J(a.steps, (s) => `<div>${stepChip(s)} <span class="small muted">${E(stepTitle(s))}</span></div>`)}${J(a.spec, (s) => `<div>${stepChip(s, true)} <span class="small muted">${E(stepTitle(s))} (specialist)</span></div>`)}</div>` : '<span class="faint">none</span>'],
            ['Output schema', mono(a.schema)], ['Contract version', mono(a.cv)],
            ['Tools on its key', a.tools.length ? J(a.tools, (t) => `<span class="ql-tag">${t}</span> `) : '<span class="muted">none</span>'],
            ['Data class max', `<span class="pill plain">${a.dc}</span> <span class="tiny faint">D3 never routes</span>`],
            ['Models allowed', J(a.models, (m) => `<span class="mono small">${E(m)}</span> `) + '<div class="tiny faint">the contract’s allow-list (code); the route picks within it</div>'],
            ['Budget default', `${tok.toLocaleString('en-US')} tokens · $${usd} · ${Math.round(ttl / 60)} min key TTL`],
            ['Key scope', a.id === 'coder' ? 'per Unit, minted at 6.0 admission' : 'per job, minted by the work driver'],
          ]), { actions: '<span class="tiny faint">packages/agents/src/spec-data.ts</span>' })}
          ${A.card('Prompt', A.kv([['File', `<span class="mono small">packages/agents/src/prompts/${E(a.prompt)}.md</span>`], ['sha256 (lock)', A.hash(a.sha + C.hx(a.prompt, 52), 16)], ['Lock entry', `<span class="mono small">"${E(a.prompt)}": { contract_version: "${E(a.cv)}" }</span>`]]) + `<p class="tiny faint" style="margin-top:10px">The prompt text lives in the repo and is reviewed there. The portal shows its hash, which every run’s evidence names; a prompt edited in a browser would bypass the lock and the eval gate.</p>`)}
          ${a.unbound ? '' : A.card('Eval runs', runs.length ? A.table([
            { h: 'Run', r: (r) => `<span class="mono">${r.id}</span><div class="tiny faint">${E(r.at)}</div>` },
            { h: 'Prompt', r: (r) => `<span class="mono small">${E(r.prompt)}</span>${r.candidate ? ' <span class="pill info">candidate</span>' : ''}` },
            { h: 'Provider · model', r: (r) => `<span class="small">${E(r.provider)} · <span class="mono">${E(r.model)}</span></span>` },
            { h: 'Pass', cls: 'r', r: (r) => `<b class="num">${(r.pass * 100).toFixed(0)}%</b><div class="tiny faint">k=${r.k} · ${r.cases} cases</div>` },
            { h: 'Δ baseline, 90% CI', r: ci },
            { h: 'Gate', r: (r) => `${gatePill(r.gate)}${r.why ? `<div class="tiny faint">${E(r.why)}</div>` : ''}` },
          ], runs) : A.empty('No eval run recorded for this agent.'), { flush: true, actions: '<span class="tiny faint">GET /v1/agents/' + E(a.id) + '/scores</span>' })}
          ${a.unbound ? '' : A.card('At its steps now', items.length ? A.table([{ h: 'Item', r: (i) => A.ichip(i.key) }, { h: 'Step', r: (i) => `<span class="mono">${i.step}</span>` }, { h: 'State', r: (i) => A.statePill(i.state) }], items, { href: (i) => 'item-' + i.key }) : A.empty('Nothing you can see is at its steps.'), { flush: true })}
        </div><aside class="stack">
          ${A.card('Change this agent', rules([
            ['info', '<b>The agent itself</b> (prompt, contract, tools, limits): a pull request to the factory repo. A schema, tools or limits change bumps contract_version.'],
            ['info', '<b>Eval gate before merge:</b> <span class="mono">aisdlc-evals run --agent ' + E(a.id) + '</span>, then <span class="mono">compare</span> and <span class="mono">gate</span>. Significant regression, absolute floor, a security case, an errored trial or no baseline all fail.'],
            ['info', `<b>The model:</b> prod ${E(a.dc)} routes to <span class="mono">${E(pm || 'nothing')}</span>. A route is per environment and data class and moves every agent at ${E(a.dc)}.`],
            ['warn', '<b>No on/off switch:</b> not available (gap 14, M19).'],
          ]) + `<div class="row" style="margin-top:12px">${A.act('Change routes', 'config.propose', FLEET, { href: '#cfg-gateway.routes', cls: 'sm' })}<a class="btn sm" href="#evals">Eval history</a></div>`)}
          ${!a.unbound && pm && !allowed ? `<div class="banner bad">${A.icon('lock', 14)}<span>The prod route serves ${E(pm)} at ${E(a.dc)}, which ${E(a.id)}’s contract does not allow: its calls are refused (model_not_allowed).</span></div>` : ''}
        </aside></div>`;
    },
  });

  /* ================================================================ Evals: run history only (the store lives outside the factory) */
  A.view('evals', {
    label: 'Evals', group: 'Quality', icon: 'evals', access: qualityAccess,
    badge: () => ({ n: RUNS.filter((r) => r.gate === 'fail' && r.candidate).length, hot: true }),
    render: () => {
      const latest = D.AGENTS.filter((a) => !a.unbound && a.score != null).map((a) => ({ a, r: lastRun(a.id) })).filter((x) => x.r);
      const cands = RUNS.filter((r) => r.candidate);
      return A.pageHead({ eyebrow: 'Quality · aisdlc-evals', title: 'Evals', sub: 'Factory-wide eval runs, recorded by the aisdlc-evals CLI (eval.run_recorded, core.eval_run). Cases, hidden graders, holdouts and baselines stay in the eval store outside the repo and every service, so the portal shows run history and scores only.' }) +
        A.stats([
          { k: 'Agents with a suite', v: latest.length, d: 'A4 shares coder’s; A7, A8, A10 are unbound' },
          { k: 'Pinned prompts passing', v: `${latest.filter((x) => x.r.gate === 'pass').length}/${latest.length}`, d: 'last run of each against its baseline', tone: 'ok' },
          { k: 'Candidate PRs', v: cands.length, d: J(cands, (r) => `${r.agent} ${r.gate} `), tone: cands.some((r) => r.gate === 'fail') ? 'warn' : '' },
          { k: 'Baselines', v: BASELINES.filter((b) => b[1] !== '—').length, d: 'signed; codex and deepseek have none' },
        ]) +
        `<div class="split" style="margin-top:16px"><div class="stack">
          ${A.card('Candidate prompts (pull requests)', A.table([
            { h: 'Agent', r: (r) => `<a class="mono" href="#agent-${r.agent}">${r.agent}</a>` }, { h: 'Prompt', r: (r) => `<span class="mono small">${E(r.prompt)}</span>` },
            { h: 'Pass', cls: 'r', r: (r) => `${(r.pass * 100).toFixed(0)}%` }, { h: 'Δ baseline, 90% CI', r: ci }, { h: 'Gate', r: (r) => `${gatePill(r.gate)}${r.why ? `<div class="tiny faint">${E(r.why)}</div>` : ''}` },
          ], cands), { flush: true })}
          ${A.card('Pinned prompts, last run', A.table([
            { h: 'Agent', r: (x) => `<a class="mono" href="#agent-${x.a.id}">${x.a.id}</a> <span class="small">${E(x.a.name)}</span>` }, { h: 'Suite', r: (x) => `<span class="small">${E(x.r.suite)} · ${x.r.cases} cases · k=${x.r.k}</span>` },
            { h: 'Pass', cls: 'r', r: (x) => `<b class="num">${(x.r.pass * 100).toFixed(0)}%</b>` }, { h: 'pass^k', cls: 'r', r: (x) => Math.pow(x.r.pass, x.r.k / 2).toFixed(2) }, { h: 'Δ baseline, 90% CI', r: (x) => ci(x.r) }, { h: 'Gate', r: (x) => gatePill(x.r.gate) }, { h: 'When', r: (x) => `<span class="small muted">${E(x.r.at)}</span>` },
          ], latest), { flush: true })}
          ${A.card('Run history', A.table([
            { h: 'Run', r: (r) => `<span class="mono">${r.id}</span>` }, { h: 'Agent', r: (r) => `<span class="mono">${r.agent}</span>` }, { h: 'Prompt', r: (r) => `<span class="mono small">${E(r.prompt)}</span>` }, { h: 'Provider', r: (r) => `<span class="small">${E(r.provider)}</span>` },
            { h: 'Pass', cls: 'r', r: (r) => `${(r.pass * 100).toFixed(0)}%` }, { h: 'Gate', r: (r) => gatePill(r.gate) }, { h: 'When', r: (r) => `<span class="small muted">${E(r.at)}</span>` },
          ], RUNS), { flush: true, actions: '<span class="tiny faint">GET /v1/evals/runs</span>' })}
        </div><aside class="stack">
          ${A.card('Gate rules (gateRun)', rules([['bad', 'A significant regression (seeded bootstrap, level 0.90)'], ['bad', 'Below the absolute floor'], ['bad', 'Any security case failing'], ['bad', 'An errored trial'], ['bad', 'No baseline for the provider'], ['info', 'Unknown is a fail.']]))}
          ${A.card('Baselines', A.table([{ h: 'Provider', r: (b) => E(b[0]) }, { h: 'File', r: (b) => `<span class="mono small">${E(b[1])}</span>` }, { h: 'Signed', r: (b) => `<span class="small">${E(b[3])}</span>` }], BASELINES), { flush: true })}
          ${A.card('Run one', `<p class="small muted">Runs need the eval store and its key, which live outside the factory’s services by design. The holder runs them from a terminal; the result is recorded here.</p><pre class="code">AISDLC_EVAL_STORE=/srv/evals aisdlc-evals run --agent A3 --k 5\naisdlc-evals compare --baseline anthropic\naisdlc-evals gate</pre>`)}
        </aside></div>`;
    },
  });

  /* ================================================================ Models and routes */
  const BUDGET_GROUPS = [
    { id: 'unit:W-31/u2', who: 'coder · W-31 u2', limit: 2500, used: 1840, reserved: 120, state: 'open' },
    { id: 'unit:W-21/main', who: 'coder · W-21 main', limit: 1500, used: 260, reserved: 60, state: 'open' },
    { id: 'unit:W-38/main', who: 'coder · W-38 main (L7 spike)', limit: 1000, used: 140, reserved: 30, state: 'open' },
    { id: 'unit:W-18/u3', who: 'coder · W-18 u3', limit: 1333, used: 1333, reserved: 0, state: 'exhausted', at: 'today 06:12', note: 'ET1 → D1 handoff, E4 open' },
    { id: 'job:W-20/7.3', who: 'A5 review · W-20 7.3', limit: 50, used: 31, reserved: 8, state: 'open' },
    { id: 'job:W-23/5.3', who: 'A3 planner · W-23 5.3', limit: 150, used: 96, reserved: 0, state: 'settled' },
  ];
  const modelsView = {
    label: 'Models and routes', group: 'Quality', icon: 'gateway', access: qualityAccess,
    render: () => {
      const models = C.inForce('gateway.models').doc, routes = C.inForce('gateway.routes').doc, reg = C.inForce('integrations.registry').doc;
      const envs = ['local', 'staging', 'prod'];
      const cell = (env, dc) => { const r = routes.find((x) => x.environment === env && x.data_class === dc); return r ? `<span class="mono small">${E(r.model_id)}</span>` : '<span class="pill bad">no route</span>'; };
      const bound = D.AGENTS.filter((a) => !a.unbound);
      const groups = BUDGET_GROUPS.filter((g) => { const k = (g.id.match(/[WCLI]-\d+/) || [])[0]; return !k || !A.item(k) || A.canSeeProject(A.item(k).project); });
      return A.pageHead({ eyebrow: 'Quality · gateway.models · gateway.routes', title: 'Models and routes', sub: 'Every model call goes through the gateway, the only holder of vendor keys. A route is (environment, data class) → model, read on every call; D3 never routes. An agent’s contract only narrows which models its key may use.', actions: `${A.act('Change models', 'config.propose', FLEET, { href: '#cfg-gateway.models' })}${A.act('Change routes', 'config.propose', FLEET, { href: '#cfg-gateway.routes', cls: 'primary' })}` }) +
        `<div class="split" style="margin-top:4px"><div class="stack">
          ${A.card('Routes in force', `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Environment</th><th>D0</th><th>D1</th><th>D2</th><th>D3</th></tr></thead><tbody>${J(envs, (env) => `<tr><td><b>${env}</b></td><td>${cell(env, 'D0')}</td><td>${cell(env, 'D1')}</td><td>${cell(env, 'D2')}</td><td><span class="pill mute">never routed</span></td></tr>`)}</tbody></table></div><div class="tiny" style="padding:10px 16px">${C.setBy('gateway.routes')}</div>`, { flush: true })}
          ${A.card('Models', A.table([
            { h: 'Model', r: (m) => `<b class="mono">${E(m.model_id)}</b><div class="tiny faint mono">${E(m.provider_model)}</div>` },
            { h: 'Provider row', r: (m) => { const p = reg.find((x) => x.integration_id === m.provider_id); return `<span class="small">${E(p ? p.display_name : m.provider_id)}</span> ${p ? A.pill(p.status, p.status === 'enabled' ? 'ok' : 'mute') : A.pill('missing', 'bad')}`; } },
            { h: 'Tools', r: (m) => (m.tools_capable ? 'yes' : 'no') },
            { h: 'Max output', cls: 'r', r: (m) => m.max_tokens_cap.toLocaleString('en-US') },
            { h: 'Price in / out per Mtok', cls: 'r', r: (m) => (m.usd_in_per_mtok || m.usd_out_per_mtok ? `$${m.usd_in_per_mtok} / $${m.usd_out_per_mtok}` : '<span class="mono small">[PLACEHOLDER]</span>') },
          ], models), { flush: true, actions: `<span class="tiny">${C.setBy('gateway.models')}</span>` })}
          ${A.card('What each agent gets in prod', A.table([
            { h: 'Agent', r: (a) => `<a class="mono" href="#agent-${a.id}">${a.id}</a> <span class="small">${E(a.name)}</span>` }, { h: 'Data class', r: (a) => `<span class="pill plain">${a.dc}</span>` },
            { h: 'Routed model', r: (a) => `<span class="mono small">${E(prodModel(a) || 'no route')}</span>` }, { h: 'Contract allows', r: (a) => `<span class="mono tiny">${E(a.models.join(', '))}</span>` },
            { h: '', r: (a) => (a.models.includes(prodModel(a)) ? A.pill('allowed', 'ok') : A.pill('model_not_allowed', 'bad')) },
          ], bound), { flush: true })}
          ${A.card('Budget groups (hard stops)', A.table([
            { h: 'Group', r: (g) => `<span class="mono small">${E(g.id)}</span><div class="tiny faint">${E(g.who)}</div>` },
            { h: 'Used of limit', r: (g) => `<div style="min-width:140px"><div class="small">${A.cents(g.used)} of ${A.cents(g.limit)}${g.reserved ? ` · ${A.cents(g.reserved)} reserved` : ''}</div>${A.meter(g.used + g.reserved, g.limit)}</div>` },
            { h: 'State', r: (g) => `${A.pill(g.state, g.state === 'exhausted' ? 'bad' : g.state === 'open' ? 'info' : 'mute')}${g.note ? `<div class="tiny faint">${E(g.note)} · ${E(g.at)}</div>` : ''}` },
          ], groups), { flush: true, actions: '<span class="tiny faint">minted by core from the contract; not set by a person</span>' })}
        </div><aside class="stack">
          ${A.card('Order of checks on every call', `<ol class="small muted cf-steps">${J(['key', 'body', 'spend guard', 'kill switch', 'data class (D3 refused)', 'route', 'model allow-list', 'tool allow-list', 'redaction (secret ruleset)', 'budget reservation', 'vendor call', 'response tool check', 'settlement'], (c) => `<li>${E(c)}</li>`)}</ol>`)}
          ${A.card('Deployment bounds (read only)', A.kv([['GATEWAY_ENVIRONMENT', mono('prod')], ['GATEWAY_SECRET_REFS', '<span class="mono small">anthropic.key, codex.key, deepseek.key</span>'], ['GATEWAY_EGRESS_HOSTS', '<span class="mono small">api.anthropic.com, codex.provider.example, deepseek.provider.example</span>'], ['GATEWAY_MAX_PROVIDER_CALLS', mono('[PLACEHOLDER]')]]) + '<p class="tiny faint" style="margin-top:8px">Set by whoever runs the deployment. A published revision cannot make the gateway read a file it was not given or send a key somewhere new.</p>')}
          ${A.card('Not here on purpose', rules([['info', 'Per-agent routes and fallbacks: routes are per environment and data class only (contracts GatewayRoute).'], ['info', 'Budget limits per agent: they are the contract’s budget defaults (code); groups are minted per Unit or job.'], ['info', 'Vendor keys: only the gateway holds them, from file: references.']]))}
        </aside></div>`;
    },
  };
  A.view('models', modelsView);
  A.view('gateway', { ...modelsView, nav: false, parent: 'models' }); // the old route keeps working

  /* ================================================================ Integrations */
  const HEALTH = { github: ['healthy', 12], 'github-push': ['healthy', 41], 'github-gatecheck': ['unknown', null], anthropic: ['healthy', 9], codex: ['unknown', null], deepseek: ['unknown', null], fake: ['healthy', 3] };
  const healthOf = (id) => { const [h, s] = HEALTH[id] || ['unknown', null]; return s != null && s > 120 ? ['unknown', s] : [h, s]; };
  const buildOf = (r) => (r.status !== 'enabled' ? ['not built', r.status, 'mute'] : r.adapter === 'fake' ? ['refused', 'fake_not_allowed (prod)', 'warn'] : ['built', 'adapter ready', 'ok']);
  let INTEG_SEL = 'github';
  A.view('integrations', {
    label: 'Integrations', group: 'Quality', icon: 'integrations', access: qualityAccess,
    render: () => {
      const reg = C.inForce('integrations.registry').doc, inst = C.inForce('integrations.installs').doc;
      const sel = reg.find((r) => r.integration_id === INTEG_SEL) || reg[0];
      const tbl = (rows) => A.table([
        { h: 'Integration', r: (r) => `<button class="ql-rowbtn" data-isel="${E(r.integration_id)}" aria-pressed="${r.integration_id === sel.integration_id}"><b>${E(r.display_name)}</b><span class="tiny faint mono">${E(r.integration_id)} · ${E(r.adapter)}</span></button>` },
        { h: 'Status', r: (r) => A.pill(r.status, r.status === 'enabled' ? 'ok' : r.status === 'draft' ? 'info' : 'mute') },
        { h: 'Health', r: (r) => { const [h, s] = healthOf(r.integration_id); return `${A.health(h === 'healthy' ? 'ok' : h)}<div class="tiny faint">${s != null ? `${s} s ago` : 'no report'}</div>`; } },
        { h: 'Credential', r: (r) => (r.credentials.length ? J(r.credentials, (c) => `<div class="mono tiny">${E(c.secret_ref)}</div>`) : '<span class="faint small">none (keyless)</span>') },
        { h: 'Version', cls: 'r', r: (r) => mono('v' + r.version) },
      ], rows);
      const [h, s] = healthOf(sel.integration_id); const b = buildOf(sel);
      const insts = inst.filter((x) => x.integration_id === sel.integration_id && A.canSeeProject(x.project_id));
      return A.pageHead({ eyebrow: 'Quality · integrations.registry', title: 'Integrations', sub: 'Code hosts and model providers as rows of one registry. Each change is a revision decided at M1. Keys are never shown here, only the file reference the deployment reads.', actions: `${A.act('Add or edit integrations', 'config.propose', FLEET, { href: '#cfg-integrations.registry', cls: 'primary' })}${A.act('Installs per project', 'config.propose', FLEET, { href: '#cfg-integrations.installs' })}` }) +
        `<div class="split"><div class="stack">
          ${A.tabs('in', [
            { id: 'hosts', label: 'Code hosts', n: reg.filter((r) => r.kind === 'code_host').length, html: A.card('', tbl(reg.filter((r) => r.kind === 'code_host')), { flush: true }) },
            { id: 'models', label: 'Model providers', n: reg.filter((r) => r.kind === 'model_provider').length, html: A.card('', tbl(reg.filter((r) => r.kind === 'model_provider')), { flush: true }) },
            { id: 'other', label: 'Notifier, tracker, identity', n: 0, html: A.card('', A.empty('No row of these kinds: notifier, tracker and identity exist as kinds but have no adapter yet (notifications: M18).')) },
          ], sel.kind === 'model_provider' ? 'models' : 'hosts')}
          ${A.card('Installs per project', A.table([
            { h: 'Install', r: (x) => `<span class="mono small">${E(x.install_id)}</span>` }, { h: 'Integration', r: (x) => `<span class="mono small">${E(x.integration_id)}</span>` }, { h: 'Project', r: (x) => E((A.project(x.project_id) || {}).name || x.project_id) },
            { h: 'Enabled', r: (x) => (x.enabled ? A.pill('on', 'ok') : A.pill('off', 'mute')) }, { h: 'Narrowed to', r: (x) => `<span class="mono tiny">${E([...(x.overrides.repos_allowed || []), ...(x.overrides.models_allowed || [])].join(', ') || 'fleet default')}</span>` },
          ], inst.filter((x) => A.canSeeProject(x.project_id))), { flush: true, actions: `<span class="tiny">${C.setBy('integrations.installs')}</span>` })}
          ${A.card('What a code host may never do (D11)', `<p class="small muted" style="margin-bottom:8px">Every scope row carries the whole forbidden list; a row that lacks one is refused. The factory never merges.</p><div class="ql-tags">${J(C.D11, (v) => `<span class="ql-tag bad">${v}</span>`)}</div>`)}
        </div><aside class="stack">
          ${A.card(E(sel.display_name), `${A.kv([
            ['Row', `<span class="mono small">${E(sel.integration_id)}</span> · ${E(sel.kind)} · <span class="mono small">${E(sel.adapter)}</span>`],
            ['Status', A.pill(sel.status, sel.status === 'enabled' ? 'ok' : 'mute')],
            ['Settings', `<span class="mono tiny">${E(JSON.stringify(sel.config))}</span>`],
            ['Credential', sel.credentials.length ? J(sel.credentials, (c) => `<div><span class="pill plain">reference</span> <span class="mono tiny">${E(c.secret_ref)}</span><div class="tiny faint">${E(c.kind)}${c.rotated_at ? ' · rotated ' + E(c.rotated_at) : ''}</div></div>`) : '<span class="muted small">keyless adapter</span>'],
            ['Scopes', J(sel.scopes, (x) => `<div class="small"><span class="mono">${E(x.scope)}</span> · up to ${E(x.data_class_max)}</div>`)],
            ['Gateway / codehost', `${A.pill(b[0], b[2])} <span class="tiny faint">${E(b[1])}</span>`],
            ['Owner', sel.owner ? A.who(sel.owner) : '<span class="faint">—</span>'],
          ])}<div data-ihealth class="small" style="margin-top:10px"></div>`, { foot: `<button class="btn sm" data-itest>Test connection</button>${A.act('Rotate credential', 'config.propose', FLEET, { cls: 'sm', attrs: 'data-irot' })}${A.act('Edit', 'config.propose', FLEET, { href: '#cfg-integrations.registry', cls: 'sm' })}` })}
          ${insts.length ? A.card('Installed for', `<div class="stack" style="gap:6px">${J(insts, (x) => `<div class="row between small"><span>${E((A.project(x.project_id) || {}).name)}</span>${x.enabled ? A.pill('on', 'ok') : A.pill('off', 'mute')}</div>`)}</div>`) : ''}
          ${A.card('Deployment allows (read only)', A.kv([['GATEWAY_SECRET_REFS', '<span class="mono tiny">anthropic.key, codex.key, deepseek.key</span>'], ['CODEHOST app keys', '<span class="mono tiny">codehost-app-key.pem, push-app-key.pem</span>'], ['GATEWAY_EGRESS_HOSTS', '<span class="mono tiny">api.anthropic.com, codex.provider.example, deepseek.provider.example</span>']]) + '<p class="tiny faint" style="margin-top:8px">A row naming a reference or a host outside these is refused when it builds (secret_ref_not_allowed, egress_not_allowed).</p>')}
          ${A.card('History', `<div class="tiny">${C.setBy('integrations.registry')}</div><a class="small" href="#cfg-integrations.registry">Every revision</a>`)}
        </aside></div>`;
    },
    mount: (root) => {
      root.addEventListener('click', (e) => {
        const s = e.target.closest('[data-isel]'); if (s) { INTEG_SEL = s.dataset.isel; A.render(); return; }
        if (e.target.closest('[data-itest]')) { const id = INTEG_SEL; const [h, sec] = healthOf(id); root.querySelector('[data-ihealth]').innerHTML = rules([[h === 'healthy' ? 'ok' : 'warn', h === 'healthy' ? `Reachable: the ${id.startsWith('github') ? 'codehost' : 'gateway'} reported healthy ${sec} s ago (integrations.integration_health).` : 'Unknown: no health report in the last 2 minutes. An unknown health is not healthy.'], ['info', 'Test connection shows the health the service already reports. It never reads, sends or tests a secret.']]); return; }
        if (e.target.closest('[data-irot]') && A.can('config.propose', FLEET)) { A.drawer(`<div class="row between"><span class="eyebrow">Rotate a credential</span><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div><h2>Rotation is a new reference</h2>${rules([['info', 'Put the new key in a file the deployment mounts and lists in GATEWAY_SECRET_REFS (outside the portal).'], ['info', 'Propose a revision of integrations.registry whose credential points at the new file: reference.'], ['info', 'After its M1 is published, the gateway needs a forced reload (POST /v1/admin/reload {force:true}) to read the new file; this screen then shows the per-row result.'], ['warn', 'No screen uploads, reads or shows a secret value.']])}<a class="btn primary" href="#cfg-integrations.registry">Open the registry form</a>`); }
      });
    },
  });
})();
