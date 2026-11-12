/* The ONE configuration pattern (docs/design/portal-config.md §3), used by every configurable thing in the portal.
   in force + lineage -> draft form built from a schema description -> diff -> Propose (opens an M1 card) -> pending -> history.
   Mirrors packages/config: a revision is the full document of a LAYER (factory, or one project); a proposal on a layer
   supersedes the one pending there; publish needs an approve of exactly that hash on the ledger. Example data, in memory. */
(function () {
  const D = A.data, E = A.esc, J = A.j, X = A.access;
  const FLEET = { type: 'Fleet' };
  const hx = (s, n = 64) => { let out = '', i = 0; while (out.length < n) { let h = 0x811c9dc5 ^ i; for (const c of `${s}#${i}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } out += h.toString(16).padStart(8, '0'); i++; } return out.slice(0, n); };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const name = (id) => (D.PEOPLE[id] || { name: id }).name;
  // the D11 forbidden verbs (CODEHOST_FORBIDDEN_VERBS): every integration scope row carries all of them
  const D11 = ['merge', 'enqueue', 'approve', 'auto_merge', 'force', 'delete', 'dismiss', 'admin'];
  const RT = (s) => 'file:/run/secrets/' + s; // a secret REFERENCE, never a value

  /* ================================================================ schema descriptions (mirrors the Zod schemas in contracts) */
  const S = {
    int: (o = {}) => ({ t: 'int', ...o }), num: (o = {}) => ({ t: 'num', ...o }), bool: (o = {}) => ({ t: 'bool', ...o }),
    enm: (options, o = {}) => ({ t: 'enum', options, ...o }), str: (o = {}) => ({ t: 'str', ...o }), secret: (o = {}) => ({ t: 'secret', ...o }),
    obj: (fields, o = {}) => ({ t: 'obj', fields, ...o }), list: (of, o = {}) => ({ t: 'list', of, ...o }), map: (of, o = {}) => ({ t: 'map', of, ...o }),
    person: (o = {}) => ({ t: 'person', ...o }), fixed: (o = {}) => ({ t: 'fixed', ...o }), oneof: (cases, o = {}) => ({ t: 'oneof', cases, ...o }),
  };
  const SLUG = /^[a-z][a-z0-9_.-]*$/, REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, HOSTN = /^[a-z0-9.-]+\.[a-z]{2,}$/;
  const SECRET_REF = /^(file:\/[A-Za-z0-9_./-]{1,200}|env:[A-Z][A-Z0-9_]{0,63})$/;
  // client-side refusal of anything that looks like a credential value (the server runs the shared secret ruleset again)
  const LOOKS_SECRET = new RegExp(['^(s' + 'k-', 'gh' + 'p_', 'gh' + 's_', 'AK' + 'IA', 'xox' + 'b-', '-----BEG' + 'IN)'].join('|') + '|^[A-Za-z0-9+/=_-]{32,}$');
  const LOGIN = /^(?!.*\[bot\]$)(?!app\/)[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  const ROLE_SLOTS = ['admin', 'requesters', 'intent', 'design', 'g4', 'g5', 'x', 'sec', 'm4', 'kill'];
  const GROUPS = ['g0g1', 'g2', 'g3d', 'g3_g3s', 'g5', 'g6'];
  const GROUP_LABEL = { g0g1: 'G0+G1 triage and intent', g2: 'G2 spec and oracle specs', g3d: 'G3d design and threat', g3_g3s: 'G3 / G3s plan', g5: 'G5 release', g6: 'G6 requester acceptance' };
  const LANES = Object.keys(D.LANES);
  const tierOf = (p) => ({ payments: 'T1', ledger: 'T2', web: 'T1', identity: 'T2', mobile: 'T1' }[p] || 'T1');
  const deploysOf = (p) => ['payments', 'web'].includes(p);

  const integration = S.obj({
    integration_id: S.str({ pattern: SLUG, max: 64, key: true }),
    kind: S.enm(['code_host', 'model_provider', 'notifier', 'tracker', 'identity']),
    adapter: S.enm(['github_app', 'fake_github', 'anthropic', 'openai_compat', 'fake'], { help: 'A new adapter is code: a class plus a name, never a free-text row.' }),
    display_name: S.str({ max: 120 }),
    config: S.obj({ app_id: S.str({ optional: true, pattern: /^[0-9A-Za-z_-]{1,64}$/ }), installation_id: S.int({ optional: true, min: 1 }), api_url: S.str({ optional: true, url: true }), base_url: S.str({ optional: true, url: true }), mode: S.enm(['census'], { optional: true }) }, { help: 'Non-secret settings, checked per adapter (strict: an undeclared key is refused). Only hosts in GATEWAY_EGRESS_HOSTS build.' }),
    status: S.enm(['draft', 'enabled', 'disabled', 'retired']),
    owner: S.person({ optional: true }),
    version: S.fixed({ help: 'The registry’s own count; increases with every published change of this row.' }),
    credentials: S.list(S.obj({ credential_id: S.str({ pattern: SLUG }), secret_ref: S.secret(), kind: S.enm(['app_key', 'pat', 'api_key', 'oauth']), rotated_at: S.str({ optional: true }) }), { max: 8, label: (v) => v.credential_id, add: () => ({ credential_id: 'key', secret_ref: RT('new-key'), kind: 'api_key' }) }),
    scopes: S.list(S.obj({ scope: S.enm(['read_repos', 'apply_patch', 'pr_status', 'chat_complete', 'notify']), data_class_max: S.enm(['D0', 'D1', 'D2', 'D3']), forbidden: S.fixed({ help: 'The whole D11 list, always: merge, enqueue, approve, auto_merge, force, delete, dismiss, admin.' }) }), { max: 8, label: (v) => v.scope, add: () => ({ scope: 'read_repos', data_class_max: 'D1', forbidden: D11.slice() }) }),
    provider: S.obj({ tools_capable: S.bool(), streams: S.bool(), aws_only: S.bool() }, { optional: true, help: 'Required for a model_provider, absent otherwise.' }),
  });
  const integrationRules = (doc) => {
    const out = []; const kindOf = { github_app: 'code_host', fake_github: 'code_host', anthropic: 'model_provider', openai_compat: 'model_provider', fake: 'model_provider' };
    const scopesOf = { code_host: ['read_repos', 'apply_patch', 'pr_status'], model_provider: ['chat_complete'], notifier: ['notify'], tracker: ['notify'], identity: [] };
    const ids = new Set();
    (doc || []).forEach((r, i) => {
      const p = [i];
      if (ids.has(r.integration_id)) out.push({ p, m: `duplicate integration_id ${r.integration_id}` }); ids.add(r.integration_id);
      if (kindOf[r.adapter] !== r.kind) out.push({ p: [i, 'adapter'], m: `adapter ${r.adapter} serves ${kindOf[r.adapter]}, not ${r.kind}` });
      if ((r.kind === 'model_provider') !== !!r.provider) out.push({ p: [i, 'provider'], m: 'provider facts belong to model_provider integrations, and only to them' });
      (r.scopes || []).forEach((s, n) => {
        if (!scopesOf[r.kind].includes(s.scope)) out.push({ p: [i, 'scopes', n], m: `${r.kind} cannot carry ${s.scope}` });
        if (r.kind === 'model_provider' && s.data_class_max === 'D3') out.push({ p: [i, 'scopes', n, 'data_class_max'], m: 'a model provider never carries D3' });
        if (!D11.every((v) => (s.forbidden || []).includes(v))) out.push({ p: [i, 'scopes', n], m: 'forbidden must list every verb of the D11 list' });
      });
      const keyless = r.adapter === 'fake' || r.adapter === 'fake_github';
      if (r.status === 'enabled' && !keyless && !(r.credentials || []).length) out.push({ p: [i, 'credentials'], m: 'an enabled integration needs a credential reference' });
      if (r.status === 'enabled' && !(r.scopes || []).length) out.push({ p: [i, 'scopes'], m: 'an enabled integration needs at least one scope' });
      if (r.adapter === 'fake' && r.status === 'enabled') out.push({ level: 'warn', p: [i, 'status'], m: 'the fake adapter is refused in prod (fake_not_allowed); it builds only in local' });
    });
    return out;
  };

  /* ================================================================ the key registry (portal-config.md §1.1 + decided-but-not-built keys) */
  // status: exists | partial | missing | planned (no key registered yet: a proposal would be refused as an unknown key)
  const KEYS = {
    'sandbox.caps': {
      area: 'Sandboxes', layer: 'factory', label: 'Sandbox caps', schemaName: 'SandboxCapsConfig', registeredBy: 'registerSandboxConfig (packages/config/src/sandbox.ts)', readBy: 'sandbox-controller (caps.ts); core H2 reads the free slots',
      desc: 'How many sandbox sessions each runner host may run at once, in all classes and in the coding class W. The controller refuses over a cap (409 busy) and never queues.',
      status: 'partial', milestone: 'screen M21; core still caps coding at CODING_SESSION_CAP = 1 (gap 10)',
      schema: S.obj({ total: S.int({ min: 1, max: 32, help: 'All classes on one host.' }), coding: S.int({ min: 0, max: 8, help: 'Class W on one host; never above total.' }), hosts: S.map(S.obj({ total: S.int({ min: 1, max: 32 }), coding: S.int({ min: 0, max: 8 }) }), { keyLabel: 'host id', keyPattern: /^[a-z][a-z0-9-]*$/, add: () => ({ total: 4, coding: 1 }), help: 'A host with its own row takes it; every other host takes the top level.' }) }),
      def: { total: 4, coding: 1, hosts: {} },
      rules: (d) => { const o = []; if (d.coding > d.total) o.push({ p: ['coding'], m: 'coding can never be more than total' }); Object.entries(d.hosts || {}).forEach(([h, v]) => { if (v.coding > v.total) o.push({ p: ['hosts', h, 'coding'], m: `${h}: coding can never be more than total` }); }); if (d.coding > 1 || Object.values(d.hosts || {}).some((v) => v.coding > 1)) o.push({ level: 'warn', m: 'Admission (H2) and 5.6 still use the constant CODING_SESSION_CAP = 1, so a coding cap above 1 has no effect until gap 10 is fixed (M15).' }); return o; },
      consumer: (d) => ({ who: 'sandbox-controller', route: 'GET /v1/slots', lines: [`host local: caps {total ${d.total}, coding ${d.coding}} · caps_source config`, `running: 4 (W 1, P 2, V 1) · free: W ${Math.max(0, Math.min(d.coding - 1, d.total - 4))}, other classes ${Math.max(0, d.total - 4)}`, ...Object.entries(d.hosts || {}).map(([h, v]) => `host ${h}: caps {total ${v.total}, coding ${v.coding}} (its own row)`)] }),
    },
    'sandbox.exec_allowed_repos': {
      area: 'Sandboxes', layer: 'factory', label: 'Run repo code (DEC-18 allow-list)', schemaName: 'SandboxExecAllowedRepos', registeredBy: 'registerCoreConfig', readBy: 'GuardedSandbox (checkSessionAllowed), every class that runs repo code',
      desc: 'Repos whose code the factory may run in a container sandbox (build, tests, oracles, S7). A repo not on the list is only read: its sessions fail with exec_not_allowed. DEC-18: only repos the owner wrote; any other repo is re-decided first.',
      status: 'partial', milestone: 'screen with the factory M1 (M15); multi-repo allow-list M20',
      schema: S.list(S.str({ pattern: REPO, placeholder: 'owner/name' }), { max: 200, label: (v) => v, add: () => 'acme/' }),
      def: [],
      rules: (d) => { const o = []; const seen = new Set(); d.forEach((r, i) => { if (seen.has(r.toLowerCase())) o.push({ p: [i], m: `${r} is listed twice` }); seen.add(r.toLowerCase()); if (r.startsWith('vendor-fork/')) o.push({ level: 'warn', p: [i], m: `${r} is not a repo the owner wrote: DEC-18 must be re-decided before its code runs (M20)` }); }); return o; },
    },
    'codehost.merge_bypass': {
      area: 'Code host', layer: 'factory', label: 'Merge bypass list (DEC-10)', schemaName: 'MergeBypassConfig', registeredBy: 'registerGateCheckConfig (M14.5)', readBy: 'gate-check (classifies merges: gated, bypass, unauthorised)',
      desc: 'Per repo, the named people who may merge a pull request whose aisdlc/gate check did not pass, as bypass actors on GitHub. It can be empty and differ per repo. Never an App or a bot. Every bypass merge opens an X4 review; a merge by anyone else is unauthorised (security).',
      status: 'partial', milestone: 'M14.5 schema and reader; screen M14.6, decidable after the factory M1',
      schema: S.map(S.list(S.obj({ login: S.str({ pattern: LOGIN, placeholder: 'github-login', help: 'A GitHub user login. name[bot] and app/x are refused.' }), principal_id: S.person() }), { max: 10, label: (v) => `${v.login} → ${name(v.principal_id)}`, add: () => ({ login: '', principal_id: 'ar' }) }), { keyLabel: 'repo (owner/name)', keyPattern: REPO, add: () => [] }),
      def: {},
      rules: (d) => { const o = []; Object.entries(d).forEach(([repo, list]) => { const seen = new Set(); list.forEach((p, i) => { if (seen.has((p.login || '').toLowerCase())) o.push({ p: [repo, i, 'login'], m: `${p.login} appears twice for ${repo}` }); seen.add((p.login || '').toLowerCase()); if (/\[bot\]$|^app\//i.test(p.login || '')) o.push({ p: [repo, i, 'login'], m: 'an App or bot can never be on the bypass list' }); }); if (list.length > 10) o.push({ p: [repo], m: 'at most 10 people per repo' }); }); return o; },
      consumer: () => ({ who: 'gate-check', route: 'config.genuine_publish (read, every 5 s)', lines: ['reloads the list; merges after the watch start are classed gated, bypass or unauthorised', 'each bypass or unauthorised merge opens an X4 card (core loop gatecheck_merges)'] }),
    },
    'gateway.models': {
      area: 'Models and routes', layer: 'factory', label: 'Models and prices', schemaName: 'GatewayModels', registeredBy: 'registerGatewayConfig', readBy: 'gateway (every call)',
      desc: 'The models the gateway may serve, with the provider row each belongs to, the output token cap and the price per million tokens. A model must name an enabled model_provider integration.',
      status: 'partial', milestone: 'screen M21; prices confirmed in M10.6 before real spend',
      schema: S.list(S.obj({ model_id: S.str({ pattern: SLUG, key: true }), provider_id: S.str({ pattern: SLUG, help: 'an integration_id of kind model_provider' }), provider_model: S.str({ max: 128 }), tools_capable: S.bool(), context_window: S.int({ optional: true, min: 1 }), max_tokens_cap: S.int({ min: 1, max: 1000000 }), usd_in_per_mtok: S.num({ min: 0, max: 100000, placeholder: '[PLACEHOLDER]' }), usd_out_per_mtok: S.num({ min: 0, max: 100000, placeholder: '[PLACEHOLDER]' }) }), { max: 128, label: (v) => v.model_id, add: () => ({ model_id: 'new-model', provider_id: 'anthropic', provider_model: '', tools_capable: true, max_tokens_cap: 8192, usd_in_per_mtok: 0, usd_out_per_mtok: 0 }) }),
      def: [],
      rules: (d) => { const o = []; const reg = A.cfg.inForce('integrations.registry').doc; const ids = new Set(); d.forEach((m, i) => { if (ids.has(m.model_id)) o.push({ p: [i, 'model_id'], m: 'duplicate model_id' }); ids.add(m.model_id); const prov = reg.find((r) => r.integration_id === m.provider_id); if (!prov || prov.kind !== 'model_provider') o.push({ p: [i, 'provider_id'], m: `${m.provider_id} is not a model_provider integration` }); else if (prov.status !== 'enabled') o.push({ level: 'warn', p: [i, 'provider_id'], m: `${m.provider_id} is ${prov.status}: a route to ${m.model_id} would be route_broken` }); if (!m.usd_in_per_mtok && !m.usd_out_per_mtok) o.push({ level: 'warn', p: [i], m: `${m.model_id}: price is a [PLACEHOLDER] (0); confirm it before real spend (M10.6)` }); }); return o; },
    },
    'gateway.routes': {
      area: 'Models and routes', layer: 'factory', label: 'Routes', schemaName: 'GatewayRoutes', registeredBy: 'registerGatewayConfig', readBy: 'gateway (every call: the routed model is served whatever the request names)',
      desc: 'Which model serves a call, by (environment, data class). Routes are never per agent: an agent’s contract only narrows which models its key may use. D3 is not in the schema: D3 data never routes to a model.',
      status: 'partial', milestone: 'screen M21',
      schema: S.list(S.obj({ environment: S.enm(['local', 'staging', 'prod']), data_class: S.enm(['D0', 'D1', 'D2'], { help: 'D3 is not offered: the schema has no D3.' }), model_id: S.str({ pattern: SLUG, help: 'a model_id of gateway.models' }) }), { max: 64, label: (v) => `${v.environment} · ${v.data_class}`, add: () => ({ environment: 'prod', data_class: 'D0', model_id: 'claude-haiku-5-5' }) }),
      def: [],
      rules: (d) => { const o = []; const models = A.cfg.inForce('gateway.models').doc.map((m) => m.model_id); const seen = new Set(); d.forEach((r, i) => { const k = `${r.environment}/${r.data_class}`; if (seen.has(k)) o.push({ p: [i], m: `duplicate route ${k}` }); seen.add(k); if (!models.includes(r.model_id)) o.push({ p: [i, 'model_id'], m: `${r.model_id} is not in gateway.models` }); }); ['D0', 'D1', 'D2'].forEach((dc) => { if (!d.some((r) => r.environment === 'prod' && r.data_class === dc)) o.push({ level: 'warn', m: `no prod route for ${dc}: every ${dc} call in prod is refused (no_route)` }); }); D.AGENTS.filter((a) => !a.unbound).forEach((a) => { const r = d.find((x) => x.environment === 'prod' && x.data_class === a.dc); if (r && !a.models.includes(r.model_id)) o.push({ level: 'warn', m: `${a.id} ${a.name}: prod ${a.dc} routes to ${r.model_id}, which its contract does not allow: its calls would be refused (model_not_allowed)` }); }); return o; },
      consumer: (d) => ({ who: 'gateway', route: 'GET /v1/admin/integrations', lines: [`environment prod: ${d.filter((r) => r.environment === 'prod').map((r) => `${r.data_class} → ${r.model_id}`).join(', ')}`, 'applies from the next call; no restart'] }),
    },
    'integrations.registry': {
      area: 'Integrations', layer: 'factory', label: 'Integration registry', schemaName: 'IntegrationRegistry', registeredBy: 'registerIntegrationConfig', readBy: 'codehost, gateway (adapters built per row)',
      desc: 'Code hosts and model providers as rows of one registry. Credentials are references only; the whole document is run through the shared secret ruleset, and a finding names the rule, never the value.',
      status: 'partial', milestone: 'screen M21, after the factory M1 (M15)',
      schema: S.list(integration, { max: 64, label: (v) => `${v.display_name} · ${v.adapter}`, add: () => ({ integration_id: 'new-integration', kind: 'model_provider', adapter: 'openai_compat', display_name: 'New provider', config: { base_url: 'https://provider.example/v1' }, status: 'draft', version: 1, credentials: [], scopes: [], provider: { tools_capable: true, streams: true, aws_only: false } }) }),
      def: [], rules: integrationRules,
      consumer: (d) => ({ who: 'gateway and codehost', route: 'GET /v1/admin/integrations · POST /v1/admin/reload', lines: d.map((r) => `${r.integration_id}: ${r.status !== 'enabled' ? 'not built (' + r.status + ')' : r.adapter === 'fake' ? 'refused in prod: fake_not_allowed' : 'built'}`) }),
    },
    'integrations.installs': {
      area: 'Integrations', layer: 'factory', label: 'Installs per project', schemaName: 'IntegrationInstalls', registeredBy: 'registerIntegrationConfig', readBy: 'codehost, gateway',
      desc: 'One integration enabled for one project, with overrides that can only narrow: the repos it may touch, the models the project may use. No row means the fleet default (no restriction; open point M10.6).',
      status: 'partial', milestone: 'M21; M10.6 decides the absent-install semantics',
      schema: S.list(S.obj({ install_id: S.str({ pattern: SLUG, key: true }), integration_id: S.str({ pattern: SLUG }), project_id: S.enm(['payments', 'ledger', 'web', 'identity', 'mobile']), enabled: S.bool(), overrides: S.obj({ repos_allowed: S.list(S.str({ pattern: REPO }), { optional: true, label: (v) => v, add: () => 'acme/' }), models_allowed: S.list(S.str({ pattern: SLUG }), { optional: true, label: (v) => v, add: () => 'claude-sonnet-5-5' }) }) }), { max: 256, label: (v) => `${v.integration_id} → ${v.project_id}`, add: () => ({ install_id: 'new-install', integration_id: 'anthropic', project_id: 'payments', enabled: true, overrides: {} }) }),
      def: [],
      rules: (d) => { const o = []; const reg = A.cfg.inForce('integrations.registry').doc; d.forEach((r, i) => { const x = reg.find((y) => y.integration_id === r.integration_id); if (!x) o.push({ p: [i, 'integration_id'], m: `${r.integration_id} is not in the registry` }); else if (r.enabled && x.status !== 'enabled') o.push({ p: [i, 'enabled'], m: `an enabled install must name an enabled integration (${x.integration_id} is ${x.status})` }); }); return o; },
    },
    'factory.constitution': {
      area: 'Factory rules', layer: 'factory', label: 'Constitution', schemaName: 'Constitution', registeredBy: 'registerCoreConfig', readBy: '4.5 (design time) and S7 7.5 (every lane): evaluateConstitution',
      desc: 'The rules every design and every change is checked against. Two rule kinds exist: no unapproved egress (hosts outside allow_hosts need an approval reference) and migrations reversible or flagged. A violation raises E2 with the report bound to the gate.',
      status: 'partial', milestone: 'screen M21',
      schema: S.obj({ version: S.int({ min: 1 }), rules: S.list(S.oneof({ no_unapproved_egress: S.obj({ rule_id: S.str({ pattern: /^[A-Z][A-Z0-9-]{1,31}$/ }), title: S.str({ max: 200 }), allow_hosts: S.list(S.str({ pattern: HOSTN }), { max: 100, label: (v) => v, add: () => 'api.example.com' }) }), migrations_reversible_or_flagged: S.obj({ rule_id: S.str({ pattern: /^[A-Z][A-Z0-9-]{1,31}$/ }), title: S.str({ max: 200 }) }) }, { tag: 'kind' }), { max: 50, label: (v) => `${v.rule_id} · ${v.kind}`, add: () => ({ kind: 'migrations_reversible_or_flagged', rule_id: 'C-NEW', title: '' }) }) }),
      def: { version: 1, rules: [{ kind: 'no_unapproved_egress', rule_id: 'C-EGRESS', title: 'No new external network egress without an approval reference', allow_hosts: [] }, { kind: 'migrations_reversible_or_flagged', rule_id: 'C-MIGRATION', title: 'Migrations are reversible, or flagged irreversible' }] },
      rules: (d) => { const o = []; const ids = new Set(); (d.rules || []).forEach((r, i) => { if (ids.has(r.rule_id)) o.push({ p: ['rules', i, 'rule_id'], m: 'rule ids must be unique' }); ids.add(r.rule_id); }); if (!(d.rules || []).length) o.push({ p: ['rules'], m: 'a constitution has at least one rule' }); return o; },
    },
    's0.failure_model': { area: 'Onboarding', layer: 'factory', label: 'S0 failure model', schemaName: 'S0FailureModel', registeredBy: 'registerCoreConfig', readBy: 'S0 driver', desc: 'Send-backs per step, how long silence at a human step lasts before the onboarding parks, and machine retries.', status: 'partial', milestone: 'screen M21, after the factory M1',
      schema: S.obj({ send_backs_per_step: S.int({ min: 1 }), park_business_days: S.int({ min: 1 }), machine_retries: S.int({ min: 0 }), machine_retry_delay_seconds: S.int({ min: 0 }) }), def: { send_backs_per_step: 1, park_business_days: 5, machine_retries: 3, machine_retry_delay_seconds: 60 } },
    's0.timeboxes': { area: 'Onboarding', layer: 'factory', label: 'S0 time boxes', schemaName: 'S0TimeBoxes', registeredBy: 'registerCoreConfig', readBy: 'S0 driver (timebox exceeded, reminders)', desc: 'Per onboarding step: the machine time box, the expected human effort (never enforced), the overall business days and the reminder.', status: 'partial', milestone: 'screen M21',
      schema: S.map(S.obj({ machine_minutes: S.int({ min: 1, optional: true }), human_minutes: S.int({ min: 1, optional: true }), overall_business_days: S.int({ min: 1, optional: true }), reminder_business_days: S.int({ min: 1, optional: true }), sla_business_days: S.int({ min: 1, optional: true }) }), { keyLabel: 'step', keyPattern: /^0\.[1-5]$/, fixedKeys: true }),
      def: { '0.1': { machine_minutes: 30, human_minutes: 15, reminder_business_days: 2 }, '0.2': { human_minutes: 240, overall_business_days: 10 }, '0.3': { human_minutes: 600, overall_business_days: 15 }, '0.4': { machine_minutes: 5, human_minutes: 30 }, '0.5': { human_minutes: 15, sla_business_days: 1 } } },
    's0.calendar': { area: 'Onboarding', layer: 'factory', label: 'Business calendar', schemaName: 'S0Calendar', registeredBy: 'registerCoreConfig', readBy: 'S0 timers, work lifecycle (PARK, item age)', desc: 'Which days count as business days for SLAs, PARK and reminders.', status: 'partial', milestone: 'screen M21',
      schema: S.obj({ weekend: S.list(S.int({ min: 0, max: 6 }), { max: 6, label: (v) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][v] || v, add: () => 0 }), holidays: S.list(S.str({ pattern: /^\d{4}-\d{2}-\d{2}$/, placeholder: 'YYYY-MM-DD' }), { label: (v) => v, add: () => '2026-12-25' }), utc_offset_minutes: S.int({ min: -720, max: 840 }) }), def: { weekend: [0, 6], holidays: [], utc_offset_minutes: 0 } },
    's0.t0_attestation_required': { area: 'Onboarding', layer: 'factory', label: 'T0 needs an attestation (DEC-4)', schemaName: 'boolean', registeredBy: 'registerCoreConfig', readBy: 'card 1', desc: 'A T0 tier needs the owner’s positive attestation on card 1 (no prod, no real data, no dependants).', status: 'partial', milestone: 'screen M21', schema: S.bool({ label: 'Required' }), def: true },
    'ops.maintenance.mm2': { area: 'Factory rules', layer: 'factory', label: 'Maintenance (MM-2)', schemaName: 'boolean', registeredBy: 'registerCoreConfig', readBy: 'every timer and decide path (maintenanceFrom)', desc: 'While on, timers pause and nothing new is admitted. An unreadable value reads as on (fail closed). The same effect is also a fleet control (Operate › Controls).', status: 'partial', milestone: 'screen M21', schema: S.bool({ label: 'Maintenance on' }), def: false },
    'pdp.bundle': { area: 'Access', layer: 'factory', label: 'Policy bundle', schemaName: 'PolicyBundle', registeredBy: 'registerPdpConfig', readBy: 'core, bff (every PDP)', desc: 'The Cedar policies generated from the role catalogue. Roles, actions and gate policies are code; a new PDP_POLICY_VERSION is released by PR and then published as a bundle through a factory M1 (proposeBundle, no portal route).', status: 'partial', milestone: 'view only; the bundle is built from code', readOnly: 'The bundle is generated from code (ROLE_CATALOGUE, ACTION_CATALOGUE, GATE_POLICIES). Change the code by PR, then the release proposes the bundle.', schema: S.fixed(), def: null },
    // decided, not built: shown in the pattern with propose locked, so the screen exists for the milestone that builds it
    'factory.m1_policy': { area: 'Factory rules', layer: 'factory', label: 'Who decides factory M1', planned: 'M15 (gap 1): no key is registered and nothing decides a factory revision yet; the seed decides its own (GenesisEligibility).', desc: 'Decided 2026-11-11 (PLAN §7a): by default a factory admin other than the proposer approves a factory revision. Which role decides, and whether it takes one or two people, is itself this setting, changed under this same approval.', status: 'missing', milestone: 'M15 (M15.5 META gates)',
      schema: S.obj({ deciding_role: S.enm(['factory.admin']), approvals: S.enm(['1', '2'], { help: 'Two means two different factory admins, neither the proposer.' }), proposer_may_decide: S.fixed({ help: 'Never: the proposer is always barred (own_request: blocked).' }) }), def: { deciding_role: 'factory.admin', approvals: '1', proposer_may_decide: false } },
    'onboarding.instruction_template': { area: 'Onboarding', layer: 'factory', label: 'Instruction file template (DEC-11)', planned: 'M16: the template is decided (PLAN §7a) but not built.', desc: 'What a repo’s AGENTS.md or CLAUDE.md may add (accepted) and what it never may (rejected). Card 2 checks each section against it. Factory rules and defaults always win; affirmed sections become fenced guidance, never control.', status: 'missing', milestone: 'M16',
      schema: S.obj({ accepted: S.list(S.str(), { label: (v) => v, add: () => 'new section kind' }), rejected: S.list(S.str(), { label: (v) => v, add: () => 'new section kind' }), on_rejected: S.fixed({ help: 'The factory proposes an edit to the file as a PR through X2 (a protected path).' }) }),
      def: { accepted: ['build and test commands', 'coding standards', 'architecture notes', 'conventions'], rejected: ['tools', 'permissions', 'network', 'rule overrides', 'secrets', 'merge or deploy steps'], on_rejected: 'X2 PR' } },
    'onboarding.sandbox_image': { area: 'Onboarding', layer: 'factory', label: 'Onboarding sandbox image (DEC-17)', planned: 'M16: the image is decided (PLAN §7a) but not built.', desc: 'The dedicated image the census probe runs in: scanners and common libraries baked in, each at an exact version and checksum, no internet. An image update is a reviewed config change. A repo’s own dependencies still come through the read-only package mirror.', status: 'missing', milestone: 'M16',
      schema: S.obj({ image_digest: S.str({ pattern: /^sha256:[0-9a-f]{64}$/ }), scanners: S.list(S.obj({ name: S.str(), version: S.str(), sha256: S.str({ pattern: /^[0-9a-f]{64}$/ }) }), { label: (v) => `${v.name} ${v.version}`, add: () => ({ name: 'scanner', version: '0.0.0', sha256: hx('new').slice(0, 64) }) }), network: S.fixed({ help: 'none: the probe runs with no internet' }) }),
      def: { image_digest: 'sha256:' + hx('onb-img-3'), scanners: [{ name: 'secret ruleset', version: 'rules v7', sha256: hx('srv7') }, { name: 'osv-scanner', version: '[PLACEHOLDER]', sha256: hx('osv') }, { name: 'licence scan', version: '[PLACEHOLDER]', sha256: hx('lic') }], network: 'none' } },
    'onboarding.exam': { area: 'Onboarding', layer: 'factory', label: 'Light and Full values (DEC-15, DEC-19)', planned: 'M16: accepted as written; each value stays a setting changeable by M1, no key yet.', desc: 'The numbers onboarding works to: the claims cap at Light, the intent questions, the Full exam and the per-area values.', status: 'missing', milestone: 'M16',
      schema: S.obj({ light_claims_max: S.int({ min: 1, max: 200 }), light_intent_questions: S.int({ min: 1, max: 50 }), full_golden_tasks: S.int({ min: 1, max: 200 }), claims_affirmed_min_pct: S.int({ min: 50, max: 100 }) }), def: { light_claims_max: 50, light_intent_questions: 15, full_golden_tasks: 20, claims_affirmed_min_pct: 90 } },
    'notifications.channels': { area: 'Notifications', layer: 'factory', label: 'Notification channels', planned: 'M18: notifier is an integration kind with no adapter; there is no notifier service yet.', desc: 'Where the factory sends notices (Slack, email), as rows of the integration registry of kind notifier, with a credential reference each. A notice carries ids and links only, never content above D0.', status: 'missing', milestone: 'M18',
      schema: S.list(S.obj({ channel_id: S.str({ pattern: SLUG }), adapter: S.enm(['slack (no adapter yet)', 'email (no adapter yet)']), target: S.str(), secret_ref: S.secret(), events: S.list(S.enm(['gate_opened', 'sla_missed', 'kill', 'quarantine', 'digest']), { label: (v) => v, add: () => 'gate_opened' }) }), { label: (v) => v.channel_id, add: () => ({ channel_id: 'new-channel', adapter: 'slack (no adapter yet)', target: '#channel', secret_ref: RT('slack-webhook'), events: ['gate_opened'] }) }),
      def: [{ channel_id: 'factory-alerts', adapter: 'slack (no adapter yet)', target: '#factory-alerts', secret_ref: RT('slack-factory-alerts'), events: ['kill', 'quarantine', 'sla_missed'] }, { channel_id: 'email-digest', adapter: 'email (no adapter yet)', target: 'per person', secret_ref: RT('smtp-relay'), events: ['digest', 'gate_opened'] }] },

    /* ---- project layer ---- */
    'project.role_map': { area: 'Project', layer: 'project', label: 'Role map', schemaName: 'RoleMap', registeredBy: 'registerCoreConfig (settings.ts)', readBy: 'core, identity (bindings generated), killswitch holders',
      desc: 'The ten slots of the project and who holds each. Bindings are generated from it; nobody edits a project binding directly. An empty slot means nobody can decide its gates. Only g4 may be the code owners on GitHub. Granting a slot that decides gates also needs an M6 approver grant.',
      status: 'exists', milestone: 'core exists; the bff PUT is missing (M14.6 or M16)',
      schema: S.map(S.oneof({ principals: S.obj({ principals: S.list(S.person(), { label: (v) => name(v), add: () => 'dn' }) }), codeowners: S.obj({}) }, { tag: 'kind' }), { keyLabel: 'slot', fixedKeys: true }),
      def: Object.fromEntries(ROLE_SLOTS.map((s) => [s, s === 'g4' ? { kind: 'codeowners' } : { kind: 'principals', principals: [] }])),
      rules: (d, ctx) => { const o = []; Object.entries(d).forEach(([s, v]) => { if (s !== 'g4' && v.kind === 'codeowners') o.push({ p: [s], m: 'only the g4 slot may be codeowners' }); if (v.kind === 'principals' && new Set(v.principals).size !== v.principals.length) o.push({ p: [s], m: 'duplicate principal' }); if (v.kind === 'principals' && !v.principals.length && ['admin', 'intent', 'design', 'x'].includes(s)) o.push({ level: 'warn', p: [s], m: `nobody holds ${s}: its gates cannot be decided` }); }); const head = A.cfg.inForce('project.role_map', ctx.scope).doc; ROLE_SLOTS.filter((s) => s !== 'requesters' && s !== 'kill').forEach((s) => { const add = ((d[s] || {}).principals || []).filter((p) => !((head[s] || {}).principals || []).includes(p)); if (add.length) o.push({ level: 'warn', m: `${add.map(name).join(', ')} gain${add.length === 1 ? 's' : ''} the ${s} slot: an approver grant also needs M6` }); if (add.includes(A.me())) o.push({ p: [s], m: 'you cannot grant yourself a slot: someone else proposes it' }); }); return o; } },
    'project.two_person': { area: 'Project', layer: 'project', label: 'Two-person rule', schemaName: 'TwoPerson', registeredBy: 'registerCoreConfig', readBy: 'decision kernel (planQuorum)', desc: 'X1, X2, E2 and M4 need two different approvers when two or more people hold the slot. A T2 project has it locked on.', status: 'exists', milestone: 'M14.6 or M16',
      schema: S.obj({ enabled: S.bool(), default: S.fixed(), locked_on: S.fixed({ help: 'Set by the tier: T2 locks it on.' }) }), def: { enabled: true, default: 'on_if_2plus', locked_on: false },
      rules: (d, ctx) => (tierOf(ctx.scope) === 'T2' && !d.enabled ? [{ p: ['enabled'], m: 'two-person is locked on at T2, so it cannot be disabled' }] : []) },
    'project.gating_profile': { area: 'Project', layer: 'project', label: 'Gating profile', schemaName: 'GatingProfile', registeredBy: 'registerCoreConfig', readBy: 'work engine (the lane profile bound at G0), gate-check',
      desc: 'Which optional human gates run, per toggle group and per lane. Off means absent, never auto-approved. G4, X1–X4, the E-gates, Q1 and M4 are floors with no switch. Items keep the profile they pinned at intake.',
      status: 'exists', milestone: 'M14.6 or M16',
      schema: S.obj({ gates: S.map(S.enm(['on', 'off']), { keyLabel: 'group', fixedKeys: true, labels: GROUP_LABEL }), schedule: S.enm(['auto', 'human'], { help: 'auto: 5.7 schedules; human: a person schedules each plan.' }), tier_floor_applied: S.fixed(), by_lane: S.map(S.map(S.enm(['on', 'off']), { keyLabel: 'group', labels: GROUP_LABEL, addKeys: GROUPS, add: () => 'off' }), { keyLabel: 'lane', addKeys: LANES, add: () => ({}), optional: true }) }),
      def: { gates: Object.fromEntries(GROUPS.map((g) => [g, 'on'])), schedule: 'auto', tier_floor_applied: false, by_lane: {} },
      rules: (d, ctx) => { const o = []; const t2 = tierOf(ctx.scope) === 'T2'; if (t2) { ['L4', 'L5', 'L6'].forEach((l) => ['g2', 'g3d', 'g3_g3s'].forEach((g) => { const v = (((d.by_lane || {})[l] || {})[g]) || d.gates[g]; if (v === 'off') o.push({ p: ['gates', g], m: `T2 floor: ${GROUP_LABEL[g]} cannot be off for ${l} (gatingFloorViolations)` }); })); if (deploysOf(ctx.scope) && d.gates.g5 === 'off') o.push({ p: ['gates', 'g5'], m: 'T2 floor: G5 cannot be off where the project deploys' }); } return o; } },
    'project.kill_delegations': { area: 'Project', layer: 'project', label: 'Kill delegations', schemaName: 'KillDelegation[]', registeredBy: 'registerCoreConfig', readBy: 'core; killswitch keeps its own table too (gap 11)', desc: 'People who may request a project or lane kill on behalf of the kill slot (DEC-29). Never a fleet kill. Lasts until revoked.', status: 'partial', milestone: 'one store decided in M19; screen M21',
      schema: S.list(S.obj({ delegate: S.person(), scope: S.obj({ kind: S.enm(['project', 'lane']), ref: S.str() }), granted_by: S.fixed(), granted_at: S.fixed(), revoked_at: S.str({ optional: true, placeholder: 'ISO time, or empty' }) }), { label: (v) => `${name(v.delegate)} · ${v.scope.kind} ${v.scope.ref}`, add: () => ({ delegate: 'ar', scope: { kind: 'lane', ref: 'L0' }, granted_by: A.me(), granted_at: new Date().toISOString().slice(0, 19) + 'Z', revoked_at: '' }) }), def: [] },
    'project.release': { area: 'Project', layer: 'project', label: 'Release (G5)', planned: 'M15 (M15.3 gate-relay): no key stores a G5 target; only Project.deploys exists.', desc: 'Chosen per project at card 4: off (merged is done), or a deploy target such as a GitHub environment, decided at G5. G5 applies only where it is on. Changing it later is an M1 config change.', status: 'missing', milestone: 'M15',
      schema: S.oneof({ off: S.obj({}), target: S.obj({ kind: S.enm(['github_environment']), environment: S.str({ placeholder: 'production' }) }) }, { tag: 'mode' }), def: { mode: 'off' } },
    'project.wip_limit': { area: 'Project', layer: 'project', label: 'WIP limit', planned: 'M15 (with admission): no key yet. Today the clamp control (Operate › Controls) caps items in flight.', desc: 'How many items may be in flight on the project at once (ADR-0003 §6: project admin, M1).', status: 'missing', milestone: 'M15', schema: S.int({ min: 1, max: 100, label: 'Items in flight' }), def: 12 },
    'project.default_envelope': { area: 'Project', layer: 'project', label: 'Default envelope', planned: 'M15: no key yet. Today budgetEnvelope comes from the coder contract and the catalogue lane default.', desc: 'The budget envelope a new item starts with, per lane (ADR-0003 §6: project admin, M1). Unit envelopes are split from it at 5.5.', status: 'missing', milestone: 'M15',
      schema: S.map(S.int({ min: 0, max: 1000000, help: 'cents' }), { keyLabel: 'lane', addKeys: LANES, add: () => 1500 }), def: { L0: 2000, L1: 1500, L2: 1500, L4: 4000, L5: 8000, L6: 12000, L7: 1000 } },
  };
  Object.entries(KEYS).forEach(([k, v]) => { v.key = k; });
  const AREAS = ['Sandboxes', 'Code host', 'Integrations', 'Models and routes', 'Factory rules', 'Access', 'Onboarding', 'Notifications', 'Project'];

  /* ================================================================ the record: revisions per layer (example data) */
  const ts = (d, t = '10:00') => `${d} ${t}`;
  const REG0 = [
    { integration_id: 'github', kind: 'code_host', adapter: 'github_app', display_name: 'GitHub, read-only App', config: { app_id: '812345', installation_id: 51234088, api_url: 'https://api.github.com' }, status: 'enabled', owner: 'lt', version: 3, credentials: [{ credential_id: 'app-key', secret_ref: RT('codehost-app-key.pem'), kind: 'app_key', rotated_at: '2026-10-02' }], scopes: [{ scope: 'read_repos', data_class_max: 'D2', forbidden: D11.slice() }] },
    { integration_id: 'github-push', kind: 'code_host', adapter: 'github_app', display_name: 'Push Broker App', config: { app_id: '812377', installation_id: 51234102, api_url: 'https://api.github.com' }, status: 'enabled', owner: 'lt', version: 2, credentials: [{ credential_id: 'app-key', secret_ref: RT('push-app-key.pem'), kind: 'app_key', rotated_at: '2026-10-28' }], scopes: [{ scope: 'apply_patch', data_class_max: 'D2', forbidden: D11.slice() }, { scope: 'pr_status', data_class_max: 'D1', forbidden: D11.slice() }] },
    { integration_id: 'github-gatecheck', kind: 'code_host', adapter: 'github_app', display_name: 'gate-check App (checks:write)', config: { app_id: '0', installation_id: 1, api_url: 'https://api.github.com' }, status: 'draft', owner: 'lt', version: 1, credentials: [{ credential_id: 'app-key', secret_ref: RT('gatecheck-app-key.pem'), kind: 'app_key' }], scopes: [{ scope: 'pr_status', data_class_max: 'D0', forbidden: D11.slice() }] },
    { integration_id: 'anthropic', kind: 'model_provider', adapter: 'anthropic', display_name: 'Anthropic', config: { base_url: 'https://api.anthropic.com' }, status: 'enabled', owner: 'lt', version: 4, credentials: [{ credential_id: 'api-key', secret_ref: RT('anthropic.key'), kind: 'api_key', rotated_at: '2026-11-01' }], scopes: [{ scope: 'chat_complete', data_class_max: 'D2', forbidden: D11.slice() }], provider: { tools_capable: true, streams: true, aws_only: false } },
    { integration_id: 'codex', kind: 'model_provider', adapter: 'openai_compat', display_name: 'Codex (OpenAI-compatible)', config: { base_url: 'https://codex.provider.example/v1' }, status: 'disabled', owner: 'oh', version: 2, credentials: [{ credential_id: 'api-key', secret_ref: RT('codex.key'), kind: 'api_key' }], scopes: [{ scope: 'chat_complete', data_class_max: 'D1', forbidden: D11.slice() }], provider: { tools_capable: true, streams: true, aws_only: false } },
    { integration_id: 'deepseek', kind: 'model_provider', adapter: 'openai_compat', display_name: 'DeepSeek (OpenAI-compatible)', config: { base_url: 'https://deepseek.provider.example/v1' }, status: 'draft', owner: 'oh', version: 1, credentials: [{ credential_id: 'api-key', secret_ref: RT('deepseek.key'), kind: 'api_key' }], scopes: [{ scope: 'chat_complete', data_class_max: 'D0', forbidden: D11.slice() }], provider: { tools_capable: false, streams: true, aws_only: false } },
    { integration_id: 'fake', kind: 'model_provider', adapter: 'fake', display_name: 'Fake provider (local and tests)', config: {}, status: 'enabled', version: 1, credentials: [], scopes: [{ scope: 'chat_complete', data_class_max: 'D2', forbidden: D11.slice() }], provider: { tools_capable: true, streams: true, aws_only: false } },
  ];
  const MODELS0 = [
    { model_id: 'claude-opus-5-5', provider_id: 'anthropic', provider_model: 'claude-opus-5-5', tools_capable: true, max_tokens_cap: 32000, usd_in_per_mtok: 0, usd_out_per_mtok: 0 },
    { model_id: 'claude-sonnet-5-5', provider_id: 'anthropic', provider_model: 'claude-sonnet-5-5', tools_capable: true, max_tokens_cap: 32000, usd_in_per_mtok: 0, usd_out_per_mtok: 0 },
    { model_id: 'claude-haiku-5-5', provider_id: 'anthropic', provider_model: 'claude-haiku-5-5', tools_capable: true, max_tokens_cap: 16000, usd_in_per_mtok: 0, usd_out_per_mtok: 0 },
    { model_id: 'codex', provider_id: 'codex', provider_model: '[PLACEHOLDER]', tools_capable: true, max_tokens_cap: 16000, usd_in_per_mtok: 0, usd_out_per_mtok: 0 },
    { model_id: 'fake-planning', provider_id: 'fake', provider_model: 'fake', tools_capable: true, max_tokens_cap: 8000, usd_in_per_mtok: 0, usd_out_per_mtok: 0 },
  ];
  const ROUTES0 = [
    { environment: 'local', data_class: 'D0', model_id: 'fake-planning' }, { environment: 'local', data_class: 'D1', model_id: 'fake-planning' }, { environment: 'local', data_class: 'D2', model_id: 'fake-planning' },
    { environment: 'staging', data_class: 'D0', model_id: 'claude-haiku-5-5' }, { environment: 'staging', data_class: 'D1', model_id: 'claude-sonnet-5-5' }, { environment: 'staging', data_class: 'D2', model_id: 'claude-sonnet-5-5' },
    { environment: 'prod', data_class: 'D0', model_id: 'claude-haiku-5-5' }, { environment: 'prod', data_class: 'D1', model_id: 'claude-sonnet-5-5' }, { environment: 'prod', data_class: 'D2', model_id: 'claude-sonnet-5-5' },
  ];
  const INSTALLS0 = [
    { install_id: 'gh-payments', integration_id: 'github', project_id: 'payments', enabled: true, overrides: { repos_allowed: ['acme/payments-api'] } },
    { install_id: 'gh-ledger', integration_id: 'github', project_id: 'ledger', enabled: true, overrides: {} },
    { install_id: 'gh-web', integration_id: 'github', project_id: 'web', enabled: true, overrides: {} },
    { install_id: 'gh-identity', integration_id: 'github', project_id: 'identity', enabled: true, overrides: {} },
    { install_id: 'anthropic-identity', integration_id: 'anthropic', project_id: 'identity', enabled: true, overrides: { models_allowed: ['claude-sonnet-5-5'] } },
  ];
  const RM = (o) => Object.fromEntries(ROLE_SLOTS.map((s) => [s, s === 'g4' ? { kind: 'codeowners' } : { kind: 'principals', principals: o[s] || [] }]));
  const GP0 = (o = {}) => ({ gates: Object.fromEntries(GROUPS.map((g) => [g, 'on'])), schedule: 'auto', tier_floor_applied: false, by_lane: { L1: { g2: 'off', g3d: 'off' }, L2: { g2: 'off', g3d: 'off' }, L3: { g2: 'off', g3d: 'off' } }, ...o });

  const L = {}; // layer id -> revisions[]
  const R = (layer, rev, at, proposer, decider, changes, o = {}) => { (L[layer] = L[layer] || []).push({ layer, rev, id: o.id || `${layer === 'factory' ? 'fac' : layer.split(':')[1]}-r${rev}`, at, proposer, decider, changes, state: o.state || 'published', ledger: o.ledger || null, reason: o.reason || '', hash: hx(layer + rev), parent: o.parent ?? rev - 1, ...o }); };
  R('factory', 1, ts('2026-09-01', '08:00'), 'seed', 'seed', { 'pdp.bundle': { version: 'pdp 1', roles: 'roles-1.0.0' }, 'gateway.models': MODELS0.filter((m) => m.provider_id === 'fake'), 'gateway.routes': ROUTES0.filter((r) => r.environment === 'local'), 'integrations.registry': REG0.filter((r) => r.adapter === 'fake') }, { ledger: 1204, reason: 'Genesis: the seed proposes and decides its own revision (GenesisEligibility).', genesis: true });
  R('factory', 4, ts('2026-09-20'), 'lt', 'oh', { 'integrations.registry': REG0.filter((r) => ['github', 'fake'].includes(r.integration_id)), 'integrations.installs': INSTALLS0.slice(0, 2) }, { ledger: 9120, reason: 'Read-only GitHub App for the first projects.' });
  R('factory', 9, ts('2026-10-12'), 'lt', 'oh', { 'sandbox.caps': { total: 3, coding: 1, hosts: {} } }, { ledger: 14377, reason: 'Start with three sessions per host.' });
  R('factory', 11, ts('2026-10-14'), 'oh', 'lt', { 'gateway.models': MODELS0, 'integrations.registry': REG0.filter((r) => !['github-gatecheck', 'deepseek'].includes(r.integration_id)), 'gateway.routes': ROUTES0.map((r) => (r.environment === 'prod' && r.data_class === 'D2' ? { ...r, model_id: 'claude-opus-5-5' } : r)) }, { ledger: 15102, reason: 'Anthropic provider and the staging and prod routes.' });
  R('factory', 12, ts('2026-10-20'), 'lt', 'oh', { 'factory.constitution': { version: 2, rules: [{ kind: 'no_unapproved_egress', rule_id: 'C-EGRESS', title: 'No new external network egress without an approval reference', allow_hosts: ['api.stripe.com', 'hooks.slack.com'] }, { kind: 'migrations_reversible_or_flagged', rule_id: 'C-MIGRATION', title: 'Migrations are reversible, or flagged irreversible' }] } }, { ledger: 17520, reason: 'Allow the card network and the Slack webhook host.' });
  R('factory', 14, ts('2026-10-30'), 'lt', 'oh', { 'sandbox.caps': { total: 4, coding: 1, hosts: {} } }, { ledger: 18011, reason: 'Back to the default of four sessions per host.' });
  R('factory', 16, ts('2026-11-04'), 'lt', 'oh', { 'sandbox.exec_allowed_repos': ['acme/payments-api', 'acme/ledger-svc', 'acme/web-checkout', 'acme/identity-hub'], 'integrations.installs': INSTALLS0 }, { ledger: 18102, reason: 'DEC-18 after SEC-OB-3: the owner’s repos may run code.' });
  R('factory', 17, ts('2026-11-06'), 'oh', 'lt', { 'integrations.registry': REG0 }, { ledger: 18190, reason: 'gate-check App row as draft; DeepSeek as draft for evals.' });
  R('factory', 18, ts('2026-11-10', '09:58'), 'oh', 'lt', { 'gateway.routes': ROUTES0 }, { ledger: 18418, reason: 'prod D2 back to Sonnet: A3 is the only agent whose contract allows Opus.' });
  R('factory', 19, ts('2026-11-11', '16:20'), 'lt', 'oh', { 'codehost.merge_bypass': { 'acme/payments-api': [{ login: 'arivera', principal_id: 'ar' }], 'acme/ledger-svc': [] } }, { ledger: 18419, reason: 'Alex can merge a failed-check PR on Payments API in an incident; every such merge gets an X4 review.' });
  R('factory', 20, ts('2026-11-12', '09:40'), 'lt', null, { 'sandbox.exec_allowed_repos': ['acme/payments-api', 'acme/ledger-svc', 'acme/web-checkout', 'acme/identity-hub', 'acme/mobile-app'] }, { state: 'pending', reason: 'Mobile App is onboarding: its census build and test probe needs container execution.' });
  ['payments', 'ledger', 'web', 'identity'].forEach((p) => {
    const rm = { payments: RM({ admin: ['rb'], requesters: ['pm', 'dn', 'ak'], intent: ['ar', 'pm'], design: ['ar', 'rb'], g5: ['pm'], x: ['jm', 'so'], sec: ['ks'], m4: ['pm', 'rb'], kill: ['rb'] }), ledger: RM({ admin: ['so'], requesters: ['dn', 'ak'], intent: ['so'], design: ['so'], x: ['jm'], sec: ['ks'], m4: ['so', 'rb'], kill: ['so'] }), web: RM({ admin: ['mw'], requesters: ['mw'], intent: ['mw'], design: ['mw'], sec: ['ks'], m4: ['mw'], kill: ['mw'] }), identity: RM({ admin: ['ks'], requesters: ['ks'], intent: ['ks'], design: ['ks'], x: ['ks'], sec: ['ks'], m4: ['ks'], kill: ['ks', 'oh'] }) }[p];
    const t2 = tierOf(p) === 'T2';
    R('project:' + p, 1, ts('2026-10-02'), { payments: 'pm', ledger: 'so', web: 'mw', identity: 'ks' }[p], { payments: 'pm', ledger: 'so', web: 'mw', identity: 'ks' }[p], { 'project.role_map': rm, 'project.two_person': { enabled: true, default: 'on_if_2plus', locked_on: t2 }, 'project.gating_profile': GP0({ tier_floor_applied: t2 }), 'project.kill_delegations': [] }, { ledger: 9800 + p.length, reason: 'Card 4 at onboarding (bootstrap decider).', bootstrap: true });
  });
  R('project:payments', 6, ts('2026-11-04', '12:10'), 'rb', 'pm', { 'project.gating_profile': GP0({ by_lane: { L1: { g2: 'off', g3d: 'off' }, L2: { g2: 'off', g3d: 'off' }, L3: { g2: 'off', g3d: 'off' }, L0: { g3_g3s: 'off' } } }), 'project.kill_delegations': [{ delegate: 'ar', scope: { kind: 'lane', ref: 'L0' }, granted_by: 'rb', granted_at: '2026-11-04T12:10:00Z', revoked_at: '' }] }, { ledger: 18010, reason: 'Hotfixes skip G3; Alex may kill the hotfix lane.' });
  R('project:payments', 7, ts('2026-11-12', '09:30'), 'lt', null, { 'project.gating_profile': GP0({ by_lane: { L1: { g2: 'off', g3d: 'off', g6: 'off' }, L2: { g2: 'off', g3d: 'off', g6: 'off' }, L3: { g2: 'off', g3d: 'off', g6: 'off' }, L0: { g3_g3s: 'off' } } }) }, { id: 'cfg-r7', state: 'pending', reason: 'Small changes do not need the requester’s acceptance: G6 off for L1–L3.' });

  /* ================================================================ reads */
  const layerOf = (key, scope) => (KEYS[key].layer === 'factory' ? 'factory' : 'project:' + scope);
  const revs = (layer) => L[layer] || [];
  const inForce = (key, scope) => {
    const k = KEYS[key]; if (!k) return { doc: null, rev: null, source: 'unknown' };
    const pub = revs(layerOf(key, scope)).filter((r) => r.state === 'published' && key in r.changes).sort((a, b) => b.rev - a.rev)[0];
    return pub ? { doc: clone(pub.changes[key]), rev: pub, source: k.layer } : { doc: clone(k.def), rev: null, source: 'default' };
  };
  const pendingOf = (layer) => revs(layer).find((r) => r.state === 'pending') || null;
  const headRev = (layer) => revs(layer).filter((r) => r.state === 'published').reduce((m, r) => Math.max(m, r.rev), 0);
  const historyOf = (key, scope) => revs(layerOf(key, scope)).filter((r) => key in r.changes).sort((a, b) => b.rev - a.rev);
  const revById = (id) => Object.values(L).flat().find((r) => r.id === id) || null;
  const projOfRev = (r) => (r.layer === 'factory' ? 'factory' : r.layer.split(':')[1]);

  /* ================================================================ who may propose and who decides */
  const resOf = (key, scope) => (KEYS[key].layer === 'factory' ? FLEET : { type: 'Project', project: scope });
  const proposeAction = (key) => (KEYS[key].layer === 'factory' ? 'config.propose' : 'project.settings.edit');
  const canRead = (key, scope) => (KEYS[key].layer === 'factory' ? A.can('config.propose', FLEET) || A.can('audit.read', FLEET) : A.canSeeProject(scope));
  const factoryAdmins = () => [...new Set(X.BINDINGS.filter((b) => !b.revoked && b.role === 'factory.admin' && b.scope.kind === 'fleet').map((b) => b.pid))];
  const projectAdmins = (p) => [...new Set(X.BINDINGS.filter((b) => !b.revoked && b.role === 'project.admin' && b.scope.kind === 'project' && b.scope.ref === p).map((b) => b.pid))];
  /** deciders of the M1 of a revision: factory = a factory admin other than the proposer (PLAN §7a, not built); project = the admin slot */
  const m1Check = (rev, pid = A.me()) => {
    const project = projOfRev(rev); const factory = project === 'factory';
    const pool = factory ? factoryAdmins() : projectAdmins(project);
    const eligible = pool.map((p) => ({ pid: p, via: factory ? 'factory.admin (fleet)' : 'project.admin', blocked: p === rev.proposer ? 'proposer: blocked' : '' }));
    const rows = [];
    const mine = eligible.find((e) => e.pid === pid);
    rows.push(mine ? { ok: true, text: factory ? 'You are a factory admin. Factory M1 is decided by a factory admin other than the proposer (decided 2026-11-11).' : `You hold the admin slot on ${(A.project(project) || {}).name}.` } : { ok: false, text: factory ? 'Not your gate: a factory M1 is decided by a factory admin (factory.admin, fleet).' : `Not your gate: M1 on ${(A.project(project) || {}).name} is decided by its admin slot (project.admin).` });
    rows.push(rev.proposer === pid ? { ok: false, text: 'You proposed this revision. The proposer never decides its own M1 (own_request: blocked).' } : { ok: true, text: `Separation of duties: ${name(rev.proposer)} proposed it, not you.` });
    if (factory) rows.push({ ok: true, info: true, text: 'Built as decided, ahead of the code: today nothing decides a factory revision except the seed (portal-config §5 gap 1, M15).' });
    else if (eligible.filter((e) => !e.blocked).length === 1 && !eligible.some((e) => e.blocked)) rows.push({ ok: true, info: true, text: 'Only one person holds the slot: the entry is stamped sod_waiver (never at T2).' });
    rows.push({ ok: true, info: true, text: 'No step-up: GATE_POLICIES.M1.step_up is false.' });
    if (A.state.killed) rows.push({ ok: false, text: 'A kill is active: nothing can be approved until it is released.' });
    return { allow: rows.every((r) => r.ok || r.info), rules: rows, eligible, twoPerson: false, stepUp: false, project, slot: factory ? 'factory admin' : 'admin', why: { allow: !!mine } };
  };

  /* ================================================================ writes */
  let LEDGER_SEQ = 18431;
  const propose = (key, scope, doc, reason) => {
    const layer = layerOf(key, scope); const old = pendingOf(layer);
    if (old) { old.state = 'superseded'; old.supersededBy = true; }
    const n = Math.max(...revs(layer).map((r) => r.rev), 0) + 1;
    const head = headRev(layer);
    R(layer, n, `today ${new Date().toTimeString().slice(0, 5)}`, A.me(), null, { [key]: clone(doc) }, { state: 'pending', reason, parent: head });
    const r = revs(layer)[revs(layer).length - 1];
    register(r);
    return { rev: r, superseded: old };
  };
  const publish = (r, decider, outcome) => {
    r.decider = decider; r.ledger = LEDGER_SEQ++; r.state = outcome === 'approve' ? 'published' : outcome === 'changes' ? 'sent back' : 'rejected';
    if (r.state === 'published' && r.changes['integrations.registry']) r.changes['integrations.registry'].forEach((x) => { x.version = (x.version || 1); });
  };
  const register = (r) => { if (A.dcx) { A.dcx.KEY_PROJECT[r.id] = projOfRev(r); A.dcx.PROPOSER[r.id] = r.proposer; A.dcx.OPENED[`gate-M1-${r.id}`] = r.at.replace('today ', 'today '); A.dcx.DUE[`gate-M1-${r.id}`] = 60 * 24; } };

  /* ================================================================ diff (canonical JSON, sorted keys, line LCS) */
  const canon = (v) => { if (Array.isArray(v)) return v.map(canon); if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])); return v; };
  const lines = (v) => JSON.stringify(canon(v), null, 2).split('\n');
  const diffLines = (a, b) => {
    const n = a.length, m = b.length; const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < n && j < m) { if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++]]); else out.push(['+', b[j++]]); }
    while (i < n) out.push(['-', a[i++]]); while (j < m) out.push(['+', b[j++]]);
    return out;
  };
  const diffHtml = (key, a, b, { ctx = 2 } = {}) => {
    const d = diffLines(lines(a), lines(b)); const changed = d.some((x) => x[0] !== ' ');
    if (!changed) return { changed: false, html: `<div class="cf-diff empty">No change against what is in force. Edit a value to see the diff.</div>` };
    const keep = d.map((x, i) => x[0] !== ' ' || d.slice(Math.max(0, i - ctx), i + ctx + 1).some((y) => y[0] !== ' '));
    let html = `<div class="cf-diff" role="region" aria-label="Diff of ${E(key)}"><div class="cf-dh"># ${E(key)}</div>`; let gap = false;
    d.forEach((x, i) => { if (!keep[i]) { if (!gap) html += '<div class="cf-dl gap">…</div>'; gap = true; return; } gap = false; html += `<div class="cf-dl ${x[0] === '+' ? 'add' : x[0] === '-' ? 'del' : ''}"><span aria-hidden="true">${x[0]}</span>${E(x[1])}</div>`; });
    const adds = d.filter((x) => x[0] === '+').length, dels = d.filter((x) => x[0] === '-').length;
    return { changed: true, html: html + '</div>', adds, dels };
  };

  /* ================================================================ validation: generic walk + the key's rules */
  const walk = (s, v, path, out) => {
    if (!s) return;
    const absent = v === undefined || v === null || v === '';
    if (absent) { if (!s.optional && !['fixed', 'map', 'list', 'obj', 'bool'].includes(s.t)) out.push({ p: path, m: 'required' }); return; }
    if (s.t === 'int' || s.t === 'num') { if (typeof v !== 'number' || Number.isNaN(v)) out.push({ p: path, m: 'a number' }); else { if (s.t === 'int' && !Number.isInteger(v)) out.push({ p: path, m: 'a whole number' }); if (s.min != null && v < s.min) out.push({ p: path, m: `at least ${s.min}` }); if (s.max != null && v > s.max) out.push({ p: path, m: `at most ${s.max}` }); } }
    else if (s.t === 'str') { if (s.pattern && !s.pattern.test(v)) out.push({ p: path, m: s.patternMsg || 'not in the expected form' }); if (s.max && v.length > s.max) out.push({ p: path, m: `at most ${s.max} characters` }); if (s.url && !/^https:\/\/[a-z0-9.-]+(\/|$)/.test(v)) out.push({ p: path, m: 'an https URL' }); }
    else if (s.t === 'secret') { if (LOOKS_SECRET.test(v)) out.push({ p: path, m: 'this looks like a secret value: only a reference (file:/… or env:NAME) is accepted, and the value is never stored' }); else if (!SECRET_REF.test(v)) out.push({ p: path, m: 'a secret reference: file:/absolute/path or env:NAME' }); }
    else if (s.t === 'enum') { if (!s.options.includes(v)) out.push({ p: path, m: `one of ${s.options.join(', ')}` }); }
    else if (s.t === 'obj') Object.entries(s.fields).forEach(([k, f]) => walk(f, v[k], [...path, k], out));
    else if (s.t === 'list') { if (s.max && v.length > s.max) out.push({ p: path, m: `at most ${s.max}` }); v.forEach((x, i) => walk(s.of, x, [...path, i], out)); }
    else if (s.t === 'map') Object.entries(v).forEach(([k, x]) => { if (s.keyPattern && !s.keyPattern.test(k)) out.push({ p: [...path, k], m: `${s.keyLabel || 'key'} “${k}” is not in the expected form` }); walk(s.of, x, [...path, k], out); });
    else if (s.t === 'oneof') { const tag = s.tag || 'kind'; const c = s.cases[v[tag]]; if (!c) out.push({ p: path, m: `${tag} must be one of ${Object.keys(s.cases).join(', ')}` }); else walk(c, v, path, out); }
  };
  const validate = (key, scope, doc) => { const k = KEYS[key]; const out = []; walk(k.schema, doc, [], out); (k.rules ? k.rules(doc, { scope }) : []).forEach((x) => out.push(x)); return out.map((x) => ({ level: 'error', ...x })); };

  /* ================================================================ the form, built from the schema description */
  const pathAttr = (p) => E(JSON.stringify(p));
  const idOf = (p) => 'cf-' + p.map((x) => String(x).replace(/[^A-Za-z0-9]/g, '_')).join('-');
  const pretty = (k) => String(k).replace(/_/g, ' ');
  const errAt = (errs, p) => errs.filter((e) => e.p && JSON.stringify(e.p) === JSON.stringify(p));
  const fieldErr = (errs, p) => { const es = errAt(errs, p); return es.length ? `<div class="cf-err" role="alert">${J(es, (e) => `<span class="${e.level}">${E(e.m)}</span>`)}</div>` : ''; };
  const control = (s, v, p, dis, label) => {
    const id = idOf(p), a = `id="${id}" data-p="${pathAttr(p)}" data-t="${s.t}" ${dis ? 'disabled' : ''}`;
    if (s.t === 'bool') return `<label class="cf-sw"><input type="checkbox" ${a} ${v ? 'checked' : ''}><span>${v ? 'on' : 'off'}</span></label>`;
    if (s.t === 'int' || s.t === 'num') return `<input class="input cf-num" type="number" ${a} value="${v ?? ''}" ${s.min != null ? `min="${s.min}"` : ''} ${s.max != null ? `max="${s.max}"` : ''} ${s.t === 'num' ? 'step="0.01"' : ''} placeholder="${E(s.placeholder || '')}">`;
    if (s.t === 'enum') return `<select class="input" ${a}>${s.optional ? '<option value="">(not set)</option>' : ''}${J(s.options, (o) => `<option value="${E(o)}" ${o === v ? 'selected' : ''}>${E((s.labels || {})[o] || o)}</option>`)}</select>`;
    if (s.t === 'person') return `<select class="input" ${a}>${s.optional ? '<option value="">(nobody)</option>' : ''}${J(Object.values(D.PEOPLE), (pp) => `<option value="${pp.id}" ${pp.id === v ? 'selected' : ''}>${E(pp.name)}</option>`)}</select>`;
    if (s.t === 'secret') return `<div class="cf-secret"><span class="pill plain">reference</span><input class="input mono" type="text" autocomplete="off" spellcheck="false" ${a} value="${E(v ?? '')}" placeholder="file:/run/secrets/name"></div>`;
    if (s.t === 'fixed') return `<div class="cf-fixed mono small">${E(Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v ? JSON.stringify(v) : String(v ?? '—'))}</div>`;
    return `<input class="input ${s.mono !== false ? 'mono' : ''}" type="text" ${a} value="${E(v ?? '')}" placeholder="${E(s.placeholder || '')}" aria-label="${E(label || '')}">`;
  };
  const renderField = (s, v, p, errs, dis, label) => {
    const lab = label ?? pretty(p[p.length - 1] ?? '');
    if (s.t === 'obj') {
      const inner = J(Object.entries(s.fields), ([k, f]) => !(f.optional && (v == null || v[k] === undefined || v[k] === null)) ? renderField(f, v ? v[k] : undefined, [...p, k], errs, dis) : `<div class="cf-row opt"><span class="cf-l">${E(pretty(k))}</span><button type="button" class="btn ghost sm" data-setdef="${pathAttr([...p, k])}" ${dis ? 'disabled' : ''}>Set</button></div>`);
      return p.length ? `<fieldset class="cf-obj"><legend>${E(lab)}</legend>${s.help ? `<div class="cf-h">${E(s.help)}</div>` : ''}${inner}${fieldErr(errs, p)}</fieldset>` : inner + fieldErr(errs, p);
    }
    if (s.t === 'oneof') {
      const tag = s.tag || 'kind'; const cur = (v || {})[tag]; const c = s.cases[cur];
      const head = `<div class="cf-row"><label class="cf-l" for="${idOf([...p, tag])}">${E(pretty(tag))}</label><select class="input" id="${idOf([...p, tag])}" data-oneof="${pathAttr(p)}" ${dis ? 'disabled' : ''}>${J(Object.keys(s.cases), (o) => `<option ${o === cur ? 'selected' : ''}>${E(o)}</option>`)}</select></div>`;
      const body = c ? J(Object.entries(c.fields), ([k, f]) => renderField(f, (v || {})[k], [...p, k], errs, dis)) : '';
      return p.length ? `<fieldset class="cf-obj"><legend>${E(lab)}</legend>${head}${body}${fieldErr(errs, p)}</fieldset>` : head + body + fieldErr(errs, p);
    }
    if (s.t === 'list') {
      const arr = v || [];
      const rows = J(arr, (x, i) => {
        const simple = !['obj', 'oneof', 'list', 'map'].includes(s.of.t);
        if (simple) return `<div class="cf-li simple">${control(s.of, x, [...p, i], dis, `${lab} ${i + 1}`)}<button type="button" class="icon-btn" data-del="${pathAttr([...p, i])}" aria-label="Remove ${E(String(s.label ? s.label(x, i) : i + 1))}" ${dis ? 'disabled' : ''}>${A.icon('close', 14)}</button>${fieldErr(errs, [...p, i])}</div>`;
        return `<details class="cf-li" ${arr.length <= 3 || errs.some((e) => e.p && JSON.stringify(e.p.slice(0, p.length + 1)) === JSON.stringify([...p, i])) ? 'open' : ''}><summary><span>${E(String(s.label ? s.label(x, i) : `#${i + 1}`))}</span><span class="sp"></span><button type="button" class="btn ghost sm" data-del="${pathAttr([...p, i])}" ${dis ? 'disabled' : ''}>Remove</button></summary>${renderField(s.of, x, [...p, i], errs, dis, '')}</details>`;
      });
      return `<fieldset class="cf-obj cf-list"><legend>${E(lab)} <span class="faint small">${arr.length}${s.max ? ` of at most ${s.max}` : ''}</span></legend>${s.help ? `<div class="cf-h">${E(s.help)}</div>` : ''}${rows || '<div class="cf-h">None.</div>'}${s.add ? `<button type="button" class="btn sm" data-add="${pathAttr(p)}" ${dis ? 'disabled' : ''}>Add</button>` : ''}${fieldErr(errs, p)}</fieldset>`;
    }
    if (s.t === 'map') {
      const obj = v || {};
      const rows = J(Object.entries(obj), ([k, x]) => {
        const simple = !['obj', 'oneof', 'list', 'map'].includes(s.of.t);
        const kl = (s.labels || {})[k] || k;
        if (simple) return `<div class="cf-row"><label class="cf-l" for="${idOf([...p, k])}"><span class="mono">${E(k)}</span>${(s.labels || {})[k] ? `<span class="cf-sub">${E(s.labels[k])}</span>` : ''}</label>${control(s.of, x, [...p, k], dis, kl)}${s.fixedKeys ? '' : `<button type="button" class="icon-btn" data-del="${pathAttr([...p, k])}" aria-label="Remove ${E(k)}" ${dis ? 'disabled' : ''}>${A.icon('close', 14)}</button>`}${fieldErr(errs, [...p, k])}</div>`;
        return `<details class="cf-li" open><summary><span class="mono">${E(k)}</span><span class="sp"></span>${s.fixedKeys ? '' : `<button type="button" class="btn ghost sm" data-del="${pathAttr([...p, k])}" ${dis ? 'disabled' : ''}>Remove</button>`}</summary>${renderField(s.of, x, [...p, k], errs, dis, '')}</details>`;
      });
      const free = (s.addKeys || []).filter((k) => !(k in obj));
      const adder = s.fixedKeys || !s.add ? '' : s.addKeys ? (free.length ? `<div class="row" style="gap:6px"><select class="input cf-newkey" aria-label="New ${E(s.keyLabel || 'key')}" ${dis ? 'disabled' : ''}>${J(free, (k) => `<option value="${E(k)}">${E((s.labels || {})[k] || k)}</option>`)}</select><button type="button" class="btn sm" data-mapadd="${pathAttr(p)}" ${dis ? 'disabled' : ''}>Add ${E(s.keyLabel || 'key')}</button></div>` : '') : `<div class="row" style="gap:6px"><input class="input mono cf-newkey" placeholder="${E(s.keyLabel || 'key')}" aria-label="New ${E(s.keyLabel || 'key')}" ${dis ? 'disabled' : ''}><button type="button" class="btn sm" data-mapadd="${pathAttr(p)}" ${dis ? 'disabled' : ''}>Add</button></div>`;
      const body = `${s.help ? `<div class="cf-h">${E(s.help)}</div>` : ''}${rows || '<div class="cf-h">None.</div>'}${adder}${fieldErr(errs, p)}`;
      return p.length ? `<fieldset class="cf-obj"><legend>${E(lab)}</legend>${body}</fieldset>` : body;
    }
    return `<div class="cf-row"><label class="cf-l" for="${idOf(p)}">${E(s.label || lab)}${s.help ? `<span class="cf-sub">${E(s.help)}</span>` : ''}</label>${control(s, v, p, dis, lab)}${fieldErr(errs, p)}</div>`;
  };
  const getAt = (o, p) => p.reduce((x, k) => (x == null ? x : x[k]), o);
  const setAt = (o, p, v) => { if (!p.length) return v; const last = p[p.length - 1]; const par = getAt(o, p.slice(0, -1)); if (par != null) par[last] = v; return o; };
  const delAt = (o, p) => { const last = p[p.length - 1]; const par = getAt(o, p.slice(0, -1)); if (Array.isArray(par)) par.splice(last, 1); else if (par) delete par[last]; };
  const schemaAt = (s, p, doc) => { let cur = s; let val = doc; for (const k of p) { if (!cur) return null; if (cur.t === 'oneof') cur = cur.cases[(val || {})[cur.tag || 'kind']]; if (!cur) return null; if (cur.t === 'obj') cur = cur.fields[k]; else if (cur.t === 'list' || cur.t === 'map') cur = cur.of; val = val == null ? val : val[k]; } if (cur && cur.t === 'oneof') return cur; return cur; };
  const blank = (s) => { if (!s) return ''; if (s.t === 'list') return []; if (s.t === 'map') return {}; if (s.t === 'obj') return Object.fromEntries(Object.entries(s.fields).filter(([, f]) => !f.optional && f.t !== 'fixed').map(([k, f]) => [k, blank(f)])); if (s.t === 'oneof') { const k0 = Object.keys(s.cases)[0]; return { [s.tag || 'kind']: k0, ...blank(s.cases[k0]) }; } if (s.t === 'bool') return false; if (s.t === 'int' || s.t === 'num') return s.min ?? 0; if (s.t === 'enum') return s.options[0]; if (s.t === 'person') return 'dn'; if (s.t === 'secret') return 'file:/run/secrets/'; return ''; };

  /* ================================================================ read-only summaries (used on area pages) */
  const brief = (key, scope) => {
    const { doc } = inForce(key, scope); const k = KEYS[key];
    if (key === 'sandbox.caps') return `total ${doc.total} · coding ${doc.coding}${Object.keys(doc.hosts || {}).length ? ` · ${Object.keys(doc.hosts).length} host rows` : ''}`;
    if (key === 'project.role_map') return `${Object.values(doc).filter((v) => v.kind === 'codeowners' || v.principals.length).length} of 10 slots held`;
    if (key === 'project.gating_profile') return `${Object.entries(doc.gates).filter(([, v]) => v === 'off').map(([g]) => g).join(', ') || 'every group on'}${Object.keys(doc.by_lane || {}).length ? ` · ${Object.keys(doc.by_lane).length} lane overrides` : ''} · schedule ${doc.schedule}`;
    if (key === 'project.two_person') return `${doc.enabled ? 'on' : 'off'}${doc.locked_on ? ' (locked on, T2)' : ''}`;
    if (Array.isArray(doc)) return `${doc.length} row${doc.length === 1 ? '' : 's'}`;
    if (typeof doc === 'boolean') return doc ? 'on' : 'off';
    if (doc && typeof doc === 'object') return `${Object.keys(doc).length} entr${Object.keys(doc).length === 1 ? 'y' : 'ies'}`;
    return k.readOnly ? 'built from code' : String(doc);
  };
  const setBy = (key, scope) => {
    const f = inForce(key, scope);
    if (!f.rev) return `<span class="small muted">registry default · nothing published</span>`;
    const r = f.rev;
    const head = `${r.layer === 'factory' ? 'factory' : 'project'} r${r.rev}${r.ledger ? ' · ' + ledgerRef(r.ledger) : ''}`;
    return `<span class="small cf-lin"><span>${head}</span><span class="muted">${r.genesis ? 'seed (genesis)' : `${E(name(r.proposer))} → M1 ${E(name(r.decider))}`}</span></span>`;
  };
  const ledgerRef = (seq) => (seq ? (A.can('audit.read', FLEET) || A.can('audit.read', { type: 'Project', project: A.state.project }) ? `<a class="mono" href="#ledger">#${seq.toLocaleString('en-US')}</a>` : `<span class="mono">#${seq.toLocaleString('en-US')}</span>`) : '<span class="faint">—</span>');
  const href = (key, scope) => `#cfg-${key}${KEYS[key].layer === 'project' ? '@' + scope : ''}`;
  const statusPill = (k) => A.pill(k.planned ? 'not built: ' + k.milestone.split(' ')[0] : k.status === 'exists' ? 'backend exists' : k.status === 'partial' ? 'backend partial' : 'backend missing', k.planned ? 'warn' : k.status === 'exists' ? 'ok' : k.status === 'partial' ? 'info' : 'warn');
  /** a compact "setting card" for area screens: value in force, where it came from, pending, and the way into the pattern */
  const tile = (key, scope, o = {}) => {
    const k = KEYS[key]; const pend = pendingOf(layerOf(key, scope));
    const mine = pend && key in pend.changes;
    const tag = k.planned ? A.pill('backend ' + k.milestone.split(' ')[0], 'warn') : mine ? A.pill('change pending', 'gate') : '';
    return `<div class="cf-tile"><div class="cf-th"><div class="cf-tk">${E(o.label || k.label)}</div>${tag ? `<div class="cf-tt">${tag}</div>` : ''}</div><div class="mono tiny faint">${E(key)}</div>
      <div class="cf-tv">${o.value || E(brief(key, scope))}</div><div class="tiny">${k.planned ? `<span class="muted">${E(k.planned)}</span>` : setBy(key, scope)}</div>
      <div class="row" style="gap:8px;margin-top:4px"><a class="btn sm" href="${href(key, scope)}">${o.cta || (A.can(proposeAction(key), resOf(key, scope)) && !k.planned && !k.readOnly ? 'View and change' : 'View')}</a>${mine ? `<a class="btn sm ghost" href="#gate-M1-${pend.id}">M1 r${pend.rev}</a>` : ''}</div></div>`;
  };

  A.cfg = { KEYS, AREAS, S, L, inForce, pendingOf, historyOf, revById, projOfRev, layerOf, m1Check, propose, publish, register, validate, diffHtml, renderField, brief, setBy, tile, href, statusPill, resOf, proposeAction, canRead, factoryAdmins, projectAdmins, ledgerRef, tierOf, deploysOf, D11, GROUP_LABEL, ROLE_SLOTS, hx,
    _internal: { getAt, setAt, delAt, schemaAt, blank, clone, lines, canon } };
})();
