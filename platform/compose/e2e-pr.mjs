// Request to merged PR in a real browser against the running local-prod stack (see e2e-pr.sh; RC-E2E-2, RC-E2E-7).
// Plain Node, Playwright as a library; it exits non-zero with a message on the first thing that is not as expected.
//
// Every decision is made in the browser by the person whose slot decides it (the design personas; the testbed's role
// map is `personaRoleMap('payments')`):
//
//   lt (factory owner) asks for the Light onboarding of reshif/asf-factory-testbed and, as its bootstrap grantee,
//   decides card 1, card 2 (the instructions affirmed with a step-up, after the probe passed in a K-exec session),
//   card 4 (the role map of the personas, release off, two-person off at T0), the settings revision and card 5 (a
//   step-up) -> dn (requester) types a request on Ask for work -> S1 runs on the real planning port (the gateway's fake
//   answers with the testbed fixtures), dn says Ready -> G0/G1 by the intent slot (ar) -> S3/S5 -> G2, G3 by their
//   slot holders -> S6 in W sessions (A6 writes the oracle, the coder the implementation) -> S7 in the verify service
//   -> 7.6 the signed Evidence Pack -> 6.6 the Push Broker's commit on agent/<item>/<unit> and a Draft PR -> gate-check's
//   `aisdlc/gate` success -> G4 by the g4 slot (ar) -> a person merges on the fake GitHub -> the item closes.
// A non-holder (dn) is shown why not on each gate he cannot decide. The record, the ledger and the PR are checked.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const base =
  process.env.E2E_BASE_URL ?? `http://localhost:${process.env.AISDLC_BFF_PORT ?? '8640'}`;
const REPO = { owner: 'reshif', name: 'asf-factory-testbed' };
const REPO_REF = `${REPO.owner}/${REPO.name}`;
const PROJECT = 'testbed';
const composeDir = dirname(fileURLToPath(import.meta.url));
const T = Number(process.env.E2E_WAIT_MS ?? 300_000);
const started = Date.now();

// the dev IdP's subjects of the personas (services/bff/src/dev-oidc/personas.ts)
const SUBJECT = Object.fromEntries(
  ['lt', 'oh', 'rb', 'ar', 'pm', 'dn', 'ks', 'jm', 'mw', 'nf', 'tb'].map((p, i) => [
    p,
    `00000000-0000-4000-8000-${String(i + 3).padStart(12, '0')}`,
  ]),
);
// personaRoleMap('payments'): the testbed's role map
const ROLE_MAP = {
  admin: ['rb'],
  requesters: ['pm', 'dn'],
  intent: ['ar', 'pm'],
  design: ['rb', 'ar'],
  g4: ['ar'],
  g5: ['pm'],
  x: ['jm'],
  sec: ['ks'],
  m4: ['rb', 'pm'],
  kill: ['rb'],
};

