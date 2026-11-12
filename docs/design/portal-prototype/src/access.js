/* Identity, sessions and the permission engine of the portal prototype.
   Mirrors packages/contracts: ROLE_CATALOGUE (access.ts), ACTION_CATALOGUE (policy.ts), GATE_POLICIES
   (gate-lifecycle.ts), TWO_PERSON_GATES (projects.ts). The portal never decides: every check here is
   what the PDP (Cedar, embedded) would answer, and the server asks again on every route. */
(function () {
  const D = A.data;

  /* ================================================================ principals (people + new ones) */
  Object.assign(D.PEOPLE, {
    nf: { name: 'Nora Field', roles: ['internal audit'], team: 'audit', color: '#c9b37a' },
    tb: { name: 'Tom Becker', roles: ['finance stakeholder'], team: 'finance', color: '#a3b8cc' },
    oh: { name: 'Omar Haddad', roles: ['platform lead', 'deputy factory admin'], team: 'platform', color: '#7fc4a1' },
  });
  Object.entries(D.PEOPLE).forEach(([id, p]) => { p.id = id; p.initials = p.name.split(' ').map((s) => s[0]).join(''); p.email = p.email || `${p.name.split(' ')[0].toLowerCase()}.${p.name.split(' ')[1].toLowerCase()}@acme.example`; });
  D.TEAMS.push({ id: 'audit', name: 'Internal audit', lead: 'nf', members: ['nf'] }, { id: 'finance', name: 'Finance', lead: 'tb', members: ['tb'] });

  /* ================================================================ role catalogue (contracts ROLE_CATALOGUE, roles 1.1.0) */
  const R = (role_id, slot, description, o = {}) => ({ role_id, slot, description, scope_kinds: ['project'], approval_capable: false, privileged: false, view_level: 'V2', data_class: 'D1', ...o });
  const ROLES = [
    R('project.admin', 'admin', 'Project administrator: role map, settings, project gates (M1, M2, M3, M5, M6)', { approval_capable: true, privileged: true, view_level: 'V3' }),
    R('project.requester', 'requesters', 'May request work; decides G6 acceptance of their own request'),
    R('project.intent_approver', 'intent', 'Approves intent and spec (G0, G1, G1f, G2)', { approval_capable: true }),
    R('project.design_approver', 'design', 'Approves design and plan (G3d, G3, G3s, G3o)', { approval_capable: true }),
    R('project.code_owner', 'g4', 'Merge review (G4): the code owners on GitHub', { approval_capable: true }),
    R('project.release_approver', 'g5', 'Approves release (G5), step-up kept', { approval_capable: true, privileged: true }),
    R('project.exception_approver', 'x', 'Decides exception and action gates (X1–X4, E1–E6)', { approval_capable: true, privileged: true }),
    R('project.security_approver', 'sec', 'Security gates (Q1, SECT)', { approval_capable: true, privileged: true, data_class: 'D2' }),
    R('project.onboarding_signer', 'm4', 'Signs onboarding (M4), step-up required', { approval_capable: true, privileged: true }),
    R('project.kill_holder', 'kill', 'Requests a project or lane kill; releases it', { scope_kinds: ['project', 'lane'], privileged: true }),
    R('project.viewer', null, 'Read access to a project', { view_level: 'V1', data_class: 'D0' }),
    R('factory.admin', null, 'Factory administrator: every administrative action and the fleet kill (DEC-29); no gate or card decision unless it holds the slot through a project role map', { scope_kinds: ['fleet'], approval_capable: true, privileged: true, view_level: 'V3', data_class: 'D2' }),
    R('factory.onboarder', null, 'May request an onboarding (project.onboard); decides no gate and no card', { scope_kinds: ['fleet', 'team'], view_level: 'V1' }),
    R('factory.auditor', null, 'Reads the whole factory record; decides nothing', { scope_kinds: ['fleet'], view_level: 'V3', data_class: 'D2' }),
  ];
  const ROLE = Object.fromEntries(ROLES.map((r) => [r.role_id, r]));
  const VR = { V0: 0, V1: 1, V2: 2, V3: 3 };
  const DR = { D0: 0, D1: 1, D2: 2, D3: 3 };
  const DECIDING = ['admin', 'requesters', 'intent', 'design', 'g4', 'g5', 'x', 'sec', 'm4'];

  /* ================================================================ action catalogue (contracts ACTION_CATALOGUE, + portal-only rows marked) */
  const ADMINS = ['factory.admin'];
  const ACTIONS = {
    'project.onboard': { cls: 'write', types: ['Fleet', 'Team'], grants: [{ roles: ['factory.admin', 'factory.onboarder'] }], d: 'Request that a repository is onboarded as a project (S0, DEC-2)' },
    'work.request': { cls: 'write', types: ['Project'], grants: [{ slots: ['requesters', 'admin'] }], d: 'Ask for work on a project (S1)' },
    'item.ready': { cls: 'write', types: ['Item'], grants: [{ slots: ['requesters', 'intent', 'admin'] }], d: 'Say a request is ready (1.6) or answer its S1 questions' },
    'item.observe': { cls: 'write', types: ['Item'], grants: [{ slots: ['design'] }], d: 'Record an observed signal: B4 (design shows a spec gap) or R2 (smaller than its lane)' },
    'item.plan': { cls: 'write', types: ['Item'], grants: [{ slots: ['design'] }], d: 'Write the plan by hand after B5' },
    'project.view': { cls: 'read', types: ['Project'], grants: [{ view: 'V1' }], d: 'See a project and its settings' },
    'project.settings.edit': { cls: 'config', types: ['Project'], grants: [{ slots: ['admin'] }, { roles: ADMINS }], d: 'Change a project: role map, two-person rule, gating profile, kill delegations' },
    'floor.read': { cls: 'read', types: ['Fleet', 'Project'], grants: [{ view: 'V1' }], d: 'Open the floor of a project, or the fleet floor' },
    'item.view_floor': { cls: 'read', types: ['Item'], grants: [{ view: 'V1' }], d: 'See an item on the floor' },
    'gate.view': { cls: 'read', types: ['Gate'], grants: [{ view: 'V1' }], d: 'See a gate instance and its evidence' },
    'gate.decide': { cls: 'decide', types: ['Gate'], grants: [{ gate_slot: true }], d: 'Decide a gate; only the gate policy slot' },
    'card.decide': { cls: 'decide', types: ['Card'], grants: [{ decides_gates: true }], d: 'Decide an inbox card (a decision on each gate it carries)' },
    'kill.request': { cls: 'kill', types: ['Fleet', 'Project', 'Lane'], grants: [{ slots: ['kill', 'admin'] }, { roles: ADMINS }], d: 'Request a kill of a project or lane; the fleet kill is factory.admin only (DEC-29)' },
    'kill.release': { cls: 'kill', types: ['Fleet', 'Project', 'Lane'], grants: [{ slots: ['kill', 'admin'] }, { roles: ADMINS }], d: 'Release a kill (two different people, DEC-28)' },
    'config.propose': { cls: 'config', types: ['Fleet', 'Project'], grants: [{ slots: ['admin'] }, { roles: ADMINS }], d: 'Propose a configuration revision (publishing needs an M1 gate)' },
    'audit.read': { cls: 'read', types: ['Fleet', 'Project'], grants: [{ view: 'V3' }], d: 'Read the audit views of a project or of the whole factory' },
    'control.apply': { cls: 'config', types: ['Fleet', 'Project', 'Lane'], grants: [{ slots: ['admin'] }, { roles: ADMINS }], d: 'Preview and apply a control (hold, clamp, halt, maintenance)' },
    'control.lift': { cls: 'config', types: ['Fleet', 'Project', 'Lane'], grants: [{ slots: ['admin'] }, { roles: ADMINS }], d: 'Lift a control' },
    'banner.publish': { cls: 'config', types: ['Fleet', 'Project'], grants: [{ slots: ['admin'] }, { roles: ADMINS }], d: 'Publish or withdraw a banner' },
    'access.explain': { cls: 'read', types: ['Fleet', 'Project'], grants: [{ view: 'V3' }], d: 'Ask who can decide what (effective access)' },
    // portal rows that the action catalogue does not have yet (proposed with this design; a change is an M3 catalogue/permission gate)
    'access.manage': { cls: 'config', types: ['Fleet', 'Project'], grants: [{ slots: ['admin'] }, { roles: ADMINS }], d: 'Add or revoke role bindings, approve access requests (approver grants still need M6)', proposed: true },
    'identity.admin': { cls: 'config', types: ['Fleet'], grants: [{ roles: ADMINS }], d: 'Sign-in settings: SSO, session policy, MFA, provisioning; suspend a person; end sessions', proposed: true },
    'ops.read': { cls: 'read', types: ['Fleet', 'Project'], grants: [{ view: 'V2' }], d: 'See scheduler, sandboxes and health (no content)', proposed: true },
    'session.stop': { cls: 'kill', types: ['Fleet', 'Project'], grants: [{ slots: ['kill', 'admin', 'sec'] }, { roles: ADMINS }], d: 'Stop one sandbox session (a session-scope kill)', proposed: true },
    'quality.read': { cls: 'read', types: ['Fleet'], grants: [{ view: 'V2' }], d: 'See agents, evals, gateway and integrations', proposed: true },
    'assistant.use': { cls: 'write', types: ['Fleet', 'Project'], grants: [{ view: 'V1' }], d: 'Ask the factory (answers only from what you can already see)', proposed: true },
  };

  /* ================================================================ gate policies (contracts GATE_POLICIES) */
  const TWO_PERSON = ['X1', 'X2', 'E2', 'M4'];
  const GP = (slot, o = {}) => ({ slot, two_person: false, own_request: 'blocked', step_up: false, consolidatable: false, ...o });
  const GATE_POLICY = {
    G0: GP('intent', { consolidatable: true }), G1: GP('intent', { consolidatable: true }), G0G1: GP('intent', { consolidatable: true }), G1f: GP('intent'), G2: GP('intent', { consolidatable: true }),
    G3: GP('design', { consolidatable: true }), G3d: GP('design', { consolidatable: true }), G3s: GP('design', { consolidatable: true }), G3o: GP('design', { consolidatable: true }),
    G4: GP('g4', { step_up_if: 'a sensitive path is in the diff (D37)' }), G5: GP('g5', { step_up: true, consolidatable: true }), G6: GP('requesters', { own_request: 'allowed', consolidatable: true }),
    X1: GP('x'), X2: GP('x'), X3: GP('x'), X4: GP('x'), E1: GP('x'), E2: GP('x'), E3: GP('x'), E4: GP('x'), E5: GP('x'), E6: GP('x'),
    M1: GP('admin'), M2: GP('admin'), M3: GP('admin'), M4: GP('m4', { step_up: true }), M5: GP('admin'), M6: GP('admin'),
    Q1: GP('sec'), SECT: GP('sec'),
  };
  TWO_PERSON.forEach((g) => (GATE_POLICY[g].two_person = true));

  /* ================================================================ bindings: who holds which role where */
  const B = (pid, role, kind, ref = null, o = {}) => ({ pid, role, scope: { kind, ref }, source: 'role map', since: '2026-10-02', ...o });
  const BINDINGS = [
    B('lt', 'factory.admin', 'fleet', null, { source: 'SCIM group aisdlc-admins', since: '2026-09-01' }),
    B('oh', 'factory.admin', 'fleet', null, { source: 'SCIM group aisdlc-admins', since: '2026-09-01', note: 'deputy: the second person for fleet kill releases (DEC-28)' }), B('oh', 'project.kill_holder', 'project', 'identity', { note: 'second releaser for Identity Hub kills' }),
    B('rb', 'project.admin', 'project', 'payments'), B('rb', 'project.kill_holder', 'project', 'payments'), B('rb', 'project.design_approver', 'project', 'payments', { note: 'backup approver (B21)' }),
    B('ar', 'project.intent_approver', 'project', 'payments'), B('ar', 'project.design_approver', 'project', 'payments'), B('ar', 'project.code_owner', 'project', 'payments', { source: 'CODEOWNERS (synced)' }), B('ar', 'project.viewer', 'project', 'ledger'),
    B('pm', 'project.intent_approver', 'project', 'payments'), B('pm', 'project.requester', 'project', 'payments'), B('pm', 'project.release_approver', 'project', 'payments'), B('pm', 'project.viewer', 'project', 'web'),
    B('dn', 'project.requester', 'project', 'payments'), B('dn', 'project.requester', 'project', 'ledger'),
    B('ak', 'project.requester', 'project', 'payments'), B('ak', 'project.requester', 'project', 'ledger'),
    B('jm', 'project.exception_approver', 'project', 'payments'), B('jm', 'project.exception_approver', 'project', 'ledger'), B('so', 'project.exception_approver', 'project', 'payments', { note: 'second approver for two-person X1, X2, E2' }),
    B('pm', 'project.onboarding_signer', 'project', 'payments'), B('rb', 'project.onboarding_signer', 'project', 'payments'), B('so', 'project.onboarding_signer', 'project', 'ledger'), B('rb', 'project.onboarding_signer', 'project', 'ledger', { note: 'second M4 signer' }), B('so', 'project.kill_holder', 'project', 'ledger'),
    B('ks', 'project.security_approver', 'project', 'payments'), B('ks', 'project.security_approver', 'project', 'web'), B('ks', 'project.security_approver', 'project', 'ledger'), B('ks', 'project.admin', 'project', 'identity'), B('ks', 'project.security_approver', 'project', 'identity'),
    B('so', 'project.admin', 'project', 'ledger'), B('so', 'project.code_owner', 'project', 'ledger', { source: 'CODEOWNERS (synced)' }), B('so', 'project.intent_approver', 'project', 'ledger'), B('so', 'project.design_approver', 'project', 'ledger'), B('so', 'project.code_owner', 'project', 'payments', { source: 'CODEOWNERS (synced)' }),
    B('mw', 'project.admin', 'project', 'web'), B('mw', 'project.code_owner', 'project', 'web', { source: 'CODEOWNERS (synced)' }), B('mw', 'project.intent_approver', 'project', 'web'), B('mw', 'project.design_approver', 'project', 'web'), B('mw', 'factory.onboarder', 'team', 'web'), B('mw', 'project.onboarding_signer', 'project', 'mobile', { note: 'bootstrap until card 4' }),
    B('nf', 'factory.auditor', 'fleet', null, { source: 'SCIM group aisdlc-audit', since: '2026-09-15' }),
    B('tb', 'project.viewer', 'project', 'payments', { since: '2026-11-01', expires: '2027-02-01' }),
  ];

  /* ================================================================ accounts that can sign in (the dev IdP lists these; production is SSO) */
  const ACCOUNTS = [
    { pid: 'lt', persona: 'Factory owner', blurb: 'Runs the factory: projects, people, access, kill switch, config. Decides no gate unless a project gives the slot.' },
    { pid: 'oh', persona: 'Deputy factory admin', blurb: 'Factory admin with Luis: decides factory M1 proposals Luis makes, second person for fleet kill releases.' },
    { pid: 'rb', persona: 'Project admin', blurb: 'Payments API role map and settings; kill holder; backup design approver.' },
    { pid: 'ar', persona: 'Approver and code owner', blurb: 'Decides G0–G3 and G4 on Payments API. The default account of this prototype.' },
    { pid: 'pm', persona: 'Product owner', blurb: 'Requests work, approves intent and specs, releases (G5).' },
    { pid: 'dn', persona: 'Engineer (requester)', blurb: 'Asks for work, answers S1 questions, accepts results (G6).' },
    { pid: 'ks', persona: 'Security', blurb: 'Quarantine and security triage (Q1, SECT); admin of the confidential Identity Hub.' },
    { pid: 'jm', persona: 'Exception approver', blurb: 'Irreversible operations and exceptions (X1–X4, E1–E6).' },
    { pid: 'mw', persona: 'Web lead, onboarding a repo', blurb: 'Admin of Web Checkout; started the Mobile App onboarding and decides its first cards (bootstrap).' },
    { pid: 'nf', persona: 'Auditor', blurb: 'Reads everything, ledger and audit included; decides nothing.' },
    { pid: 'tb', persona: 'Stakeholder (viewer)', blurb: 'Read-only on Payments API until 1 Feb 2027; no content beyond D0.' },
  ];

  A.access = { ROLES, ROLE, ACTIONS, GATE_POLICY, TWO_PERSON, BINDINGS, ACCOUNTS, VR, DR };

  /* ================================================================ session */
  const load = () => { try { return JSON.parse(localStorage.getItem('aisdlc.session') || 'null'); } catch { return null; } };
  const save = (s) => { try { s ? localStorage.setItem('aisdlc.session', JSON.stringify(s)) : localStorage.removeItem('aisdlc.session'); } catch { /* storage blocked: session lives in memory */ } };
  A.session = load() || { pid: 'ar', signedIn: true, at: Date.now(), mfa: true, stepUpUntil: Date.now() + 11 * 60000, sid: 'ses_web_8f2c' };
  A.me = () => A.session.pid;
  A.signIn = (pid, mfa) => { A.session = { pid, signedIn: true, at: Date.now(), mfa: !!mfa, stepUpUntil: 0, sid: 'ses_web_' + Math.random().toString(16).slice(2, 6) }; save(A.session); SIGNINS.unshift({ at: 'just now', pid, result: 'success', method: mfa ? 'SSO + WebAuthn' : 'SSO', ip: '10.20.4.17', ua: 'Chrome 131 · macOS' }); };
  A.signOut = () => { A.session = { pid: null, signedIn: false }; save(A.session); };
  A.stepUpValid = () => A.session.stepUpUntil && A.session.stepUpUntil > Date.now();
  A.grantStepUp = () => { A.session.stepUpUntil = Date.now() + 15 * 60000; save(A.session); };
  Object.defineProperty(D, 'ME', { get: () => A.session.pid || 'ar', configurable: true });

  const SIGNINS = [
    { at: '08:02', pid: 'ar', result: 'success', method: 'SSO + WebAuthn', ip: '10.20.4.17', ua: 'Chrome 131 · macOS' },
    { at: '07:55', pid: 'lt', result: 'success', method: 'SSO + WebAuthn', ip: '10.20.1.9', ua: 'Firefox 133 · Linux' },
    { at: '07:41', pid: 'tb', result: 'denied', method: 'SSO', ip: '81.4.110.2', ua: 'Safari · iOS', reason: 'outside allowed network for external guest' },
    { at: '07:40', pid: 'tb', result: 'success', method: 'SSO', ip: '10.20.9.40', ua: 'Edge · Windows' },
    { at: 'yesterday 18:12', pid: 'ks', result: 'mfa_failed', method: 'SSO + TOTP', ip: '10.20.6.3', ua: 'Chrome · macOS' },
  ];
  A.access.SIGNINS = SIGNINS;

  /* ================================================================ the engine */
  const bindingsOf = (pid) => BINDINGS.filter((b) => b.pid === pid && !b.revoked);
  A.bindingsOf = bindingsOf;
  const coversProject = (b, project) => {
    if (b.scope.kind === 'fleet') return !project || A.project(project)?.classification !== 'confidential';
    if (b.scope.kind === 'project') return b.scope.ref === project;
    if (b.scope.kind === 'team') return false; // team-to-project containment is not assumed
    return false;
  };
  /** the roles a person holds that reach this resource */
  const rolesFor = (pid, res) => bindingsOf(pid).filter((b) => {
    if (res.type === 'Fleet') return b.scope.kind === 'fleet';
    if (res.type === 'Team') return b.scope.kind === 'fleet' || (b.scope.kind === 'team' && b.scope.ref === res.team);
    return coversProject(b, res.project);
  });
  A.viewLevel = (project, pid = A.me()) => rolesFor(pid, { type: 'Project', project }).reduce((m, b) => Math.max(m, VR[ROLE[b.role].view_level]), 0);
  A.dataClass = (project, pid = A.me()) => rolesFor(pid, { type: 'Project', project }).reduce((m, b) => Math.max(m, DR[ROLE[b.role].data_class]), -1);
  const fleetView = (pid) => bindingsOf(pid).filter((b) => b.scope.kind === 'fleet').reduce((m, b) => Math.max(m, VR[ROLE[b.role].view_level]), 0);

  /**
   * why(action, res) -> { allow, reason, via, policy, need }
   * res: { type: 'Fleet'|'Project'|'Item'|'Gate'|'Card'|'Lane'|'Team', project, gate, item, team }
   */
  A.why = (action, res = { type: 'Fleet' }, pid = A.me()) => {
    const a = ACTIONS[action];
    if (!pid) return { allow: false, reason: 'You are signed out.', need: 'Sign in', policy: '—', via: [] };
    if (!a) return { allow: false, reason: `Unknown action ${action}: unknown means denied.`, policy: 'fail-closed', via: [], need: '' };
    const p = res.project && A.project(res.project);
    if (p && p.classification === 'confidential' && !bindingsOf(pid).some((b) => b.scope.kind === 'project' && b.scope.ref === p.id)) {
      return { allow: false, reason: `${p.name} is confidential. Only people with a role on it can see or act on it; fleet roles see it collapsed.`, policy: 'cross-cutting: confidential projects (FD-D6)', via: [], need: `a role on ${p.name}` };
    }
    const held = res.type === 'Fleet' ? bindingsOf(pid).filter((b) => b.scope.kind === 'fleet') : rolesFor(pid, res);
    const via = [];
    for (const b of held) {
      const r = ROLE[b.role];
      for (const g of a.grants) {
        let ok = false;
        if (g.view) ok = VR[r.view_level] >= VR[g.view];
        if (g.slots) ok = r.slot && g.slots.includes(r.slot);
        if (g.roles) ok = g.roles.includes(r.role_id);
        if (g.decides_gates) ok = r.slot && DECIDING.includes(r.slot);
        if (g.gate_slot) { const gp = GATE_POLICY[res.gate]; ok = gp && r.slot === gp.slot; }
        if (ok) { via.push(b); break; }
      }
    }
    // fleet roles read everything not confidential
    if (!via.length && (a.cls === 'read') && res.type !== 'Fleet') {
      const fv = fleetView(pid); const need = a.grants.find((g) => g.view);
      if (need && fv >= VR[need.view]) via.push(bindingsOf(pid).find((b) => b.scope.kind === 'fleet'));
    }
    const where = p ? ` on ${p.name}` : res.type === 'Fleet' ? ' for the whole factory' : '';
    if (via.length) {
      const b = via[0];
      return { allow: true, reason: `Allowed through ${b.role} ${b.scope.kind === 'fleet' ? '(fleet)' : b.scope.kind === 'team' ? `(team ${b.scope.ref})` : `on ${A.project(b.scope.ref)?.name || b.scope.ref}`}.`, policy: policyId(action, a, res), via, need: '' };
    }
    return { allow: false, reason: `You hold no role${where} that grants ${action}.`, policy: policyId(action, a, res), via: [], need: needText(a, res) };
  };
  const policyId = (action, a, res) => {
    const g = a.grants[0];
    if (g.gate_slot) return `gate_slot.${GATE_POLICY[res.gate]?.slot || '?'} (${res.gate})`;
    if (g.view) return `view_level ≥ ${g.view}`;
    if (g.slots) return `slots: ${g.slots.join(', ')}${a.grants[1]?.roles ? ' · roles: ' + a.grants[1].roles.join(', ') : ''}`;
    if (g.roles) return `roles: ${g.roles.join(', ')}`;
    return 'decides_gates';
  };
  const needText = (a, res) => {
    const g = a.grants[0];
    const where = res.project ? ` on ${A.project(res.project)?.name}` : '';
    if (g.gate_slot) { const s = GATE_POLICY[res.gate]?.slot; const r = ROLES.find((x) => x.slot === s); return `${r ? r.role_id : s}${where}`; }
    if (g.view) return `any role with view level ${g.view} or higher${where} (${ROLES.filter((r) => VR[r.view_level] >= VR[g.view]).map((r) => r.role_id).slice(0, 3).join(', ')}…)`;
    if (g.slots) return `${ROLES.filter((r) => g.slots.includes(r.slot)).map((r) => r.role_id).join(' or ')}${where}`;
    if (g.roles) return g.roles.join(' or ');
    return `a gate-deciding role${where}`;
  };
  A.can = (action, res, pid) => A.why(action, res, pid).allow;

  /** The cross-cutting rules on top of the grant, for one gate decision on one item */
  A.decideCheck = (gate, key, pid = A.me()) => {
    const it = A.item(key) || {}; const gp = GATE_POLICY[gate] || GP('admin');
    const res = { type: 'Gate', project: it.project || A.state.project, gate, item: key };
    const w = A.why('gate.decide', res, pid);
    const rules = [];
    rules.push({ ok: w.allow, text: w.allow ? w.reason : `Not your gate: ${gate} is decided by the ${gp.slot} slot (${w.need}).` });
    if (gp.own_request === 'blocked') rules.push({ ok: it.requester !== pid, text: it.requester === pid ? 'You asked for this work. The requester cannot decide its own gate (SoD).' : 'Separation of duties: you are not the requester.' });
    if (gate === 'G3' || gate === 'G3s') rules.push({ ok: true, text: 'The plan was written by agent A3, not by you (plan-author SoD).' });
    if (gate === 'G4') rules.push({ ok: true, text: 'The code was written by the coder agent; nobody pushed to the branch by hand.' });
    if (gp.two_person) rules.push({ ok: true, info: true, text: 'Two-person rule: a second, different approver must also approve (DEC-28).' });
    const stepUp = gp.step_up || (gate === 'G4' && key === 'W-24');
    if (stepUp) rules.push({ ok: true, info: true, text: A.stepUpValid() ? 'Step-up is valid, bound to this decision.' : 'Step-up needed: you confirm with your security key before the decision is recorded.' });
    if (A.state.killed) rules.push({ ok: false, text: 'A kill covers this project. Gates stay open; nothing can be approved until it is released.' });
    return { allow: rules.every((r) => r.ok || r.info), rules, stepUp, twoPerson: gp.two_person, policy: gp, why: w };
  };

  /* ================================================================ visibility filters */
  A.canSeeProject = (id, pid) => A.can('project.view', { type: 'Project', project: id }, pid);
  A.visibleProjects = (pid) => D.PROJECTS.filter((p) => A.canSeeProject(p.id, pid));
  A.visibleItems = (pid) => D.ITEMS.filter((i) => A.canSeeProject(i.project, pid));
  /** what an item looks like to someone with view level 1 (D0): key, lane, stage only */
  A.redactedTitle = (it) => (A.dataClass(it.project) >= 1 ? it.title : 'Title hidden (needs D1)');
  A.roleLabel = (role) => role.replace('project.', '').replace('factory.', 'factory ').replace(/_/g, ' ');
  A.myRolesOn = (project, pid = A.me()) => bindingsOf(pid).filter((b) => (b.scope.kind === 'project' && b.scope.ref === project) || b.scope.kind === 'fleet').map((b) => b.role);
  A.persona = (pid = A.me()) => (ACCOUNTS.find((a) => a.pid === pid) || {}).persona || 'Member';

  /* ================================================================ UI helpers that obey the engine */
  /**
   * A.act(label, action, res, {cls, href, go, attrs, icon}) -> a button or link; when denied, a disabled
   * button with a lock whose click explains why (never hidden silently when the person can see the thing).
   */
  A.act = (label, action, res, o = {}) => {
    const w = A.why(action, res);
    const cls = `btn ${o.cls || ''}`;
    if (!w.allow) return `<button class="${cls} locked" aria-disabled="true" data-why="${A.esc(JSON.stringify({ action, res }))}" title="${A.esc(w.reason)}">${A.icon('lock', 13)} ${label}</button>`;
    if (o.href) return `<a class="${cls}" href="${o.href}" ${o.attrs || ''}>${o.icon ? A.icon(o.icon, 14) : ''}${label}</a>`;
    return `<button class="${cls}" ${o.go ? `data-go="${o.go}"` : ''} ${o.attrs || ''}>${o.icon ? A.icon(o.icon, 14) : ''}${label}</button>`;
  };
  A.explainDrawer = (action, res) => {
    const w = A.why(action, res); const a = ACTIONS[action] || {};
    A.drawer(`<div class="row between"><span class="eyebrow">Why ${w.allow ? 'you can' : 'you can’t'}</span><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      <h2>${w.allow ? 'Allowed' : 'Not allowed'}: <span class="mono" style="font-size:.8em">${action}</span></h2>
      <p class="muted">${A.esc(a.d || '')}</p>
      <div class="banner ${w.allow ? 'info' : 'bad'}" style="margin:0">${A.esc(w.reason)}</div>
      ${A.kv([['You', A.who(A.me())], ['Resource', `<span class="mono">${res.type}${res.project ? ' · ' + res.project : ''}${res.gate ? ' · ' + res.gate : ''}${res.item ? ' · ' + res.item : ''}</span>`], ['Policy', `<span class="mono">${A.esc(w.policy)}</span>`], ['Bundle', '<span class="mono">pdp 37 · roles-1.1.0 · 3f9a…c21</span>'], !w.allow ? ['What would allow it', A.esc(w.need)] : null, ['Your roles here', A.j(res.type === 'Fleet' ? bindingsOf(A.me()).filter((b) => b.scope.kind === 'fleet').map((b) => b.role) : A.myRolesOn(res.project), (r) => `<span class="pill plain">${r}</span> `) || '<span class="faint">none</span>']])}
      ${!w.allow ? `<div class="card"><div class="bd stack" style="gap:10px"><b>Ask for access</b><p class="small muted">Your request goes to the project admin${res.project ? ` of ${A.project(res.project)?.name}` : ' (factory admin for fleet roles)'}. A role that decides gates also needs an M6 approver grant. Every grant is a ledger entry.</p><button class="btn primary" data-reqaccess="${A.esc(JSON.stringify({ action, res, need: w.need }))}">Request ${A.esc(w.need.split(' (')[0])}</button></div></div>` : ''}
      <p class="tiny faint">The portal only mirrors the policy. The server asks the PDP again on every request, so a hidden or enabled button never grants anything.</p>`);
  };
  A.ACCESS_REQUESTS = [
    { id: 'ar-31', pid: 'tb', role: 'project.requester', project: 'payments', why: 'Finance needs to file reporting requests directly until the Q1 close', at: '2h ago', state: 'pending', approver: 'rb', until: '2027-02-01' },
    { id: 'ar-30', pid: 'dn', role: 'project.code_owner', project: 'payments', why: 'I own billing/ now (CODEOWNERS PR #398 merged)', at: '1d ago', state: 'pending', approver: 'rb', m6: true },
    { id: 'ar-29', pid: 'mw', role: 'project.viewer', project: 'payments', why: 'Checkout depends on refunds API', at: '3d ago', state: 'approved', approver: 'rb', ledger: 18391 },
    { id: 'ar-28', pid: 'ak', role: 'project.admin', project: 'payments', why: '—', at: '6d ago', state: 'denied', approver: 'rb', note: 'Ops needs requester, not admin' },
  ];
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-why],[data-reqaccess]'); if (!t) return;
    e.preventDefault(); e.stopPropagation();
    if (t.dataset.why) { const { action, res } = JSON.parse(t.dataset.why); A.explainDrawer(action, res); }
    else { const { res, need } = JSON.parse(t.dataset.reqaccess); const role = (need.match(/(project|factory)\.[a-z_]+/) || ['project.viewer'])[0]; A.ACCESS_REQUESTS.unshift({ id: 'ar-' + (32 + A.ACCESS_REQUESTS.length), pid: A.me(), role, project: res.project || null, why: 'Requested from the portal', at: 'just now', state: 'pending', approver: res.project ? (BINDINGS.find((b) => b.role === 'project.admin' && b.scope.ref === res.project) || {}).pid || 'lt' : 'lt', m6: ROLE[role]?.approval_capable }); A.closeOverlay(); A.toast(`Access request sent: ${role}. You will see it under My access.`); }
  }, true);

  /** a full-page "you can't open this" with the explanation */
  A.forbidden = (action, res, title) => {
    const w = A.why(action, res);
    return `<div class="ac-403"><div class="ac-403-mark">${A.icon('lock', 28)}</div><div class="eyebrow">403 · ${A.esc(action)}</div><h1>${A.esc(title || 'You can’t open this')}</h1><p class="muted" style="max-width:60ch">${A.esc(w.reason)} ${w.need ? `It needs ${A.esc(w.need)}.` : ''}</p>
      <div class="row"><button class="btn primary" data-why="${A.esc(JSON.stringify({ action, res }))}">See why and ask for access</button><a class="btn" href="#home">Go to your home</a></div>
      <p class="tiny faint">Policy <span class="mono">${A.esc(w.policy)}</span> · bundle pdp 37. This denial is not logged as an error; denies on write actions are in the decision log.</p></div>`;
  };
})();
