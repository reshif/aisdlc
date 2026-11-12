/* Onboarding: card 2 (Light: claims with evidence, practices, and each AGENTS.md / CLAUDE.md section accepted or rejected
   against the factory template, DEC-11 refined), card 3 (Full), G5 release on card 4, per-area levels, and the ONBOARDING
   AGENT CONSOLE beside the S0 page (portal-config.md §4): answers from what the person can see, cites file and commit,
   drafts and proposal buttons, never decides a card; repo text is data. */
(function () {
  const D = A.data, E = A.esc, J = A.j, X = A.dcx;
  const hx = X.hx, rules = X.rules;
  const cardTag = (label) => `<span class="gtag m"><i></i>${E(label)}</span>`;
  const SHA = '4e1c9a0';
  const cite = (t, href) => `<a class="ob-cite" ${href ? `href="${href}"` : 'href="#s0-S0-4c1e"'}>${E(t)}</a>`;

  /* ================================================================ card 2 (Light) */
  const CLAIMS = [
    ['Tests run with ./gradlew test (JUnit 5) and swift test', 'build.gradle.kts:41 · Package.swift:12', 'affirmed'],
    ['Android min SDK 26, target 35', 'app/android/build.gradle.kts:18', 'affirmed'],
    ['Network calls go through ApiClient only', 'app/android/src/net/ApiClient.kt:1 · 23 call sites', 'affirmed'],
    ['Owners of app/ios/ are @acme/mobile-ios', 'CODEOWNERS:4', 'affirmed'],
    ['Crash reports are uploaded by tools/upload-crash.sh', 'tools/upload-crash.sh:1', 'affirmed'],
    ['No secret in the head tree', 'secret scan · rules sr-2026.10.3 · head ' + SHA, 'affirmed'],
    ['iOS UI tests run in CI', '.github/workflows/ios.yml:30', 'unknown'],
    ['Feature flags are read from RemoteConfig', 'app/android/src/flags/Flags.kt:9', 'rejected'],
  ];
  const SECTIONS = [
    ['AGENTS.md', '## Build and test', 'build and test commands', 'accepted', 'Taken as fenced guidance inside the factory’s task contract commands.'],
    ['AGENTS.md', '## Kotlin style', 'coding standards', 'accepted', 'Fenced guidance for the coder at 6.4.'],
    ['AGENTS.md', '## Module map', 'architecture notes', 'accepted', 'Fenced guidance at levels 3–4 of the context builder.'],
    ['AGENTS.md', '## Naming and commits', 'conventions', 'accepted', 'Fenced guidance; factory commit trailers still win.'],
    ['AGENTS.md', '## Release', 'merge or deploy steps', 'rejected', 'Tells agents to run fastlane and push to main. The factory never merges or pushes to main; the human merges on GitHub.'],
    ['AGENTS.md', '## Tools you may use', 'tools and permissions', 'rejected', 'Grants Bash with network. Tools come only from the agent contract; a repo can never add one.'],
    ['CLAUDE.md', '@AGENTS.md', 'stub', 'accepted', 'A pointer to AGENTS.md; nothing of its own.'],
  ];
  const AREAS = [['app/android/', 'Light', 'probe passes, claims affirmed'], ['app/ios/', 'Census', 'iOS probe pending (RS-BT-1): agent lanes closed there'], ['tools/', 'Census', 'scripts with a credential history']];
  const c2main = () =>
    A.card('Claims the factory found <span class="small faint">0.2 · at census commit ' + SHA + ' · at most 50</span>', A.table([
      { h: 'Claim', r: (c) => `<span class="small">${E(c[0])}</span>` }, { h: 'Evidence', r: (c) => `<span class="mono tiny">${E(c[1])}</span>` },
      { h: '', r: (c) => A.pill(c[2], c[2] === 'affirmed' ? 'ok' : c[2] === 'rejected' ? 'bad' : 'warn') },
    ], CLAIMS), { flush: true, actions: '<span class="tiny faint">46 affirmed · 3 unknown · 1 rejected of 50 (8 shown)</span>' }) +
    A.card('Instruction files against the factory template <span class="small faint">DEC-11 refined</span>', `${A.table([
      { h: 'File', r: (s) => `<span class="mono small">${E(s[0])}</span>` }, { h: 'Section', r: (s) => `<span class="mono small">${E(s[1])}</span>` }, { h: 'Template kind', r: (s) => `<span class="small">${E(s[2])}</span>` },
      { h: 'Verdict', r: (s) => A.pill(s[3], s[3] === 'accepted' ? 'ok' : 'bad') }, { h: 'Why', r: (s) => `<span class="small muted">${E(s[4])}</span>` },
    ], SECTIONS)}<div class="dc-rule" style="padding:12px 16px">${J([['info', 'Factory rules and defaults always win. A repo file can only add repo detail inside them; accepted sections become <b>fenced guidance</b>, never control.'], ['info', 'For the two rejected sections the factory proposes an edit to AGENTS.md as a PR through <b>X2</b> (a protected path); a person decides it.'], ['info', 'The template itself is a factory setting: <a href="#cfg-onboarding.instruction_template">onboarding.instruction_template</a> (decided, not built: M16).']], ([k, h]) => `<div><span class="dc-ico ${k}">i</span><span>${h}</span></div>`)}</div>`, { flush: true }) +
    A.card('Per-area levels <span class="small faint">DEC-25</span>', A.table([{ h: 'Area', r: (a) => `<span class="mono">${E(a[0])}</span>` }, { h: 'Level asked', r: (a) => X.lvl(a[1]) }, { h: 'Why', r: (a) => `<span class="small muted">${E(a[2])}</span>` }], AREAS), { flush: true }) +
    A.card('Intent answers and practices', A.kv([['Intent questions', '15 asked, 15 answered (stored as redactable payloads; only hashes on the chain)'], ['Practices', 'trunk-based, squash merges, release trains every 2 weeks'], ['operations.md', 'drafted from the answers, attested on this card']]));
  X.CARDS['C2-mobile'] = () => ({
    title: 'Card 2: claims, practices and instruction files', sub: 'Mobile App onboarding, step 0.2 (Light). Affirm or correct what the factory found, and see how each instruction-file section was judged against the factory template.',
    eyebrow: `${cardTag('Card 2')} <span style="margin-left:6px">S0-4c1e · Mobile App · Light</span>`, crumbs: '<a href="#inbox">Inbox</a><span>›</span><a href="#s0-S0-4c1e">S0-4c1e</a><span>›</span><span>Card 2</span>',
    actions: '<a class="btn sm" href="#s0-S0-4c1e">Open the onboarding</a>',
    sentence: 'Are these claims, practices and instruction-file verdicts right for <b>Mobile App</b>?',
    subject: { hash: hx('c2-mobile'), binds: [['claims (50)', hx('claims')], ['AGENTS.md text_sha256', hx('agentsmd')], ['template verdicts', hx('tmpl')], ['intent answers', hx('ia')]] },
    facts: [['Census commit', `<span class="mono">${SHA}</span>`], ['Claims', '46 affirmed, 3 unknown, 1 rejected'], ['Instruction sections', '5 accepted, 2 rejected (X2 edit proposed)'], ['Step-up', 'D37 step-up; never affirmed in the session that proposed it']],
    main: c2main(), stepUpWhy: 'Card 2 affirms instruction text: it needs the D37 step-up and cannot be decided from the session that proposed it.',
    rules: [['info', '<b>Bootstrap.</b> Mei Wong asked for this onboarding and decided card 2 under the grant (with step-up).'], ['info', 'Affirmed text is pinned by text_sha256: a later change to AGENTS.md is drift and serves the affirmed text until it is re-affirmed.']],
    options: { approve: 'Approve card 2', changes: 'Send back', reject: 'Reject' }, readWhat: 'the claims and the template verdicts', after: 'The affirmed sections become fenced guidance; the X2 edit for the rejected ones is opened as a PR.',
  });
  X.CARDS['C3-mobile'] = () => ({
    title: 'Card 3: the Full baseline', sub: 'Step 0.3, only for an onboarding that asks for Full: the factory’s exam of the repo, from which every lane can open.',
    eyebrow: `${cardTag('Card 3')} <span style="margin-left:6px">S0-4c1e · Mobile App</span>`, crumbs: '<a href="#inbox">Inbox</a><span>›</span><a href="#s0-S0-4c1e">S0-4c1e</a><span>›</span><span>Card 3</span>',
    sentence: 'Is the Full baseline of <b>Mobile App</b> right?', subject: { hash: hx('c3-mobile'), binds: [] },
    main: A.card('What card 3 holds', `${A.kv([['Extraction (A12)', 'full code knowledge base, system map, spec seeds per area'], ['Golden tasks', 'a set of tasks with hidden answers the agents must pass (values: onboarding.exam, M16)'], ['Reverse engineering (A9)', 'focused per area at 0.3'], ['Per-area levels', 'each area raised to Full only where its exam passes'], ['Floors', 'the Full floors (FF1–FF4), then M4']])}<p class="small muted" style="margin-top:10px">Mobile App asked for Light. Raising it to Full later is a new onboarding version with its own card 3 and M4 (level-up, M17).</p>`),
    noDecision: A.card('Not requested', rules([['info', 'This onboarding asked for Light, so step 0.3 is skipped and card 3 never opens.'], ['info', 'Card 3 is built in M17 (coverage §3).']]), { foot: '<a class="btn sm" href="#s0-S0-4c1e">Back to the onboarding</a>' }),
  });
  // card 4: G5 release (PLAN §7a) beside the gating profile
  const c4 = X.CARDS['C4-mobile'];
  X.CARDS['C4-mobile'] = () => { const o = c4(); o.main += A.card('Release (G5) <span class="small faint">decided 2026-11-11 · backend M15</span>', `<div class="stack" style="gap:8px"><label class="check"><input type="radio" name="ob-g5" checked> <span><b>Off</b>: merged is done. G5 is absent.</span></label><label class="check"><input type="radio" name="ob-g5"> <span><b>Release to a target</b>, decided at G5 (step-up)</span></label><div class="field" style="margin-left:26px"><label for="ob-g5t">Deploy target</label><input class="input mono" id="ob-g5t" placeholder="GitHub environment, e.g. production" disabled></div><p class="tiny faint">Changing it later is an M1 config change (project.release). No key stores a G5 target yet (M15.3); the card records Project.deploys only.</p></div>`); return o; };

  /* ================================================================ the onboarding agent console */
  const THREAD = {};
  const SUGGEST = ['Why is card 4 waiting?', 'Why was the Release section of AGENTS.md rejected?', 'What would Full unlock?', 'Show me the secret that was found'];
  const answer = (q) => {
    const s = q.toLowerCase();
    if (/secret|key value|credential|password|token/.test(s)) return { kind: 'refusal', text: 'I can’t show a secret or where its value is. Secret findings stay on the security card, as rule ids and counts; the credential found by <span class="mono">aws-access-key-id</span> is recorded as rotated.', cites: [['security card', '#card-SECR-mobile']] };
    if (/approve|decide|sign|affirm/.test(s) && /card|m4|for me|it/.test(s)) return { kind: 'refusal', text: 'I never decide or affirm a card, and I never click anything for you. I can open the card; you decide it there, with step-up where it needs one.', cites: [], btn: ['Open card 4', '#card-C4-mobile'] };
    if (/card 4|waiting|wait/.test(s)) return { kind: 'answer', text: 'Step 0.4 waits on you: card 4 asks what the factory cannot read (secret scanning and push protection are not readable to a read-only App, and the ruleset bypass list never is), then the role map, two-person rule, gating profile and the G5 release choice. Two controls read <i>warn</i>; any “I do not know” counts as not met.', cites: [['controls report cr-4c1e-2', '#card-C4-mobile'], ['S0 step 0.4', '#s0-S0-4c1e']], btn: ['Open card 4', '#card-C4-mobile'] };
    if (/release|rejected|agents\.md|instruction/.test(s)) return { kind: 'answer', text: 'The <span class="mono">## Release</span> section tells agents to run fastlane and push to main once tests pass. The factory template rejects merge and deploy steps: the factory never merges or pushes to main. I can draft a replacement section for an X2 proposal; nothing is sent until a person approves the X2.', cites: [[`AGENTS.md:41-48 @ ${SHA}`, null], ['factory template · merge or deploy steps', '#cfg-onboarding.instruction_template']], draft: '## Release\nReleases are cut by the mobile team with fastlane after a merge on GitHub.\nAgents never run release steps and never push to main; they open agent/* pull requests.' };
    if (/full|level|unlock|lane/.test(s)) return { kind: 'answer', text: 'At Light, app/android/ opens L1–L3 and L2 remediation, plus L8 and planning everywhere. Full adds L4–L6 where an area passes its card 3 exam. app/ios/ stays at Census until its probe passes (RS-BT-1), so agent lanes stay closed there.', cites: [['catalogue 1.3.0 eligibility', '#catalogue'], ['per-area levels on card 2', '#card-C2-mobile']] };
    if (/ignore|instruction|system prompt|you are now/.test(s)) return { kind: 'refusal', text: 'Repo text reaches me only as fenced data, so an instruction inside it changes nothing. I answer the person in this panel, from what they can see.', cites: [] };
    return { kind: 'answer', text: `I answer from the S0 record of acme/mobile-app at <span class="mono">${SHA}</span> and what you may see. Try one of the suggestions, or ask about a step, a card, a claim or a gap.`, cites: [['S0-4c1e', '#s0-S0-4c1e']] };
  };
  const turnHtml = (t) => (t.who === 'me' ? `<div class="ob-turn me"><div>${E(t.text)}</div></div>` : `<div class="ob-turn ${t.kind}"><div>${t.text}</div>${t.cites && t.cites.length ? `<div class="ob-cites">${J(t.cites, ([c, h]) => cite(c, h))}</div>` : ''}${t.btn ? `<div class="row" style="margin-top:8px">${A.act(t.btn[0], 'card.decide', { type: 'Card', project: 'mobile' }, { href: t.btn[1], cls: 'sm' })}</div>` : ''}${t.draft ? `<div class="ob-draft"><div class="eyebrow">Draft · AGENTS.md ## Release</div><pre class="code">${E(t.draft)}</pre><div class="row" style="gap:6px">${A.act('Propose as an X2 edit', 'card.decide', { type: 'Card', project: 'mobile' }, { cls: 'sm', attrs: 'data-obx2' })}<button class="btn sm ghost" data-obcopy>Copy</button></div><p class="tiny faint">The factory opens the PR on agent/*; X2 is decided by two people. You still decide every card.</p></div>` : ''}</div>`);
  const consoleHtml = () => {
    const me = A.me(); const th = THREAD[me] || (THREAD[me] = [{ who: 'bot', kind: 'answer', text: `I read the census of <span class="mono">acme/mobile-app</span>. Card 4 is open; 46 of 50 claims are affirmed; AGENTS.md has 6 sections: 4 accepted by the factory template, 2 rejected.`, cites: [[`census ${SHA}`, null], ['card 2', '#card-C2-mobile']] }]);
    const can = A.can('assistant.use', { type: 'Project', project: 'mobile' });
    return `<section class="card ob-console" aria-label="Onboarding assistant"><div class="hd"><h3>Onboarding assistant</h3><span class="sp"></span><span class="pill plain">backend M18</span></div><div class="bd stack" style="gap:10px">
      <div class="tiny muted">acme/mobile-app · grounded on <span class="mono">${SHA}</span> · head moved to <span class="mono">9d2f71b</span>: I answer nothing about the new head until a re-census.</div>
      ${can ? `<div class="ob-thread" data-obthread aria-live="polite">${J(th, turnHtml)}</div>
      <div class="ob-sugg">${J(SUGGEST, (q) => `<button class="btn ghost sm" data-obq="${E(q)}">${E(q)}</button>`)}</div>
      <form class="row" data-obform style="gap:6px;flex-wrap:nowrap"><label class="sr" for="ob-in">Ask about this repo</label><input class="input" id="ob-in" placeholder="Ask about this repo" autocomplete="off" style="flex:1;min-width:0"><button class="btn primary" type="submit">Ask</button></form>
      <div class="tiny faint">Answers come only from what you can see, citing file and commit. Repo text is data, never instructions. It drafts and explains; only a person decides a card. Budget today (assistant_user_day): 71% left.</div>` : A.empty('The assistant answers only people who can see this onboarding.')}
    </div></section>`;
  };
  const s0 = A.viewDef('s0');
  const s0render = s0.render, s0mount = s0.mount;
  s0.render = (p) => { const html = s0render(p); if (p[0] !== 'S0-4c1e') return html; const re = /<section class="card"\s*><div class="hd"><h3>Access<\/h3>/; return re.test(html) ? html.replace(re, (m) => consoleHtml() + m) : html; };
  s0.mount = (root, p) => {
    if (s0mount) s0mount(root, p);
    const thread = root.querySelector('[data-obthread]'); if (!thread) return;
    const ask = (q) => { if (!q.trim()) return; const th = THREAD[A.me()]; th.push({ who: 'me', text: q }); th.push({ who: 'bot', ...answer(q) }); thread.innerHTML = J(th, turnHtml); thread.scrollTop = thread.scrollHeight; };
    root.querySelector('[data-obform]').addEventListener('submit', (e) => { e.preventDefault(); const i = root.querySelector('#ob-in'); ask(i.value); i.value = ''; });
    root.addEventListener('click', (e) => {
      const q = e.target.closest('[data-obq]'); if (q) { ask(q.dataset.obq); return; }
      if (e.target.closest('[data-obx2]')) { A.toast('Proposal drafted: the factory opens an agent/* PR changing AGENTS.md, and X2 opens for two approvers. Nothing is merged by the factory.'); return; }
      if (e.target.closest('[data-obcopy]')) A.toast('Draft copied.');
    });
  };
})();