const log = (m) => console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${m}`);
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = T) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    must(Date.now() < end, `timed out waiting for ${what}`);
    await sleep(1500);
  }
};

/** One SQL query on the record database, as the superuser (read only here). */
function sql(q) {
  const pw = readFileSync(join(composeDir, 'secrets/pg-superuser'), 'utf8').trim();
  return execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      '-e',
      `PGPASSWORD=${pw}`,
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'aisdlc',
      '-At',
      '-c',
      q,
    ],
    { cwd: composeDir, encoding: 'utf8' },
  ).trim();
}
const rows = (q) => sql(q).split('\n').filter(Boolean);

/** A call to the fake GitHub's API, from inside its container (it listens on the codehost's loopback). */
function github(method, path, auth, body) {
  const script = `
    const r = await fetch('http://127.0.0.1:8353' + process.env.P, { method: process.env.M,
      headers: { authorization: 'Bearer ' + process.env.A, 'content-type': 'application/json' },
      ...(process.env.B ? { body: process.env.B } : {}) });
    console.log(JSON.stringify({ status: r.status, json: await r.json() }));`;
  const out = execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      '-e',
      `P=${path}`,
      '-e',
      `M=${method}`,
      '-e',
      `A=${auth}`,
      '-e',
      `B=${body === undefined ? '' : JSON.stringify(body)}`,
      'fake-github',
      'node',
      '--input-type=module',
      '-e',
      script,
    ],
    { cwd: composeDir, encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').at(-1));
}

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const problems = [];
const noProblems = (where) =>
  must(
    problems.length === 0,
    `the browser reported problems at ${where}:\n  ${problems.join('\n  ')}`,
  );

/** A person signed in to the portal in a browser context of their own. */
async function personOf(who) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 1100 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  // a work-item gate card's page asks for an onboarding card first and is answered 404 (CardPage): expected
  let probes = 0;
  page.on('response', (r) => {
    if (r.status() === 404 && /\/api\/cards\/[0-9a-f-]{36}$/.test(r.url())) probes += 1;
  });
  page.on('console', (m) => {
    if (probes > 0 && /status of 404/.test(m.text())) {
      probes -= 1;
      return;
    }
    if (/status of 40[13]/.test(m.text())) return; // a guarded control asked and was told no: shown, not a fault
    if (/dev-oidc\.localhost/.test(page.url())) return; // the dev IdP's own page (its favicon), not the portal
    if (m.type() === 'error' || /Content Security Policy/i.test(m.text()))
      problems.push(`console (${who}, ${page.url()}): ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror (${who}): ${e.message}`));
  await page.goto(`${base}/`);
  await page.getByRole('link', { name: 'Sign in' }).first().click();
  await page.waitForURL(/dev-oidc\.localhost:\d+\/authorize/);
  await page.locator('select[name=dev_user]').selectOption(SUBJECT[who]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
  const csrf = async () => (await (await context.request.get(`${base}/api/me`)).json()).csrf_token;
  const p = {
    who,
    context,
    page,
    csrf,
    /** the dev IdP again, for a step-up (the same person) */
    async reSignIn() {
      await page.waitForURL(/dev-oidc\.localhost:\d+\/authorize/);
      await page.locator('select[name=dev_user]').selectOption(SUBJECT[who]);
      await page.getByRole('button', { name: 'Sign in' }).click();
    },
    async api(path) {
      const r = await context.request.get(`${base}${path}`);
      return r.status() === 200 ? r.json() : null;
    },
    /** what the main region says, for a failure message */
    async text() {
      const d = page.getByRole('region', { name: 'Decision' });
      const where = (await d.count()) > 0 ? d.first() : page.locator('main');
      return (await where.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 1500);
    },
  };
  log(`${who} signed in`);
  return p;
}

/** Clicks a decision button once the form allows it; else fails with what the form says is missing. */
const press = async (p, name, what = name) => {
  const b = p.page.getByRole('button', { name, exact: true });
  await until(async () => b.isEnabled(), `${what} to be enabled`, 30_000).catch(async (e) => {
    throw new Error(`${e.message}: ${await p.text()}`);
  });
  await b.click();
};

const formReady = async (page) => {
  await page.getByRole('region', { name: 'Decision' }).waitFor();
  await page.waitForFunction(
    () => !/Getting the decision form ready/.test(document.body.innerText),
  );
};

/** Every card id the item's gates were opened on, by gate, oldest first (from the record). */
function cardsOf(itemId) {
  const byGate = {};
  for (const line of rows(
    `SELECT body::text FROM record.record_event WHERE stream = 'item:${itemId}' AND type = 'item.gates_opened' ORDER BY seq`,
  )) {
    const b = JSON.parse(line);
    const p = b.payload ?? b;
    // one card per gate, in the order of the gates (a card may carry several when they were opened as one)
    for (const [i, g] of (p.gates ?? []).entries())
      (byGate[g.gate] ??= []).push(p.card_ids[i] ?? p.card_ids[0]);
  }
  return byGate;
}

try {
  // ---------------------------------------------------------------------------------------------- the onboarding
  const lt = await personOf('lt');
  const page = lt.page;
  // resumable on a kept stack (E2E_KEEP): the onboarding of a run before is picked up where it is
  let s0Id = rows(
    `SELECT s0_id FROM core.s0_record WHERE status <> 'withdrawn' ORDER BY s0_id DESC LIMIT 1`,
  )[0];
  if (!s0Id) {
    await page.getByRole('link', { name: 'Onboard a repo' }).first().click();
    await page.getByLabel('Repository owner').fill(REPO.owner);
    await page.getByLabel('Repository name').fill(REPO.name);
    await page.getByLabel('Project slug').fill(PROJECT);
    await page.getByLabel('Light', { exact: true }).check();
    await page.getByRole('button', { name: 'Request onboarding' }).click();
    await page.waitForURL(/\/s0\/[0-9a-f-]{36}$/);
    s0Id = page.url().split('/').pop();
    log(`lt asked for the Light onboarding of ${REPO_REF} in the wizard: s0 ${s0Id}`);
  } else log(`the onboarding s0 ${s0Id} is already there: going on from where it is`);
  const s0Url = `${base}/s0/${s0Id}`;

  const stepState = async (step) => {
    await page.goto(s0Url);
    await page.locator(`[data-step="${step}"]`).waitFor();
    return page.locator(`[data-step="${step}"]`).getAttribute('data-state');
  };
  const waitStep = async (step, states) => {
    let last = '';
    return until(
      async () => {
        const s = await stepState(step);
        if (s !== last) {
          log(`step ${step} is ${s}`);
          last = s;
        }
        return states.includes(s) ? s : null;
      },
      `step ${step} to be ${states.join(' or ')}`,
    );
  };
  const openCard = async (label) => {
    const link = page.getByRole('link', { name: `Card ${label}` });
    await until(async () => {
      await page.goto(s0Url);
      await page.waitForLoadState('networkidle');
      return (await link.count()) > 0;
    }, `card ${label} to open`);
    await link.last().click();
    await page.getByRole('heading', { level: 1 }).waitFor();
  };
  /** The step-up at the dev IdP (bound to what the card shows), then back on the card with the form ready. */
  const stepUp = async (p) => {
    await p.page.getByRole('button', { name: 'Confirm my identity' }).click();
    await p.reSignIn();
    await p.page.waitForURL(/\/cards\/[0-9a-f-]{36}/);
    await p.page.getByTestId('stepup-ready').waitFor();
    await formReady(p.page);
  };

  // card 1: the census, the tier, the gaps
  if ((await waitStep('0.1', ['card', 'done'])) === 'card') {
    await openCard('C1');
    await formReady(page);
    const gaps = page.locator('.gap');
    for (let i = 0; i < (await gaps.count()); i++) {
      const g = gaps.nth(i);
      const severity = (await g.locator('.badge').first().innerText()).trim();
      if (severity === 'blocking') await g.getByRole('radio', { name: /Fix now/ }).check();
      else if (await g.getByRole('radio', { name: /Fix later/ }).isEnabled())
        await g.getByRole('radio', { name: /Fix later/ }).check();
    }
    const t0 = page.getByLabel('no prod, no real data, no dependants');
    if ((await t0.count()) > 0) await t0.check();
    const reg = page.getByLabel(/no regulatory obligation/);
    if ((await reg.count()) > 0) await reg.check();
    const crit = page.getByLabel(/I attest the criticality/);
    if ((await crit.count()) > 0) await crit.check();
    await press(lt, 'Approve card 1');
    await page.getByTestId('receipt').waitFor();
    log('card 1 approved by lt');
  }

  // card 2: the probe ran in a K-exec session (the onboarding image), LF3, LF4 and LF8 met; the claims, the questions,
  // the instruction text affirmed with a step-up
  if ((await waitStep('0.2', ['card', 'done'])) === 'card') {
    await openCard('C2');
    await until(async () => {
      await page.reload();
      await formReady(page);
      const floors = (await page.getByRole('table', { name: 'Light floors' }).innerText()).replace(
        /\s+/g,
        ' ',
      );
      return ['LF3', 'LF4', 'LF8'].every((f) =>
        new RegExp(`${f}:[^—]*\\smet\\s`).test(`${floors} `),
      )
        ? floors
        : null;
    }, 'LF3 (the onboarding probe), LF4 and LF8 to be met');
    log(
      'card 2: LF3 (the probe passed in the K-exec sandbox), LF4 (SP-STD-1 on the W image) and LF8 met',
    );
    const fill = async () => {
      const radios = page.getByRole('radio', { name: 'True', exact: true });
      for (let i = 0; i < (await radios.count()); i++) await radios.nth(i).check();
      const answers = page.locator('textarea[id^="intent-"], textarea[id^="prac-"]');
      for (let i = 0; i < (await answers.count()); i++) {
        const a = answers.nth(i);
        if ((await a.inputValue()).trim() === '')
          await a.fill('A throwaway testbed: one function and its test; nothing depends on it.');
      }
      const att = page.getByLabel('These answers describe how this repository is worked on.');
      if (!(await att.isChecked())) await att.check();
    };
    await fill();
    await stepUp(lt);
    await fill();
    const affirm = page.getByRole('button', { name: 'Affirm (with the step-up)' });
    await until(async () => affirm.isEnabled(), 'card 2 to be ready to affirm', 30_000).catch(
      async (e) => {
        throw new Error(`${e.message}: ${await lt.text()}`);
      },
    );
    await affirm.click();
    await page.getByTestId('receipt').waitFor();
    log('card 2 affirmed by lt (step-up bound to the affirmed instruction files)');
  }

  // card 4: controls, attestations, the personas' role map, release off, two-person off
  if ((await waitStep('0.4', ['card', 'done'])) === 'card') {
    await openCard('C4');
    await formReady(page);
    // what the controls report says of the fake testbed's settings: everything met (a report read before a settings
    // change is read again with the card's own Re-check)
    await until(
      async () => {
        const open = await page.locator('[data-control][data-status="not_met"]').count();
        if (open === 0) return true;
        log(`card 4: ${open} control(s) not met; Re-check`);
        await page.getByRole('button', { name: 'Re-check' }).click();
        await sleep(5000);
        await page.reload();
        await formReady(page);
        return false;
      },
      'card 4 controls to be met',
      90_000,
    );
    for (const t of [
      'operations.md is in place and describes how this project is run',
      'the bypass list has no factory App',
      /installed on selected repositories only/,
      'the default GITHUB_TOKEN is read-only',
      '“Actions may create/approve PRs” is off',
      'fork-PR approval is required',
      /secret scanning and push protection are on where the plan allows/,
    ]) {
      const box = page.getByLabel(t);
      if ((await box.count()) > 0) await box.check();
    }
    // the plan: a private repo on Free cannot enforce rulesets, so the factory could not write to it at Light
    const plan = page.getByLabel('Team', { exact: true });
    if ((await plan.count()) > 0) await plan.check();
    const owners = page.getByRole('checkbox', { name: /^g4:/ });
    if (await owners.isChecked()) await owners.uncheck();
    for (const [slot, people] of Object.entries(ROLE_MAP)) {
      await page.getByRole('textbox', { name: new RegExp(`^${slot}:`) }).fill(people.join(', '));
    }
    const two = page.getByLabel(/Require a second person/);
    if (await two.isChecked()) await two.uncheck();
    await page.getByRole('radio', { name: 'Off: this project does not release' }).check();
    await press(lt, 'Approve card 4');
    await page.getByTestId('receipt').waitFor();
    log(`card 4 approved by lt: role map ${JSON.stringify(ROLE_MAP)}, release off`);
  }

  // the settings revision card 4 proposed, decided by lt (the provisional admin) and published
  if ((await stepState('0.5')) !== 'done') {
    const revLink = page.getByRole('link', { name: 'Decide the settings revision' });
    const pending = await until(async () => {
      await page.goto(s0Url);
      await page.waitForLoadState('networkidle');
      if ((await revLink.count()) > 0) return 'pending';
      return (await page.getByRole('link', { name: 'Card C5' }).count()) > 0 ? 'published' : null;
    }, 'the settings revision to be pending');
    if (pending === 'pending') {
      await revLink.click();
      await page.getByRole('heading', { level: 1, name: 'Settings revision pending' }).waitFor();
      const approveRev = page.getByRole('button', { name: 'Approve and publish these settings' });
      await until(async () => approveRev.isEnabled(), 'the revision decision form');
      await approveRev.click();
      await page.getByTestId('receipt').waitFor();
      log('the settings revision decided and published by lt');
    }
    // card 5: the sign-off of the readiness record and M4, by their slot holders now that the role map is published:
    // rb holds admin (the sign-off) and m4. lt, the grantee who did the rest, is shown why not.
    await openCard('C5');
    const c5 = page.url();
    await page.getByTestId('c5-level').waitFor();
    const level = await page.getByTestId('c5-level').innerText();
    const lanes = (await page.getByTestId('c5-lanes').innerText()).replace(/\s+/g, ' ');
    log(`card 5 shows level "${level}", lanes "${lanes}"`);
    must(/light/i.test(level), `card 5 level is ${level}`);
    must(/L3/.test(lanes), `card 5 opens no agent lane (L1-L3): ${lanes}`);
    await page.getByTestId('not-decidable').waitFor();
    log(
      `card 5: lt is told "${(await page.getByTestId('not-decidable').innerText()).replace(/\s+/g, ' ')}"`,
    );
    const rb = await personOf('rb');
    await rb.page.goto(c5);
    await rb.page.getByTestId('c5-level').waitFor();
    await formReady(rb.page);
    await rb.page.getByLabel(/I have read this readiness record/).check();
    await stepUp(rb);
    await rb.page.getByLabel(/I have read this readiness record/).check();
    await press(rb, 'Sign off and approve M4');
    const r5 = rb.page.getByTestId('receipt');
    await r5.waitFor();
    must(/M4: approved/.test(await r5.innerText()), 'card 5: no M4 approval in the receipt');
    log('card 5 signed off by rb (admin and m4) with a step-up: M4 approved');
  }
  await waitStep('0.5', ['done']);
  await until(
    async () => rows(`SELECT 1 FROM core.s0_record WHERE s0_id = '${s0Id}' AND status = 'done'`)[0],
    'the S0 record to be done',
  );
  log('the onboarding is done: the readiness record is active at Light');
  noProblems('the onboarding');

  // ---------------------------------------------------------------------------------------------- the request
  const dn = await personOf('dn');
  // E2E_NEW_ITEM=1: a new request even when an item is there (a kept stack whose item went wrong)
  let itemId =
    process.env.E2E_NEW_ITEM === '1'
      ? undefined
      : rows(`SELECT item_id FROM core.work_item ORDER BY item_id DESC LIMIT 1`)[0];
  if (!itemId) {
    await dn.page.goto(`${base}/ask-for-work/${PROJECT}`);
    await dn.page.getByTestId('ask-form').waitFor();
    await dn.page
      .getByLabel('Repo')
      .selectOption(REPO_REF)
      .catch(() => undefined);
    await dn.page
      .getByLabel('What do you need?')
      .fill('Add a farewell(name) function next to greet that says goodbye.');
    await dn.page.getByRole('button', { name: 'Send the request' }).click();
    await dn.page.getByTestId('ask-receipt').waitFor();
    await dn.page.getByRole('link', { name: 'Open the work item' }).click();
    await dn.page.waitForURL(/\/items\/[0-9a-f-]{36}$/);
    itemId = dn.page.url().split('/').pop();
    log(`dn typed the request on Ask for work: item ${itemId}`);
  } else log(`the item ${itemId} is already there: going on from where it is`);
  const itemUrl = `${base}/items/${itemId}`;
  const readItem = (p) => p.api(`/api/items/${itemId}`);
  const waitItem = (p, pred, what, ms = T) =>
    until(
      async () => {
        const v = await readItem(p);
        return v && pred(v) ? v : null;
      },
      what,
      ms,
    );

  // S1 on the real planning port; dn answers Ready (1.6)
  let item = await waitItem(
    dn,
    (v) =>
      v.waiting === 'human:ready' || v.gates.length > 0 || v.questions.some((q) => !q.answered),
    'S1 to reach the Ready decision',
  );
  if (item.waiting === 'human:ready') {
    log(`S1 ran on the planning port; proposed lane ${item.proposed_lane}`);
    must(
      item.proposed_lane === 'L3',
      `the small change should be routed to L3, not ${item.proposed_lane}`,
    );
    await dn.page.goto(itemUrl);
    await dn.page.getByRole('button', { name: 'Say it is ready' }).click();
    item = await waitItem(dn, (v) => v.waiting !== 'human:ready', 'the item to leave 1.6');
    log(`dn said Ready in the browser: the item now waits at ${item.waiting}`);
  }

  // the gates, each decided in the browser by its slot holder; dn (who holds none of them) is shown why not
  const people = { dn, lt };
  const holderOf = { G0: 'ar', G1: 'ar', G2: 'ar', G3: 'ar', G3s: 'ar', G4: 'ar' };
  const decided = new Set();
  const decideOnScreen = async (gate) => {
    const card = cardsOf(itemId)[gate]?.at(-1);
    must(card, `no card for ${gate}`);
    // a non-holder sees why not
    await dn.page.goto(`${base}/cards/${card}`);
    await dn.page.getByRole('heading', { level: 1 }).waitFor();
    const why = dn.page.getByTestId('not-decidable');
    await why.waitFor();
    log(`${gate}: dn is told "${(await why.innerText()).replace(/\s+/g, ' ').slice(0, 120)}"`);
    const who = holderOf[gate] ?? 'ar';
    people[who] ??= await personOf(who);
    const p = people[who];
    await p.page.goto(`${base}/cards/${card}`);
    await p.page.getByRole('heading', { level: 1 }).waitFor();
    const approve = p.page.getByRole('button', { name: 'Approve', exact: true });
    await until(
      async () => approve.isEnabled(),
      `${gate}: the decision form for ${who}`,
      60_000,
    ).catch(async (e) => {
      throw new Error(`${e.message}: ${await p.text()}`);
    });
    await approve.click();
    await p.page.getByTestId('receipt').waitFor();
    log(`${gate} approved in the browser by ${who} (card ${card})`);
  };
  const pendingGates = (v) => v.gates.filter((g) => g.status === 'pending').map((g) => g.gate);
  // until the item has a PR and G4 is pending: decide every planning gate that opens on the way
  // a card carries every gate opened together (G0 and G1, G3 and G3s): each card is decided once
  const openCards = (v) => {
    const by = cardsOf(itemId);
    const out = new Map();
    for (const g of pendingGates(v)) {
      const c = by[g]?.at(-1);
      if (c && !decided.has(c)) out.set(c, [...(out.get(c) ?? []), g]);
    }
    return out;
  };
  let lastWait = '';
  for (;;) {
    item = await waitItem(
      dn,
      (v) => {
        if (v.waiting !== lastWait) {
          log(`the item is at ${v.waiting}`);
          lastWait = v.waiting;
        }
        return (
          openCards(v).size > 0 ||
          v.handoff !== null ||
          ['G4', 'G6'].some((g) => pendingGates(v).includes(g)) ||
          v.terminal !== null
        );
      },
      'the next gate (or the PR)',
      Number(process.env.E2E_BUILD_WAIT_MS ?? 900_000),
    );
    must(
      item.handoff === null,
      `the item was handed off: ${JSON.stringify(item.handoff)} (waiting ${item.waiting})`,
    );
    if (['G4', 'G6'].some((g) => pendingGates(item).includes(g)) || item.terminal !== null) break;
    for (const [card, gates] of openCards(item)) {
      log(`card ${card}: ${gates.join(' and ')} pending`);
      await decideOnScreen(gates[0]);
      decided.add(card);
    }
  }
  // ------------------------------------------------------------------- S6, S7, 7.6 and the PR, as the record says
  const q1 = (q) => rows(q)[0];
  const pr = JSON.parse(
    q1(
      `SELECT row_to_json(p) FROM core.pull_request p WHERE item_id = '${itemId}' ORDER BY number DESC LIMIT 1`,
    ) ?? 'null',
  );
  must(pr, 'no pull request in core.pull_request');
  must(
    pr.head_ref === `agent/${itemId}/${pr.unit_key}`,
    `the PR's branch is ${pr.head_ref}, not agent/<item>/<unit>`,
  );
  log(`6.6: the Push Broker pushed ${pr.head_ref} at ${pr.head_sha} and opened PR #${pr.number}`);
  const done = (step) =>
    q1(
      `SELECT count(*) FROM record.record_event WHERE stream = 'item:${itemId}' AND type = 'item.stage_completed' AND body ->> 'step' = '${step}'`,
    );
  for (const step of [
    '6.1',
    '6.2',
    '6.3',
    '6.4',
    '6.5',
    '6.6',
    '7.1',
    '7.2',
    '7.3',
    '7.4',
    '7.5',
    '7.6',
  ])
    must(Number(done(step)) >= 1, `step ${step} was not completed`);
  const checks = rows(
    `SELECT result ->> 'step', result ->> 'verdict' FROM verify.check_result WHERE item_id = '${itemId}' AND head_sha = '${pr.head_sha}' ORDER BY 1`,
  );
  log(`S7 in the verify service, on the PR head: ${checks.join(', ')}`);
  for (const c of checks) must(c.endsWith('|passed'), `a check did not pass: ${c}`);
  const pack = JSON.parse(
    q1(
      `SELECT row_to_json(e) FROM core.evidence_pack e WHERE item_id = '${itemId}' AND head_sha = '${pr.head_sha}' AND passing ORDER BY produced_at DESC LIMIT 1`,
    ) ?? 'null',
  );
  must(pack, 'no passing Evidence Pack for the PR head');
  log(
    `7.6: the Evidence Pack ${pack.pack_sha256.slice(0, 16)} is signed (${pack.key_id}) and stored in ${pack.bucket}`,
  );
  const gh = github('GET', `/repos/${REPO_REF}/pulls/${pr.number}`, 'ghp_fake_reshif');
  must(gh.status === 200, `the fake GitHub does not have PR #${pr.number}: ${gh.status}`);
  // (a kept stack past the merge: the PR is merged already)
  must(
    (gh.json.draft === true && gh.json.state === 'open') || gh.json.merged === true,
    `PR #${pr.number} is not an open draft`,
  );
  // the Push Broker's bot: the factory App's in the two-App layout (e2e-pr.sh sets it as setup-github-apps does)
  const bot = process.env.E2E_BROKER_LOGIN || 'aisdlc[bot]';
  must(gh.json.user?.login === bot, `PR #${pr.number} is by ${gh.json.user?.login}, not ${bot}`);
  must(gh.json.head.sha === pr.head_sha, `the PR head on GitHub is ${gh.json.head.sha}`);
  log(
    `the fake GitHub: PR #${pr.number} is ${gh.json.merged ? 'merged' : 'an open draft'} by ${bot} at ${gh.json.head.sha.slice(0, 12)}`,
  );
  // gate-check looks at the PR as soon as the Push Broker opens it, before 7.6 signs the pack (`failure no_pack`, as its
  // spec says), and again on every pass: the check must turn to success for exactly this head
  const seen = new Set();
  const verdict = await until(() => {
    const v = q1(
      `SELECT outcome || ' ' || profile || ' ' || reason FROM gatecheck.verdict WHERE pr_number = ${pr.number} AND head_sha = '${pr.head_sha}' ORDER BY seq DESC LIMIT 1`,
    );
    if (v && !seen.has(v)) {
      seen.add(v);
      log(`aisdlc/gate on the head: ${v}`);
    }
    return v?.startsWith('success agent') ? v : null;
  }, 'gate-check to write aisdlc/gate success on the PR head');
  log(`gate-check wrote aisdlc/gate: ${verdict}`);

  // ------------------------------------------------------------------- G4 in the browser by the g4 slot (ar)
  const g4 = cardsOf(itemId)['G4']?.at(-1);
  must(g4, 'no G4 card');
  people.ar ??= await personOf('ar');
  const ar = people.ar;
  if (pendingGates(item).includes('G4')) {
    await dn.page.goto(`${base}/cards/${g4}`);
    await dn.page.getByRole('heading', { level: 1, name: 'Merge review' }).waitFor();
    await dn.page.getByTestId('deciders').waitFor();
    must(
      (await dn.page.getByRole('button', { name: 'Approve the merge', exact: true }).count()) ===
        0 ||
        (await dn.page
          .getByRole('button', { name: 'Approve the merge', exact: true })
          .isDisabled()),
      'dn (no g4 slot) may approve the merge',
    );
    log(
      `G4: dn is shown who decides: ${(await dn.page.getByTestId('deciders').innerText()).replace(/\s+/g, ' ').slice(0, 120)}`,
    );
    await ar.page.goto(`${base}/cards/${g4}`);
    await ar.page.getByRole('heading', { level: 1, name: 'Merge review' }).waitFor();
    await ar.page.getByTestId('subject-hash').waitFor();
    await ar.page.waitForFunction(
      () => !/Getting the decision form ready/.test(document.body.innerText),
    );
    await ar.page.getByLabel(/I have read/).check();
    await ar.page
      .getByLabel(/Reason \(required/)
      .fill('The pack is for exactly this head and every S7 step passed.');
    await press(ar, 'Approve the merge', 'G4: Approve the merge');
    await ar.page.getByTestId('decided').waitFor();
    log(
      `G4 approved in the browser by ar: ${(await ar.page.getByTestId('decided').innerText()).replace(/\s+/g, ' ').slice(0, 160)}`,
    );
  }

  // ------------------------------------------------------------------- a person merges on the fake GitHub
  await waitItem(dn, (v) => !pendingGates(v).includes('G4'), 'G4 to be decided');
  if (gh.json.merged !== true) {
    const ready = github(
      'POST',
      `/repos/${REPO_REF}/pulls/${pr.number}/ready_for_review`,
      'ghp_fake_reshif',
    );
    must(ready.status === 200, `ready for review: ${ready.status} ${JSON.stringify(ready.json)}`);
    const merged = github('PUT', `/repos/${REPO_REF}/pulls/${pr.number}/merge`, 'ghp_fake_reshif', {
      sha: pr.head_sha,
    });
    must(
      merged.status === 200 && merged.json.merged === true,
      `the merge: ${merged.status} ${JSON.stringify(merged.json)}`,
    );
    log(
      `reshif (a person, not the factory) merged PR #${pr.number} on the fake GitHub: ${merged.json.sha}`,
    );
  }

  // ------------------------------------------------------------------- G6 (acceptance) by a requester, then the item closes
  // the merge is observed by the factory (record first), S8 completes for exactly the approved head; release is off for
  // the testbed (card 4), so there is no S8b and no G5; G6 is the item's requester's (dn); ar is not one
  if ((await readItem(dn))?.terminal === null) {
    await waitItem(
      dn,
      (v) => pendingGates(v).includes('G6') || v.handoff !== null,
      'G6 to open after the merge',
    );
    const g6 = cardsOf(itemId)['G6']?.at(-1);
    must(g6, 'no G6 card');
    await ar.page.goto(`${base}/cards/${g6}`);
    await ar.page.getByRole('heading', { level: 1, name: 'Acceptance' }).waitFor();
    await ar.page.getByTestId('deciders').waitFor();
    must(
      (await ar.page.getByRole('button', { name: 'Accept', exact: true }).count()) === 0 ||
        (await ar.page.getByRole('button', { name: 'Accept', exact: true }).isDisabled()),
      'ar (not a requester) may accept',
    );
    log(
      `G6: ar is shown who decides: ${(await ar.page.getByTestId('deciders').innerText()).replace(/\s+/g, ' ').slice(0, 120)}`,
    );
    await dn.page.goto(`${base}/cards/${g6}`);
    await dn.page.getByRole('heading', { level: 1, name: 'Acceptance' }).waitFor();
    await dn.page.getByTestId('subject-hash').waitFor();
    await dn.page.waitForFunction(
      () => !/Getting the decision form ready/.test(document.body.innerText),
    );
    await dn.page.getByLabel(/I have read/).check();
    await dn.page
      .getByLabel(/Reason \(required/)
      .fill('farewell(name) says goodbye, as asked; merged.');
    await press(dn, 'Accept', 'G6: Accept');
    await dn.page.getByTestId('decided').waitFor();
    log(
      `G6 accepted in the browser by dn (the item's requester: the requesters slot decides G6 of its own item)`,
    );
  }
  const closed = await waitItem(
    dn,
    (v) => v.terminal !== null || v.handoff !== null,
    'the item to close after G6',
  );
  must(
    closed.handoff === null,
    `the item was handed off after the merge: ${JSON.stringify(closed.handoff)}`,
  );
  must(closed.terminal === 'Done', `the item ended ${JSON.stringify(closed.terminal)}`);
  log(`the item closed: terminal ${closed.terminal}, phase ${closed.phase}`);
  const merges = q1(
    `SELECT count(*) FROM record.record_event WHERE stream = 'item:${itemId}' AND type = 'item.merge_observed'`,
  );
  must(Number(merges) === 1, `item.merge_observed recorded ${merges} times`);
  const gm = q1(
    `SELECT count(*) FROM record.record_event WHERE type = 'gatecheck.merge_gated' AND body ->> 'item_id' = '${itemId}'`,
  );
  must(Number(gm) === 1, `gate-check recorded ${gm} gated merges of the item`);
  const rec = q1(
    `SELECT body ->> 'outcome' FROM record.record_event WHERE type = 'merge.reconciled' AND stream = 'merge:${itemId}' ORDER BY seq DESC LIMIT 1`,
  );
  must(rec === 'completed', `the merge was reconciled as ${rec}`);
  log(
    'gate-check recorded the merge as gated; core reconciled it as completed for the approved head; no X4',
  );
  const x4 = cardsOf(itemId)['X4'] ?? [];
  must(x4.length === 0, 'an X4 review was opened for the merge');
  noProblems('the end of the journey');
  log(`PASS in ${Math.round((Date.now() - started) / 1000)} s`);
} finally {
  await browser.close();
}
