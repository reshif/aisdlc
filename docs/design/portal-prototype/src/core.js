/* AISDLC portal prototype: shared data, components, router and shell.
   Every view file calls A.view(...) and builds HTML strings with the helpers below. */
(function () {
  const A = (window.A = {});

  /* ================================================================ vocabulary (mirrors packages/contracts) */
  const LANES = {
    L0: { label: 'hotfix', group: 'L0', color: 'var(--l0)', route: 'S1 → S6 → S7 → S8 → S9', skips: 'S2, S3, S4, S5' },
    L1: { label: 'small change', group: 'L1-3', color: 'var(--l13)', route: 'S1 → S3 (partial) → S5 (partial) → S6 → S9', skips: 'S2, S4' },
    L2: { label: 'remediation', group: 'L1-3', color: 'var(--l13)', route: 'S1 → S3 (partial) → S5 (partial) → S6 → S9', skips: 'S2, S4' },
    L3: { label: 'small change', group: 'L1-3', color: 'var(--l13)', route: 'S1 → S3 (partial) → S5 (partial) → S6 → S9', skips: 'S2, S4' },
    L4: { label: 'feature', group: 'L4-5', color: 'var(--l45)', route: 'S1 → S9, every stage', skips: '' },
    L5: { label: 'feature, staged', group: 'L4-5', color: 'var(--l45)', route: 'S1 → S9, every stage', skips: '' },
    L6: { label: 'initiative', group: 'L6', color: 'var(--l6)', route: 'S1 → S9 with 2.4, 2.5 and G1f', skips: '' },
    L7: { label: 'spike', group: 'L7', color: 'var(--l7)', route: 'S1 → S6 (ends at 6.5) → S9', skips: 'S7, S8' },
    L8: { label: 'human-led', group: 'L8', color: 'var(--l8)', route: 'S1 → S9, a person writes the code', skips: '' },
  };
  const LANE_GROUPS = [
    ['L0', 'L0 hotfix', 'var(--l0)'],
    ['L1-3', 'L1–3 small', 'var(--l13)'],
    ['L4-5', 'L4–5 feature', 'var(--l45)'],
    ['L6', 'L6 initiative', 'var(--l6)'],
    ['L7', 'L7 spike', 'var(--l7)'],
    ['L8', 'L8 human-led', 'var(--l8)'],
  ];

  const STEPS = {
    '0.1': ['S0', 'D+A', 'Census'], '0.2': ['S0', 'A+H', 'Light baseline'], '0.3': ['S0', 'A+H', 'Full baseline'], '0.4': ['S0', 'D+H', 'Controls and environment'], '0.5': ['S0', 'H', 'Sign-off'],
    '1.1': ['S1', 'D', 'Normalise and taint-mark input'], '1.2': ['S1', 'D+A', 'De-dupe and conflict scan'], '1.3': ['S1', 'D+A', 'Classify, propose lane'], '1.4': ['S1', 'D+A', 'Eligibility and suitability'], '1.5': ['S1', 'A+H', 'Clarify questions and intent block'], '1.6': ['S1', 'H', 'Ready decision'],
    '2.1': ['S2', 'A', 'Ground in code and docs'], '2.1b': ['S2', 'A', 'Focused reverse-engineering'], '2.2': ['S2', 'A', 'Impact and stakeholders'], '2.3': ['S2', 'A', 'Options and decision brief'], '2.4': ['S2', 'A', 'Initiative elaboration (L6)'], '2.5': ['S2', 'H', 'Intent acceptance, final (L6)'],
    '3.1': ['S3', 'A', 'Locate affected requirements'], '3.2': ['S3', 'A', 'Draft delta spec'], '3.3': ['S3', 'D', 'Validate'], '3.4': ['S3', 'A', 'Oracle specs'], '3.5': ['S3', 'A', 'Clean-context review'],
    '4.1': ['S4', 'A', 'Decisions and ADRs'], '4.2': ['S4', 'D+A', 'Contracts'], '4.3': ['S4', 'A', 'Data and migration'], '4.4': ['S4', 'A', 'NFR, threat, ops'], '4.5': ['S4', 'D+A', 'Constitution check, design-time'], '4.6': ['S4', 'H', 'Design and threat review'],
    '5.1': ['S5', 'A', 'Split into Units'], '5.2': ['S5', 'A', 'Sequence'], '5.3': ['S5', 'A', 'Task plan per Unit'], '5.4': ['S5', 'A', 'Bind verification'], '5.5': ['S5', 'D', 'Budget envelope'], '5.6': ['S5', 'D+A', 'Capacity input'], '5.7': ['S5', 'H', 'Schedule'], '5.8': ['S5', 'H', 'Plan approval'],
    '6.0': ['S6', 'D', 'Admission'], '6.1': ['S6', 'D', 'Provision or rehydrate'], '6.2': ['S6', 'D', 'Baseline'], '6.3': ['S6', 'D', 'Oracles red'], '6.4': ['S6', 'A', 'Implement task loop'], '6.5': ['S6', 'D', 'Self-check and tripwires'], '6.6': ['S6', 'A', 'Draft PR via Push Broker'],
    '7.1': ['S7', 'D', 'Deterministic checks'], '7.2': ['S7', 'D', 'Test integrity and oracle quality'], '7.3': ['S7', 'D+A', 'Spec conformance'], '7.4': ['S7', 'D', 'Secrets and dependencies'], '7.5': ['S7', 'D+A', 'Constitution check, all lanes'], '7.6': ['S7', 'D', 'Pack assembly and sign'],
    '8.1': ['S8', 'H', 'G4 review'], '8.2': ['S8', 'H', 'Human merges on GitHub'], 'S8b': ['S8', 'H', 'Release'],
    '9.2': ['S9', 'H', 'Requester acceptance'], '9.3': ['S9', 'D', 'Close-out record'], '9.4': ['S9', 'A', 'Learn'], '9.5': ['S9', 'H', 'Mode-E audit sample'],
  };
  const STAGES = [
    { id: 'S1', name: 'Intake & triage', actors: ['A', 'D'] },
    { id: 'S2', name: 'Shape', actors: ['A'] },
    { id: 'S3', name: 'Specify', actors: ['D', 'A'] },
    { id: 'S4', name: 'Design', actors: ['A'] },
    { id: 'S5', name: 'Plan', actors: ['D', 'A'] },
    { id: 'S6', name: 'Build in sandbox', actors: ['A'] },
    { id: 'S7', name: 'Verify', actors: ['D', 'D'] },
    { id: 'S8', name: 'Human merge', actors: ['H'] },
    { id: 'S9', name: 'Close & learn', actors: ['D', 'A'] },
  ];
  const stepsOf = (stage) => Object.keys(STEPS).filter((k) => STEPS[k][0] === stage);

  const GATES = {
    G0G1: { fam: 'stage', title: 'Triage and intent', short: 'G0+G1' },
    G0: { fam: 'stage', title: 'Triage' },
    G1: { fam: 'stage', title: 'Intent, provisional' },
    G1f: { fam: 'stage', title: 'Intent acceptance, final (L6)' },
    G2: { fam: 'stage', title: 'Spec and oracle-spec approval' },
    G3d: { fam: 'stage', title: 'Design and threat sign-off' },
    G3: { fam: 'stage', title: 'Plan approval, SHA-bound' },
    G3s: { fam: 'stage', title: 'Skeleton' },
    G3o: { fam: 'stage', title: 'Oracle deviation approval' },
    G4: { fam: 'stage', title: 'Merge approval, never skipped' },
    G5: { fam: 'stage', title: 'Production release' },
    G6: { fam: 'stage', title: 'Requester acceptance' },
    X1: { fam: 'action', title: 'Destructive or irreversible' },
    X2: { fam: 'action', title: 'Protected-path change' },
    X3: { fam: 'action', title: 'New dependency' },
    X4: { fam: 'action', title: 'Break-glass post-hoc review' },
    E1: { fam: 'exception', title: 'Downshift approval (R2)' },
    E2: { fam: 'exception', title: 'Constitution exception' },
    E3: { fam: 'exception', title: 'Envelope extension' },
    E4: { fam: 'exception', title: 'Owner of record chooses' },
    E5: { fam: 'exception', title: 'Escalation override' },
    E6: { fam: 'exception', title: 'Test change request on locked tests' },
    M1: { fam: 'meta', title: 'Config' },
    M2: { fam: 'meta', title: 'Variance' },
    M3: { fam: 'meta', title: 'Catalogue or permission' },
    M4: { fam: 'meta', title: 'Onboarding approval' },
    M5: { fam: 'meta', title: 'Autonomy promotion' },
    M6: { fam: 'meta', title: 'Approver grant' },
    Q1: { fam: 'quarantine', title: 'Test integrity quarantine' },
    SECT: { fam: 'quarantine', title: 'Security triage' },
  };

  const BACK_EDGES = {
    B1: 'Two clarify rounds without an answer: PARK', B3: 'Agent output invalid after auto rounds: ET8', B4: 'Design reveals a spec gap: back to S3', B5: 'Plan rejected three times: a person writes it',
    B9: 'Verify fails: back to S6', B12: 'Locked test must change: E6', B13: 'Merge review asked for changes', B14: 'Evidence approver unsure: mode C', B15a: 'Clean rebase: S7 again', B15b: 'Conflict: back to S6',
    B16: 'Rollback: a new linked item', B17: 'Requester rejects at G6', B21: 'Approver SLA missed: backup notified',
  };

  /* ================================================================ people, teams, projects */
  const PEOPLE = {
    ar: { name: 'Alex Rivera', roles: ['maintainer', 'codeowner', 'G2/G3/G4 approver'], team: 'payments', color: '#2fb7a6' },
    pm: { name: 'Priya Menon', roles: ['product owner', 'owner of record'], team: 'payments', color: '#e0a43a' },
    dn: { name: 'Daniel Novak', roles: ['engineer', 'requester'], team: 'payments', color: '#6fa8ff' },
    ak: { name: 'Amara Kone', roles: ['operations', 'requester'], team: 'ops', color: '#f08a6a' },
    jm: { name: 'Jonas Meyer', roles: ['data owner', 'X1 approver'], team: 'data', color: '#b49cff' },
    ks: { name: 'Keiko Sato', roles: ['security', 'SECT approver'], team: 'security', color: '#ff7f8a' },
    lt: { name: 'Luis Torres', roles: ['platform admin', 'kill holder'], team: 'platform', color: '#9fd36b' },
    rb: { name: 'Rana Begum', roles: ['engineering manager', 'backup approver'], team: 'payments', color: '#5fd1c6' },
    so: { name: 'Sam Osei', roles: ['engineer', 'codeowner'], team: 'ledger', color: '#ffc46b' },
    mw: { name: 'Mei Wong', roles: ['engineer'], team: 'web', color: '#8fd0ff' },
  };
  Object.entries(PEOPLE).forEach(([id, p]) => { p.id = id; p.initials = p.name.split(' ').map((s) => s[0]).join(''); });
  const ME = 'ar';

  const TEAMS = [
    { id: 'payments', name: 'Payments', lead: 'rb', members: ['ar', 'pm', 'dn', 'rb'] },
    { id: 'ledger', name: 'Ledger', lead: 'so', members: ['so'] },
    { id: 'web', name: 'Web', lead: 'mw', members: ['mw'] },
    { id: 'security', name: 'Security', lead: 'ks', members: ['ks'] },
    { id: 'platform', name: 'Platform', lead: 'lt', members: ['lt', 'oh'] },
    { id: 'data', name: 'Data', lead: 'jm', members: ['jm'] },
    { id: 'ops', name: 'Operations', lead: 'ak', members: ['ak'] },
  ];

  const PROJECTS = [
    { id: 'payments', name: 'Payments API', repo: 'acme/payments-api', level: 'Light', team: 'payments', owner: 'pm', lanes: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'], areas: [['api/', 'Light'], ['billing/', 'Light'], ['migrations/', 'Census'], ['infra/', 'Census']], prr: 'prr/1 · 7f3a91c2', since: '2026-10-02', classification: 'internal', stack: 'TypeScript, Node 22, Postgres', health: 'ok' },
    { id: 'ledger', name: 'Ledger Service', repo: 'acme/ledger-svc', level: 'Census', team: 'ledger', owner: 'so', lanes: ['L2', 'L7', 'L8'], areas: [['*', 'Census']], prr: 'prr/1 · 2b81d0aa', since: '2026-10-21', classification: 'internal', stack: 'Go 1.23, Postgres', health: 'ok' },
    { id: 'web', name: 'Web Checkout', repo: 'acme/web-checkout', level: 'Full', team: 'web', owner: 'mw', lanes: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'], areas: [['src/', 'Full'], ['e2e/', 'Full']], prr: 'prr/1 · c09e44f1', since: '2026-09-11', classification: 'internal', stack: 'React 18, Vite, Playwright', health: 'degraded' },
    { id: 'identity', name: 'Identity Hub', repo: 'acme/identity-hub', level: 'Light', team: 'security', owner: 'ks', lanes: ['L0', 'L2', 'L8'], areas: [['*', 'Light']], prr: 'prr/1 · restricted', since: '2026-10-14', classification: 'confidential', stack: 'restricted', health: 'ok' },
    { id: 'mobile', name: 'Mobile App', repo: 'acme/mobile-app', level: 'Onboarding', team: 'web', owner: 'mw', lanes: [], areas: [], prr: 'not yet', since: null, classification: 'internal', stack: 'Kotlin, Swift', health: 'unknown', s0: 'S0-4c1e' },
  ];

  /* ================================================================ work items (Payments API unless said) */
  // state: working | waiting | held | stuck | quarantined | handoff | scheduled | parked | done | declined
  const I = (key, lane, stage, step, state, title, more = {}) => ({ key, lane, stage, step, state, title, project: 'payments', gate: null, wait: [], requester: 'dn', owner: 'pm', risk: 'medium', size: 'M', type: 'feature', age: '2d', updated: '4m ago', units: [0, 1], spend: [0, 0], backEdges: [], ...more });
  const ITEMS = [
    I('W-33', 'L4', 'S1', '1.6', 'waiting', 'Add idempotency keys to POST /refunds', { gate: 'G0G1', wait: ['ar'], requester: 'ak', age: '5h', updated: '12m ago', risk: 'medium', size: 'M', spend: [38, 4000] }),
    I('W-35', 'L2', 'S1', '1.3', 'working', 'Rotate webhook signing secret on schedule', { type: 'remediation', size: 'S', requester: 'ks', age: '20m', updated: 'now', spend: [6, 1500] }),
    I('W-36', 'L4', 'S1', '1.5', 'waiting', 'Partial capture for card-present payments', { wait: ['dn'], waitWhat: 'answers to 3 questions (round 1 of 2)', age: '1d', spend: [54, 4000] }),
    I('W-32', 'L6', 'S2', '2.3', 'working', 'Multi-currency settlement (initiative)', { type: 'initiative', size: 'XL', risk: 'high', requester: 'pm', age: '4d', spend: [610, 12000] }),
    I('W-30', 'L4', 'S3', '3.2', 'stuck', 'Expose dispute evidence upload API', { age: '3d', updated: '41m ago (no heartbeat)', spend: [220, 4000] }),
    I('W-28', 'L1', 'S3', '3.4', 'working', 'Return 422 not 500 for malformed currency', { type: 'bug', size: 'S', risk: 'low', age: '6h', spend: [41, 1500] }),
    I('W-26', 'L4', 'S3', '3.5', 'waiting', 'Refund status webhooks', { gate: 'G2', wait: ['ar', 'pm'], age: '2d', spend: [302, 4000] }),
    I('W-25', 'L5', 'S4', '4.4', 'working', 'Payout batching for marketplaces', { size: 'L', risk: 'high', requester: 'pm', age: '5d', spend: [880, 8000] }),
    I('W-23', 'L4', 'S5', '5.3', 'working', 'Retry policy for card network timeouts', { age: '3d', spend: [512, 4000], units: [0, 3] }),
    I('W-27', 'L4', 'S5', '5.8', 'waiting', 'Saved payment methods: list and delete', { gate: 'G3', wait: ['ar'], age: '4d', spend: [640, 4000], units: [0, 4] }),
    I('W-22', 'L3', 'S6', '6.0', 'scheduled', 'Paginate GET /payments with cursors', { type: 'change', size: 'S', risk: 'low', age: '1d', spend: [190, 1500], units: [0, 2], waitWhat: 'a coding pod (3 of 3 busy)' }),
    I('W-31', 'L4', 'S6', '6.4', 'working', 'Strong customer authentication exemptions', { pod: 1, age: '6d', spend: [1840, 4000], units: [1, 3], backEdges: [{ id: 'X1', note: 'X1 approved: re-admit and reload saved work', at: '2h ago' }] }),
    I('W-21', 'L2', 'S6', '6.5', 'working', 'Upgrade pg driver (CVE-2026-1183)', { pod: 2, type: 'remediation', size: 'S', requester: 'ks', age: '1d', spend: [260, 1500], units: [1, 1] }),
    I('W-38', 'L7', 'S6', '6.4', 'working', 'Spike: can we drop the legacy FX cache?', { pod: 3, type: 'spike', size: 'S', risk: 'low', age: '7h', spend: [140, 1000], units: [0, 1] }),
    I('W-29', 'L4', 'S6', '6.4', 'held', 'Backfill merchant_category on old charges', { gate: 'X1', wait: ['jm'], waitWhat: 'X1 irreversible migration: waiting on a person, pod released', age: '3d', spend: [1210, 4000], units: [1, 2] }),
    I('W-19', 'L2', 'S6', '6.4', 'quarantined', 'Tighten CORS on the admin endpoints', { gate: 'SECT', wait: ['ks'], waitWhat: 'ET10: the session read ~/.aws/credentials (tripwire)', type: 'remediation', age: '2d', spend: [330, 1500] }),
    I('W-18', 'L4', 'S6', '6.4', 'handoff', 'Chargeback fee reporting', { gate: 'E4', wait: ['pm'], waitWhat: 'ET1: budget envelope spent (4,000¢ of 4,000¢)', age: '8d', spend: [4000, 4000], units: [2, 3] }),
    I('W-20', 'L4', 'S7', '7.3', 'working', 'Apple Pay domain verification endpoint', { age: '5d', spend: [1560, 4000], units: [2, 2] }),
    I('W-37', 'L0', 'S7', '7.1', 'working', 'Hotfix: double charge on 3DS retry', { type: 'hotfix', size: 'S', risk: 'high', requester: 'ak', age: '2h', spend: [180, 2000], units: [1, 1] }),
    I('W-24', 'L4', 'S7', '7.6', 'waiting', 'Store network transaction id for MIT', { gate: 'G4', wait: ['ar'], age: '6d', spend: [2210, 4000], units: [3, 3], pr: 'acme/payments-api#412', backEdges: [{ id: 'B13', note: 'B13 merge review asked for changes, round 1 of 2', at: '1d ago' }] }),
    I('W-16', 'L1', 'S8', '8.2', 'waiting', 'Typo in refund email template', { wait: ['ar'], waitWhat: 'merge PR acme/payments-api#409 on GitHub', type: 'bug', size: 'XS', risk: 'low', age: '1d', spend: [60, 1500], pr: 'acme/payments-api#409' }),
    I('W-14', 'L4', 'S9', '9.4', 'working', 'Payment links expiry', { age: '9d', spend: [2900, 4000] }),
    I('W-12', 'L4', 'S9', '9.2', 'waiting', 'Settlement report CSV export', { gate: 'G6', wait: ['ak'], requester: 'ak', age: '11d', spend: [3120, 4000] }),
    I('W-39', 'L8', 'S5', '5.7', 'working', 'Rewrite the reconciliation cron (human-led)', { type: 'change', size: 'L', risk: 'high', age: '3d', spend: [95, 2000], owner: 'dn' }),
    I('W-17', 'L2', 'S1', '1.6', 'declined', 'Duplicate of W-21: bump pg', { cause: 'duplicate (G0 rejected)', age: '1d' }),
    I('W-34', 'L4', 'S1', '1.5', 'declined', 'Gift cards', { cause: 'PARK: no answer after 2 rounds (B1)', age: '9d' }),
  ];
  const DONE_KEYS = ['W-14x'];
  ['W-01:L4', 'W-03:L1', 'W-04:L4', 'W-05:L0', 'W-06:L2', 'W-07:L6', 'W-08:L4', 'W-10:L6', 'W-11:L1', 'W-13:L2', 'W-15:L4', 'W-09:L7'].forEach((s, i) => {
    const [k, l] = s.split(':');
    ITEMS.push(I(k, l, 'S9', '9.3', 'done', ['Card BIN lookup cache', 'Fix rounding in JPY refunds', 'Webhook retries with backoff', 'Hotfix: 3DS redirect loop', 'Remove unused Stripe v1 client', 'Instant payouts (initiative)', 'Refund reason codes', 'Ledger events for disputes (initiative)', 'Log redaction for PAN fragments', 'Bump openssl in base image', 'Merchant statement descriptors', 'Spike: idempotency store on Redis?'][i], { age: `${12 + i}d`, updated: `${2 + i}d ago`, spend: [900 + i * 140, 4000] }));
  });
  void DONE_KEYS;
  // other projects, a few each (for fleet and items)
  [['ledger', 'L-08', 'L2', 'S6', '6.4', 'working', 'Remove deprecated gRPC reflection'], ['ledger', 'L-09', 'L7', 'S6', '6.5', 'working', 'Spike: event sourcing for balances'], ['ledger', 'L-07', 'L8', 'S8', '8.2', 'waiting', 'Partition the journal table'],
   ['web', 'C-51', 'L4', 'S3', '3.2', 'working', 'Address autocomplete in checkout'], ['web', 'C-50', 'L1', 'S7', '7.2', 'working', 'Fix focus trap in card modal'], ['web', 'C-49', 'L5', 'S4', '4.6', 'waiting', 'Split checkout into steps'], ['web', 'C-48', 'L0', 'S8', '8.2', 'waiting', 'Hotfix: wallet button hidden on Safari'], ['web', 'C-47', 'L4', 'S6', '6.4', 'working', 'Saved cards UI'],
   ['identity', 'I-12', 'L2', 'S5', '5.3', 'working', 'Short-lived signing keys for SAML assertions'], ['identity', 'I-11', 'L8', 'S7', '7.1', 'working', 'Remove the legacy LDAP bind fallback']].forEach(([p, k, l, s, st, state, t]) => ITEMS.push(I(k, l, s, st, state, t, { project: p, owner: PROJECTS.find((x) => x.id === p).owner, gate: state === 'waiting' && s === 'S4' ? 'G3d' : null })));

  /* ================================================================ agents and sessions */
  const AGENTS = [
    { id: 'A1', name: 'triage', steps: ['1.2', '1.3', '1.4'], tools: [], dc: 'internal', ver: '1.2.0', sha: 'a1c09e', score: 0.94, delta: +0.02, provider: 'anthropic', model: 'claude-sonnet-5-5' },
    { id: 'A2', name: 'intent', steps: ['1.5'], tools: ['KnowledgeSearch'], dc: 'internal', ver: '1.1.0', sha: '9be210', score: 0.91, delta: 0, provider: 'anthropic', model: 'claude-sonnet-5-5' },
    { id: 'A3', name: 'planner', steps: ['5.1', '5.2', '5.3', '5.4', '5.6'], tools: ['KnowledgeSearch'], dc: 'internal', ver: '1.3.0', sha: '44d7af', score: 0.86, delta: -0.03, provider: 'anthropic', model: 'claude-opus-5-5' },
    { id: 'A4', name: 'coding (one-call)', steps: ['6.6'], tools: [], dc: 'internal', ver: '1.0.0', sha: '0e7c31', score: 0.89, delta: +0.01, provider: 'anthropic', model: 'claude-sonnet-5-5' },
    { id: 'A5', name: 'review', steps: ['3.5', '4.5', '7.3', '7.5'], tools: ['KnowledgeSearch'], dc: 'internal', ver: '1.2.1', sha: 'c2f9d0', score: 0.92, delta: +0.04, provider: 'openai_compat', model: 'codex-2' },
    { id: 'A6', name: 'test', steps: ['3.4', '6.3'], tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'], dc: 'internal', ver: '1.1.0', sha: '7a6b42', score: 0.88, delta: 0, provider: 'anthropic', model: 'claude-sonnet-5-5' },
    { id: 'A7', name: 'spec writer', steps: ['3.1', '3.2'], tools: ['KnowledgeSearch'], dc: 'internal', ver: '1.0.2', sha: 'f01a9e', score: 0.9, delta: +0.01, provider: 'anthropic', model: 'claude-sonnet-5-5' },
    { id: 'A8', name: 'design', steps: ['4.1', '4.2', '4.3', '4.4'], tools: ['KnowledgeSearch'], dc: 'internal', ver: '1.0.1', sha: '3d55c0', score: 0.83, delta: -0.05, provider: 'anthropic', model: 'claude-opus-5-5' },
    { id: 'A9', name: 'reverse engineering', steps: ['0.2', '2.1b'], tools: ['KnowledgeSearch'], dc: 'internal', ver: '1.0.0', sha: 'b8e112', score: 0.87, delta: 0, provider: 'anthropic', model: 'claude-sonnet-5-5' },
    { id: 'A10', name: 'shaping', steps: ['2.1', '2.2', '2.3', '2.4'], tools: ['KnowledgeSearch'], dc: 'internal', ver: '1.0.0', sha: '5c3e70', score: 0.9, delta: +0.02, provider: 'deepseek', model: 'deepseek-v4' },
    { id: 'A11', name: 'handoff pack', steps: ['D1'], tools: [], dc: 'internal', ver: '1.0.0', sha: 'e4a0b9', score: 0.95, delta: 0, provider: 'anthropic', model: 'claude-haiku-5-5' },
    { id: 'A12', name: 'extraction', steps: ['0.3'], tools: ['KnowledgeSearch'], dc: 'internal', ver: '1.0.0', sha: '61f2d4', score: 0.84, delta: -0.01, provider: 'anthropic', model: 'claude-sonnet-5-5' },
    { id: 'coder', name: 'coder (sandbox)', steps: ['6.4'], tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], dc: 'internal', ver: '1.0.0', sha: '2aa7c8', score: 0.81, delta: +0.03, provider: 'anthropic', model: 'claude-opus-5-5' },
  ];

  const SESSIONS = [
    { id: 'ses-7f21', cls: 'W', item: 'W-31', unit: 'u2', agent: 'coder', pod: 1, state: 'running', since: '18m', cpu: 61, mem: 1.4, memCap: 4, calls: 37, tokens: '412k', spend: 214, tripwires: 0 },
    { id: 'ses-7f19', cls: 'W', item: 'W-21', unit: 'main', agent: 'coder', pod: 2, state: 'running', since: '6m', cpu: 34, mem: 0.9, memCap: 4, calls: 12, tokens: '98k', spend: 51, tripwires: 0 },
    { id: 'ses-7f22', cls: 'W', item: 'W-38', unit: 'main', agent: 'coder', pod: 3, state: 'running', since: '2m', cpu: 22, mem: 0.6, memCap: 4, calls: 4, tokens: '31k', spend: 12, tripwires: 0 },
    { id: 'ses-7f1d', cls: 'O', item: 'W-31', unit: 'u2', agent: null, pod: null, state: 'finished', since: '24m', cpu: 0, mem: 0, memCap: 2, calls: 0, tokens: '0', spend: 0, tripwires: 0 },
    { id: 'ses-7f12', cls: 'W', item: 'W-19', unit: 'main', agent: 'coder', pod: null, state: 'killed', since: '2d', cpu: 0, mem: 0, memCap: 4, calls: 22, tokens: '190k', spend: 120, tripwires: 1 },
    { id: 'ses-7f0a', cls: 'K', item: null, unit: null, agent: null, pod: null, state: 'finished', since: '1h', cpu: 0, mem: 0, memCap: 1, calls: 0, tokens: '0', spend: 0, tripwires: 0, note: 'Census of acme/mobile-app' },
  ];

  /* ================================================================ ledger (shared sample) */
  const LEDGER = [
    { seq: 18422, at: '10:41:07', type: 'gate.decision', subj: 'G3 · W-23', actor: 'ar', result: 'approved', hash: '9f12c0e7', cp: 312 },
    { seq: 18421, at: '10:38:55', type: 'push.receipt', subj: 'W-24 · agent/W-24/u3', actor: 'codehost', result: 'pushed 4c01aa9', hash: '1b7e3d20', cp: 312 },
    { seq: 18420, at: '10:22:13', type: 'gate.decision', subj: 'X1 · W-31', actor: 'jm', result: 'approved', hash: 'c4a99b01', cp: 312 },
    { seq: 18419, at: '10:20:40', type: 'kill.event', subj: 'session ses-7f12', actor: 'lt', result: 'released (2 of 2)', hash: '77e0f4ad', cp: 312 },
    { seq: 18418, at: '09:58:02', type: 'config.publish', subj: 'gateway.routes r14', actor: 'lt', result: 'M1 approved', hash: '3e9d6b12', cp: 311 },
    { seq: 18417, at: '09:41:30', type: 'gate.decision', subj: 'G2 · W-28', actor: 'pm', result: 'approved', hash: 'aa0c51f9', cp: 311 },
    { seq: 18416, at: '09:12:44', type: 'checkpoint', subj: 'checkpoint 311 · 18,000–18,416', actor: 'witness', result: 'co-signed', hash: 'e01d77c3', cp: 311 },
    { seq: 18415, at: '08:55:19', type: 'gate.decision', subj: 'SECT · W-19', actor: 'ks', result: 'pending', hash: '5d40e2aa', cp: 310 },
    { seq: 18414, at: '08:30:02', type: 'onboarding.card', subj: 'card 4 · Mobile App', actor: 'mw', result: 'submitted', hash: '0f8b9c21', cp: 310 },
    { seq: 18413, at: '08:02:51', type: 'gate.decision', subj: 'G4 · W-15', actor: 'so', result: 'approved (mode C)', hash: 'b2c3d4e5', cp: 310 },
  ];

  A.data = { LANES, LANE_GROUPS, STEPS, STAGES, GATES, BACK_EDGES, PEOPLE, ME, TEAMS, PROJECTS, ITEMS, AGENTS, SESSIONS, LEDGER, stepsOf };
  A.state = { project: 'payments', killed: false };

  /* ================================================================ lookups */
  A.item = (key) => ITEMS.find((i) => i.key === key);
  A.person = (id) => PEOPLE[id];
  A.project = (id) => PROJECTS.find((p) => p.id === id);
  A.agent = (id) => AGENTS.find((a) => a.id === id);
  A.stage = (id) => STAGES.find((s) => s.id === id);
  A.itemsOf = (projectId) => ITEMS.filter((i) => i.project === projectId);
  A.laneGroup = (lane) => (LANES[lane] || {}).group;
  A.laneColor = (lane) => (LANES[lane] || {}).color || 'var(--belt)';
  A.waitingOnMe = () => ITEMS.filter((i) => i.wait.includes(A.data.ME) && !['done', 'declined'].includes(i.state) && (!A.canSeeProject || A.canSeeProject(i.project)));

  /* ================================================================ html helpers */
  A.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  A.j = (arr, fn) => (arr || []).map(fn).join('');

  const ICON_PATHS = {
    floor: 'M3 5h18M3 12h18M3 19h18M7 5v14M17 5v14',
    fleet: 'M4 6h16M4 12h10M4 18h13',
    board: 'M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v13h-4z',
    items: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
    inbox: 'M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5',
    ask: 'M12 5v14M5 12h14',
    chat: 'M4 5h16v11H9l-5 4z',
    projects: 'M3 7h7l2 2h9v10H3z',
    onboard: 'M12 3v12M7 10l5 5 5-5M4 20h16',
    issues: 'M12 8v5M12 16h.01M12 3a9 9 0 100 18 9 9 0 000-18',
    capacity: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    sessions: 'M4 4h16v12H4zM8 20h8M12 16v4',
    controls: 'M5 4v16M12 4v16M19 4v16M3 9h4M10 15h4M17 7h4',
    kill: 'M12 3v9M6.3 7.3a8 8 0 1011.4 0',
    health: 'M3 12h4l3-7 4 14 3-7h4',
    agents: 'M8 9h8v8H8zM12 5v4M10 13h.01M14 13h.01M5 12h3M16 12h3',
    evals: 'M5 13l4 4L19 7',
    gateway: 'M12 3l8 4v6c0 4-3.5 7-8 8-4.5-1-8-4-8-8V7z',
    integrations: 'M9 7V3M15 7V3M7 7h10v5a5 5 0 01-10 0zM12 17v4',
    ledger: 'M6 3h12v18l-6-3-6 3z',
    audit: 'M11 4a7 7 0 100 14 7 7 0 000-14M16 16l5 5',
    catalogue: 'M4 5h7v14H4zM13 5h7v14h-7z',
    config: 'M12 8a4 4 0 100 8 4 4 0 000-8M12 2v3M12 19v3M2 12h3M19 12h3',
    people: 'M9 11a3 3 0 100-6 3 3 0 000 6M3 20c0-3 3-5 6-5s6 2 6 5M16 11a3 3 0 100-6M21 20c0-3-2-4.5-4-5',
    notifications: 'M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20h4',
    bell: 'M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20h4',
    search: 'M11 4a7 7 0 100 14 7 7 0 000-14M16 16l5 5',
    close: 'M6 6l12 12M18 6L6 18',
    menu: 'M4 6h16M4 12h16M4 18h16',
    ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
    lock: 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3',
    play: 'M7 5l12 7-12 7z', pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  };
  A.icon = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON_PATHS[name] || ICON_PATHS.items}"/></svg>`;

  // actor glyphs from the floor: robot (agent), console (deterministic), person (human)
  A.glyph = (kind, size = 22) => {
    if (kind === 'A') return `<svg class="g-a" width="${size}" height="${size}" viewBox="0 0 24 24" aria-label="agent"><circle cx="12" cy="3" r="1.6" fill="var(--agent)"/><rect x="11.3" y="3.5" width="1.4" height="3" fill="var(--agent)"/><rect x="4" y="6.5" width="16" height="11" rx="3.5" fill="var(--agent)"/><circle cx="9" cy="12" r="1.8" fill="#1a1636"/><circle cx="15" cy="12" r="1.8" fill="#1a1636"/><rect x="6" y="18.5" width="12" height="3" rx="1.5" fill="var(--agent)"/></svg>`;
    if (kind === 'H') return `<svg class="g-h" width="${size}" height="${size}" viewBox="0 0 24 24" aria-label="person"><circle cx="12" cy="7" r="4.2" fill="var(--human)"/><path d="M4 21c0-4.5 3.6-7.5 8-7.5s8 3 8 7.5z" fill="var(--human)"/></svg>`;
    return `<svg class="g-d" width="${size}" height="${size}" viewBox="0 0 24 24" aria-label="deterministic"><rect x="3.5" y="3.5" width="17" height="11" rx="2.5" fill="var(--det)"/><rect x="6" y="7.5" width="12" height="3" rx="1" fill="#2a3039"/><rect x="7" y="16" width="10" height="4.5" rx="1.5" fill="var(--det)"/></svg>`;
  };
  A.actors = (kinds, size) => `<span class="act">${A.j(kinds, (k) => A.glyph(k, size))}</span>`;
  A.actorKinds = (actor) => (actor || '').split('+');

  A.avatar = (id, cls = '') => {
    const p = PEOPLE[id];
    if (!p) return `<span class="av ${cls}" style="background:var(--det)">${A.esc(id || '?').slice(0, 2).toUpperCase()}</span>`;
    return `<span class="av ${cls}" style="background:${p.color}" title="${A.esc(p.name)}">${p.initials}</span>`;
  };
  A.avatars = (ids, cls = 'sm') => `<span class="avs">${A.j(ids, (i) => A.avatar(i, cls))}</span>`;
  A.who = (id) => { const p = PEOPLE[id]; return p ? `<span class="row" style="gap:7px;flex-wrap:nowrap">${A.avatar(id, 'sm')}<span>${A.esc(p.name)}</span></span>` : `<span class="mono">${A.esc(id)}</span>`; };

  A.lane = (lane) => `<span class="lane" style="background:${A.laneColor(lane)}" title="${A.esc((LANES[lane] || {}).label || '')}">${lane}</span>`;
  A.chip = (item, opts = {}) => {
    const it = typeof item === 'string' ? A.item(item) : item;
    const n = it.key.split('-')[1];
    return `<a class="chip ${it.state === 'stuck' ? 'stuck' : ''}" href="#item-${it.key}" data-chip="${it.key}" title="${A.esc(it.key + (A.dataClass && A.dataClass(it.project) < 1 ? '' : ' · ' + it.title))}"><b style="background:${A.laneColor(it.lane)}">${opts.full ? it.key : n}</b><u></u></a>`;
  };
  A.ichip = (key) => { const it = A.item(key); if (!it) return `<span class="mono">${A.esc(key)}</span>`; const hide = A.dataClass && A.dataClass(it.project) < 1; return `<a class="ichip" href="#item-${key}"><b style="background:${A.laneColor(it.lane)}">${key}</b><span style="color:var(--fg-2);font-family:var(--body)">${hide ? '<span class="faint">title hidden</span>' : A.esc(it.title)}</span></a>`; };
  A.gate = (id) => { const g = GATES[id] || { fam: 'stage' }; const c = { action: 'x', exception: 'e', meta: 'm', quarantine: 'q' }[g.fam] || ''; return `<span class="gtag ${c}" title="${A.esc(g.title || '')}"><i></i>${(g.short || id)}</span>`; };
  A.hash = (h, len = 8) => `<span class="hash" title="sha256:${A.esc(h)}">${A.esc(String(h).slice(0, len))}</span>`;

  const STATE_PILL = { working: ['info', 'working'], waiting: ['gate', 'waiting'], held: ['back', 'held'], stuck: ['bad', 'stuck'], quarantined: ['bad', 'quarantined'], handoff: ['info', 'handoff'], scheduled: ['mute', 'scheduled'], parked: ['mute', 'parked'], done: ['ok', 'done'], declined: ['mute', 'declined'] };
  A.statePill = (state) => { const [c, t] = STATE_PILL[state] || ['mute', state]; return `<span class="pill ${c}">${t}</span>`; };
  A.pill = (text, kind = '') => `<span class="pill ${kind}">${A.esc(text)}</span>`;
  A.health = (s) => A.pill(s, { ok: 'ok', degraded: 'warn', down: 'bad', unknown: 'mute' }[s] || 'mute');

  A.pageHead = ({ crumbs, eyebrow, title, sub, actions }) => `
    <div class="ph"><div class="t">
      ${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}
      ${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}
      <h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}
    </div>${actions ? `<div class="acts">${actions}</div>` : ''}</div>`;
  A.card = (title, body, { actions = '', foot = '', flush = false, id = '' } = {}) => `
    <section class="card" ${id ? `id="${id}"` : ''}>${title ? `<div class="hd"><h3>${title}</h3><span class="sp"></span>${actions}</div>` : ''}
    <div class="bd ${flush ? 'flush' : ''}">${body}</div>${foot ? `<div class="ft">${foot}</div>` : ''}</section>`;
  A.stats = (tiles) => `<div class="stats">${A.j(tiles, (t) => `<div class="stat ${t.tone || ''}"><span class="k">${t.k}</span><span class="v">${t.v}</span>${t.d ? `<span class="d">${t.d}</span>` : ''}</div>`)}</div>`;
  A.kv = (pairs) => `<dl class="kv">${A.j(pairs.filter(Boolean), ([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
  /** cols: [{h, r: row => html, cls}] ; rows: array ; opts.href(row) makes rows clickable */
  A.table = (cols, rows, opts = {}) => `
    <div class="tbl-wrap"><table class="tbl"><thead><tr>${A.j(cols, (c) => `<th class="${c.cls || ''}">${c.h}</th>`)}</tr></thead>
    <tbody>${A.j(rows, (r) => { const href = opts.href && opts.href(r); return `<tr ${href ? `class="click" data-go="${href}"` : ''}>${A.j(cols, (c) => `<td class="${c.cls || ''}">${c.r(r)}</td>`)}</tr>`; })}</tbody></table></div>`;
  A.meter = (used, cap, { warnAt = 0.75, badAt = 0.95 } = {}) => { const p = cap ? Math.min(1, used / cap) : 0; const t = p >= badAt ? 'bad' : p >= warnAt ? 'warn' : ''; return `<div class="meter ${t}" title="${Math.round(p * 100)}%"><i style="width:${(p * 100).toFixed(1)}%"></i></div>`; };
  A.cents = (c) => `${(c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`;
  A.spark = (vals, { w = 120, h = 30, color = 'var(--hand)' } = {}) => {
    const max = Math.max(...vals), min = Math.min(...vals), sx = w / (vals.length - 1), sy = (v) => h - 3 - ((v - min) / ((max - min) || 1)) * (h - 6);
    const pts = vals.map((v, i) => `${(i * sx).toFixed(1)},${sy(v).toFixed(1)}`).join(' ');
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polygon points="0,${h} ${pts} ${w},${h}" fill="${color}" opacity=".14"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/><circle cx="${w}" cy="${sy(vals[vals.length - 1])}" r="2.6" fill="${color}"/></svg>`;
  };
  /** tabs: [{id,label,n,html}] — switching is handled globally; the first is open unless sel given */
  A.tabs = (group, tabs, sel) => {
    const open = sel || tabs[0].id;
    return `<div class="tabs" role="tablist">${A.j(tabs, (t) => `<button role="tab" data-tab="${group}:${t.id}" aria-selected="${t.id === open}">${t.label}${t.n != null ? `<span class="n">${t.n}</span>` : ''}</button>`)}</div>
      ${A.j(tabs, (t) => `<div data-panel="${group}:${t.id}" ${t.id === open ? '' : 'hidden'}>${t.html}</div>`)}`;
  };
  A.steps = (stage, current, doneAll = false) => {
    const ids = stepsOf(stage); const ci = ids.indexOf(current);
    return `<div class="steps">${A.j(ids, (id, i) => { const [, actor, title] = STEPS[id]; const cls = doneAll || i < ci ? 'done' : i === ci ? 'now' : 'todo'; return `<div class="s ${cls}"><span class="id">${id}</span><span>${title}</span>${A.actors(A.actorKinds(actor), 16)}</div>`; })}</div>`;
  };
  A.empty = (text) => `<div class="empty">${text}</div>`;

  /* ================================================================ overlays */
  A.toast = (msg) => { const box = document.querySelector('.toasts'); const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; box.appendChild(t); setTimeout(() => t.remove(), 3800); };
  A.closeOverlay = () => document.querySelectorAll('.scrim').forEach((s) => s.remove());
  A.drawer = (html) => { A.closeOverlay(); const s = document.createElement('div'); s.className = 'scrim'; s.innerHTML = `<aside class="drawer" role="dialog" aria-modal="true">${html}</aside>`; s.addEventListener('click', (e) => { if (e.target === s) A.closeOverlay(); }); document.body.appendChild(s); return s.firstElementChild; };
  A.modal = (html) => { A.closeOverlay(); const s = document.createElement('div'); s.className = 'scrim center'; s.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`; s.addEventListener('click', (e) => { if (e.target === s) A.closeOverlay(); }); document.body.appendChild(s); return s.firstElementChild; };

  /** The item quick-look used by the floor, board and lists */
  A.peek = (key) => {
    const it = A.item(key); if (!it) return;
    const [, , stepTitle] = STEPS[it.step] || [];
    A.drawer(`
      <div class="row between"><span class="eyebrow">${A.project(it.project).name}</span><button class="icon-btn" data-close aria-label="Close">${A.icon('close')}</button></div>
      <div class="row">${A.lane(it.lane)}<span class="mono" style="font-weight:600">${it.key}</span>${A.statePill(it.state)}</div>
      <h2>${A.dataClass && A.dataClass(it.project) < 1 ? '<span class="faint">Title hidden (needs D1)</span>' : A.esc(it.title)}</h2>
      ${A.kv([['Stage', `${it.stage} ${A.esc(A.stage(it.stage)?.name || '')}`], ['Step', `<span class="mono">${it.step}</span> ${A.esc(stepTitle || '')}`], it.gate ? ['Open gate', `${A.gate(it.gate)} <span class="muted">${A.esc(GATES[it.gate]?.title || '')}</span>`] : null, it.wait.length ? ['Waiting on', A.j(it.wait, (w) => A.who(w)) + (it.waitWhat ? `<div class="small muted" style="margin-top:4px">${A.esc(it.waitWhat)}</div>` : '')] : null, ['Requester', A.who(it.requester)], ['Owner of record', A.who(it.owner)], ['Envelope', `${A.cents(it.spend[0])} of ${A.cents(it.spend[1])}${A.meter(it.spend[0], it.spend[1])}`], ['Age', it.age]])}
      ${A.j(it.backEdges, (b) => `<div class="banner warn" style="margin:0">${A.esc(b.note)} <span class="sp"></span><span class="small">${b.at}</span></div>`)}
      <div class="row">${it.gate ? (A.decideCheck && A.decideCheck(it.gate, it.key).allow && it.wait.includes(A.data.ME) ? `<a class="btn primary" href="#gate-${it.gate}-${it.key}">Decide ${GATES[it.gate]?.short || it.gate}</a>` : `<a class="btn" href="#gate-${it.gate}-${it.key}">View ${GATES[it.gate]?.short || it.gate}</a>`) : ''}<a class="btn" href="#item-${it.key}">Open item</a></div>`);
  };

  /* ================================================================ router */
  const VIEWS = [];
  /** A.view(name, {label, group, icon, nav, badge(), match: RegExp, title, render(params) -> html, mount(root, params)}) */
  A.view = (name, def) => VIEWS.push({ name, nav: true, ...def });
  A.go = (hash) => { location.hash = hash.startsWith('#') ? hash : '#' + hash; };
  const resolve = (hash) => {
    const h = hash.replace(/^#/, '') || 'home';
    if (h === 'login' || h === 'signed-out') return { v: VIEWS.find((x) => x.name === 'home') || VIEWS[0], params: [] };
    for (const v of VIEWS) {
      if (v.match) { const m = v.match.exec(h); if (m) return { v, params: m.slice(1) }; } else if (v.name === h) return { v, params: [] };
    }
    return { v: VIEWS.find((x) => x.name === 'notfound') || VIEWS.find((x) => x.name === 'home') || VIEWS[0], params: [] };
  };
  const GROUPS = ['Home', 'Work', 'Decide', 'Projects', 'Operate', 'Quality', 'Govern', 'Admin'];
  /** a view may declare access(params) -> {action, res}; navAccess() for the rail (defaults to access([])) */
  const allowed = (v, params) => { if (!v.access || !A.why) return { ok: true }; const q = v.access(params || []); if (!q) return { ok: true }; return { ok: A.can(q.action, q.res), q }; };
  const renderRail = (active) => GROUPS.map((g) => {
    const links = VIEWS.filter((v) => v.group === g && v.nav && (v.navAccess ? v.navAccess() : allowed(v).ok));
    if (!links.length) return '';
    return (g === 'Home' ? '' : `<div class="grp">${g}</div>`) + A.j(links, (v) => { const b = v.badge ? v.badge() : null; return `<a href="#${v.name}" ${active === v.name || active === v.parent ? 'aria-current="page"' : ''}>${A.icon(v.icon || v.name)}<span>${v.label}</span>${b && b.n ? `<span class="n ${b.hot ? 'hot' : ''}">${b.n}</span>` : ''}</a>`; });
  }).join('') + `<div class="foot">catalogue 1.4.0 · 8c2e…f1<br>policy bundle 37 · roles-1.1.0<br>ledger head 18,422 ✓</div>`;
  let current = null;
  const render = () => {
    if (current && current.unmount) try { current.unmount(); } catch (e) { console.error(e); }
    if (!A.session || !A.session.signedIn) { current = VIEWS.find((x) => x.name === 'login'); document.getElementById('app').innerHTML = current ? current.render([]) : ''; if (current && current.mount) current.mount(document.getElementById('app')); return; }
    if (!document.querySelector('.shell')) A.boot(true);
    const { v, params } = resolve(location.hash);
    current = v;
    document.querySelector('.rail').innerHTML = renderRail(v.name);
    A.renderTop && A.renderTop();
    const main = document.querySelector('main');
    // a fresh wrapper per render, so listeners a view adds to its root never pile up
    const root = document.createElement('div'); root.className = 'view';
    const gate = allowed(v, params);
    try { root.innerHTML = gate.ok ? v.render(params) : A.forbidden(gate.q.action, gate.q.res, v.deniedTitle); } catch (e) { console.error(e); root.innerHTML = A.empty(`This screen failed to draw: ${A.esc(e.message)}`); }
    main.replaceChildren(root);
    document.title = 'AISDLC Portal';
    if (gate.ok && v.mount) try { v.mount(root, params); } catch (e) { console.error(e); }
    document.body.classList.remove('nav-open');
    A.closeOverlay();
    window.scrollTo(0, 0);
  };
  A.render = render;

  /* ================================================================ global behaviour */
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab],[data-go],[data-toast],[data-close],[data-peek],[data-chip]');
    if (!t) return;
    if (t.dataset.tab) {
      const [g] = t.dataset.tab.split(':');
      document.querySelectorAll(`[data-tab^="${g}:"]`).forEach((b) => b.setAttribute('aria-selected', String(b === t)));
      document.querySelectorAll(`[data-panel^="${g}:"]`).forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
    } else if (t.dataset.go) { e.preventDefault(); A.go(t.dataset.go); }
    else if (t.dataset.toast) { e.preventDefault(); A.toast(t.dataset.toast); }
    else if (t.hasAttribute('data-close')) A.closeOverlay();
    else if (t.dataset.peek || (t.dataset.chip && t.closest('[data-peek-chips]'))) { e.preventDefault(); A.peek(t.dataset.peek || t.dataset.chip); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') A.closeOverlay(); if (e.key === '/' && document.activeElement === document.body) { e.preventDefault(); document.getElementById('q')?.focus(); } });

  A.boot = (shellOnly) => {
    document.getElementById('app').innerHTML = `
      <header class="top" id="top"></header>
      <div class="shell"><nav class="rail" aria-label="Sections"></nav><main id="main"></main></div>
      <div class="toasts" aria-live="polite"></div>`;
    if (!A.bootedOnce) { A.bootedOnce = true; window.addEventListener('hashchange', render); }
    if (!shellOnly) render();
  };
  A.renderTop = () => {
    const me = A.data.ME, P = PEOPLE[me];
    const proj = A.visibleProjects ? A.visibleProjects().filter((p) => p.level !== 'Onboarding') : PROJECTS;
    if (!proj.find((p) => p.id === A.state.project) && proj[0]) A.state.project = proj[0].id;
    const decide = A.inboxCount ? A.inboxCount() : A.waitingOnMe().length;
    const top = document.getElementById('top');
    top.innerHTML = `
        <button class="menu-btn" id="menu" aria-label="Menu">${A.icon('menu')}</button>
        <a class="brand" href="#home" style="color:inherit;text-decoration:none"><svg class="mark" viewBox="0 0 24 24"><path d="M2 12h20" stroke="var(--belt-2)" stroke-width="3"/><rect x="8" y="8" width="8" height="8" transform="rotate(45 12 12)" fill="var(--gate)"/></svg>AISDLC<small>acme factory</small></a>
        ${proj.length ? `<label class="proj-switch"><span class="lb faint small">Project</span><select id="proj" aria-label="Project">${A.j(proj, (p) => `<option value="${p.id}" ${p.id === A.state.project ? 'selected' : ''}>${A.esc(p.name)}${p.classification === 'confidential' ? ' (confidential)' : ''}</option>`)}</select></label>` : ''}
        <label class="search">${A.icon('search')}<input id="q" placeholder="Search items you can see…" aria-label="Search"><kbd>/</kbd></label>
        <span class="sp"></span>
        <div class="top-actions">
          ${A.state.killed ? '<span class="pill bad">kill active</span>' : ''}
          <a class="icon-btn" href="#inbox" aria-label="Inbox, ${decide} waiting">${A.icon('bell', 18)}${decide ? `<span class="dot">${decide}</span>` : ''}</a>
          ${A.can && (A.can('kill.request', { type: 'Project', project: A.state.project }) || A.can('session.stop', { type: 'Project', project: A.state.project })) ? `<button class="kill-btn" data-go="kill">${A.icon('kill', 14)} <span>Kill switch</span></button>` : ''}
          <button class="me" id="me-btn" aria-haspopup="menu" aria-expanded="false">${A.avatar(me)}<span class="nm"><b>${A.esc(P.name)}</b><small>${A.esc(A.persona ? A.persona() : '')}</small></span>${A.stepUpValid && A.stepUpValid() ? '<span class="stepup-ok" title="Step-up valid">step-up</span>' : ''}</button>
        </div>`;
    top.querySelector('#menu').onclick = () => document.body.classList.toggle('nav-open');
    const ps = top.querySelector('#proj'); if (ps) ps.onchange = (e) => { A.state.project = e.target.value; render(); };
    top.querySelector('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const k = e.target.value.trim().toUpperCase(); const it = A.item(k); if (it && (!A.canSeeProject || A.canSeeProject(it.project))) A.go('item-' + k); else A.go('items'); } });
    top.querySelector('#me-btn').onclick = (e) => { e.stopPropagation(); A.userMenu && A.userMenu(e.currentTarget); };
  };
})();
