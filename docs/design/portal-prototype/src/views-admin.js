/* Admin: identity and access. Organisation & sign-in, People, Teams, Roles & permissions, Access requests,
   Who can do what, Sign-ins & sessions. Everything reads the live engine in access.js (A.why, A.can,
   A.decideCheck, A.access.BINDINGS), so a change made here (a binding added or revoked) changes what the
   person can do everywhere else in the portal. Vocabulary: contracts identity.ts / access.ts (Principal,
   Group, Membership, Binding, Qualification, IdentityLink, access.* ledger entries), step-up.ts (StepUpUse),
   DM §3.1 (BffSession, PdpDecision, AccessGrant = the M6 second key, AccessCampaign, SodRule). */
(function () {
  const D = A.data, X = A.access, esc = A.esc, j = A.j;
  const F = { type: 'Fleet' };
  const P = (project) => ({ type: 'Project', project });
  const mono = (s) => `<span class="mono">${esc(s)}</span>`;
  const DECIDING = ['admin', 'requesters', 'intent', 'design', 'g4', 'g5', 'x', 'sec', 'm4'];

  /* ================================================================ who is looking */
  const isIdAdmin = () => A.can('identity.admin', F);
  const isAuditor = () => A.can('audit.read', F);
  const managed = () => D.PROJECTS.filter((p) => A.can('access.manage', P(p.id)));
  const fullDir = () => isIdAdmin() || isAuditor();
  /** the one {action,res} that opens People / Teams for this person (router guard) */
  const dirAccess = () => {
    if (isIdAdmin()) return { action: 'identity.admin', res: F };
    if (isAuditor()) return { action: 'audit.read', res: F };
    const m = managed()[0];
    return { action: 'access.manage', res: P(m ? m.id : A.state.project) };
  };
  const reqAccess = () => {
    if (isIdAdmin()) return { action: 'identity.admin', res: F };
    const m = managed()[0];
    if (m) return { action: 'access.manage', res: P(m.id) };
    if (isAuditor()) return { action: 'audit.read', res: F };
    return { action: 'access.manage', res: P(A.state.project) };
  };
  const explainable = () => D.PROJECTS.filter((p) => A.can('access.explain', P(p.id)));
  const explainAccess = () => (A.can('access.explain', F) ? { action: 'access.explain', res: F } : { action: 'access.explain', res: P((explainable()[0] || {}).id || A.state.project) });
  const signinAccess = () => (isIdAdmin() || !isAuditor() ? { action: 'identity.admin', res: F } : { action: 'audit.read', res: F });

  /* ================================================================ directory (beyond core's PEOPLE) */
  const DIR = {
    lt: { source: 'SCIM', last: 'today 07:55', mfa: 'WebAuthn · YubiKey 5C', gh: 'ltorres', upn: 'luis.torres@acme.example', created: '2026-09-01' },
    ar: { source: 'SCIM', last: 'today 08:02', mfa: 'WebAuthn · Touch ID + key', gh: 'alexr-acme', created: '2026-09-03' },
    pm: { source: 'SCIM', last: 'yesterday 17:40', mfa: 'WebAuthn · Windows Hello', gh: 'priya-m', created: '2026-09-03' },
    dn: { source: 'SCIM', last: 'today 09:14', mfa: 'TOTP · Authenticator', gh: 'dnovak', created: '2026-09-04' },
    ak: { source: 'SCIM', last: 'today 07:30', mfa: 'TOTP · Authenticator', gh: 'amarak', created: '2026-09-04' },
    jm: { source: 'SCIM', last: 'today 10:20', mfa: 'WebAuthn · YubiKey 5', gh: 'jmeyer-data', created: '2026-09-05' },
    ks: { source: 'SCIM', last: 'yesterday 18:14', mfa: 'WebAuthn · YubiKey 5C', gh: 'keiko-sec', created: '2026-09-01' },
    rb: { source: 'SCIM', last: 'today 08:47', mfa: 'WebAuthn · Touch ID', gh: 'rana-b', created: '2026-09-02' },
    so: { source: 'SCIM', last: '2 days ago', mfa: 'WebAuthn · YubiKey 5', gh: 'samosei', created: '2026-09-10' },
    mw: { source: 'SCIM', last: 'today 09:02', mfa: 'WebAuthn · Touch ID', gh: 'meiwong', created: '2026-09-11' },
    nf: { source: 'SCIM', last: 'today 08:20', mfa: 'WebAuthn · YubiKey 5', gh: null, created: '2026-09-15' },
    tb: { source: 'guest', last: 'today 07:40', mfa: 'TOTP · Authenticator', gh: null, created: '2026-11-01', sponsor: 'rb', guestUntil: '2027-02-01', home: 'Finance Partners GmbH (B2B)' },
  };
  /** principals core's PEOPLE does not have: an invite and a leaver */
  const EXTRA = {
    hv: { name: 'Hana Vogel', email: 'hana.vogel@acme.example', team: 'web', source: 'SCIM', status: 'invited', last: 'never', mfa: 'not enrolled', gh: 'hvogel', created: '2026-11-09', pending: [{ role: 'project.viewer', ref: 'web', note: 'starts on first sign-in' }] },
    ec: { name: 'Erik Carlsson', email: 'erik.carlsson@acme.example', team: 'payments', source: 'SCIM', status: 'suspended', last: '2026-11-02 16:31', mfa: 'WebAuthn · revoked', gh: 'ecarlsson', created: '2026-09-03', revoked: [{ role: 'project.requester', ref: 'payments' }, { role: 'project.design_approver', ref: 'payments' }], note: 'Left Acme 2026-11-03. SCIM set the account disabled; the factory revoked 2 bindings (ledger #18288–18290).' },
  };
  const STATUS = {}; // pid -> 'suspended' when suspended in this session
  const statusOf = (pid) => STATUS[pid] || (EXTRA[pid] ? EXTRA[pid].status : 'active');
  const person = (pid) => D.PEOPLE[pid] || EXTRA[pid] || { name: pid, email: '' };
  const meta = (pid) => DIR[pid] || EXTRA[pid] || { source: 'SCIM', last: '—', mfa: 'WebAuthn', created: '2026-11-01' };
  const av = (pid, cls = 'sm') => (D.PEOPLE[pid] ? A.avatar(pid, cls) : `<span class="av ${cls}" style="background:var(--det)">${esc(person(pid).name.split(' ').map((s) => s[0]).join(''))}</span>`);
  const who = (pid) => (D.PEOPLE[pid] ? A.who(pid) : `<span class="row" style="gap:7px;flex-wrap:nowrap">${av(pid)}<span>${esc(person(pid).name)}</span></span>`);
  const allPids = () => [...Object.keys(D.PEOPLE), ...Object.keys(EXTRA)];
  const statusPill = (s) => A.pill(s, { active: 'ok', suspended: 'bad', invited: 'info' }[s] || 'mute');
  const sourcePill = (s) => `<span class="ad-tag ${s === 'guest' ? 'warn' : ''}">${s === 'SCIM' ? 'SCIM · Entra ID' : s === 'guest' ? 'external guest' : esc(s)}</span>`;
  const projName = (id) => A.project(id)?.name || id;

  const QUALS = {
    ar: [['secure-code-review', '2026-03-12', '2027-03-12', 'lms_import', 'LMS-88213'], ['pci-dss-awareness', '2026-01-20', '2027-01-20', 'lms_import', 'LMS-80114']],
    so: [['secure-code-review', '2026-05-02', '2027-05-02', 'lms_import', 'LMS-90122']],
    mw: [['secure-code-review', '2026-06-18', '2027-06-18', 'lms_import', 'LMS-91877']],
    pm: [['sox-change-approver', '2026-04-01', '2027-04-01', 'lms_import', 'LMS-84410']],
    jm: [['data-protection-officer-delegate', '2026-02-11', '2027-02-11', 'lms_import', 'LMS-81002'], ['sox-change-approver', '2026-04-01', '2027-04-01', 'lms_import', 'LMS-84411']],
    ks: [['incident-handler', '2025-12-01', '2026-12-01', 'lms_import', 'LMS-77420'], ['secure-code-review', '2026-03-12', '2027-03-12', 'lms_import', 'LMS-88214']],
    lt: [['break-glass-custodian', '2026-09-01', '2027-09-01', 'manual (CISO)', 'CISO-2026-031']],
    nf: [['internal-auditor', '2026-01-05', '2027-01-05', 'lms_import', 'LMS-79001']],
    rb: [['people-manager', '2026-02-01', null, 'lms_import', 'LMS-80555']],
  };

  /* ================================================================ sessions, sign-ins, step-up, denies, access ledger */
  const SESSIONS = [
    { sid: 'ses_web_3a91', pid: 'lt', device: 'Firefox 133 · Linux', ip: '10.20.1.9', started: '07:55', last: '1 min ago', abs: '19:55', mfa: 'WebAuthn' },
    { sid: 'ses_web_77c0', pid: 'lt', device: 'Slack link · iOS', ip: '10.20.31.4', started: '06:40', last: '52 min ago', abs: '18:40', mfa: 'WebAuthn' },
    { sid: 'ses_web_8f2c', pid: 'ar', device: 'Chrome 131 · macOS', ip: '10.20.4.17', started: '08:02', last: 'now', abs: '20:02', mfa: 'WebAuthn' },
    { sid: 'ses_web_1d4e', pid: 'rb', device: 'Safari 18 · macOS', ip: '10.20.4.22', started: '08:47', last: '6 min ago', abs: '20:47', mfa: 'WebAuthn' },
    { sid: 'ses_web_c3b7', pid: 'dn', device: 'Chrome 131 · Windows', ip: '10.20.7.80', started: '09:14', last: '3 min ago', abs: '21:14', mfa: 'TOTP' },
    { sid: 'ses_web_5e02', pid: 'jm', device: 'Edge 131 · Windows', ip: '10.20.12.5', started: '10:18', last: 'now', abs: '22:18', mfa: 'WebAuthn' },
    { sid: 'ses_web_9a6f', pid: 'mw', device: 'Chrome 131 · macOS', ip: '10.20.9.11', started: '09:02', last: '18 min ago', abs: '21:02', mfa: 'WebAuthn' },
    { sid: 'ses_web_0bb1', pid: 'tb', device: 'Edge · Windows', ip: '10.20.9.40', started: '07:40', last: '22 min ago', abs: '19:40', mfa: 'TOTP', guest: true },
    { sid: 'ses_web_44d8', pid: 'nf', device: 'Chrome 131 · macOS', ip: '10.20.2.30', started: '08:20', last: '9 min ago', abs: '20:20', mfa: 'WebAuthn' },
    { sid: 'ses_web_e7a2', pid: 'ak', device: 'Chrome 131 · Linux', ip: '10.20.15.3', started: '07:30', last: '1 h ago', abs: '19:30', mfa: 'TOTP' },
  ];
  const liveSessions = () => {
    const me = A.me(); const list = SESSIONS.filter((s) => !s.ended && !(s.pid === me && s.sid !== A.session.sid && s.sid === 'ses_web_8f2c'));
    if (me && !list.some((s) => s.sid === A.session.sid)) list.unshift({ sid: A.session.sid, pid: me, device: 'This browser', ip: '10.20.4.17', started: new Date(A.session.at || Date.now()).toTimeString().slice(0, 5), last: 'now', abs: '+12 h', mfa: A.session.mfa ? 'WebAuthn' : 'SSO', you: true });
    return list.filter((s) => statusOf(s.pid) === 'active');
  };
  const MORE_SIGNINS = [
    { at: 'today 09:14', pid: 'dn', result: 'success', method: 'SSO + TOTP', ip: '10.20.7.80', ua: 'Chrome 131 · Windows' },
    { at: 'today 09:02', pid: 'mw', result: 'success', method: 'SSO + WebAuthn', ip: '10.20.9.11', ua: 'Chrome 131 · macOS' },
    { at: 'today 08:47', pid: 'rb', result: 'success', method: 'SSO + WebAuthn', ip: '10.20.4.22', ua: 'Safari 18 · macOS' },
    { at: 'today 08:31', pid: null, name: 'contractor (j.doe@gmail.com)', result: 'denied', method: 'SSO', ip: '92.41.7.200', ua: 'Chrome · Android', reason: 'email domain gmail.com is not allowed' },
    { at: 'today 08:20', pid: 'nf', result: 'success', method: 'SSO + WebAuthn', ip: '10.20.2.30', ua: 'Chrome 131 · macOS' },
    { at: 'today 07:30', pid: 'ak', result: 'success', method: 'SSO + TOTP', ip: '10.20.15.3', ua: 'Chrome 131 · Linux' },
    { at: 'today 06:40', pid: 'lt', result: 'success', method: 'Slack link + WebAuthn', ip: '10.20.31.4', ua: 'Slack · iOS' },
    { at: 'yesterday 18:14', pid: 'ks', result: 'success', method: 'SSO + WebAuthn', ip: '10.20.6.3', ua: 'Chrome · macOS' },
    { at: 'yesterday 17:40', pid: 'pm', result: 'success', method: 'SSO + WebAuthn', ip: '10.20.4.31', ua: 'Edge · Windows' },
    { at: 'yesterday 16:02', pid: 'ec', result: 'denied', method: 'SSO', ip: '85.10.2.14', ua: 'Safari · macOS', reason: 'principal disabled (SCIM, 2026-11-03)' },
    { at: 'yesterday 11:20', pid: 'jm', result: 'mfa_failed', method: 'SSO + WebAuthn', ip: '10.20.12.5', ua: 'Edge · Windows', reason: 'WebAuthn timed out (no touch in 60 s)' },
    { at: '2 days ago 19:05', pid: 'so', result: 'success', method: 'SSO + WebAuthn', ip: '10.20.8.2', ua: 'Firefox · Linux' },
    { at: '2 days ago 08:44', pid: 'dn', result: 'mfa_failed', method: 'SSO + TOTP', ip: '10.20.7.80', ua: 'Chrome · Windows', reason: 'wrong TOTP code (3 tries), locked 5 min' },
  ];
  const siKey = (at) => { const d = /^just/.test(at) ? 0 : /^today/.test(at) ? 1 : /^yesterday/.test(at) ? 2 : /^(\d) days/.test(at) ? 1 + +RegExp.$1 : 9; const t = (at.match(/(\d\d):(\d\d)/) || [0, 99, 99]); return d * 10000 - (+t[1] * 60 + +t[2]); };
  const signins = () => [...X.SIGNINS.map((s) => ({ ...s, at: /^\d\d:\d\d$/.test(s.at) ? 'today ' + s.at : s.at, reason: s.reason || (s.result === 'mfa_failed' ? 'TOTP code expired' : undefined) })), ...MORE_SIGNINS].sort((a, b) => siKey(a.at) - siKey(b.at));
  const STEPUPS = [
    { at: '10:41:02', pid: 'ar', what: 'G3 · W-23 decision', hash: '9f12c0e7a4b1', method: 'reauth', proof: '3c1e9a70-…-41f2', ledger: 18422 },
    { at: '10:22:09', pid: 'jm', what: 'X1 · W-31 decision (approver 1 of 2)', hash: 'c4a99b01de30', method: 'reauth', proof: '8a02f611-…-c09d', ledger: 18420 },
    { at: '10:20:31', pid: 'lt', what: 'kill release ses-7f12 (2 of 2)', hash: '77e0f4ad1b52', method: 'reauth', proof: '51bd0c3e-…-7a10', ledger: 18419 },
    { at: '09:57:48', pid: 'lt', what: 'M1 · gateway.routes r14 proposal', hash: '3e9d6b12f0aa', method: 'reauth', proof: 'e7c41a09-…-3b6e', ledger: 18418 },
    { at: 'yesterday 16:12', pid: 'pm', what: 'G5 · W-11 release', hash: '0aa4c2e9b771', method: 'reauth', proof: 'a10f2c88-…-e4d1', ledger: 18301 },
    { at: 'yesterday 11:02', pid: 'rb', what: 'M6 · M6-0042 approver grant', hash: 'f2d0b4a1c9e3', method: 'reauth', proof: '2c99e0b4-…-1f07', ledger: 18409 },
  ];
  const DENIES = [
    { at: '10:03:52', pid: 'core-worker', action: 'gate.decide', res: 'G3 · W-27', policy: 'xcut/service_principal_never_decides', why: 'a service principal never decides' },
    { at: '09:41:11', pid: 'dn', action: 'gate.decide', res: 'G4 · W-24', policy: 'default deny', why: 'no g4 slot on Payments API' },
    { at: '09:30:40', pid: 'lt', action: 'gate.decide', res: 'G4 · W-24', policy: 'xcut/factory_admin_no_gate (DEC-29)', why: 'factory.admin holds no gate slot' },
    { at: '09:12:30', pid: 'ak', action: 'gate.decide', res: 'G0+G1 · W-33', policy: 'sod/requester_not_approver', why: 'own request, and no intent slot' },
    { at: '08:58:02', pid: 'tb', action: 'work.request', res: 'Payments API', policy: 'default deny', why: 'project.viewer cannot request work' },
    { at: '08:40:19', pid: 'mw', action: 'access.manage', res: 'Payments API', policy: 'default deny', why: 'admin of Web Checkout, not of Payments API' },
    { at: '08:12:07', pid: 'ar', action: 'kill.request', res: 'Fleet', policy: 'xcut/fleet_kill_factory_admin_only', why: 'the fleet kill is factory.admin only' },
    { at: 'yesterday 17:02', pid: 'ks', action: 'gate.decide', res: 'SECT · W-19', policy: 'xcut/step_up_expired', why: 'step-up proof expired before submit; refused, never approved' },
    { at: 'yesterday 15:44', pid: 'tb', action: 'config.propose', res: 'Payments API', policy: 'default deny', why: 'needs project.admin' },
  ];
  let SEQ = 18423;
  const LEDGER = [
    { seq: 18412, at: 'today 07:40', kind: 'access.binding_updated', subj: 'tb · project.viewer · Payments API', actor: 'rb', detail: 'expiry set 2027-02-01 (guest rule: 90 days max)', ref: null, hash: '6e01c2a9' },
    { seq: 18409, at: 'yesterday 11:02', kind: 'access.binding_created', subj: 'rb · project.design_approver · Payments API', actor: 'rb', detail: 'backup approver (B21), AccessGrant from M6-0042', ref: 'M6-0042', hash: 'f2d0b4a1' },
    { seq: 18388, at: '2026-11-08', kind: 'access.qualification_granted', subj: 'ar · secure-code-review', actor: 'lms_import', detail: 'LMS-88213, valid to 2027-03-12', ref: null, hash: '0c7d1e55' },
    { seq: 18361, at: '2026-11-05', kind: 'access.binding_created', subj: 'ks · project.security_approver · Identity Hub', actor: 'ks', detail: 'M6-0037', ref: 'M6-0037', hash: 'aa31f7c0', conf: 'identity' },
    { seq: 18290, at: '2026-11-03', kind: 'access.binding_revoked', subj: 'ec · project.design_approver · Payments API', actor: 'scim-sync', detail: 'principal disabled', ref: null, hash: '19be3d02' },
    { seq: 18289, at: '2026-11-03', kind: 'access.binding_revoked', subj: 'ec · project.requester · Payments API', actor: 'scim-sync', detail: 'principal disabled', ref: null, hash: '7f4c0b18' },
    { seq: 18288, at: '2026-11-03', kind: 'access.principal_status', subj: 'ec · active → disabled', actor: 'scim-sync', detail: 'SCIM PATCH active=false', ref: null, hash: 'd03e9a71' },
    { seq: 18270, at: '2026-11-01', kind: 'access.binding_created', subj: 'tb · project.viewer · Payments API', actor: 'rb', detail: 'external guest, sponsor Rana Begum', ref: null, hash: '4b8a2f6d' },
    { seq: 18122, at: '2026-10-28', kind: 'access.binding_created', subj: 'jm · project.exception_approver · Payments API', actor: 'pm', detail: 'M6-0041', ref: 'M6-0041', hash: 'c1e0a7b3' },
    { seq: 17904, at: '2026-10-21', kind: 'access.membership_added', subj: 'nf → group aisdlc-audit', actor: 'scim-sync', detail: 'source sync · binds factory.auditor (fleet)', ref: null, hash: '8d2b6f40' },
  ];
  const logLedger = (kind, subj, detail, ref = null) => { const e = { seq: SEQ++, at: 'just now', kind, subj, actor: A.me(), detail, ref, hash: Math.random().toString(16).slice(2, 10) }; LEDGER.unshift(e); return e; };
  let M6N = 43;

  /* ================================================================ binding visibility for the viewer */
  const live = () => X.BINDINGS.filter((b) => !b.revoked);
  const scopeLabel = (b) => (b.scope.kind === 'fleet' ? '<span class="pill info">whole factory</span>' : b.scope.kind === 'team' ? `<span class="pill plain">team ${esc(b.scope.ref)}</span>` : esc(projName(b.scope.ref)));
  /** 'show' | 'collapsed' (exists but confidential to you) | 'hidden' (not yours to see) */
  const bVis = (b) => {
    if (fullDir()) { if (b.scope.kind !== 'project') return 'show'; return A.canSeeProject(b.scope.ref) ? 'show' : 'collapsed'; }
    const ids = managed().map((p) => p.id);
    return b.scope.kind === 'project' && ids.includes(b.scope.ref) ? 'show' : 'hidden';
  };
  const visibleBindingsOf = (pid) => live().filter((b) => b.pid === pid && bVis(b) === 'show');
  const dirPeople = () => allPids().filter((pid) => {
    if (fullDir()) return true;
    const ids = managed().map((p) => p.id);
    if (live().some((b) => b.pid === pid && b.scope.kind === 'project' && ids.includes(b.scope.ref))) return true;
    const ex = EXTRA[pid]; return !!ex && [...(ex.pending || []), ...(ex.revoked || [])].some((x) => ids.includes(x.ref));
  });
  const canManageBinding = (b) => (b.scope.kind === 'project' ? A.can('access.manage', P(b.scope.ref)) : isIdAdmin());
  const bindingRes = (b) => (b.scope.kind === 'project' ? P(b.scope.ref) : F);
  const syncedBy = (b) => (/CODEOWNERS/.test(b.source) ? 'CODEOWNERS on GitHub' : /SCIM/.test(b.source) ? 'the IdP group' : null);

  const scopeNote = () => fullDir() ? '' : `<div class="banner info">${A.icon('lock', 14)} You see the people of ${esc(managed().map((p) => p.name).join(', '))}, where you manage access. Fleet roles, other projects and sign-in details are not shown to a project admin.</div>`;
  const roHint = () => (!isIdAdmin() && isAuditor() ? `<div class="banner info">${A.icon('audit', 14)} Read-only: you read this through factory.auditor (audit.read). Every button that changes something is locked and explains who can.</div>` : '');
  const devHint = (txt = 'Switch account to try it') => `<button class="btn ghost sm ad-sw" data-switch>${A.icon('fleet', 13)} ${txt}</button>`;
  const wireSwitch = (root) => root.querySelectorAll('[data-switch]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); A.closeOverlay(); setTimeout(() => document.getElementById('me-btn')?.click(), 0); }));

  /* ================================================================ 1. Organisation & sign-in */
  const ORG = {
    revs: [], // no identity.settings key exists: sign-in and session policy are deployment settings (portal-config §1.5, §6)
  };
  const CLAIMS = [
    ['sub', 'Principal.entra_oid', 'immutable; the principal id'], ['preferred_username', 'Principal.upn', ''], ['email', 'IdentityLink (email)', 'must end in an allowed domain'], ['name', 'Principal.display_name', ''],
    ['groups', 'Membership (source sync)', 'only the groups below; others are ignored'], ['amr', 'MFA evidence', 'hwk / swk / otp'], ['auth_time', 'StepUpClaims.auth_time', 'step-up uses prompt=login, max_age=0'],
  ];
  const GROUPMAP = [
    ['aisdlc-admins', 'factory.admin', 'fleet', 1, 'protected · PIM managed'], ['aisdlc-audit', 'factory.auditor', 'fleet', 1, 'protected'], ['aisdlc-onboarders-web', 'factory.onboarder', 'team web', 1, ''], ['aisdlc-breakglass', '— (break-glass principal only)', 'fleet', 0, 'sealed'],
  ];
  const SYNC = [
    ['today 10:30', 'delta', '0 created · 0 updated · 0 disabled', 'ok'], ['today 10:00', 'delta', '1 created (Hana Vogel, invited) · 2 updated', 'ok'], ['today 09:30', 'delta', 'no changes', 'ok'],
    ['2026-11-03 14:00', 'delta', '1 disabled (Erik Carlsson) → 2 bindings revoked', 'ok'], ['2026-11-02 02:00', 'full', '214 users read · 13 in scope · 4 groups', 'ok'], ['2026-10-29 10:00', 'delta', '429 from Graph, retried after 30 s', 'warn'],
  ];
  function orgRender() {
    const ENV = { sso: 'BFF_OIDC_* (issuer, client id, scopes)', claims: 'BFF_OIDC_* claim mapping', groups: 'identity /v1/groups and the IdP sync seed (IDENTITY_IDP_SEED_FILE)', session: 'BFF_IDLE_SECONDS, BFF_ABSOLUTE_SECONDS, BFF_STEP_UP_MODE', domains: 'BFF_ALLOWED_ORIGINS and the IdP tenant', guests: 'the IdP tenant and BFF_* settings' };
    const edit = (sec) => `<button class="btn sm locked" aria-disabled="true" data-cflock="${esc('Deployment setting, read only here: ' + ENV[sec] + '. Whoever runs the deployment sets it; making it editable from the portal would remove the bound it places on the factory (portal-config §6).')}">${A.icon('lock', 13)} Read only</button>`;
    const revs = ORG.revs.filter((r) => r.state === 'M1 pending');
    const guests = Object.keys(DIR).filter((p) => DIR[p].source === 'guest');
    return A.pageHead({ eyebrow: 'Admin · identity', title: 'Organisation & sign-in', sub: 'How people sign in to the factory: the identity provider, provisioning, session and MFA rules, guests and the break-glass account. These are deployment settings: shown here read only, set by whoever runs the deployment. Bindings for fleet roles come from IdP groups.', actions: `${A.act('Run SCIM sync now', 'identity.admin', F, { attrs: 'data-sync' })}${A.act('Unseal break-glass', 'identity.admin', F, { cls: 'danger', attrs: 'data-unseal' })}` }) +
      roHint() +
      (revs.length ? j(revs, (r) => `<div class="banner warn">${A.gate('M1')} <b>${esc(r.rev)}</b> waits on M1: ${esc(r.what)}. Proposed by ${esc(person(r.by).name)} ${esc(r.at)}; a factory admin other than the proposer decides it.<span class="sp"></span><span class="mono small">${esc(ORG.published)}</span></div>`) : '') +
      A.stats([
        { k: 'Identity provider', v: 'OIDC', d: 'sso.acme.example · discovery ok', tone: 'ok' },
        { k: 'SCIM provisioning', v: 'healthy', d: 'last delta 10:30 · 13 principals', tone: 'ok' },
        { k: 'MFA coverage', v: '12 / 13', d: '1 invited, not enrolled', tone: 'warn' },
        { k: 'Phishing-resistant', v: '9 / 12', d: '3 on TOTP (no privileged role)' },
        { k: 'External guests', v: guests.length, d: 'max 90 days · viewer only' },
        { k: 'Break-glass', v: 'sealed', d: 'last unsealed 2026-08-14 · X4 reviewed', tone: 'ok' },
      ]) +
      `<div class="ad-gap"></div><div class="grid g2 ad-cols">
      <div class="stack">
        ${A.card('Single sign-on (OIDC)', A.kv([['Issuer', mono('https://sso.acme.example')], ['Client id', mono('aisdlc-portal-prod')], ['Redirect URI', mono('https://factory.acme.example/auth/callback')], ['Flow', 'authorization code + PKCE (S256)'], ['Scopes', mono('openid profile email groups')], ['Token signing', 'RS256 · JWKS refreshed 4 min ago (2 keys)'], ['Clock skew', '60 s'], ['Local accounts', '<span class="pill ok">none</span> no factory passwords exist']]), { actions: edit('sso') })}
        ${A.card('Claims mapping', A.table([{ h: 'Claim', r: (c) => mono(c[0]) }, { h: 'Becomes', r: (c) => `<span class="small">${esc(c[1])}</span>` }, { h: 'Note', r: (c) => `<span class="tiny faint">${esc(c[2])}</span>` }], CLAIMS), { flush: true, actions: edit('claims') })}
        ${A.card('IdP groups → fleet roles', A.table([{ h: 'IdP group', r: (g) => mono(g[0]) }, { h: 'Role', r: (g) => `<b class="mono small">${esc(g[1])}</b>` }, { h: 'Scope', r: (g) => `<span class="small">${esc(g[2])}</span>` }, { h: 'Members', r: (g) => `<span class="num">${g[3]}</span>` }, { h: '', r: (g) => (g[4] ? `<span class="tiny faint">${esc(g[4])}</span>` : '') }], GROUPMAP) + '<p class="tiny faint ad-pad">Project roles never come from IdP groups. Each project’s role map makes them (M4.4), so the project admin decides who holds them and approver roles still need an M6 grant.</p>', { flush: true, actions: edit('groups') })}
        ${A.card('SCIM provisioning', A.kv([['Endpoint', mono('https://factory.acme.example/scim/v2')], ['Source', 'Entra ID · enterprise app “AISDLC”'], ['Scope', 'assigned users and groups (13 users, 4 groups)'], ['Deprovision', 'active=false disables the principal, ends its sessions and revokes its bindings'], ['Token', 'rotates 2027-01-15 · stored as a file reference']]) + `<div class="ad-gap s"></div>` + A.table([{ h: 'Run', r: (s) => `<span class="small mono">${s[0]}</span>` }, { h: 'Kind', r: (s) => `<span class="small">${s[1]}</span>` }, { h: 'Result', r: (s) => `<span class="small">${esc(s[2])}</span>` }, { h: '', r: (s) => A.pill(s[3], s[3]) }], SYNC), { actions: '<span class="pill ok">healthy</span>' })}
      </div>
      <div class="stack">
        ${A.card('Session policy', A.kv([['Idle timeout', '30 minutes'], ['Longest session', '12 hours, then sign in again'], ['MFA at sign-in', 'required for everyone; <b>security key (WebAuthn) for privileged roles</b>'], ['Step-up', '15 minutes, bound to one decision’s subject hash, single use (StepUpUse)'], ['Step-up method', '<span class="mono">reauth</span> (prompt=login); <span class="mono">reconfirm</span> (DEC-11 c-ii) is off'], ['Concurrent sessions', '3 per person; the oldest ends'], ['Privileged and IP change', 'session ends, sign in again']]), { actions: edit('session') })}
        ${A.card('Allowed email domains', `<div class="row" style="gap:6px">${j(['acme.example', 'acme-payments.example', 'partners.acme.example'], (d) => `<span class="ad-tag">${d}</span>`)}</div><p class="small muted" style="margin-top:10px">Sign-in from any other domain is refused before a principal is created. Last refused: <span class="mono">gmail.com</span> today 08:31.</p>`, { actions: edit('domains') })}
        ${A.card('External guests', A.kv([['Network', 'company network only (10.20.0.0/14 and VPN)'], ['Longest access', '90 days, then the binding expires; expiry never approves'], ['Roles', '<span class="mono">project.viewer</span> only (V1 · D0)'], ['Sponsor', 'a project admin of the project, named on the binding'], ['MFA', 'their own IdP’s MFA is not trusted; TOTP enrolled here']]) + `<div class="ad-gap s"></div>` + j(guests, (g) => `<div class="li ad-li" data-person="${g}">${who(g)}<div><div class="small">${esc(DIR[g].home)}</div><div class="tiny faint">sponsor ${esc(person(DIR[g].sponsor).name)} · until ${DIR[g].guestUntil}</div></div>${A.pill('guest', 'warn')}</div>`), { actions: edit('guests') })}
        ${A.card('Break-glass account', A.kv([['Principal', mono('bg-factory-01') + ' <span class="pill ok">sealed</span>'], ['Holds', 'factory.admin (fleet) while unsealed, at most 4 hours'], ['Unseal', 'two people: a factory admin and a security approver, each with a security key'], ['Custodians', `${who('lt')} ${who('ks')}`], ['After use', 'an X4 break-glass post-hoc review opens automatically'], ['Last use', '2026-08-14 · gateway key rotation outage · X4 approved (ledger #9120)']]), { actions: A.gate('X4') })}
        ${A.card('Where these come from', A.table([{ h: 'Setting', r: (r) => esc(r[0]) }, { h: 'Source', r: (r) => `<span class="mono small">${esc(r[1])}</span>` }], [['Sign-in (OIDC)', 'BFF_OIDC_*'], ['Session idle and absolute', 'BFF_IDLE_SECONDS · BFF_ABSOLUTE_SECONDS'], ['Step-up mode', 'BFF_STEP_UP_MODE'], ['Allowed origins', 'BFF_ALLOWED_ORIGINS'], ['PDP sampling', 'BFF_PDP_SAMPLE_RATE'], ['Identity callers', 'IDENTITY_CALLERS']]), { flush: true })}
      </div></div>`;
  }
  function orgMount(root) {
    const s = root.querySelector('[data-sync]:not(.locked)'); if (s) s.onclick = () => { SYNC.unshift(['just now', 'delta', 'no changes', 'ok']); A.render(); A.toast('SCIM delta sync finished: no changes'); };
    const u = root.querySelector('[data-unseal]:not(.locked)'); if (u) u.onclick = () => {
      const m = A.modal(`<div class="row between"><h2>Unseal break-glass</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
        <p class="muted">Unsealing gives <span class="mono">bg-factory-01</span> factory.admin for at most 4 hours. It needs two people: you and a security approver. Afterwards an X4 post-hoc review opens and every action of the account is on the ledger.</p>
        <div class="field"><label for="ad-bg">Incident or reason</label><textarea class="input" id="ad-bg" placeholder="For example: INC-2291, the IdP is down and a kill must be released"></textarea></div>
        <div class="ad-steps"><div class="ok">1 · You confirm with your security key</div><div>2 · Keiko Sato (security) confirms with hers</div><div>3 · The account unseals for 4 h; X4 opens</div></div>
        <div class="row"><button class="btn danger" id="ad-bgo">Request unseal (1 of 2)</button><button class="btn ghost" data-close>Cancel</button></div>`);
      m.querySelector('#ad-bgo').onclick = () => A.stepUpModal(() => A.toast('Unseal request 1 of 2 recorded. Keiko Sato was paged to confirm.'), 'Unsealing break-glass is a privileged action. Your step-up is bound to this unseal request.');
    };
    root.querySelectorAll('[data-person]').forEach((r) => (r.onclick = () => openPerson(r.dataset.person)));
  }
  A.view('org', { label: 'Organisation & sign-in', group: 'Admin', icon: 'gateway', access: () => signinAccess(), deniedTitle: 'Organisation settings are for identity admins', render: orgRender, mount: orgMount });

  /* ================================================================ 2. People */
  let pFilter = 'all', pQuery = '';
  const projectsOf = (pid) => [...new Set(visibleBindingsOf(pid).filter((b) => b.scope.kind === 'project').map((b) => b.scope.ref))];
  const hiddenCount = (pid) => live().filter((b) => b.pid === pid && bVis(b) === 'collapsed').length;
  function peopleRender() {
    const pids = dirPeople();
    const count = (f) => pids.filter((p) => (f === 'guest' ? meta(p).source === 'guest' : statusOf(p) === f)).length;
    const rows = pids.filter((p) => (pFilter === 'all' ? true : pFilter === 'guest' ? meta(p).source === 'guest' : statusOf(p) === pFilter))
      .filter((p) => !pQuery || (person(p).name + ' ' + (person(p).email || '')).toLowerCase().includes(pQuery));
    const m0 = managed()[0];
    const addRes = isIdAdmin() ? F : m0 ? P(m0.id) : P(A.state.project);
    const expiring = live().filter((b) => b.expires && bVis(b) === 'show').length;
    const svc = [['core-worker', 'executes commands through the outbox; machine actions only'], ['codehost', 'GitHub App; push broker in push mode'], ['gateway', 'model gateway; holds the vendor keys'], ['knowledge', 'census and search index'], ['witness', 'co-signs ledger checkpoints (external)']];
    return A.pageHead({ eyebrow: 'Admin · identity', title: 'People', sub: fullDir() ? 'Everyone who can sign in to the factory, where they come from, and the roles they hold. Open a person to change their bindings, sessions or status.' : 'The people who hold roles on the projects you administer. Add or revoke a binding; approver roles also need an M6 grant.', actions: `${A.act('Invite person', 'identity.admin', F, { attrs: 'data-invite' })}${A.act('Add binding', 'access.manage', addRes, { cls: 'primary', attrs: 'data-addb' })}` }) +
      roHint() + scopeNote() +
      A.stats([
        { k: 'Principals', v: pids.length, d: fullDir() ? `${pids.length} people · ${svc.length} services` : 'with a role on your projects' },
        { k: 'Active', v: count('active'), d: fullDir() ? 'signed in within 7 days: ' + pids.filter((p) => /today|yesterday|days/.test(meta(p).last || '')).length : 'can sign in', tone: 'ok' },
        { k: 'Invited', v: count('invited'), d: 'waiting for first sign-in' },
        { k: 'Suspended', v: count('suspended'), d: 'bindings grant nothing', tone: count('suspended') ? 'bad' : '' },
        { k: 'External guests', v: count('guest'), d: 'viewer only · max 90 days', tone: count('guest') ? 'warn' : '' },
        { k: 'Bindings expiring', v: expiring, d: 'in the next 90 days' },
      ]) +
      `<div class="ad-gap"></div><div class="ad-toolbar"><div class="seg" role="group" aria-label="Filter">${j([['all', 'All'], ['active', 'Active'], ['invited', 'Invited'], ['suspended', 'Suspended'], ['guest', 'Guests']], ([k, l]) => `<button aria-pressed="${pFilter === k}" data-pf="${k}">${l}</button>`)}</div><label class="ad-search">${A.icon('search', 14)}<input class="input" id="ad-pq" placeholder="Find a person by name or email" value="${esc(pQuery)}" aria-label="Find a person"></label></div>` +
      A.card('', A.table([
        { h: 'Person', r: (p) => `<div class="row" style="gap:9px;flex-wrap:nowrap">${av(p)}<div><b>${esc(person(p).name)}</b><div class="tiny faint">${esc(person(p).email)}</div></div></div>` },
        { h: 'Status', r: (p) => statusPill(statusOf(p)) },
        { h: 'Source', r: (p) => sourcePill(meta(p).source) },
        { h: 'Roles', r: (p) => { const n = visibleBindingsOf(p).length, h = hiddenCount(p); return `<span class="num">${n}</span>${h ? ` <span class="tiny faint" title="bindings on a confidential project you cannot see">+${h} confidential</span>` : ''}`; } },
        { h: 'Projects', r: (p) => { const ps = projectsOf(p); const fl = visibleBindingsOf(p).some((b) => b.scope.kind === 'fleet'); return `<div class="ad-tags">${fl ? '<span class="ad-tag info">fleet</span>' : ''}${j(ps, (x) => `<span class="ad-tag">${esc(projName(x))}</span>`)}${!ps.length && !fl ? '<span class="faint small">none</span>' : ''}</div>`; } },
        ...(fullDir() ? [{ h: 'Last sign-in', r: (p) => `<span class="small muted">${esc(meta(p).last || '—')}</span>` },
          { h: 'MFA', r: (p) => { const m = meta(p).mfa || ''; return `<span class="small ${/WebAuthn/.test(m) && !/revoked/.test(m) ? '' : 'muted'}">${esc(m.split(' · ')[0])}</span>`; } }] : [{ h: 'Since', r: (p) => `<span class="small muted">${esc(visibleBindingsOf(p).map((b) => b.since).sort()[0] || '—')}</span>` }]),
      ], rows), { flush: true, id: 'ad-ptbl' }) + (rows.length ? '' : A.empty('Nobody matches this filter.')) +
      (fullDir() ? '<div class="ad-gap"></div>' + A.card('Service principals', A.table([{ h: 'Principal', r: (s) => `<span class="row" style="gap:7px;flex-wrap:nowrap">${A.glyph('D', 16)}<span class="mono">${s[0]}</span></span>` }, { h: 'Kind', r: () => A.pill('service', 'mute') }, { h: 'What it does', r: (s) => `<span class="small">${esc(s[1])}</span>` }, { h: 'May decide', r: () => '<span class="small muted">never · xcut/service_principal_never_decides</span>' }], svc), { flush: true }) : '');
  }
  // rows open the person drawer (A.table's href would route instead)
  function peopleMount(root) {
    const pids = dirPeople().filter((p) => (pFilter === 'all' ? true : pFilter === 'guest' ? meta(p).source === 'guest' : statusOf(p) === pFilter)).filter((p) => !pQuery || (person(p).name + ' ' + (person(p).email || '')).toLowerCase().includes(pQuery));
    const trs = root.querySelector('#ad-ptbl')?.querySelectorAll('tbody tr') || [];
    trs.forEach((tr, i) => { tr.classList.add('click'); tr.onclick = () => openPerson(pids[i]); });
    root.querySelectorAll('[data-pf]').forEach((b) => (b.onclick = () => { pFilter = b.dataset.pf; A.render(); }));
    const q = root.querySelector('#ad-pq'); q.oninput = () => { pQuery = q.value.trim().toLowerCase(); const pos = q.selectionStart; A.render(); const n = document.querySelector('#ad-pq'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } };
    const add = root.querySelector('[data-addb]:not(.locked)'); if (add) add.onclick = () => addBindingModal(null);
    const inv = root.querySelector('[data-invite]:not(.locked)'); if (inv) inv.onclick = inviteModal;
  }
  A.view('people', { label: 'People', group: 'Admin', icon: 'people', access: () => dirAccess(), deniedTitle: 'People is for access admins', render: peopleRender, mount: peopleMount });

  function inviteModal() {
    const m = A.modal(`<div class="row between"><h2>Invite a person</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      <p class="muted small">People normally arrive by SCIM when they are assigned the AISDLC app in Entra ID. Invite only someone who is assigned but has not signed in, or an external guest.</p>
      <div class="field"><label for="ad-ie">Email</label><input class="input" id="ad-ie" placeholder="name@acme.example"></div>
      <div class="field"><label for="ad-ik">Kind</label><select class="input" id="ad-ik"><option>Employee (SCIM)</option><option>External guest (viewer only, 90 days)</option></select></div>
      <p class="tiny faint">A new principal starts with no role. Writes principal.created to the identity journal and access.principal_status to the ledger.</p>
      <div class="row"><button class="btn primary" id="ad-igo">Send invitation</button><button class="btn ghost" data-close>Cancel</button></div>`);
    m.querySelector('#ad-igo').onclick = () => { const e = m.querySelector('#ad-ie').value || 'new.person@acme.example'; if (!/@(acme\.example|acme-payments\.example|partners\.acme\.example)$/.test(e) && !/guest/i.test(m.querySelector('#ad-ik').value)) { A.toast(`${e.split('@')[1] || 'that domain'} is not an allowed domain`); return; } logLedger('access.principal_status', `${e} · invited`, 'principal.created, waiting for first sign-in'); A.closeOverlay(); A.toast(`Invitation sent to ${e}. Ledger #${SEQ - 1}.`); };
  }

  /* ---------------------------------------------------------------- the person drawer */
  function openPerson(pid) {
    const p = person(pid), mt = meta(pid), st = statusOf(pid), me = A.me();
    const bs = visibleBindingsOf(pid), hidden = live().filter((b) => b.pid === pid && bVis(b) !== 'show');
    const ex = EXTRA[pid];
    const sess = liveSessions().filter((s) => s.pid === pid);
    const sis = signins().filter((s) => s.pid === pid).slice(0, 5);
    const dens = DENIES.filter((d) => d.pid === pid);
    const quals = QUALS[pid] || [];
    const sees = fullDir();
    const m0 = managed()[0];
    const brow = (b) => {
      const i = X.BINDINGS.indexOf(b); const sync = syncedBy(b); const r = X.ROLE[b.role];
      const act = sync ? `<span class="tiny faint">managed by ${sync}</span>` : A.act('Revoke', b.scope.kind === 'project' ? 'access.manage' : 'identity.admin', bindingRes(b), { cls: 'sm danger', attrs: `data-revoke="${i}"` });
      return `<tr><td><b class="mono small">${esc(b.role)}</b><div class="tiny faint">${r.view_level} · ${r.data_class}${r.approval_capable ? ' · approver' : ''}${r.privileged ? ' · privileged' : ''}</div></td><td>${scopeLabel(b)}</td><td><span class="small">${esc(b.source)}</span>${b.note ? `<div class="tiny faint">${esc(b.note)}</div>` : ''}</td><td><span class="small">${b.since}${b.expires ? `<br><b>→ ${b.expires}</b>` : ''}</span></td><td class="r">${act}</td></tr>`;
    };
    const lockedNote = (what) => `<div class="ad-hidden">${A.icon('lock', 13)} ${what} are visible to identity admins and auditors. ${A.act('Why', 'identity.admin', F, { cls: 'sm ghost' })}</div>`;
    const el = A.drawer(`<div class="row between"><span class="eyebrow">Principal · human</span><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      <div class="row" style="gap:12px;flex-wrap:nowrap">${av(pid, 'lg')}<div style="min-width:0"><h2>${esc(p.name)}</h2><div class="small muted">${esc(p.email)}</div><div class="row" style="gap:6px;margin-top:6px">${statusPill(st)}${sourcePill(mt.source)}${pid === me ? A.pill('you', 'human') : ''}</div></div></div>
      ${ex && ex.note ? `<div class="banner bad" style="margin:0">${esc(ex.note)}</div>` : ''}
      ${mt.source === 'guest' ? `<div class="banner warn" style="margin:0">External guest from ${esc(mt.home)}. Sponsor ${esc(person(mt.sponsor).name)}. Access ends ${mt.guestUntil}; company network only.</div>` : ''}
      ${A.kv([['Team', esc(D.TEAMS.find((t) => t.id === p.team)?.name || p.team || '—')], ['Principal id', mono('oid:' + (pid + '7f3a90c2e1d4').slice(0, 12))], ['Identity links', `${mt.gh ? `<span class="ad-tag">github_login ${esc(mt.gh)}</span> ` : ''}<span class="ad-tag">email ${esc(p.email)}</span>`], ['Created', esc(mt.created || '—') + ' by SCIM'], sees ? ['MFA', esc(mt.mfa || '—')] : null, ['Persona', esc(A.persona(pid))]])}
      <div class="row" style="gap:8px">${A.act('Add binding', 'access.manage', isIdAdmin() ? F : m0 ? P(m0.id) : P(A.state.project), { cls: 'sm primary', attrs: 'data-dadd' })}${A.act('End sessions', 'identity.admin', F, { cls: 'sm', attrs: 'data-dend' })}${st === 'suspended' ? A.act('Reactivate', 'identity.admin', F, { cls: 'sm', attrs: 'data-dreact' }) : A.act('Suspend', 'identity.admin', F, { cls: 'sm danger', attrs: 'data-dsus' })}</div>
      <h3 class="ad-h">Role bindings <span class="faint small">${bs.length}</span></h3>
      ${bs.length ? `<div class="tbl-wrap"><table class="tbl ad-btbl"><thead><tr><th>Role</th><th>Scope</th><th>Source</th><th>Since</th><th></th></tr></thead><tbody>${j(bs, brow)}</tbody></table></div>` : `<p class="small muted">${st === 'suspended' ? 'No live bindings: they were revoked when the account was disabled.' : 'No role you can see.'}</p>`}
      ${hidden.length ? `<p class="tiny faint">${A.icon('lock', 12)} +${hidden.length} binding${hidden.length > 1 ? 's' : ''} ${sees ? 'on a confidential project (only people with a role on it see them)' : 'outside the projects you administer'}.</p>` : ''}
      ${ex && ex.pending ? `<p class="small">Pending on first sign-in: ${j(ex.pending, (x) => `<span class="ad-tag info">${x.role} · ${esc(projName(x.ref))}</span> `)}</p>` : ''}
      ${ex && ex.revoked ? `<p class="small muted">Revoked: ${j(ex.revoked, (x) => `<span class="ad-tag bad">${x.role} · ${esc(projName(x.ref))}</span> `)}</p>` : ''}
      <h3 class="ad-h">Qualifications <span class="faint small">${quals.length}</span></h3>
      ${quals.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Type</th><th>Valid</th><th>Source</th></tr></thead><tbody>${j(quals, (q) => `<tr><td class="mono small">${q[0]}</td><td class="small">${q[1]} → ${q[2] || 'open'}</td><td class="small">${esc(q[3])}<div class="tiny faint mono">${q[4]}</div></td></tr>`)}</tbody></table></div><p class="tiny faint">No role in roles-1.1.0 requires a qualification yet (requires_qualification: null); they show in recertification.</p>` : '<p class="small muted">None recorded.</p>'}
      <h3 class="ad-h">Sessions <span class="faint small">${sees ? sess.length : ''}</span></h3>
      ${sees ? (sess.length ? j(sess, (s) => `<div class="ad-sess"><div><span class="mono small">${s.sid}</span>${s.you ? ' ' + A.pill('this browser', 'human') : ''}<div class="tiny faint">${esc(s.device)} · ${s.ip} · since ${s.started} · ${s.mfa}</div></div>${A.act('End', 'identity.admin', F, { cls: 'sm', attrs: `data-dend1="${s.sid}"` })}</div>`) : '<p class="small muted">No active session.</p>') : lockedNote('Sessions')}
      <h3 class="ad-h">Recent sign-ins</h3>
      ${sees ? (sis.length ? `<ul class="ad-mini">${j(sis, (s) => `<li><span class="mono tiny">${esc(s.at)}</span> ${A.pill(s.result, s.result === 'success' ? 'ok' : 'bad')} <span class="small">${esc(s.method)}</span>${s.reason ? `<div class="tiny faint">${esc(s.reason)}</div>` : ''}</li>`)}</ul>` : '<p class="small muted">None in the last 30 days.</p>') : lockedNote('Sign-ins')}
      <h3 class="ad-h">PDP denies on write actions</h3>
      ${dens.length ? `<ul class="ad-mini">${j(dens, (d) => `<li><span class="mono tiny">${d.at}</span> <span class="mono small">${d.action}</span> · ${esc(d.res)}<div class="tiny faint">${esc(d.policy)}: ${esc(d.why)}</div></li>`)}</ul>` : '<p class="small muted">No denies in 30 days.</p>'}
      <p class="tiny faint">Every change here writes to the identity journal and is made permanent as an access.* ledger entry (access.binding_created, access.binding_revoked, access.principal_status).</p>`);
    el.classList.add('ad-wide');
    const reopen = () => { A.render(); openPerson(pid); };
    el.querySelectorAll('[data-revoke]:not(.locked)').forEach((b) => (b.onclick = () => {
      const bd = X.BINDINGS[+b.dataset.revoke];
      if (bd.pid === me && bd.role.endsWith('admin')) { A.toast('You cannot revoke your own admin binding; ask another admin.'); return; }
      const m = A.modal(`<div class="row between"><h2>Revoke binding</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
        <p><b>${esc(p.name)}</b> loses <span class="mono">${esc(bd.role)}</span> on ${bd.scope.kind === 'project' ? esc(projName(bd.scope.ref)) : 'the whole factory'} at once. Open gate cards that wait on them for this role are reassigned to the other holders of the slot.</p>
        <div class="field"><label for="ad-rr">Reason (goes on the ledger)</label><textarea class="input" id="ad-rr" placeholder="For example: moved to the Ledger team"></textarea></div>
        <div class="row"><button class="btn danger" id="ad-rgo">Revoke · writes access.binding_revoked</button><button class="btn ghost" data-close>Cancel</button></div>`);
      m.querySelector('#ad-rgo').onclick = () => { bd.revoked = true; const e = logLedger('access.binding_revoked', `${pid} · ${bd.role} · ${bd.scope.kind === 'project' ? projName(bd.scope.ref) : 'fleet'}`, m.querySelector('#ad-rr').value || 'revoked in the portal'); reopen(); A.toast(`Revoked. Ledger #${e.seq} access.binding_revoked`); };
    }));
    const add = el.querySelector('[data-dadd]:not(.locked)'); if (add) add.onclick = () => addBindingModal(pid);
    const end = el.querySelector('[data-dend]:not(.locked)'); if (end) end.onclick = () => { if (pid === me) { A.toast('Use Sign out to end your own session.'); return; } SESSIONS.forEach((s) => { if (s.pid === pid) s.ended = true; }); logLedger('access.principal_status', `${pid} · sessions ended`, 'BffSession rows deleted'); reopen(); A.toast(`All sessions of ${p.name} ended. They must sign in again.`); };
    el.querySelectorAll('[data-dend1]:not(.locked)').forEach((b) => (b.onclick = () => { const s = SESSIONS.find((x) => x.sid === b.dataset.dend1); if (!s || s.you) { A.toast('That is this browser. Use Sign out.'); return; } s.ended = true; reopen(); A.toast(`Session ${s.sid} ended`); }));
    const sus = el.querySelector('[data-dsus]:not(.locked)'); if (sus) sus.onclick = () => {
      if (pid === me) { A.toast('You cannot suspend yourself.'); return; }
      const m = A.modal(`<div class="row between"><h2>Suspend ${esc(p.name)}</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
        <p class="muted">The principal becomes <span class="mono">disabled</span>: ${sess.length} session${sess.length === 1 ? '' : 's'} end now, sign-in is refused, and their ${live().filter((b) => b.pid === pid).length} bindings grant nothing while disabled. Gates waiting on them go to the other holders of the slot. Reactivating restores them.</p>
        <div class="field"><label for="ad-sr">Reason</label><textarea class="input" id="ad-sr" placeholder="For example: security investigation SEC-118"></textarea></div>
        <div class="row"><button class="btn danger" id="ad-sgo">Suspend · writes access.principal_status</button><button class="btn ghost" data-close>Cancel</button></div>`);
      m.querySelector('#ad-sgo').onclick = () => { STATUS[pid] = 'suspended'; SESSIONS.forEach((s) => { if (s.pid === pid) s.ended = true; }); const e = logLedger('access.principal_status', `${pid} · active → disabled`, m.querySelector('#ad-sr').value || 'suspended in the portal'); reopen(); A.toast(`${p.name} suspended. Ledger #${e.seq}`); };
    };
    const rea = el.querySelector('[data-dreact]:not(.locked)'); if (rea) rea.onclick = () => { if (EXTRA[pid]) { A.toast('SCIM disabled this account; re-enable it in Entra ID.'); return; } delete STATUS[pid]; const e = logLedger('access.principal_status', `${pid} · disabled → active`, 'reactivated'); reopen(); A.toast(`Reactivated. Ledger #${e.seq}`); };
  }

  function addBindingModal(pid) {
    const fleetOk = isIdAdmin();
    const projs = managed();
    const roles = X.ROLES.filter((r) => fleetOk || r.scope_kinds.includes('project'));
    const pids = (fullDir() ? allPids() : dirPeople().concat(Object.keys(D.PEOPLE).filter((x) => !dirPeople().includes(x)))).filter((x) => statusOf(x) === 'active');
    const m = A.modal(`<div class="row between"><h2>Add a role binding</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      <div class="grid g2"><div class="field"><label for="ad-bp">Person</label><select class="input" id="ad-bp">${j(pids, (x) => `<option value="${x}" ${x === pid ? 'selected' : ''}>${esc(person(x).name)}</option>`)}</select></div>
      <div class="field"><label for="ad-bs">Scope</label><select class="input" id="ad-bs">${j(projs, (p) => `<option value="project:${p.id}">Project · ${esc(p.name)}</option>`)}${fleetOk ? '<option value="fleet:">Whole factory (fleet)</option><option value="team:web">Team · Web</option>' : ''}</select></div></div>
      <div class="field"><label for="ad-br">Role</label><select class="input" id="ad-br">${j(roles, (r) => `<option value="${r.role_id}">${r.role_id} · ${r.view_level} ${r.data_class}${r.approval_capable ? ' · approver' : ''}</option>`)}</select></div>
      <div id="ad-bnote"></div>
      <div class="grid g2"><div class="field"><label for="ad-be">Expires (optional)</label><input class="input" id="ad-be" type="date"></div><div class="field"><label for="ad-bw">Reason</label><input class="input" id="ad-bw" placeholder="For example: joins Payments on-call"></div></div>
      <div class="row"><button class="btn primary" id="ad-bgo">Add binding</button><button class="btn ghost" data-close>Cancel</button></div>
      ${fleetOk ? '' : '<p class="tiny faint">Fleet and team roles are added only by an identity admin (Luis Torres). Approver roles need an M6 grant.</p>'}`);
    const note = () => {
      const r = X.ROLE[m.querySelector('#ad-br').value], [kind] = m.querySelector('#ad-bs').value.split(':');
      const okScope = r.scope_kinds.includes(kind);
      const t = !okScope ? `<div class="banner bad" style="margin:0">${r.role_id} can only be bound at ${r.scope_kinds.join(' or ')} scope.</div>`
        : r.approval_capable && kind === 'project' ? `<div class="banner warn" style="margin:0">${r.role_id} decides gates, so this opens an <b>M6 approver grant</b>. The binding exists only after M6 is approved (the AccessGrant is its second key). The M6 is decided by the project admin slot with step-up; nobody decides the grant of their own role.</div>`
          : `<div class="banner info" style="margin:0">Takes effect at once. Writes access.binding_created to the ledger.${r.privileged ? ' Privileged: the person needs a security key at sign-in.' : ''}</div>`;
      m.querySelector('#ad-bnote').innerHTML = t; m.querySelector('#ad-bgo').disabled = !okScope;
      m.querySelector('#ad-bgo').textContent = r.approval_capable && kind === 'project' ? 'Open M6 card' : 'Add binding';
    };
    ['#ad-br', '#ad-bs'].forEach((s) => (m.querySelector(s).onchange = note)); note();
    m.querySelector('#ad-bgo').onclick = () => {
      const who2 = m.querySelector('#ad-bp').value, role = m.querySelector('#ad-br').value, [kind, ref] = m.querySelector('#ad-bs').value.split(':');
      const r = X.ROLE[role], exp = m.querySelector('#ad-be').value;
      if (who2 === A.me()) { A.toast('You cannot grant yourself a role: someone else adds it.'); return; }
      if (kind === 'project' && X.ROLE[role].slot) { A.closeOverlay(); A.go(`cfg-project.role_map@${ref}`); A.toast(`Project roles come from the role map: draft ${who2 === 'ak' ? '' : ''}${person(who2).name} into the ${X.ROLE[role].slot} slot and propose it (M1${X.ROLE[role].approval_capable ? ' + M6' : ''}).`); return; }
      if (live().some((b) => b.pid === who2 && b.role === role && b.scope.kind === kind && (b.scope.ref || '') === (ref || ''))) { A.toast('That binding already exists'); return; }
      if (r.approval_capable && kind === 'project') { m6Flow({ pid: who2, role, project: ref, why: m.querySelector('#ad-bw').value || 'added from People' }, () => openPerson(who2)); return; }
      X.BINDINGS.push({ pid: who2, role, scope: { kind, ref: ref || null }, source: 'portal (access.manage)', since: '2026-11-10', ...(exp ? { expires: exp } : {}) });
      const e = logLedger('access.binding_created', `${who2} · ${role} · ${kind === 'project' ? projName(ref) : kind === 'team' ? 'team ' + ref : 'fleet'}`, m.querySelector('#ad-bw').value || 'added in the portal');
      A.render(); openPerson(who2); A.toast(`Binding added. Ledger #${e.seq} access.binding_created`);
    };
  }

  /** M6 approver grant: the binding exists only after M6. The admin slot of the project decides it with step-up. */
  function m6Flow(req, after) {
    const id = `M6-00${M6N++}`;
    const res = { type: 'Gate', project: req.project, gate: 'M6' };
    const w = A.why('gate.decide', res);
    const self = req.pid === A.me();
    const holders = live().filter((b) => b.scope.kind === 'project' && b.scope.ref === req.project && X.ROLE[b.role].slot === 'admin' && b.pid !== req.pid).map((b) => b.pid);
    const can = w.allow && !self;
    const m = A.modal(`<div class="row between"><h2>${A.gate('M6')} ${id} · approver grant</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      ${A.kv([['Grant', `<span class="mono">${esc(req.role)}</span> to ${who(req.pid)}`], ['Project', esc(projName(req.project))], ['Reason', esc(req.why)], ['Decided by', `the admin slot: ${holders.length ? j(holders, (h) => who(h)) : '<span class="faint">no other admin</span>'}`], ['Step-up', 'required, bound to this card’s subject hash']])}
      <ul class="ad-rules">${j([[w.allow, w.allow ? `You hold the admin slot on ${projName(req.project)}.` : `You do not hold the admin slot (${w.need}).`], [!self, self ? 'You cannot decide a grant of a role to yourself.' : 'Not a grant to yourself (self-grant forbidden).'], [true, 'Separation of duties checked: no toxic pair with the person’s other roles.']], ([ok, t]) => `<li class="${ok ? 'ok' : 'no'}">${esc(t)}</li>`)}</ul>
      <div class="row">${can ? '<button class="btn primary" id="ad-m6go">Approve M6 with step-up</button>' : `<button class="btn" id="ad-m6open">Leave the card open for ${holders.length ? esc(person(holders[0]).name) : 'an admin'}</button>`}<button class="btn ghost" data-close>Later</button>${can ? '' : devHint()}</div>
      <p class="tiny faint">On approval the factory writes the AccessGrant, then the binding (access.binding_created with m_gate_ref = this M6 entry).</p>`);
    wireSwitch(m);
    const finish = () => {
      if (!live().some((b) => b.pid === req.pid && b.role === req.role && b.scope.ref === req.project)) X.BINDINGS.push({ pid: req.pid, role: req.role, scope: { kind: 'project', ref: req.project }, source: `M6 ${id}`, since: '2026-11-10' });
      const g = logLedger('gate.decision', `${id} · ${req.role} → ${req.pid}`, 'M6 approved with step-up', id);
      const e = logLedger('access.binding_created', `${req.pid} · ${req.role} · ${projName(req.project)}`, `AccessGrant from ${id}`, id);
      STEPUPS.unshift({ at: 'just now', pid: A.me(), what: `M6 · ${id} approver grant`, hash: Math.random().toString(16).slice(2, 14), method: 'reauth', proof: 'new-…', ledger: g.seq });
      if (req.reqId) { const r = A.ACCESS_REQUESTS.find((x) => x.id === req.reqId); if (r) { r.state = 'approved'; r.ledger = e.seq; r.decidedBy = A.me(); } }
      A.render(); after && after(); A.toast(`${id} approved. Ledger #${g.seq} gate.decision, #${e.seq} access.binding_created`);
    };
    const go = m.querySelector('#ad-m6go'); if (go) go.onclick = () => (A.stepUpValid() ? finish() : A.stepUpModal(finish, `Deciding ${id} grants an approver role. Your step-up is bound to this card.`));
    const op = m.querySelector('#ad-m6open'); if (op) op.onclick = () => { if (req.reqId) { const r = A.ACCESS_REQUESTS.find((x) => x.id === req.reqId); if (r) { r.state = 'awaiting M6'; r.m6card = id; } } logLedger('gate.opened', `${id} · ${req.role} → ${req.pid}`, 'M6 approver grant opened', id); A.closeOverlay(); A.render(); A.toast(`${id} opened; it waits on the admin slot of ${projName(req.project)}.`); };
  }

  /* ================================================================ 3. Teams */
  const TEAM_META = { payments: ['eng-payments', 'internal'], ledger: ['eng-ledger', 'internal'], web: ['eng-web', 'internal'], security: ['sec-team', 'confidential'], platform: ['platform-eng', 'internal'], data: ['data-office', 'internal'], ops: ['ops-oncall', 'internal'], audit: ['aisdlc-audit', 'internal'], finance: [null, 'internal'] };
  function teamsRender() {
    const ids = managed().map((p) => p.id);
    const teams = D.TEAMS.filter((t) => fullDir() || D.PROJECTS.some((p) => p.team === t.id && ids.includes(p.id)) || t.members.some((m) => dirPeople().includes(m)));
    const teamB = live().filter((b) => b.scope.kind === 'team');
    return A.pageHead({ eyebrow: 'Admin · identity', title: 'Teams', sub: 'Teams group people and own projects. A team-scoped binding gives a fleet role to one team only, such as onboarding repositories for Web.', actions: A.act('New team', 'identity.admin', F, { attrs: 'data-newteam' }) }) + roHint() + scopeNote() +
      A.stats([{ k: 'Teams', v: teams.length, d: fullDir() ? 'owned by the factory (PLAN §7)' : 'that touch your projects' }, { k: 'Mapped to IdP groups', v: teams.filter((t) => TEAM_META[t.id]?.[0]).length, d: 'membership by SCIM sync' }, { k: 'Team-scoped bindings', v: teamB.length, d: 'factory.onboarder' }, { k: 'Confidential teams', v: teams.filter((t) => TEAM_META[t.id]?.[1] === 'confidential').length, d: 'members only see their projects' }]) +
      '<div class="ad-gap"></div>' +
      `<div class="grid g3 ad-teams">${j(teams, (t) => {
        const [grp, cls] = TEAM_META[t.id] || [null, 'internal']; const projs = D.PROJECTS.filter((p) => p.team === t.id && (A.canSeeProject(p.id) || fullDir()));
        const tb = teamB.filter((b) => b.scope.ref === t.id);
        const canAdd = D.PROJECTS.find((p) => p.team === t.id && A.can('access.manage', P(p.id)));
        return `<section class="card"><div class="bd stack" style="gap:10px"><div class="row between"><h3>${esc(t.name)}</h3>${cls === 'confidential' ? A.pill('confidential', 'bad') : ''}</div>
          <div class="row" style="gap:8px">${A.avatars(t.members.filter((m) => D.PEOPLE[m]), 'sm')}<span class="small muted">${t.members.length} member${t.members.length > 1 ? 's' : ''} · lead ${esc(person(t.lead).name)}</span></div>
          ${A.kv([['IdP group', grp ? mono(grp) : '<span class="faint">none (managed here)</span>'], ['Projects', projs.length ? j(projs, (p) => (A.canSeeProject(p.id) ? `<a href="#project-${p.id}">${esc(p.name)}</a> ` : `<span class="faint">1 confidential</span> `)) : '<span class="faint">none</span>'], ['Team bindings', tb.length ? j(tb, (b) => `<span class="ad-tag info">${b.role} · ${esc(person(b.pid).name)}</span> `) : '<span class="faint">none</span>']])}
          <div class="ad-members">${j(t.members, (m) => `<button class="ad-mem" data-person="${m}">${av(m)}<span>${esc(person(m).name)}</span>${m === t.lead ? '<span class="tiny faint">lead</span>' : ''}</button>`)}</div>
          <div class="row" style="gap:6px">${grp ? `<span class="tiny faint">Members come from ${esc(grp)}; change them in Entra ID.</span>` : A.act('Add member', canAdd ? 'access.manage' : 'identity.admin', canAdd ? P(canAdd.id) : F, { cls: 'sm', attrs: `data-addmem="${t.id}"` })}${A.act('Bind team role', 'identity.admin', F, { cls: 'sm', attrs: `data-teamrole="${t.id}"` })}</div></div></section>`;
      })}</div>` +
      '<div class="ad-gap"></div>' + A.card('Team-scoped bindings', teamB.length ? A.table([{ h: 'Person', r: (b) => who(b.pid) }, { h: 'Role', r: (b) => `<b class="mono small">${b.role}</b>` }, { h: 'Team', r: (b) => esc(D.TEAMS.find((t) => t.id === b.scope.ref)?.name || b.scope.ref) }, { h: 'What it allows', r: (b) => `<span class="small">${esc(X.ROLE[b.role].description)}</span>` }, { h: 'Since', r: (b) => `<span class="small">${b.since}</span>` }], teamB) + '<p class="tiny faint ad-pad">Team-to-project containment is not assumed: a team binding never reaches a project’s items. It only allows team-level actions such as project.onboard for that team.</p>' : A.empty('No team-scoped bindings.'), { flush: true });
  }
  function teamsMount(root) {
    root.querySelectorAll('[data-person]').forEach((b) => (b.onclick = () => openPerson(b.dataset.person)));
    root.querySelectorAll('[data-addmem]:not(.locked)').forEach((b) => (b.onclick = () => A.toast('Members of this team are managed here; choose someone from People and add a binding on the team’s project.')));
    root.querySelectorAll('[data-teamrole]:not(.locked)').forEach((b) => (b.onclick = () => {
      const t = b.dataset.teamrole;
      const m = A.modal(`<div class="row between"><h2>Bind a team role</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
        <div class="field"><label for="ad-tp">Person</label><select class="input" id="ad-tp">${j(D.TEAMS.find((x) => x.id === t).members, (x) => `<option value="${x}">${esc(person(x).name)}</option>`)}</select></div>
        <div class="field"><label>Role</label><input class="input" value="factory.onboarder (team ${esc(t)})" disabled></div>
        <p class="small muted">factory.onboarder may request an onboarding for this team (project.onboard). It decides no gate and no card. Writes access.binding_created.</p>
        <div class="row"><button class="btn primary" id="ad-tgo">Add binding</button><button class="btn ghost" data-close>Cancel</button></div>`);
      m.querySelector('#ad-tgo').onclick = () => { const pp = m.querySelector('#ad-tp').value; if (live().some((x) => x.pid === pp && x.role === 'factory.onboarder' && x.scope.ref === t)) { A.toast('That binding already exists'); return; } X.BINDINGS.push({ pid: pp, role: 'factory.onboarder', scope: { kind: 'team', ref: t }, source: 'portal (identity.admin)', since: '2026-11-10' }); const e = logLedger('access.binding_created', `${pp} · factory.onboarder · team ${t}`, 'team binding'); A.render(); A.toast(`Added. Ledger #${e.seq} access.binding_created`); };
    }));
    const nt = root.querySelector('[data-newteam]:not(.locked)'); if (nt) nt.onclick = () => A.toast('Teams are created by team.created in the identity journal; map one to an IdP group to sync members.');
  }
  A.view('teams', { label: 'Teams', group: 'Admin', icon: 'fleet', access: () => dirAccess(), deniedTitle: 'Teams is for access admins', render: teamsRender, mount: teamsMount });

  /* ================================================================ 4. Roles & permissions */
  const gatesOfSlot = (slot) => Object.keys(X.GATE_POLICY).filter((g) => X.GATE_POLICY[g].slot === slot && g !== 'G0' && g !== 'G1');
  /** does role r satisfy a grant of action a? '✓' plain, '◆' only as a gate slot, '' no */
  const roleCell = (r, a) => {
    for (const g of a.grants) {
      if (g.view && X.VR[r.view_level] >= X.VR[g.view]) return '✓';
      if (g.slots && r.slot && g.slots.includes(r.slot)) return '✓';
      if (g.roles && g.roles.includes(r.role_id)) return '✓';
      if (g.decides_gates && r.slot && DECIDING.includes(r.slot)) return '◆';
      if (g.gate_slot && r.slot && gatesOfSlot(r.slot).length) return '◆';
    }
    return '';
  };
  const XCUT = [
    ['Own request', 'The requester of an item never decides its gates; G6 acceptance is theirs.', 'sod/requester_not_approver', 'G0–G5, X, E'],
    ['Plan author', 'A person who wrote the plan by hand (B5) cannot approve its G3.', 'sod/plan_author', 'G3, G3s'],
    ['Code author', 'Nobody who pushed to the branch by hand approves its G4.', 'sod/code_author', 'G4'],
    ['Two-person', 'A second, different approver must also approve (DEC-28).', 'gate_policy.two_person', 'X1, X2, E2, M4'],
    ['Step-up', 'A fresh security-key proof bound to the decision’s subject hash (D37).', 'gate_policy.step_up', 'G5, M4, G4 with a sensitive path'],
    ['Admin decides no gate', 'factory.admin decides no gate or card unless a project role map gives it the slot (DEC-29).', 'xcut/factory_admin_no_gate', 'every gate'],
    ['Services never decide', 'No service principal holds a decide action.', 'xcut/service_principal_never_decides', 'every gate'],
    ['Self-grant forbidden', 'Nobody decides the M6 grant of their own role.', 'sod/self_grant', 'M6'],
    ['Proposer ≠ M1 decider', 'Whoever proposes a configuration revision does not publish it.', 'sod/config_proposer', 'M1, M3'],
    ['Confidential projects', 'Do not exist for people without a role on them; fleet roles see a collapsed row (FD-D6).', 'xcut/confidential', 'every action'],
    ['Fail closed', 'An unknown action, an unreachable PDP or an error is a refusal, never an approval.', 'pdp/fail_closed', 'every action'],
    ['Expiry never approves', 'A gate that times out escalates (B21); an expired binding grants nothing.', 'xcut/expiry', 'every gate'],
    ['Kill blocks approvals', 'While a kill covers a project, gates stay open but nothing can be approved.', 'xcut/kill_holds', 'every gate'],
  ];
  const SOD_PAIRS = [['static_pair', 'factory.admin', 'factory.auditor', 'never both'], ['toxic_pair', 'project.security_approver', 'project.exception_approver', 'flagged at grant, reviewed in recertification'], ['toxic_pair', 'project.release_approver', 'project.code_owner', 'flagged at grant']];
  function rolesRender() {
    const R = X.ROLES, ACT = Object.entries(X.ACTIONS);
    const myRoles = new Set(A.bindingsOf(A.me()).map((b) => b.role));
    const proj = A.canSeeProject(A.state.project) ? A.state.project : null;
    const holders = (slot) => (proj ? [...new Set(live().filter((b) => b.scope.kind === 'project' && b.scope.ref === proj && X.ROLE[b.role].slot === slot).map((b) => b.pid))] : []);
    const roleT = A.table([
      { h: 'Role', r: (r) => `<b class="mono small">${r.role_id}</b>${myRoles.has(r.role_id) ? ' ' + A.pill('you', 'human') : ''}<div class="tiny faint">${esc(r.description)}</div>` },
      { h: 'Slot', r: (r) => (r.slot ? mono(r.slot) : '<span class="faint">—</span>') },
      { h: 'Decides', r: (r) => (r.slot && DECIDING.includes(r.slot) ? `<div class="ad-tags ad-gates">${j(gatesOfSlot(r.slot), (g) => A.gate(g))}</div>` : '<span class="faint small">no gate</span>') },
      { h: 'View', r: (r) => mono(r.view_level) }, { h: 'Data', r: (r) => mono(r.data_class) },
      { h: 'Scopes', r: (r) => `<span class="small">${r.scope_kinds.join(', ')}</span>` },
      { h: 'Approver', r: (r) => (r.approval_capable ? '<span class="pill warn">M6 grant</span>' : '<span class="faint">—</span>') },
      { h: 'Privileged', r: (r) => (r.privileged ? '<span class="pill bad">security key</span>' : '<span class="faint">—</span>') },
    ], R);
    const actT = A.table([
      { h: 'Action', r: ([id, a]) => `<b class="mono small">${id}</b>${a.proposed ? ' <span class="ad-tag warn">proposed</span>' : ''}<div class="tiny faint">${esc(a.d)}</div>` },
      { h: 'Class', r: ([, a]) => `<span class="ad-tag ${a.cls === 'decide' ? 'gold' : a.cls === 'kill' ? 'bad' : ''}">${a.cls}</span>` },
      { h: 'Resource', r: ([, a]) => `<span class="small mono">${a.types.join(' · ')}</span>` },
      { h: 'Granted by', r: ([, a]) => `<span class="small">${esc(a.grants.map((g) => (g.view ? `view ≥ ${g.view}` : g.slots ? `slot ${g.slots.join(' / ')}` : g.roles ? g.roles.join(', ') : g.gate_slot ? 'the gate’s policy slot' : 'any gate-deciding slot')).join(' or '))}</span>` },
      { h: 'You', r: ([id, a]) => { const res = a.types.includes('Fleet') ? F : P(A.state.project); const ok = A.can(id, a.types.includes('Gate') ? { type: 'Gate', project: A.state.project, gate: 'G3' } : res); return `<span class="ad-cell ${ok ? 'y' : 'n'}" data-why="${esc(JSON.stringify({ action: id, res: a.types.includes('Gate') ? { type: 'Gate', project: A.state.project, gate: 'G3' } : res }))}">${ok ? '✓' : '·'}</span>`; } },
    ], ACT);
    const mx = `<div class="tbl-wrap"><table class="tbl ad-mx"><thead><tr><th>Action</th>${j(R, (r) => `<th class="${myRoles.has(r.role_id) ? 'me' : ''}" title="${esc(r.role_id)}"><span>${esc(r.role_id.replace('project.', '').replace('factory.', 'f.'))}</span></th>`)}</tr></thead><tbody>${j(ACT, ([id, a]) => `<tr><td><span class="mono small">${id}</span>${a.proposed ? ' <span class="ad-tag warn">p</span>' : ''}</td>${j(R, (r) => { const c = roleCell(r, a); return `<td class="ad-mc ${c === '✓' ? 'y' : c ? 'g' : ''} ${myRoles.has(r.role_id) ? 'me' : ''}">${c || '·'}</td>`; })}</tr>`)}</tbody></table></div><div class="row tiny muted ad-pad" style="gap:14px"><span><b class="ad-y">✓</b> granted</span><span><b class="ad-g">◆</b> only for the gates of its slot</span><span>· not granted</span><span class="ad-me-key">your roles</span><span class="sp"></span><span>Fleet roles reach every non-confidential project for read actions.</span></div>`;
    const gpRows = Object.entries(X.GATE_POLICY).filter(([g]) => g !== 'G0' && g !== 'G1');
    const gpT = A.table([
      { h: 'Gate', r: ([g]) => `${A.gate(g)} <span class="small">${esc(D.GATES[g]?.title || '')}</span>` },
      { h: 'Slot', r: ([, p]) => mono(p.slot) },
      { h: 'Role', r: ([, p]) => `<span class="mono small">${X.ROLES.find((r) => r.slot === p.slot)?.role_id || '—'}</span>` },
      { h: 'Two-person', r: ([, p]) => (p.two_person ? '<span class="pill warn">2 people</span>' : '<span class="faint">—</span>') },
      { h: 'Own request', r: ([, p]) => (p.own_request === 'allowed' ? '<span class="pill ok">allowed</span>' : '<span class="small muted">blocked</span>') },
      { h: 'Step-up', r: ([, p]) => (p.step_up ? '<span class="pill bad">always</span>' : p.step_up_if ? `<span class="small">if ${esc(p.step_up_if)}</span>` : '<span class="faint">—</span>') },
      { h: 'Consolidatable', r: ([, p]) => (p.consolidatable ? '✓' : '<span class="faint">—</span>') },
      ...(proj ? [{ h: `Decided on ${esc(projName(proj))} by`, r: ([, p]) => { const h = holders(p.slot); return h.length ? A.avatars(h) : '<span class="tiny faint">nobody yet</span>'; } }] : []),
    ], gpRows);
    const rules = `<div class="grid g2 ad-cols"><div>${A.card('Cross-cutting rules', `<ul class="ad-xr">${j(XCUT, ([t, d, pol, where]) => `<li><b>${esc(t)}</b><span>${esc(d)}</span><span class="mono tiny faint">${esc(pol)} · ${esc(where)}</span>${A.pill('enforced', 'ok')}</li>`)}</ul>`)}</div>
      <div class="stack">${A.card('Separation-of-duties pairs', A.table([{ h: 'Kind', r: (s) => mono(s[0]) }, { h: 'Role A', r: (s) => `<span class="mono small">${s[1]}</span>` }, { h: 'Role B', r: (s) => `<span class="mono small">${s[2]}</span>` }, { h: 'Effect', r: (s) => `<span class="small">${esc(s[3])}</span>` }], SOD_PAIRS) + '<p class="tiny faint ad-pad">No current binding breaks a static pair. 0 toxic pairs flagged.</p>', { flush: true })}
      ${A.card('Policy bundle', A.kv([['Bundle', mono('pdp 37 · pdp-1.3.0.roles-1.1.0')], ['Hash', A.hash('3f9a0c71e2b84d55a1c0f9e3d7b26c21', 16)], ['Published', 'factory r1 bundle, then each release · PDP_POLICY_VERSION 1.3.0'], ['Policies', '61 generated from the role catalogue + 13 cross-cutting'], ['Evaluator', 'embedded Cedar in every service, fail closed'], ['Decision log', 'every deny; allows on decide, kill and config · retention decision_7y']]) + `<pre class="code ad-code" style="margin-top:12px">@id("xcut/factory_admin_no_gate")\nforbid (principal, action == Action::"gate.decide", resource)\nunless { resource.slot in principal.slots[resource.project] };</pre>`)}</div></div>`;
    return A.pageHead({ eyebrow: 'Admin · policy', title: 'Roles & permissions', sub: 'The rules every screen and service follows: the roles, the actions the PDP is asked, which role grants which action, and how each gate is decided. Anyone signed in can read this; changing it is code: a PR with a new PDP_POLICY_VERSION, then a new policy bundle published through a factory M1 (the META gate M3 is not wired yet, M15.5).', actions: `<a class="btn" href="#cfg-pdp.bundle">Policy bundle in force</a>` }) +
      A.stats([
        { k: 'Roles', v: R.length, d: 'roles-1.1.0 · 11 project, 3 fleet' },
        { k: 'Actions', v: ACT.length, d: `${ACT.filter(([, a]) => a.proposed).length} proposed with this portal`, tone: 'warn' },
        { k: 'Gates', v: gpRows.length, d: `${X.TWO_PERSON.length} two-person · ${gpRows.filter(([, p]) => p.step_up).length} always step-up` },
        { k: 'Approver roles', v: R.filter((r) => r.approval_capable).length, d: 'binding needs an M6 grant' },
        { k: 'Policy bundle', v: '37', d: '3f9a…c21 · fail closed', tone: 'ok' },
        { k: 'Your roles', v: myRoles.size, d: [...myRoles].slice(0, 2).map((r) => r.replace('project.', '')).join(', ') || 'none' },
      ]) + '<div class="ad-gap"></div>' +
      A.tabs('adr', [
        { id: 'roles', label: 'Role catalogue', n: R.length, html: A.card('', roleT, { flush: true }) },
        { id: 'actions', label: 'Action catalogue', n: ACT.length, html: A.card('', actT + '<p class="tiny faint ad-pad"><span class="ad-tag warn">proposed</span> rows are portal actions not yet in the contracts’ ACTION_CATALOGUE; adding them is a code change to ACTION_CATALOGUE (a PR and a new policy bundle) before the real portal ships them (coverage §5.6, gap 6). The “You” column is your answer on the current project.</p>', { flush: true }) },
        { id: 'matrix', label: 'Role × action', html: A.card('Which role grants which action', mx, { flush: true }) },
        { id: 'gates', label: 'Gate policy', n: gpRows.length, html: A.card('', gpT, { flush: true }) },
        { id: 'rules', label: 'Rules on top', n: XCUT.length, html: rules },
      ]);
  }
  function rolesMount() {}
  A.view('roles', { label: 'Roles & permissions', group: 'Admin', icon: 'catalogue', access: () => null /* readable by everyone signed in: transparency */, render: rolesRender, mount: rolesMount });

  /* ================================================================ 5. Access requests */
  const canActOn = (r) => r.pid !== A.me() && (r.project ? A.can('access.manage', P(r.project)) : isIdAdmin());
  const reqVisible = (r) => (r.project ? (isIdAdmin() || isAuditor() ? A.canSeeProject(r.project) : A.can('access.manage', P(r.project))) : isIdAdmin() || isAuditor());
  const pendingMine = () => A.ACCESS_REQUESTS.filter((r) => r.state === 'pending' && canActOn(r) && reqVisible(r));
  function reqRender() {
    const all = A.ACCESS_REQUESTS.filter(reqVisible);
    const pend = all.filter((r) => r.state === 'pending' || r.state === 'awaiting M6');
    const hist = all.filter((r) => r.state === 'approved' || r.state === 'denied');
    const card = (r) => {
      const role = X.ROLE[r.role] || {}; const has = A.bindingsOf(r.pid).filter((b) => b.scope.ref === r.project);
      const res = r.project ? P(r.project) : F; const own = r.pid === A.me();
      const conflict = SOD_PAIRS.find(([, a, b]) => (r.role === a && has.some((x) => x.role === b)) || (r.role === b && has.some((x) => x.role === a)));
      const guestBlock = meta(r.pid).source === 'guest' && r.role !== 'project.viewer';
      const approvers = r.project ? [...new Set(live().filter((b) => b.scope.kind === 'project' && b.scope.ref === r.project && X.ROLE[b.role].slot === 'admin').map((b) => b.pid))] : ['lt'];
      return `<section class="card ad-req"><div class="bd stack" style="gap:10px">
        <div class="row between" style="align-items:flex-start"><div class="row" style="gap:10px;flex-wrap:nowrap;min-width:0">${av(r.pid, 'lg')}<div><b>${esc(person(r.pid).name)}</b> asks for <span class="mono">${esc(r.role)}</span><div class="small muted">${esc(r.project ? projName(r.project) : 'the whole factory')} · ${esc(r.at)} · <span class="mono">${r.id}</span></div></div></div>${r.state === 'awaiting M6' ? `<span class="pill warn">${r.m6card} open</span>` : r.m6 ? '<span class="pill warn">needs M6 approver grant</span>' : '<span class="pill info">direct</span>'}</div>
        <div class="fence"><div class="src">reason given</div>${esc(r.why)}</div>
        <div class="ad-facts">${A.kv([['Role', `${role.view_level || ''} · ${role.data_class || ''}${role.approval_capable ? ' · decides ' + gatesOfSlot(role.slot).join(', ') : ''}${role.privileged ? ' · privileged (security key)' : ''}`], ['Holds here', has.length ? j(has, (b) => `<span class="ad-tag">${b.role.replace('project.', '')}</span> `) : '<span class="faint">nothing yet</span>'], guestBlock ? ['Guest rule', '<span class="pill bad">external guests hold project.viewer only</span>'] : null, ['SoD check', conflict ? `<span class="pill warn">${conflict[0]} with ${conflict[1] === r.role ? conflict[2] : conflict[1]}</span>` : '<span class="pill ok">no conflicting pair</span>'], ['Decided by', j(approvers, (a) => who(a)) + '<div class="tiny faint">project admin; a factory admin may also decide</div>']])}</div>
        ${guestBlock ? `<p class="small muted">${esc(person(r.pid).name)} is an external guest (guest rule: viewer only, at most 90 days). Deny with a reason, or ask an identity admin to convert the account to an employee first.</p>` : ''}
        ${r.state === 'awaiting M6' ? `<p class="small muted">Approved as a request; the binding waits on ${r.m6card}, decided by the admin slot with step-up.</p>` : ''}
        <div class="field ad-reason"><label for="ad-rqx-${r.id}">Access until <span class="faint">(the binding expires by itself; expiry never approves anything)</span></label><input class="input" type="date" id="ad-rqx-${r.id}" value="${esc(r.until || (meta(r.pid).source === 'guest' ? '2027-02-10' : ''))}"></div>
        <div class="field ad-reason"><label for="ad-rq-${r.id}">Reason for your decision</label><input class="input" id="ad-rq-${r.id}" placeholder="Visible to ${esc(person(r.pid).name.split(' ')[0])} and written to the ledger"></div>
        <div class="row" style="gap:8px">${own ? '<span class="small muted">This is your own request; another admin decides it.</span>' : `${guestBlock && canActOn(r) ? '<button class="btn primary sm" disabled title="Guest rule: viewer only">Approve</button>' : A.act(r.m6 ? 'Approve and open M6' : 'Approve', r.project ? 'access.manage' : 'identity.admin', res, { cls: 'primary sm', attrs: `data-approve="${r.id}"` })}${A.act('Deny', r.project ? 'access.manage' : 'identity.admin', res, { cls: 'sm danger', attrs: `data-deny="${r.id}"` })}`}${!canActOn(r) && !own ? devHint() : ''}</div>
      </div></section>`;
    };
    const m = pendingMine().length;
    return A.pageHead({ eyebrow: 'Admin · access', title: 'Access requests', sub: 'People ask for a role from any locked button or from My access. Approve or deny with a reason; a role that decides gates also needs an M6 approver grant before it binds.', actions: '<a class="btn" href="#my-access">My own requests</a>' }) + roHint() +
      A.stats([{ k: 'Waiting on you', v: m, d: 'pending, not your own', tone: m ? 'warn' : '' }, { k: 'Need M6', v: pend.filter((r) => r.m6).length, d: 'approver roles' }, { k: 'Approved · 30 days', v: hist.filter((r) => r.state === 'approved').length + 6, d: 'median 4 h to decide' }, { k: 'Denied · 30 days', v: hist.filter((r) => r.state === 'denied').length + 1, d: 'with a reason' }, { k: 'Recertification', v: 'Q4', d: 'campaign AC-2026-Q4 opens 1 Dec' }]) +
      '<div class="ad-gap"></div>' +
      A.tabs('adq', [
        { id: 'pend', label: 'Pending', n: pend.length, html: pend.length ? `<div class="grid g2 ad-cols">${j(pend, card)}</div>` : A.empty('No pending requests for the projects you manage.') },
        { id: 'hist', label: 'Decided', n: hist.length, html: A.card('', A.table([{ h: 'Request', r: (r) => mono(r.id) }, { h: 'Person', r: (r) => who(r.pid) }, { h: 'Role', r: (r) => `<span class="mono small">${esc(r.role)}</span>` }, { h: 'Project', r: (r) => esc(r.project ? projName(r.project) : 'fleet') }, { h: 'Decision', r: (r) => A.pill(r.state, r.state === 'approved' ? 'ok' : 'bad') }, { h: 'By', r: (r) => who(r.decidedBy || r.approver) }, { h: 'Note', r: (r) => `<span class="small muted">${esc(r.note || (r.state === 'approved' ? 'granted' : ''))}</span>` }, { h: 'Ledger', r: (r) => (r.ledger ? `<a class="mono" href="#ledger">#${r.ledger}</a>` : '<span class="faint">—</span>') }], hist), { flush: true }) },
      ], rqTab);
  }
  function reqMount(root) {
    keepTab(root, 'adq', (t) => (rqTab = t));
    root.querySelectorAll('[data-approve]:not(.locked)').forEach((b) => (b.onclick = () => {
      const r = A.ACCESS_REQUESTS.find((x) => x.id === b.dataset.approve); const note = root.querySelector(`#ad-rq-${r.id}`).value;
      if (r.m6 && r.project) { m6Flow({ pid: r.pid, role: r.role, project: r.project, why: r.why, reqId: r.id }); return; }
      const until = (root.querySelector(`#ad-rqx-${r.id}`) || {}).value;
      X.BINDINGS.push({ pid: r.pid, role: r.role, scope: r.project ? { kind: 'project', ref: r.project } : { kind: 'fleet', ref: null }, source: `access request ${r.id}`, since: '2026-11-12', ...(until ? { expires: until } : {}) });
      const e = logLedger('access.binding_created', `${r.pid} · ${r.role} · ${r.project ? projName(r.project) : 'fleet'}`, `request ${r.id}${note ? ': ' + note : ''}`);
      Object.assign(r, { state: 'approved', ledger: e.seq, decidedBy: A.me(), note: note || 'approved' }); A.render(); A.toast(`Approved. Ledger #${e.seq} access.binding_created`);
    }));
    root.querySelectorAll('[data-deny]:not(.locked)').forEach((b) => (b.onclick = () => {
      const r = A.ACCESS_REQUESTS.find((x) => x.id === b.dataset.deny); const inp = root.querySelector(`#ad-rq-${r.id}`);
      if (!inp.value.trim()) { inp.focus(); inp.classList.add('ad-need'); A.toast('A denial needs a reason the person can read'); return; }
      Object.assign(r, { state: 'denied', decidedBy: A.me(), note: inp.value.trim() }); A.render(); A.toast('Denied. The person sees your reason under My access.');
    }));
    wireSwitch(root);
  }
  A.view('access-requests', { label: 'Access requests', group: 'Admin', icon: 'inbox', access: () => reqAccess(), deniedTitle: 'Access requests are for access admins', badge: () => ({ n: pendingMine().length, hot: true }), render: reqRender, mount: reqMount });

  /* ================================================================ 6. Who can do what */
  const EX_ACTIONS = ['gate.decide', 'card.decide', 'project.view', 'floor.read', 'work.request', 'item.ready', 'item.plan', 'item.observe', 'kill.request', 'kill.release', 'session.stop', 'config.propose', 'project.settings.edit', 'control.apply', 'access.manage', 'access.explain', 'audit.read', 'identity.admin', 'project.onboard'];
  const PRESETS = [
    ['lt', 'gate.decide', 'payments', 'G4', 'W-24', 'Can Luis decide G4 on W-24?'],
    ['dn', 'gate.decide', 'payments', 'G6', 'W-12', 'Can Daniel decide G6 on W-12?'],
    ['ak', 'gate.decide', 'payments', 'G0G1', 'W-33', 'Can Amara triage her own W-33?'],
    ['jm', 'gate.decide', 'payments', 'X1', 'W-29', 'Can Jonas approve X1 on W-29?'],
    ['pm', 'gate.decide', 'payments', 'G5', 'W-24', 'Can Priya release W-24?'],
    ['ar', 'gate.decide', 'payments', 'G3', 'W-27', 'Can Alex approve the plan of W-27?'],
    ['tb', 'work.request', 'payments', '', '', 'Can Tom ask for work?'],
    ['rb', 'kill.request', '', '', '', 'Can Rana kill the whole factory?'],
    ['lt', 'project.view', 'identity', '', '', 'Can Luis open Identity Hub?'],
  ];
  let ex = { pid: 'lt', action: 'gate.decide', project: 'payments', gate: 'G4', item: 'W-24' };
  let rev = { action: 'gate.decide', project: 'payments', gate: 'G3', all: false };
  const exProjects = () => { const ps = explainable(); return A.can('access.explain', F) ? ps.concat(D.PROJECTS.filter((p) => p.classification === 'confidential' && !ps.includes(p)).map((p) => ({ ...p, collapsed: true }))) : ps; };
  const resOf = (s) => {
    const a = X.ACTIONS[s.action];
    if (s.action === 'gate.decide') return { type: 'Gate', project: s.project, gate: s.gate, item: s.item || undefined };
    if (s.action === 'card.decide') return { type: 'Card', project: s.project };
    if (a.types.includes('Item') && s.item) return { type: 'Item', project: s.project, item: s.item };
    if (!s.project) return F;
    return a.types.includes('Project') ? P(s.project) : a.types.includes('Item') ? { type: 'Item', project: s.project } : F;
  };
  const resText = (res) => `${res.type}${res.project ? ' · ' + projName(res.project) : ''}${res.gate ? ' · ' + res.gate : ''}${res.item ? ' · ' + res.item : ''}`;
  /** decideCheck for another person: same rules, with the step-up line written for them */
  const checkFor = (pid, gate, project, key) => {
    if (key && A.item(key)) { const c = A.decideCheck(gate, key, pid); if (pid !== A.me()) c.rules.forEach((r) => { if (/^Step-up/.test(r.text)) r.text = 'Step-up needed: they confirm with a security key, bound to this decision.'; }); return c; }
    const gp = X.GATE_POLICY[gate]; const w = A.why('gate.decide', { type: 'Gate', project, gate }, pid);
    const rules = [{ ok: w.allow, text: w.allow ? w.reason : `Not their gate: ${gate} is decided by the ${gp.slot} slot (${w.need}).` }];
    if (gp.own_request === 'blocked') rules.push({ ok: true, info: true, text: 'Own request blocked: checked per item at decision time.' });
    if (gp.two_person) rules.push({ ok: true, info: true, text: 'Two-person rule: a second, different approver must also approve (DEC-28).' });
    if (gp.step_up || gp.step_up_if) rules.push({ ok: true, info: true, text: gp.step_up ? 'Step-up at decision time.' : `Step-up if ${gp.step_up_if}.` });
    return { allow: rules.every((r) => r.ok || r.info), rules, why: w, policy: gp };
  };
  const third = (pid, t) => (pid === A.me() ? t : String(t || '').replace(/\bYou hold\b/g, `${person(pid).name.split(' ')[0]} holds`).replace(/\bYou asked\b/g, `${person(pid).name.split(' ')[0]} asked`).replace(/\byou are\b/g, 'they are').replace(/\bYou are\b/g, 'They are').replace(/\byou confirm\b/g, 'they confirm').replace(/\bNot your gate\b/g, 'Not their gate').replace(/\bby you\b/g, 'by them').replace(/\byour\b/g, 'their').replace(/\bYou\b/g, 'They').replace(/\byou\b/g, 'them'));
  const seesText = (pid, project) => { if (!project) return '—'; const v = A.viewLevel(project, pid), dc = A.dataClass(project, pid); if (!A.canSeeProject(project, pid)) return 'nothing: the project does not exist for them'; return `V${v} · D${Math.max(0, dc)}: ${['', 'positions, who it waits on', 'content: titles, artefacts, diffs', 'content plus audit, settings and access'][v] || 'nothing'}${dc >= 2 ? '; transcripts, tripwire evidence, secret findings' : dc < 1 ? '; no titles' : ''}`; };
  function explainOut() {
    const res = resOf(ex); const w = A.why(ex.action, res, ex.pid); const a = X.ACTIONS[ex.action];
    const chk = ex.action === 'gate.decide' && ex.gate ? checkFor(ex.pid, ex.gate, ex.project, ex.item) : null;
    const allow = chk ? chk.allow : w.allow;
    const typeOk = a.types.includes(res.type);
    const fixers = !allow ? Object.keys(D.PEOPLE).filter((p) => p !== ex.pid && (chk ? checkFor(p, ex.gate, ex.project, ex.item).allow : A.can(ex.action, res, p))) : [];
    const acct = X.ACCOUNTS.some((x) => x.pid === ex.pid) && ex.pid !== A.me();
    return `<div class="ad-verdict ${allow ? 'ok' : 'bad'}"><div class="row between"><b class="ad-vb">${allow ? 'Yes' : 'No'}</b><span class="mono small ad-wrap">${esc(w.policy)}</span></div>
      <p style="margin-top:6px">${esc(person(ex.pid).name)} ${allow ? 'can' : 'cannot'} <span class="mono">${esc(ex.action)}</span> on ${esc(resText(res))}. ${esc(third(ex.pid, chk && w.allow && !allow ? (chk.rules.find((r) => !r.ok && !r.info) || {}).text || '' : w.reason))}${ex.action === 'gate.decide' && !w.allow && A.bindingsOf(ex.pid).some((b) => b.role === 'factory.admin') ? ' factory.admin decides no gate unless a project gives it the slot (DEC-29).' : ''}</p>
      ${!typeOk ? `<p class="small" style="margin-top:6px">${ex.action} applies to ${a.types.join(' or ')} resources.</p>` : ''}
      <ol class="ad-trace">${j([['principal is active', statusOf(ex.pid) === 'active'], ['a person, not a service', true], [`bindings reaching it: ${w.via.length || A.bindingsOf(ex.pid).length}`, A.bindingsOf(ex.pid).length > 0], [w.allow ? 'a permit matched' : 'no permit matched', w.allow], ...(chk && chk.rules.filter((r) => !r.info).length > 1 ? [[chk.rules.filter((r) => !r.info).slice(1).every((r) => r.ok) ? 'cross-cutting rules pass' : 'a cross-cutting rule forbids', chk.rules.filter((r) => !r.info).slice(1).every((r) => r.ok)]] : [])], ([t, ok]) => `<li class="${ok ? 'ok' : 'no'}">${esc(t)}</li>`)}</ol></div>
      <div class="grid g2 ad-cols" style="margin-top:14px">
        <div class="stack">${A.card('Bindings that matched', w.via.length ? A.table([{ h: 'Role', r: (b) => `<b class="mono small">${b.role}</b>` }, { h: 'Scope', r: (b) => scopeLabel(b) }, { h: 'Source', r: (b) => `<span class="small">${esc(b.source)}</span>` }], w.via) : `<p class="small muted ad-pad">None. ${esc(person(ex.pid).name.split(' ')[0])} holds: ${esc(A.bindingsOf(ex.pid).map((b) => `${b.role} (${b.scope.kind === 'project' ? projName(b.scope.ref) : b.scope.kind})`).join(', ') || 'no role')}.</p>`, { flush: true })}
        ${chk ? A.card('Rules on top (decision time)', `<ul class="ad-rules">${j(chk.rules, (r) => `<li class="${r.info ? 'info' : r.ok ? 'ok' : 'no'}">${esc(third(ex.pid, r.text))}</li>`)}</ul>`) : ''}</div>
        <div class="stack">${A.card(allow ? 'What they can see there' : 'What would allow it', allow ? `<p class="small">${esc(seesText(ex.pid, ex.project))}</p>` : `<p class="small">${esc(w.allow ? 'The grant is there; the rule above blocks this case. Another holder of the slot decides it.' : w.need ? 'A binding of ' + w.need + '.' : '')}</p>${fixers.length ? `<div class="small muted" style="margin-top:8px">People who can today:</div><div class="row" style="gap:6px;margin-top:6px">${j(fixers.slice(0, 6), (p) => `<button class="ad-mem" data-expid="${p}">${av(p)}<span>${esc(person(p).name)}</span></button>`)}</div>` : '<p class="small muted" style="margin-top:8px">Nobody holds it today.</p>'}<p class="tiny faint" style="margin-top:8px">The project admin adds a binding under People; an approver role also needs an M6 grant.</p>`)}
        <pre class="code ad-code">${esc(w.allow ? `permit (\n  principal in Role::"${(w.via[0] || {}).role || '?'}",\n  action == Action::"${ex.action}",\n  resource${res.project ? ` in Project::"${res.project}"` : ''}\n)${ex.gate ? `\nwhen { resource.slot == "${X.GATE_POLICY[ex.gate]?.slot}" }` : ''};` : `// no permit for ${ex.pid} on ${resText(res)}\n// default deny (fail closed)`)}</pre>
        ${acct ? `<div class="row" style="gap:6px"><span class="tiny faint">${esc(person(ex.pid).name)} is a dev IdP account.</span>${devHint('Switch account to try it')}</div>` : ''}</div></div>`;
  }
  function reverseOut() {
    const s = { action: rev.action, project: rev.project, gate: rev.gate, item: '' };
    const res = resOf(s);
    const rows = Object.keys(D.PEOPLE).map((p) => { const w = A.why(rev.action, res, p); const c = rev.action === 'gate.decide' ? checkFor(p, rev.gate, rev.project) : null; return { p, ok: c ? c.allow : w.allow, w, c }; });
    const yes = rows.filter((r) => r.ok), no = rows.filter((r) => !r.ok);
    const show = rev.all ? yes.concat(no) : yes;
    return `<div class="row between ad-pad" style="padding-top:0"><span class="small"><b class="num">${yes.length}</b> of ${rows.length} people can <span class="mono">${esc(rev.action)}</span> on ${esc(resText(res))}</span><label class="check small"><input type="checkbox" id="ad-rall" ${rev.all ? 'checked' : ''}> show who cannot</label></div>` +
      A.table([{ h: 'Person', r: (r) => who(r.p) }, { h: '', r: (r) => A.pill(r.ok ? 'can' : 'cannot', r.ok ? 'ok' : 'mute') }, { h: 'Through', r: (r) => (r.w.via[0] ? `<span class="mono small">${r.w.via[0].role}</span> <span class="tiny faint">${r.w.via[0].scope.kind === 'fleet' ? 'fleet' : r.w.via[0].scope.kind === 'team' ? 'team' : ''}</span>` : `<span class="small muted">${esc(third(r.p, r.w.reason))}</span>`) }, { h: 'At decision time', r: (r) => (r.c ? `<span class="tiny muted">${esc(r.c.rules.filter((x) => x.info).map((x) => x.text.split(':')[0]).join(' · ') || '—')}</span>` : '<span class="faint">—</span>') }], show);
  }
  function explainRender() {
    const ps = exProjects();
    if (!ps.find((p) => p.id === ex.project) && !(ex.project === '' && A.can('access.explain', F))) ex = { ...ex, project: ps[0]?.id || '' };
    if (!ps.find((p) => p.id === rev.project && !p.collapsed)) rev.project = ps.find((p) => !p.collapsed)?.id || '';
    const items = (pid) => D.ITEMS.filter((i) => i.project === pid && !['done', 'declined'].includes(i.state));
    const presets = PRESETS.filter(([, , pr]) => (pr ? ps.some((p) => p.id === pr) : A.can('access.explain', F)));
    const opt = (v, l, sel) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`;
    const gates = Object.keys(X.GATE_POLICY).filter((g) => g !== 'G0' && g !== 'G1');
    const isGate = ex.action === 'gate.decide';
    const visItems = ex.project && !ps.find((p) => p.id === ex.project)?.collapsed ? items(ex.project) : [];
    return A.pageHead({ eyebrow: 'Admin · access', title: 'Who can do what', sub: 'Ask the same evaluator the PDP uses. Pick a person, an action and a resource to see the answer, the binding behind it and what would change it; or pick an action to list everyone who can.', actions: '<a class="btn" href="#roles">Roles & permissions</a>' }) +
      (A.can('access.explain', F) ? '' : `<div class="banner info">${A.icon('lock', 14)} You can explain access on ${esc(ps.map((p) => p.name).join(', '))}, where you hold a V3 role.</div>`) +
      A.card('Can this person do this?', `<div class="ad-form">
        <div class="field"><label for="ad-xp">Person</label><select class="input" id="ad-xp">${j(Object.keys(D.PEOPLE), (p) => opt(p, `${person(p).name} · ${A.persona(p)}`, ex.pid))}</select></div>
        <div class="field"><label for="ad-xa">Action</label><select class="input" id="ad-xa">${j(EX_ACTIONS, (a) => opt(a, a + (X.ACTIONS[a].proposed ? ' (proposed)' : ''), ex.action))}</select></div>
        <div class="field"><label for="ad-xr">Project</label><select class="input" id="ad-xr">${A.can('access.explain', F) ? opt('', 'Whole factory (fleet)', ex.project) : ''}${j(ps, (p) => opt(p.id, p.collapsed ? `${p.name} (confidential, collapsed)` : p.name, ex.project))}</select></div>
        <div class="field"><label for="ad-xg">Gate</label><select class="input" id="ad-xg" ${isGate ? '' : 'disabled'}>${j(gates, (g) => opt(g, `${D.GATES[g]?.short || g} · ${D.GATES[g]?.title || ''}`, ex.gate))}</select></div>
        <div class="field"><label for="ad-xi">Item</label><select class="input" id="ad-xi" ${visItems.length ? '' : 'disabled'}>${opt('', 'any item', ex.item)}${j(visItems, (i) => opt(i.key, `${i.key} · ${A.redactedTitle(i)}${i.gate ? ' · ' + i.gate : ''}`, ex.item))}</select></div>
      </div>
      <div class="row ad-presets"><span class="tiny faint">Try</span>${j(presets, (x) => `<button class="btn sm ghost" data-xpre="${PRESETS.indexOf(x)}">${esc(x[5])}</button>`)}</div>
      <div id="ad-xout" style="margin-top:16px">${explainOut()}</div>`, { actions: '<span class="tiny faint">access.explain · pdp 37</span>' }) + '<div class="ad-gap"></div>' +
      A.card('Who can do this here?', `<div class="ad-form ad-form3"><div class="field"><label for="ad-ya">Action</label><select class="input" id="ad-ya">${j(EX_ACTIONS, (a) => opt(a, a, rev.action))}</select></div>
        <div class="field"><label for="ad-yr">Project</label><select class="input" id="ad-yr">${A.can('access.explain', F) ? opt('', 'Whole factory (fleet)', rev.project) : ''}${j(ps.filter((p) => !p.collapsed), (p) => opt(p.id, p.name, rev.project))}</select></div>
        <div class="field"><label for="ad-yg">Gate</label><select class="input" id="ad-yg" ${rev.action === 'gate.decide' ? '' : 'disabled'}>${j(gates, (g) => opt(g, `${D.GATES[g]?.short || g} · ${D.GATES[g]?.title || ''}`, rev.gate))}</select></div></div>
        <div id="ad-yout" style="margin-top:12px">${reverseOut()}</div>`);
  }
  function explainMount(root) {
    const rd = () => { root.querySelector('#ad-xout').innerHTML = explainOut(); wire(); };
    const wire = () => { wireSwitch(root); root.querySelectorAll('[data-expid]').forEach((b) => (b.onclick = () => { ex.pid = b.dataset.expid; root.querySelector('#ad-xp').value = ex.pid; rd(); })); const all = root.querySelector('#ad-rall'); if (all) all.onchange = () => { rev.all = all.checked; root.querySelector('#ad-yout').innerHTML = reverseOut(); wire(); }; };
    root.querySelector('#ad-xp').onchange = (e) => { ex.pid = e.target.value; rd(); };
    root.querySelector('#ad-xa').onchange = (e) => { ex.action = e.target.value; A.render(); };
    root.querySelector('#ad-xr').onchange = (e) => { ex.project = e.target.value; ex.item = ''; A.render(); };
    root.querySelector('#ad-xg').onchange = (e) => { ex.gate = e.target.value; rd(); };
    root.querySelector('#ad-xi').onchange = (e) => { ex.item = e.target.value; const it = A.item(ex.item); if (it && it.gate && ex.action === 'gate.decide') { ex.gate = it.gate; root.querySelector('#ad-xg').value = it.gate; } rd(); };
    root.querySelectorAll('[data-xpre]').forEach((b) => (b.onclick = () => { const [pid, action, project, gate, item] = PRESETS[+b.dataset.xpre]; ex = { pid, action, project, gate: gate || ex.gate, item }; A.render(); }));
    root.querySelector('#ad-ya').onchange = (e) => { rev.action = e.target.value; A.render(); };
    root.querySelector('#ad-yr').onchange = (e) => { rev.project = e.target.value; root.querySelector('#ad-yout').innerHTML = reverseOut(); wire(); };
    root.querySelector('#ad-yg').onchange = (e) => { rev.gate = e.target.value; root.querySelector('#ad-yout').innerHTML = reverseOut(); wire(); };
    wire();
  }
  A.view('access-explain', { label: 'Who can do what', group: 'Admin', icon: 'search', access: () => explainAccess(), deniedTitle: 'Explaining access needs a V3 role', render: explainRender, mount: explainMount });

  /* ================================================================ 7. Sign-ins & sessions */
  let siFilter = 'all', siTab = 'log', rqTab = 'pend';
  const keepTab = (root, group, set) => root.querySelectorAll(`[data-tab^="${group}:"]`).forEach((b) => b.addEventListener('click', () => set(b.dataset.tab.split(':')[1])));
  function signinsRender() {
    const sis = signins(); const sess = liveSessions();
    const bad = sis.filter((s) => s.result !== 'success');
    const shown = sis.filter((s) => siFilter === 'all' || s.result === siFilter);
    const ledger = LEDGER.map((e) => (e.conf && !A.canSeeProject(e.conf) ? { ...e, subj: 'binding on a confidential project', detail: 'collapsed: you hold no role on it', collapsed: true } : e));
    return A.pageHead({ eyebrow: 'Admin · identity', title: 'Sign-ins & sessions', sub: 'Who signed in, who was refused and why, which sessions are open, every step-up proof and the PDP’s denies on write actions. End a session to force a fresh sign-in.', actions: A.act('Export (signed CSV)', 'audit.read', F, { attrs: 'data-toast="Export queued: signed, write-once, retention decision_7y."' }) }) + roHint() +
      A.stats([
        { k: 'Sign-ins · 24 h', v: sis.filter((s) => /today|just/.test(s.at)).length, d: 'all through SSO' },
        { k: 'Refused', v: bad.filter((s) => s.result === 'denied').length, d: 'domain, network, disabled', tone: 'warn' },
        { k: 'MFA failures', v: bad.filter((s) => s.result === 'mfa_failed').length, d: '0 locked accounts now' },
        { k: 'Open sessions', v: sess.length, d: 'idle 30 min · max 12 h' },
        { k: 'Step-ups today', v: STEPUPS.filter((s) => !/yesterday/.test(s.at)).length, d: 'each bound to one decision' },
        { k: 'Denies on writes', v: DENIES.length, d: 'last 24 h · decision log', tone: 'bad' },
      ]) + '<div class="ad-gap"></div>' +
      A.tabs('ads', [
        { id: 'log', label: 'Sign-in log', n: sis.length, html: `<div class="ad-toolbar"><div class="seg" role="group" aria-label="Result">${j([['all', 'All'], ['success', 'Success'], ['denied', 'Refused'], ['mfa_failed', 'MFA failed']], ([k, l]) => `<button aria-pressed="${siFilter === k}" data-sf="${k}">${l}</button>`)}</div></div>` + A.card('', A.table([{ h: 'When', r: (s) => `<span class="mono small">${esc(s.at)}</span>` }, { h: 'Who', r: (s) => (s.pid ? who(s.pid) : `<span class="small">${esc(s.name)}</span>`) }, { h: 'Result', r: (s) => A.pill(s.result === 'mfa_failed' ? 'MFA failed' : s.result === 'denied' ? 'refused' : 'success', s.result === 'success' ? 'ok' : 'bad') }, { h: 'Method', r: (s) => `<span class="small">${esc(s.method)}</span>` }, { h: 'From', r: (s) => `<span class="mono small">${esc(s.ip)}</span><div class="tiny faint">${esc(s.ua)}</div>` }, { h: 'Reason', r: (s) => `<span class="small ${s.reason ? '' : 'faint'}">${esc(s.reason || '—')}</span>` }], shown), { flush: true }) },
        { id: 'sess', label: 'Open sessions', n: sess.length, html: A.card('', A.table([{ h: 'Session', r: (s) => `<span class="mono small">${s.sid}</span>${s.you ? ' ' + A.pill('you', 'human') : ''}` }, { h: 'Who', r: (s) => who(s.pid) }, { h: 'Device', r: (s) => `<span class="small">${esc(s.device)}</span>${s.guest ? ' <span class="ad-tag warn">guest</span>' : ''}` }, { h: 'IP', r: (s) => `<span class="mono small">${s.ip}</span>` }, { h: 'Started', r: (s) => `<span class="small">${s.started}</span>` }, { h: 'Last seen', r: (s) => `<span class="small">${s.last}</span>` }, { h: 'Ends by', r: (s) => `<span class="small">${s.abs}</span>` }, { h: 'MFA', r: (s) => `<span class="small">${s.mfa}</span>` }, { h: '', r: (s) => (s.you ? '<span class="tiny faint">sign out instead</span>' : A.act('End session', 'identity.admin', F, { cls: 'sm', attrs: `data-endsid="${s.sid}"` })) }], sess) + '<p class="tiny faint ad-pad">A BffSession holds only a hash of the cookie. Ending it deletes the row; the browser is signed out on its next request.</p>', { flush: true }) },
        { id: 'su', label: 'Step-up uses', n: STEPUPS.length, html: A.card('', A.table([{ h: 'When', r: (s) => `<span class="mono small">${esc(s.at)}</span>` }, { h: 'Who', r: (s) => who(s.pid) }, { h: 'Bound to', r: (s) => `<span class="small">${esc(s.what)}</span>` }, { h: 'Hash', r: (s) => A.hash(s.hash, 12) }, { h: 'Method', r: (s) => mono(s.method) }, { h: 'Proof', r: (s) => `<span class="mono tiny faint">${esc(s.proof)}</span>` }, { h: 'Ledger', r: (s) => `<a class="mono" href="#ledger">#${s.ledger}</a>` }], STEPUPS) + '<p class="tiny faint ad-pad">A proof is single use and bound to one subject hash (StepUpClaims.bound_hash); a proof for one decision cannot confirm another. Method reconfirm (DEC-11 c-ii) would be stamped dec-11c-ii:plain_confirm; none in this period.</p>', { flush: true }) },
        { id: 'deny', label: 'PDP denies', n: DENIES.length, html: A.card('', A.table([{ h: 'When', r: (d) => `<span class="mono small">${d.at}</span>` }, { h: 'Principal', r: (d) => (D.PEOPLE[d.pid] ? who(d.pid) : `<span class="row" style="gap:6px;flex-wrap:nowrap">${A.glyph('D', 15)}<span class="mono small">${d.pid}</span></span>`) }, { h: 'Action', r: (d) => mono(d.action) }, { h: 'Resource', r: (d) => `<span class="small">${esc(d.res)}</span>` }, { h: 'Policy', r: (d) => `<span class="mono tiny">${esc(d.policy)}</span>` }, { h: 'Why', r: (d) => `<span class="small muted">${esc(d.why)}</span>` }], DENIES) + '<p class="tiny faint ad-pad">Denies on read actions are not logged as errors. Denies on write, decide, kill and config actions are PdpDecision rows, retention decision_7y.</p>', { flush: true }) },
        { id: 'led', label: 'Access ledger', n: ledger.length, html: A.card('', A.table([{ h: 'Seq', r: (e) => `<a class="mono" href="#ledger">#${e.seq}</a>` }, { h: 'When', r: (e) => `<span class="small">${esc(e.at)}</span>` }, { h: 'Entry', r: (e) => `<span class="mono small">${esc(e.kind)}</span>` }, { h: 'Subject', r: (e) => `<span class="small ${e.collapsed ? 'faint' : ''}">${e.collapsed ? A.icon('lock', 12) + ' ' : ''}${esc(e.subj)}</span>` }, { h: 'By', r: (e) => (D.PEOPLE[e.actor] ? who(e.actor) : `<span class="mono small">${esc(e.actor)}</span>`) }, { h: 'Detail', r: (e) => `<span class="small muted">${esc(e.detail)}</span>${e.ref ? ` <span class="ad-tag">${e.ref}</span>` : ''}` }, { h: 'Hash', r: (e) => A.hash(e.hash) }], ledger), { flush: true }) },
      ], siTab);
  }
  function signinsMount(root) {
    keepTab(root, 'ads', (t) => (siTab = t));
    root.querySelectorAll('[data-sf]').forEach((b) => (b.onclick = () => { siFilter = b.dataset.sf; A.render(); }));
    root.querySelectorAll('[data-endsid]:not(.locked)').forEach((b) => (b.onclick = () => {
      const s = SESSIONS.find((x) => x.sid === b.dataset.endsid); if (!s) return;
      const m = A.modal(`<div class="row between"><h2>End session</h2><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div><p>End <span class="mono">${s.sid}</span> of ${esc(person(s.pid).name)} (${esc(s.device)})? They are signed out on their next request and must sign in again with MFA.</p><div class="row"><button class="btn danger" id="ad-ego">End session</button><button class="btn ghost" data-close>Cancel</button></div>`);
      m.querySelector('#ad-ego').onclick = () => { s.ended = true; A.render(); A.toast(`Session ${s.sid} ended`); };
    }));
  }
  A.view('signins', { label: 'Sign-ins & sessions', group: 'Admin', icon: 'sessions', access: () => signinAccess(), deniedTitle: 'Sign-ins are for identity admins and auditors', render: signinsRender, mount: signinsMount });
})();
