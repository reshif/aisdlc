/* Sign-in, sign-out, user menu, Home (per person), My access, not found. */
(function () {
  const D = A.data, X = A.access;

  /* ================================================================ sign-in */
  let step = 'start', picked = null;
  const brandSide = () => `
    <div class="ac-brand">
      <div class="ac-logo"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M1 12h22" stroke="var(--belt-2)" stroke-width="3"/><rect x="8" y="8" width="8" height="8" transform="rotate(45 12 12)" fill="var(--gate)"/></svg><span>AISDLC</span></div>
      <div class="ac-belt" aria-hidden="true"><i></i><b></b><i></i><b></b><i></i></div>
      <h1>The Acme software factory</h1>
      <p>Work moves through governed stages. Agents build in sandboxes; people decide every gate; every decision is signed into the ledger.</p>
      <ul class="ac-facts">
        <li><span class="mono">SSO</span> Your company account; no factory passwords.</li>
        <li><span class="mono">MFA</span> Security key for privileged roles and for step-up on sensitive decisions.</li>
        <li><span class="mono">PDP</span> What you see and do comes from your role bindings, checked on every request.</li>
      </ul>
    </div>`;
  function loginRender() {
    if (step === 'idp') return `<div class="ac-login">${brandSide()}<div class="ac-panel"><div class="ac-card ac-idp">
      <div class="ac-idp-hd"><span class="ac-idp-logo">acme</span><span class="mono small faint">sso.acme.example · OIDC</span></div>
      <h2>Choose an account</h2>
      <p class="small muted">Local-prod uses the dev identity provider, which lists these accounts. In production this is your company SSO and you never pick.</p>
      <div class="ac-accts">${A.j(X.ACCOUNTS, (a) => { const p = D.PEOPLE[a.pid]; const roles = A.bindingsOf(a.pid); return `<button class="ac-acct" data-pick="${a.pid}">${A.avatar(a.pid)}<span class="ac-acct-t"><b>${A.esc(p.name)}</b><span class="small">${A.esc(a.persona)}</span><span class="tiny faint">${A.esc(a.blurb)}</span></span><span class="tiny mono faint">${roles.length} role${roles.length === 1 ? '' : 's'}</span></button>`; })}</div>
      <button class="btn ghost sm" data-step="start">Back</button></div></div></div>`;
    if (step === 'mfa') { const p = D.PEOPLE[picked]; const priv = A.bindingsOf(picked).some((b) => X.ROLE[b.role].privileged); return `<div class="ac-login">${brandSide()}<div class="ac-panel"><div class="ac-card">
      <div class="ac-idp-hd"><span class="ac-idp-logo">acme</span><span class="mono small faint">sso.acme.example</span></div>
      <div class="row">${A.avatar(picked, 'lg')}<div><b>${A.esc(p.name)}</b><div class="small muted">${A.esc(p.email)}</div></div></div>
      <h2>Confirm it’s you</h2>
      <p class="small muted">${priv ? 'You hold a privileged role, so the factory requires a security key at sign-in (WebAuthn).' : 'Your organisation asks for a second factor at sign-in.'}</p>
      <div class="ac-key" id="ac-key">${A.icon('lock', 26)}<span>Touch your security key</span></div>
      <button class="btn primary" id="ac-mfa">Use security key</button>
      <button class="btn ghost sm" data-step="idp">Use another account</button></div></div></div>`; }
    if (step === 'out') return `<div class="ac-login">${brandSide()}<div class="ac-panel"><div class="ac-card">
      <h2>You are signed out</h2><p class="muted">Your portal session ended and its cookie was cleared. Sessions on other devices are not affected; a factory admin can end them under Sign-ins and sessions.</p>
      <button class="btn primary ac-sso" data-step="idp">Sign in again</button></div></div></div>`;
    return `<div class="ac-login">${brandSide()}<div class="ac-panel"><div class="ac-card">
      <h2>Sign in</h2><p class="muted">Use your Acme account. Access is granted per project by its admin; if you can sign in but see nothing, ask for a role.</p>
      <button class="btn primary ac-sso" data-step="idp">${A.icon('lock', 15)} Continue with Acme SSO</button>
      <div class="ac-or"><span>session policy</span></div>
      ${A.kv([['Idle timeout', '30 minutes'], ['Longest session', '12 hours'], ['Step-up lasts', '15 minutes, bound to one decision'], ['External guests', 'company network only']])}
      <p class="tiny faint">Prototype: every account is example data. Signing in here changes which screens and buttons you get, exactly as the policy would.</p></div></div></div>`;
  }
  function loginMount(root) {
    root.querySelectorAll('[data-step]').forEach((b) => (b.onclick = () => { step = b.dataset.step; A.render(); }));
    root.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => { picked = b.dataset.pick; step = 'mfa'; A.render(); }));
    const m = root.querySelector('#ac-mfa');
    if (m) m.onclick = () => { root.querySelector('#ac-key').classList.add('ok'); m.disabled = true; setTimeout(() => { A.signIn(picked, true); step = 'start'; location.hash = 'home'; A.boot(); A.toast(`Signed in as ${D.PEOPLE[picked].name}`); }, 650); };
  }
  A.view('login', { nav: false, render: loginRender, mount: loginMount });
  A.signOutNow = () => { const n = D.PEOPLE[A.me()]?.name; A.signOut(); step = 'out'; A.closeOverlay(); document.querySelector('.ac-menu')?.remove(); A.render(); A.toast && n && setTimeout(() => {}, 0); };

  /* ================================================================ user menu */
  A.userMenu = (anchor) => {
    const old = document.querySelector('.ac-menu'); if (old) { old.remove(); anchor.setAttribute('aria-expanded', 'false'); return; }
    const me = A.me(), p = D.PEOPLE[me], bs = A.bindingsOf(me);
    const el = document.createElement('div'); el.className = 'ac-menu'; el.setAttribute('role', 'menu');
    el.innerHTML = `<div class="ac-menu-hd">${A.avatar(me, 'lg')}<div><b>${A.esc(p.name)}</b><div class="small muted">${A.esc(p.email)}</div><div class="tiny faint">${A.esc(A.persona())} · session ${A.esc(A.session.sid)}</div></div></div>
      <div class="ac-menu-roles">${A.j(bs.slice(0, 6), (b) => `<span class="pill plain">${A.roleLabel(b.role)} · ${b.scope.kind === 'fleet' ? 'fleet' : b.scope.kind === 'team' ? 'team ' + b.scope.ref : A.project(b.scope.ref)?.name}</span>`)}${bs.length > 6 ? `<span class="pill plain">+${bs.length - 6}</span>` : ''}</div>
      <a role="menuitem" href="#my-access">${A.icon('people')} My access and requests</a>
      <a role="menuitem" href="#notifications">${A.icon('bell')} Notification preferences</a>
      <button role="menuitem" id="ac-stepup">${A.icon('lock')} ${A.stepUpValid() ? 'Step-up valid · ends in ' + Math.max(1, Math.round((A.session.stepUpUntil - Date.now()) / 60000)) + ' min' : 'Step up now (security key)'}</button>
      <button role="menuitem" id="ac-switch">${A.icon('fleet')} Switch account <span class="tiny faint">(dev IdP)</span></button>
      <button role="menuitem" id="ac-out" class="ac-danger">${A.icon('ext')} Sign out</button>`;
    document.body.appendChild(el); anchor.setAttribute('aria-expanded', 'true');
    const r = anchor.getBoundingClientRect(); el.style.top = r.bottom + 6 + 'px'; el.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    el.querySelector('#ac-out').onclick = () => A.signOutNow();
    el.querySelector('#ac-switch').onclick = () => { A.signOut(); step = 'idp'; el.remove(); A.render(); };
    el.querySelector('#ac-stepup').onclick = () => { el.remove(); A.stepUpModal(() => A.renderTop()); };
    setTimeout(() => document.addEventListener('click', function off(e) { if (!el.contains(e.target)) { el.remove(); anchor.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', off); } }), 0);
  };
  /** step-up: a security-key touch that lasts 15 minutes and is bound to the next decision */
  A.stepUpModal = (done, why) => {
    const m = A.modal(`<div class="row between"><h2>Step up</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      <p class="muted">${A.esc(why || 'Sensitive decisions need a fresh proof that it is you. The proof is bound to the decision’s subject hash and lasts 15 minutes.')}</p>
      <div class="ac-key" id="su-key">${A.icon('lock', 26)}<span>Touch your security key</span></div>
      <div class="row"><button class="btn primary" id="su-go">Use security key</button><button class="btn ghost" data-close>Cancel</button></div>
      <p class="tiny faint">Recorded as a StepUpUse with your session id; the bff verifies it, the decision kernel only sees verify(proof, hash, principal).</p>`);
    m.querySelector('#su-go').onclick = () => { m.querySelector('#su-key').classList.add('ok'); setTimeout(() => { A.grantStepUp(); A.closeOverlay(); A.toast('Step-up valid for 15 minutes'); done && done(); }, 500); };
  };

  /* ================================================================ inbox count shared by the bell and Home */
  A.myDecisions = () => A.visibleItems().filter((i) => i.gate && i.wait.includes(A.me()) && !['done', 'declined'].includes(i.state));
  A.inboxCount = () => A.myDecisions().length + A.visibleItems().filter((i) => i.state === 'waiting' && !i.gate && i.wait.includes(A.me()) && ['S1', 'S8'].includes(i.stage)).length + (A.bindingsOf(A.me()).some((b) => b.role === 'project.onboarding_signer' && b.scope.ref === 'mobile') ? 1 : 0) + A.ACCESS_REQUESTS.filter((r) => r.state === 'pending' && r.approver === A.me() && r.pid !== A.me()).length;

  /* ================================================================ Home */
  function homeRender() {
    const me = A.me(), p = D.PEOPLE[me], bs = A.bindingsOf(me);
    const hour = new Date().getHours(); const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const projs = A.visibleProjects();
    const mine = A.myDecisions();
    const asks = A.visibleItems().filter((i) => i.requester === me && !['done', 'declined'].includes(i.state));
    const answers = A.visibleItems().filter((i) => i.state === 'waiting' && !i.gate && i.wait.includes(me));
    const reqs = A.ACCESS_REQUESTS.filter((r) => r.state === 'pending' && r.approver === me);
    const fleetAdmin = A.can('identity.admin', { type: 'Fleet' });
    const auditor = A.can('audit.read', { type: 'Fleet' }) && !fleetAdmin;
    const sec = bs.some((b) => b.role === 'project.security_approver');
    const tasks = [
      ...mine.map((i) => ({ k: 'gate', i, html: `${A.gate(i.gate)} <b>${A.esc(D.GATES[i.gate]?.title || i.gate)}</b> · ${A.ichip(i.key)}`, go: `gate-${i.gate}-${i.key}`, cta: 'Decide' })),
      ...answers.filter((i) => i.stage === 'S1').map((i) => ({ k: 'answer', i, html: `<span class="pill gate">S1</span> <b>Answer questions</b> · ${A.ichip(i.key)} <span class="small muted">${A.esc(i.waitWhat || '')}</span>`, go: `item-${i.key}`, cta: 'Answer' })),
      ...answers.filter((i) => i.stage === 'S8').map((i) => ({ k: 'merge', i, html: `<span class="pill gate">S8</span> <b>Merge on GitHub</b> · ${A.ichip(i.key)} <span class="small muted">${A.esc(i.pr || '')}</span>`, go: `item-${i.key}`, cta: 'Open PR' })),
      ...reqs.map((r) => ({ k: 'access', html: `<span class="pill info">access</span> <b>${A.esc(D.PEOPLE[r.pid].name)}</b> asks for <span class="mono">${r.role}</span> on ${A.esc(A.project(r.project)?.name || 'the factory')}${r.m6 ? ' <span class="pill warn">needs M6</span>' : ''}`, go: 'access-requests', cta: 'Review' })),
    ];
    const roleSummary = bs.length ? A.j(bs, (b) => `<span class="ac-rolechip"><b>${A.roleLabel(b.role)}</b><span>${b.scope.kind === 'fleet' ? 'whole factory' : b.scope.kind === 'team' ? 'team ' + b.scope.ref : A.esc(A.project(b.scope.ref)?.name || b.scope.ref)}</span></span>`) : '<span class="muted">No roles yet.</span>';
    const quick = [
      A.act('Ask for work', 'work.request', { type: 'Project', project: A.state.project }, { href: '#ask', cls: 'primary', icon: 'ask' }),
      A.can('project.onboard', { type: 'Fleet' }) || bs.some((b) => b.role === 'factory.onboarder') ? `<a class="btn" href="#onboard">${A.icon('onboard', 14)} Onboard a repo</a>` : '',
      `<a class="btn" href="#floor">${A.icon('floor', 14)} Open the floor</a>`,
      A.can('assistant.use', { type: 'Fleet' }) ? `<a class="btn" href="#chat">${A.icon('chat', 14)} Ask the factory</a>` : '',
    ].join('');

    const projCards = A.j(projs, (pr) => {
      const its = D.ITEMS.filter((i) => i.project === pr.id && !['done', 'declined'].includes(i.state));
      const roles = A.myRolesOn(pr.id).filter((r) => !r.startsWith('factory'));
      return `<a class="ac-pcard" href="#project-${pr.id}"><div class="row between"><h3>${A.esc(pr.name)}</h3>${A.health(pr.health)}</div>
        <div class="small muted mono">${pr.repo}</div>
        <div class="row" style="gap:6px">${A.pill(pr.level, pr.level === 'Full' ? 'ok' : pr.level === 'Light' ? 'info' : 'mute')}${pr.classification === 'confidential' ? A.pill('confidential', 'bad') : ''}</div>
        <div class="ac-pnums"><span><b class="num">${its.length}</b> in flight</span><span><b class="num">${its.filter((i) => i.state === 'waiting').length}</b> waiting</span><span><b class="num">${its.filter((i) => ['held', 'quarantined', 'stuck'].includes(i.state)).length}</b> need care</span></div>
        <div class="tiny faint">${roles.length ? 'You: ' + roles.map(A.roleLabel).join(', ') : 'You see it through a factory role'}</div></a>`;
    });

    const blocks = [];
    if (fleetAdmin) blocks.push(A.card('Factory at a glance', A.stats([
      { k: 'Projects', v: D.PROJECTS.length, d: '1 onboarding · 1 confidential' },
      { k: 'Coding slot', v: '1 / 1', d: 'queue 6 · HUMAN-WAIT 2 · caps 4 / 1', tone: 'warn' },
      { k: 'Active kills', v: 3, d: 'k-0193 lane web/L0 · k-0192 session · k-0191 lane', tone: 'bad' },
      { k: 'Pending factory M1', v: (A.cfg ? A.cfg.L.factory.filter((r) => r.state === 'pending').length : 0), d: 'decided by a factory admin other than the proposer', tone: 'warn' },
      { k: 'Access requests', v: A.ACCESS_REQUESTS.filter((r) => r.state === 'pending').length, d: 'across projects' },
      { k: 'Spend today', v: '$412', d: 'of $1,500 factory budget' },
    ]), { actions: '<a class="small" href="#health">Health</a> · <a class="small" href="#kill">Kill switch</a>' }));
    if (auditor) blocks.push(A.card('Record integrity', A.kv([['Ledger', '18,422 entries · chain intact · verified 6 min ago'], ['Checkpoint', '#312 · Witness co-signed 09:12'], ['Decisions today', '14 (2 with step-up)'], ['Exports', 'last: Q3 SOX sample, signed, write-once']]) + '<div class="row" style="margin-top:12px"><a class="btn" href="#ledger">Open ledger</a><a class="btn" href="#audit">Audit</a></div>'));
    if (sec) blocks.push(A.card('Security watch', A.kv([['Quarantined', `${A.ichip('W-19')} SECT open, ET10 credential read`], ['Tripwires 24h', '3 (1 confirmed, 2 false positives)'], ['Secret findings', '0 new in pushed patches'], ['Kill holders', 'Luis Torres (fleet), Rana Begum (Payments)']])));
    if (A.viewLevel(A.state.project) === 1) blocks.push(A.card('What you can see', `<p class="muted">You are a viewer (view level V1, data class D0) on ${A.esc(A.project(A.state.project)?.name || 'this project')}. You see where work is and who it waits on. Titles, artefacts, code and transcripts stay hidden. Your access ends on 1 Feb 2027.</p><div class="row" style="margin-top:10px"><a class="btn" href="#my-access">My access</a></div>`));

    return `<div class="ac-home">
      <div class="ac-hello"><div class="stack" style="gap:6px"><div class="eyebrow">${A.esc(A.persona())}</div><h1>${greet}, ${A.esc(p.name.split(' ')[0])}</h1>
        <p class="muted">${tasks.length ? `${tasks.length} thing${tasks.length === 1 ? '' : 's'} need${tasks.length === 1 ? 's' : ''} you.` : 'Nothing needs you right now.'} ${asks.length ? `${asks.length} of your requests are in flight.` : ''}</p></div>
        <div class="row">${quick}</div></div>
      <div class="ac-roles"><span class="eyebrow">Your roles</span>${roleSummary}<a class="small" href="#my-access">What can I do?</a></div>
      <div class="split">
        <div class="stack">
          ${A.card('Needs you', tasks.length ? `<div class="list">${A.j(tasks, (t) => `<div class="li" tabindex="0" data-go="${t.go}"><span>${t.i ? A.chip(t.i) : A.avatar(t.k === 'access' ? 'tb' : me, 'sm')}</span><div><div class="ti">${t.html}</div>${t.i ? `<div class="me">${A.esc(A.project(t.i.project).name)} · waiting ${t.i.updated || t.i.age}</div>` : ''}</div><span class="btn sm primary">${t.cta}</span></div>`)}</div>` : A.empty('Nothing waits on you. Decisions, questions and access requests for your roles appear here first.'), { flush: true, actions: '<a class="small" href="#inbox">Inbox</a>' })}
          ${asks.length ? A.card('Your requests', A.table([{ h: 'Item', r: (i) => A.ichip(i.key) }, { h: 'Where', r: (i) => `<span class="mono">${i.stage} ${i.step}</span>` }, { h: 'State', r: (i) => A.statePill(i.state) }, { h: 'Waiting on', r: (i) => (i.wait.length ? A.avatars(i.wait) : '<span class="faint">the factory</span>') }], asks, { href: (i) => 'item-' + i.key }), { flush: true }) : ''}
          ${blocks.join('')}
        </div>
        <div class="stack">
          <div class="eyebrow">Your projects</div>
          ${projs.length ? projCards : A.empty('You have no project yet. Ask a project admin for a role, or request one under My access.')}
          ${A.card('Sign-in', A.kv([['Signed in', 'today ' + new Date(A.session.at || Date.now()).toTimeString().slice(0, 5) + ' · SSO + security key'], ['Session', `<span class="mono">${A.session.sid}</span> · ends after 30 min idle`], ['Step-up', A.stepUpValid() ? '<span class="pill ok">valid</span>' : '<span class="pill mute">not active</span>']]))}
        </div>
      </div></div>`;
  }
  A.view('home', { label: 'Home', group: 'Home', icon: 'floor', render: homeRender, badge: () => ({ n: A.inboxCount(), hot: true }) });

  /* ================================================================ My access */
  const PROBE = [
    ['project.view', 'See the project'], ['floor.read', 'Open the floor'], ['work.request', 'Ask for work'], ['item.ready', 'Mark ready, answer S1'],
    ['gate.decide:G0G1', 'Decide G0+G1'], ['gate.decide:G2', 'Decide G2'], ['gate.decide:G3', 'Decide G3'], ['gate.decide:G4', 'Decide G4'], ['gate.decide:G5', 'Decide G5'], ['gate.decide:X1', 'Decide X1'], ['gate.decide:SECT', 'Decide SECT'],
    ['item.plan', 'Write a plan (B5)'], ['kill.request', 'Request a kill'], ['control.apply', 'Apply a control'], ['project.settings.edit', 'Change settings'], ['access.manage', 'Manage access'], ['audit.read', 'Read audit'],
  ];
  function myAccessRender() {
    const me = A.me(), bs = A.bindingsOf(me), projs = A.visibleProjects();
    const cell = (a, pid) => { const [act, gate] = a.split(':'); const res = gate ? { type: 'Gate', project: pid, gate } : { type: act.startsWith('item') ? 'Item' : 'Project', project: pid }; const w = A.why(act, res); return `<td class="ac-cell ${w.allow ? 'y' : 'n'}" title="${A.esc(w.reason)}" data-why="${A.esc(JSON.stringify({ action: act, res }))}">${w.allow ? '✓' : '·'}</td>`; };
    const myReq = A.ACCESS_REQUESTS.filter((r) => r.pid === me);
    return A.pageHead({ eyebrow: 'Account', title: 'My access', sub: 'Every role you hold, where it applies, where it came from, and what it lets you do. Click any cell to see the policy behind it.', actions: `<button class="btn primary" id="ma-req">Request a role</button>` }) +
      `<div class="split"><div class="stack">
        ${A.card('Role bindings', A.table([{ h: 'Role', r: (b) => `<b>${b.role}</b><div class="tiny faint">${A.esc(X.ROLE[b.role].description)}</div>` }, { h: 'Scope', r: (b) => (b.scope.kind === 'fleet' ? '<span class="pill info">whole factory</span>' : b.scope.kind === 'team' ? `<span class="pill plain">team ${b.scope.ref}</span>` : A.esc(A.project(b.scope.ref)?.name)) }, { h: 'View · data', r: (b) => `<span class="mono">${X.ROLE[b.role].view_level} · ${X.ROLE[b.role].data_class}</span>` }, { h: 'Source', r: (b) => `<span class="small">${A.esc(b.source)}</span>${b.note ? `<div class="tiny faint">${A.esc(b.note)}</div>` : ''}` }, { h: 'Since', r: (b) => `<span class="small">${b.since}${b.expires ? ` → <b>${b.expires}</b>` : ''}</span>` }], bs), { flush: true })}
        ${A.card('What you can do, per project', `<div class="tbl-wrap"><table class="tbl ac-matrix"><thead><tr><th>Action</th>${A.j(projs, (p) => `<th>${A.esc(p.name)}</th>`)}</tr></thead><tbody>${A.j(PROBE, ([a, l]) => `<tr><td>${l}<div class="tiny mono faint">${a}</div></td>${A.j(projs, (p) => cell(a, p.id))}</tr>`)}</tbody></table></div><p class="tiny faint" style="padding:10px 16px">✓ allowed by the policy · · not allowed. Cross-cutting rules (you cannot decide your own request, two-person gates, step-up) apply on top at decision time.</p>`, { flush: true })}
      </div><div class="stack">
        ${A.card('Your access requests', myReq.length ? A.j(myReq, (r) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--line)"><span><span class="mono small">${r.role}</span><div class="tiny faint">${A.esc(A.project(r.project)?.name || 'factory')} · ${r.at}</div></span>${A.pill(r.state, r.state === 'approved' ? 'ok' : r.state === 'denied' ? 'bad' : 'warn')}</div>`) : '<p class="muted small">You have not asked for any role.</p>')}
        ${A.card('Sessions', A.kv([['This browser', `<span class="mono">${A.session.sid}</span> · Chrome · now`], ['Phone', 'Slack link sign-in · 2h ago'], ['Step-up', A.stepUpValid() ? 'valid' : 'not active']]) + `<div class="row" style="margin-top:10px"><button class="btn sm" data-toast="Other sessions ended">End other sessions</button><button class="btn sm danger" id="ma-out">Sign out</button></div>`)}
        ${A.card('How access works', `<ul class="small muted" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px"><li>A <b>role binding</b> gives you a role at a scope: one project, a team, or the whole factory.</li><li>Each role has a <b>view level</b> (V1 see positions, V2 content, V3 audit and settings) and a <b>data class</b> (D0–D2) that caps what text you see.</li><li><b>Gates</b> are decided by one slot each. Admins do not decide gates unless a project gives them the slot.</li><li>On top: you never decide your own request; X1, X2, E2 and M4 need two people; G5, M4 and sensitive G4s need step-up.</li><li>Confidential projects are invisible without a role on them.</li></ul>`)}
      </div></div>`;
  }
  A.view('my-access', { nav: false, render: myAccessRender, mount: (root) => {
    root.querySelector('#ma-out').onclick = () => A.signOutNow();
    root.querySelector('#ma-req').onclick = () => {
      const m = A.modal(`<div class="row between"><h2>Request a role</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
        <div class="field"><label for="rq-p">Project</label><select class="input" id="rq-p">${A.j(D.PROJECTS.filter((p) => p.classification !== 'confidential'), (p) => `<option value="${p.id}">${A.esc(p.name)}</option>`)}</select></div>
        <div class="field"><label for="rq-r">Role</label><select class="input" id="rq-r">${A.j(X.ROLES.filter((r) => r.scope_kinds.includes('project')), (r) => `<option value="${r.role_id}">${r.role_id} — ${A.esc(r.description)}</option>`)}</select></div>
        <div class="field"><label for="rq-w">Why you need it</label><textarea class="input" id="rq-w" placeholder="For example: I own billing/ now (CODEOWNERS PR #398)"></textarea></div>
        <p class="small muted">The project admin approves. A gate-deciding role also needs an M6 approver grant, and a privileged role needs MFA at sign-in.</p>
        <div class="row"><button class="btn primary" id="rq-go">Send request</button><button class="btn ghost" data-close>Cancel</button></div>`);
      m.querySelector('#rq-go').onclick = () => { const pr = m.querySelector('#rq-p').value, role = m.querySelector('#rq-r').value; A.ACCESS_REQUESTS.unshift({ id: 'ar-' + (40 + A.ACCESS_REQUESTS.length), pid: A.me(), role, project: pr, why: m.querySelector('#rq-w').value || '—', at: 'just now', state: 'pending', approver: (X.BINDINGS.find((b) => b.role === 'project.admin' && b.scope.ref === pr) || {}).pid || 'lt', m6: X.ROLE[role].approval_capable }); A.closeOverlay(); A.toast('Request sent to the project admin'); A.render(); };
    };
  } });

  A.notFoundHtml = () => `<div class="ac-403"><div class="eyebrow">404</div><h1>Nothing here</h1><p class="muted">The link may be old, or it points at something you cannot see. Items, gates and settings in projects you have no role on do not exist for you.</p><a class="btn" href="#home">Go home</a></div>`;
  A.view('notfound', { nav: false, render: () => A.notFoundHtml() });
})();
