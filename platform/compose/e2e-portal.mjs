// The portal in a real browser against the running local-prod stack (see e2e.sh): the whole Census
// onboarding of reshif/asf-factory-testbed, decided by a person in the browser (PLAN M8.1 to M8.4).
// Plain Node, no test runner: Playwright is used as a library, with no tracing, and the script exits
// non-zero with a message on the first thing that is not as expected.
//
//   alice requests the onboarding -> card 1 (gaps disposed, T0, regulatory, criticality) ->
//   card 4 (attestations, role map with alice in admin and m4, two-person off at T0) ->
//   the settings revision card 4 proposed is decided and published -> card 5 with a step-up
//   re-login at the dev IdP -> PRR active, repo level census, S0 done -> the PRR page and the
//   ledger page show it. Screenshots at deviceScaleFactor 2, accessibility checks on every page,
//   the strict CSP watched all along.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IDP_URL, idpSignIn } from './e2e-signin.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const base = process.env.E2E_BASE_URL ?? 'http://localhost:8340';
const shots = process.env.E2E_SCREENSHOT_DIR ?? 'docs/screenshots';
const REPO = { owner: 'reshif', name: 'asf-factory-testbed' };
const composeDir = dirname(fileURLToPath(import.meta.url));
const T = 240_000;

const log = (m) => console.log(`  ${m}`);
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
try {
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    viewport: { width: 1000, height: 1100 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const problems = [];
  page.on('console', (m) => {
    if (IDP_URL.test(page.url())) return; // the identity provider's own page, not the portal
    if (m.type() === 'error' || /Content Security Policy/i.test(m.text()))
      problems.push(`console (${page.url()}): ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  mkdirSync(shots, { recursive: true });

  const shot = async (name) => {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(shots, name), fullPage: true });
    log(`screenshot: ${join(shots, name)}`);
  };
  const noProblems = (where) =>
    must(
      problems.length === 0,
      `the browser reported problems at ${where}:\n  ${problems.join('\n  ')}`,
    );

  // Every field has a name, every control has a name, one h1, nothing is wider than the screen.
  const audit = async (p, where) => {
    const bad = await p.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('input,select,textarea')) {
        const named =
          (el.labels && el.labels.length > 0) ||
          el.getAttribute('aria-label') ||
          el.getAttribute('aria-labelledby');
        if (!named)
          out.push(`${el.tagName.toLowerCase()} ${el.name || el.id || el.type} has no label`);
      }
      for (const el of document.querySelectorAll('button,a')) {
        if (!el.textContent.trim() && !el.getAttribute('aria-label'))
          out.push('a control has no name');
      }
      const h1 = document.querySelectorAll('h1').length;
      if (h1 !== 1) out.push(`${h1} h1 headings`);
      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth + 1) {
        const wide = [...document.querySelectorAll('body *')]
          .filter((el) => el.getBoundingClientRect().right > root.clientWidth + 1)
          .slice(0, 4)
          .map(
            (el) =>
              `<${el.tagName.toLowerCase()} class="${el.className}"> ${Math.round(el.getBoundingClientRect().right)}px: ${el.textContent.trim().slice(0, 40)}`,
          );
        out.push(
          `the page scrolls sideways (${root.scrollWidth} > ${root.clientWidth}): ${wide.join(' | ')}`,
        );
      }
      return out;
    });
    must(bad.length === 0, `accessibility at ${where}: ${bad.join('; ')}`);
  };

  const until = async (fn, what, ms = T) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      must(Date.now() < end, `timed out waiting for ${what}`);
      await sleep(1000);
    }
  };

  // the IdP's page (Keycloak; the dev IdP with E2E_IDP=dev): sign in as alice
  const devSignIn = () => idpSignIn(page, 'alice', composeDir);

  // 1. The shell, signed out, under the strict policy.
  const first = await page.goto(`${base}/`);
  const csp = first.headers()['content-security-policy'] ?? '';
  must(
    csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'"),
    `no strict CSP: ${csp}`,
  );
  must(!/unsafe-inline|unsafe-eval/.test(csp), `CSP allows inline code: ${csp}`);
  await page.getByRole('link', { name: 'Sign in' }).first().click();
  log('signed out: clicked Sign in (bff /auth/login)');

  // 2. The identity provider (Keycloak): sign in as alice (the first person of the seed, a factory admin).
  await devSignIn();
  await page.waitForURL(`${base}/`);
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
  const who = await page.locator('.who-name').innerText();
  log(`signed in as ${who}`);
  must(/Alice/.test(who), `unexpected principal ${who}`);
  // The 401 of /api/me before sign-in is the browser logging a normal answer; from here on nothing may be reported.
  problems.length = 0;
  must(
    !/aisdlc_sid/.test(await page.evaluate(() => document.cookie)),
    'the session cookie is readable by script',
  );
  must(
    (await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))) ===
      '{}{}',
    'browser storage holds something',
  );

  // 3. The wizard.
  await page.getByRole('link', { name: 'Onboard a repo' }).first().click();
  await page.getByLabel('Repository owner').fill(REPO.owner);
  await page.getByLabel('Repository name').fill(REPO.name);
  await page.getByLabel('Project slug').fill('testbed');
  await page.getByLabel('Census').check();
  await page.getByRole('button', { name: 'Request onboarding' }).click();
  await page.waitForURL(/\/s0\/[0-9a-f-]{36}$/);
  const s0Url = page.url();
  const s0Id = s0Url.split('/').pop();
  log(`requested onboarding of ${REPO.owner}/${REPO.name}: ${s0Url}`);
  await page
    .getByRole('heading', { level: 1, name: `Onboarding of ${REPO.owner}/${REPO.name}` })
    .waitFor();

  const stepState = (step) => page.locator(`[data-step="${step}"]`).getAttribute('data-state');
  const waitStep = async (step, state) => {
    let last = '';
    await until(async () => {
      const s = await stepState(step);
      if (s !== last) {
        log(`step ${step} is ${s}`);
        last = s;
      }
      return s === state;
    }, `step ${step} to be ${state}`);
  };

  // 4. Card 1 opens by itself; the inbox lists it for alice, who may decide it.
  await waitStep('0.1', 'card');
  must((await stepState('0.2')) === 'skip', 'step 0.2 should be skipped at Census');
  await page.locator('[data-card="C1"]').waitFor();
  await page.getByRole('link', { name: 'Inbox' }).click();
  await page.getByRole('heading', { level: 1, name: 'Inbox' }).waitFor();
  const waiting = page.getByRole('list', { name: 'Waiting for you' });
  await waiting.getByRole('link', { name: 'Card 1: confirm the census' }).waitFor();
  must(
    (await waiting.locator('[data-label="C1"]').count()) === 1,
    'the inbox does not list card 1',
  );
  log(`inbox: ${(await waiting.innerText()).replace(/\s+/g, ' ').slice(0, 160)}`);
  await audit(page, 'the inbox');
  await shot('m8-inbox.png');

  // 5. Card 1: census, tier, gaps. Decide it.
  await waiting.getByRole('link', { name: 'Card 1: confirm the census' }).click();
  await page.getByRole('heading', { level: 1, name: 'Card 1: confirm the census' }).waitFor();
  await page.getByRole('region', { name: 'Decision' }).waitFor();
  await page.waitForFunction(
    () => !/Getting the decision form ready/.test(document.body.innerText),
  );
  const gapSets = page.locator('.gap');
  const nGaps = await gapSets.count();
  log(`card 1 lists ${nGaps} gaps`);
  for (let i = 0; i < nGaps; i++) {
    const g = gapSets.nth(i);
    const waive = g.getByRole('radio', { name: /Accept the risk/ });
    const severity = (await g.locator('.badge').first().innerText()).trim();
    if (severity === 'blocking') {
      must(await waive.isDisabled(), 'a blocking gap can be waived');
      await g.getByRole('radio', { name: /Fix now/ }).check();
    } else if (await g.getByRole('radio', { name: /Fix later/ }).isEnabled()) {
      await g.getByRole('radio', { name: /Fix later/ }).check();
    }
  }
  // Keyboard: from the tier radio, Tab reaches the T0 sentence, Space ticks it.
  const tierBox = page.getByLabel('no prod, no real data, no dependants');
  if ((await tierBox.count()) > 0) {
    await page.getByRole('radio', { name: /^T0/ }).focus();
    await page.keyboard.press('Tab');
    must(
      await tierBox.evaluate((el) => el === document.activeElement),
      'Tab from the tier does not reach the T0 attestation',
    );
    await page.keyboard.press('Space');
    must(await tierBox.isChecked(), 'Space did not tick the T0 attestation');
  } else {
    log('the floor is above T0: no T0 attestation asked');
  }
  const reg = page.getByLabel(/no regulatory obligation/);
  if ((await reg.count()) > 0) await reg.check();
  const crit = page.getByLabel(/I attest the criticality/);
  if ((await crit.count()) > 0) await crit.check();
  await audit(page, 'card 1');
  await shot('m8-c1.png');
  noProblems('card 1');
  await page.getByRole('button', { name: 'Approve card 1' }).click();
  const r1 = page.getByTestId('receipt');
  await r1.waitFor();
  log(`card 1 receipt: ${(await r1.innerText()).replace(/\s+/g, ' ').slice(0, 200)}`);
  must(/#\d+/.test(await r1.innerText()), 'no ledger sequence in the card 1 receipt');

  // 6. Card 4: controls, attestations, role map, two-person off at T0.
  await page.getByRole('link', { name: 'Onboarding record' }).click();
  await waitStep('0.4', 'card');
  await page.getByRole('link', { name: 'Card C4' }).click();
  await page.getByRole('heading', { level: 1, name: /Card 4/ }).waitFor();
  await page.getByRole('region', { name: 'Decision' }).waitFor();
  await page.waitForFunction(
    () => !/Getting the decision form ready/.test(document.body.innerText),
  );
  const open = await page.locator('[data-control][data-status="not_met"]').count();
  log(`card 4: ${open} controls not met`);
  must(open === 0, 'a control is not met on the fake GitHub testbed');
  for (const t of [
    'the bypass list has no factory App',
    /installed on selected repositories only/,
    'the default GITHUB_TOKEN is read-only',
    '“Actions may create/approve PRs” is off',
    'fork-PR approval is required',
    /secret scanning and push protection are on where the plan allows/,
  ]) {
    await page.getByLabel(t).check();
  }
  await page.getByLabel('Free', { exact: true }).check();
  await page.getByLabel(/^admin:/).fill('alice');
  await page.getByLabel(/^m4:/).fill('alice');
  // M14.6: bob decides the work item's gates (alice requests it, so she may not) and does its human-led work
  // g4 defaults to the code owners on GitHub (the testbed's are alice's login): bob is named instead
  const owners = page.getByRole('checkbox', { name: /^g4:/ });
  if (await owners.isChecked()) await owners.uncheck();
  for (const slot of ['intent', 'design', 'g4', 'x', 'sec']) {
    await page.getByRole('textbox', { name: new RegExp(`^${slot}:`) }).fill('bob');
  }
  const two = page.getByLabel(/Require a second person/);
  if (await two.isChecked()) await two.uncheck();
  await audit(page, 'card 4');
  await shot('m8-c4.png');
  noProblems('card 4');
  await page.getByRole('button', { name: 'Approve card 4' }).click();
  const r4 = page.getByTestId('receipt');
  await r4.waitFor();
  log(`card 4 receipt: ${(await r4.innerText()).replace(/\s+/g, ' ').slice(0, 160)}`);

  // 7. The settings revision card 4 proposed: decided by alice as the provisional admin, then published.
  await page.getByRole('link', { name: 'Onboarding record' }).click();
  const revLink = page.getByRole('link', { name: 'Decide the settings revision' });
  await until(async () => (await revLink.count()) > 0, 'the settings revision to be pending');
  await revLink.click();
  await page.getByRole('heading', { level: 1, name: 'Settings revision pending' }).waitFor();
  const roleRows = page.getByRole('table', { name: 'Role map' }).locator('tbody tr');
  must((await roleRows.count()) === 10, 'the role map does not list the ten slots');
  must(
    /alice/.test(await page.locator('[data-slot="m4"]').innerText()),
    'alice is not in the m4 slot',
  );
  const approveRev = page.getByRole('button', { name: 'Approve and publish these settings' });
  await until(async () => approveRev.isEnabled(), 'the revision decision form');
  await audit(page, 'the settings revision');
  await approveRev.click();
  const rr = page.getByTestId('receipt');
  await rr.waitFor();
  must(
    /published/.test(await rr.innerText()),
    `the revision was not published: ${await rr.innerText()}`,
  );
  log('settings revision decided and published');

  // 8. Card 5: appears once identity bound the role map; step-up re-login, then sign-off and M4.
  await page.getByRole('link', { name: 'Onboarding record' }).click();
  const c5Link = page.getByRole('link', { name: 'Card C5' });
  await until(async () => (await c5Link.count()) > 0, 'card 5 to open');
  await c5Link.click();
  await page.getByRole('heading', { level: 1, name: /Card 5/ }).waitFor();
  await page.getByTestId('c5-level').waitFor();
  const level = await page.getByTestId('c5-level').innerText();
  const lanes = await page.getByTestId('c5-lanes').innerText();
  log(`card 5 shows level "${level}", lanes "${lanes}"`);
  must(/census/.test(level), `card 5 level is ${level}`);
  const recordHash = (await page.locator('.hash').first().innerText()).trim();
  must(/^[0-9a-f]{64}$/.test(recordHash), `no record hash on card 5: ${recordHash}`);
  await page.getByRole('region', { name: 'Decision' }).waitFor();
  await page.waitForFunction(
    () => !/Getting the decision form ready/.test(document.body.innerText),
  );
  await page.getByLabel(/I have read this readiness record/).check();
  must(
    await page.getByRole('button', { name: 'Sign off and approve M4' }).isDisabled(),
    'the sign-off is enabled before the step-up',
  );
  await audit(page, 'card 5');
  await shot('m8-c5.png');
  noProblems('card 5');
  const c5Url = page.url();
  await page.getByRole('button', { name: 'Confirm my identity' }).click();
  await devSignIn(); // the re-login at the identity provider, bound to the record hash
  await page.waitForURL(/\/cards\/[0-9a-f-]{36}/);
  await page.getByTestId('stepup-ready').waitFor();
  must(!page.url().includes('step_up'), 'the step-up attempt id is left in the address bar');
  log(`step-up done, back on ${page.url() === c5Url ? 'card 5' : page.url()}`);
  await page.getByRole('region', { name: 'Decision' }).waitFor();
  await page.waitForFunction(
    () => !/Getting the decision form ready/.test(document.body.innerText),
  );
  await page.getByLabel(/I have read this readiness record/).check();
  await page.getByRole('button', { name: 'Sign off and approve M4' }).click();
  const r5 = page.getByTestId('receipt');
  await r5.waitFor();
  const r5text = await r5.innerText();
  log(`card 5 receipt: ${r5text.replace(/\s+/g, ' ').slice(0, 260)}`);
  must(/M4: approved/.test(r5text), 'the receipt shows no M4 approval');
  must((await r5.locator('li').count()) === 2, 'card 5 should write two ledger entries');

  // 9. S0 done, the PRR active at level census.
  await page.getByRole('link', { name: 'Onboarding record' }).click();
  await until(
    async () => (await page.locator('[data-status="done"]').count()) > 0,
    'the onboarding to be done',
  );
  log('S0 record is done');
  await page.getByRole('link', { name: 'testbed' }).first().click();
  await page.getByRole('heading', { level: 1, name: 'testbed' }).waitFor();
  await page.getByRole('link', { name: 'Readiness record' }).click();
  await page.getByRole('heading', { level: 1, name: 'Readiness record of testbed' }).waitFor();
  await page.getByTestId('prr-level').waitFor();
  must(
    /census/.test(await page.getByTestId('prr-level').innerText()),
    'the PRR level is not census',
  );
  must(
    (await page.locator('.prr').getAttribute('data-status')) === 'active',
    'the PRR is not active',
  );
  must(
    (await page.locator('.prr .hash').first().innerText()).trim() === recordHash,
    'the PRR page shows another record hash than card 5',
  );
  log(
    `PRR: level ${await page.getByTestId('prr-level').innerText()}, tier ${await page.getByTestId('prr-tier').innerText()}, effective ${await page.getByTestId('prr-effective').innerText()}, lanes ${await page.getByTestId('prr-lanes').innerText()}`,
  );
  await audit(page, 'the readiness record');
  const prrUrl = page.url();
  await shot('m8-prr.png');

  // 10. The ledger page lists every decision of the onboarding, each with its entry hash.
  await page.getByRole('link', { name: /Ledger entries of this project/ }).click();
  await page.getByRole('heading', { level: 1, name: 'Ledger of testbed' }).waitFor();
  const table = page.getByRole('table', { name: 'Ledger entries' });
  await table.waitFor();
  const rows = await table.locator('tbody tr').evaluateAll((trs) =>
    trs.map((tr) => ({
      type: tr.getAttribute('data-type'),
      text: tr.innerText.replace(/\s+/g, ' '),
    })),
  );
  log(`ledger: ${rows.length} entries`);
  const has = (re) => rows.some((r) => re.test(r.text));
  must(has(/bootstrap_grant/), 'no bootstrap grant entry');
  must(has(/step 0\.1\b.*approve/), 'no card 1 decision');
  must(has(/step 0\.4\b.*approve/), 'no card 4 decision');
  must(has(/step 0\.5\b.*approve/), 'no card 5 sign-off');
  must(has(/\bM1\b.*approve/), 'no M1 decision');
  must(has(/\bM4\b.*approve/), 'no M4 decision');
  for (const r of rows) must(/[0-9a-f]{64}/.test(r.text), `an entry has no hash: ${r.text}`);
  await audit(page, 'the ledger');
  const ledgerUrl = page.url();
  await shot('m8-ledger.png');
  noProblems('the end of the onboarding');

  // 11. Phone width: nothing scrolls sideways, on the pages that matter.
  await page.setViewportSize({ width: 375, height: 800 });
  for (const [name, url] of [
    ['inbox', `${base}/inbox`],
    ['S0 record', s0Url],
    ['readiness record', prrUrl],
    ['ledger', ledgerUrl],
    ['card 5', c5Url],
  ]) {
    await page.goto(url);
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    await page.waitForLoadState('networkidle');
    await audit(page, `${name} at phone width`);
  }
  log(`phone width ok (s0 ${s0Id})`);
  noProblems('phone width');
  await page.setViewportSize({ width: 1000, height: 1100 });

  // 12. The old S0 screenshot of M8.1 stays: the record at its end.
  await page.goto(s0Url);
  await page.locator('[data-status="done"]').waitFor();
  await shot('m8-s0.png');

  // 12b. (M12, Gap A; M12.5) S1 with the REAL planning agents on this stack: core-worker runs the work driver with
  // `CORE_WORKER_STAGE_PORTS=agents`, the gateway's local fake provider answers each planning step with a
  // canned valid output (`fixtures: planning`), the port validates it and stores it as an artefact. A Census
  // project cannot run L4 (OB 2.1: the lane is routed to L8). After the Ask the BROWSER answers a clarification
  // question if the scripted fake asked one (it does not today, so that branch is only taken when it does) and
  // decides Ready (1.6) on the item page; the lane stays L8 and the item goes on to its gates.
  {
    const csrf = (await (await context.request.get(`${base}/api/me`)).json()).csrf_token;
    const asked = await context.request.post(`${base}/api/requests`, {
      headers: { 'x-csrf-token': csrf },
      data: {
        project_id: 'testbed',
        repo: `${REPO.owner}/${REPO.name}`,
        lane: 'L4',
        text: 'Let admins export the audit log as CSV.',
      },
    });
    must(asked.status() === 201, `Ask answered ${asked.status()}: ${await asked.text()}`);
    const itemId = (await asked.json()).item_id;
    const readItem = async () => {
      const r = await context.request.get(`${base}/api/items/${itemId}`);
      return r.status() === 200 ? await r.json() : null;
    };
    // S1 runs; it rests at a clarification (if the fake asks) or at 1.6
    let item = await until(async () => {
      const v = await readItem();
      return v && (v.waiting === 'human:ready' || v.questions.some((q) => !q.answered)) ? v : null;
    }, 'the item to reach a question or the Ready decision (S1 run by the agents)');
    await page.goto(`${base}/items/${itemId}`);
    await page.getByRole('heading', { level: 1, name: 'Work item' }).waitFor();
    if (item.questions.some((q) => !q.answered)) {
      // the browser answers each open question, as the requester
      for (const q of item.questions.filter((x) => !x.answered)) {
        await page
          .getByLabel('Your answer')
          .first()
          .fill('The audit_log table; CSV with a header row.');
        await page.getByRole('button', { name: 'Send answer' }).first().click();
        await until(async () => {
          const v = await readItem();
          return v?.questions.find((x) => x.question_id === q.question_id)?.answered ? v : null;
        }, `the answer to "${q.text}" to be recorded`);
      }
      log('the browser answered the S1 clarification question(s)');
      item = await until(async () => {
        const v = await readItem();
        return v && v.waiting === 'human:ready' ? v : null;
      }, 'the item to reach the Ready decision after the answers');
    } else {
      log('S1 asked no clarification question: nothing to answer');
    }
    must(
      item.proposed_lane === 'L8',
      `a census project routes L4 to L8, not ${item.proposed_lane}`,
    );
    must(item.may.ready === true, 'the PDP does not let alice decide Ready');
    log(
      `S1 ran with the real planning port: item ${itemId} waits at 1.6 (proposed lane ${item.proposed_lane})`,
    );
    // Ready, decided in the browser: one press, then the item leaves 1.6 and keeps its L8 route
    await page.reload();
    await page.getByRole('button', { name: 'Say it is ready' }).click();
    const after = await until(async () => {
      const v = await readItem();
      return v && v.waiting !== 'human:ready' ? v : null;
    }, 'the item to leave the Ready decision');
    must(after.proposed_lane === 'L8', `the lane changed after Ready: ${after.proposed_lane}`);
    must(after.may.ready === false, 'Ready is still offered after it was decided');
    await page.getByRole('button', { name: 'Say it is ready' }).waitFor({ state: 'detached' });
    log(
      `Ready decided in the browser: item ${itemId} is now at ${after.waiting} (lane ${after.proposed_lane})`,
    );
    globalThis.__e2eItem = itemId;
  }

  // 12c. (M14.6) S7's exception gates decided in the browser. core-worker runs S7 over the fakes scripted by
  // CORE_WORKER_FAKE_VERIFY=exceptions: on the first item to reach S7, 7.2 hits ET10 (Q1, decided through SECT), 7.4
  // raises X2 and 7.5 raises E2; on the second, 7.2 raises E6. Census routes everything to L8, so each item waits for
  // the developer's D5 before S7. bob holds intent, design, g4, x and sec; alice requested the items. X3 is not
  // reachable here (it is raised only at 6.4, which L8 never runs): the component and route tests cover it.
  await s7Exceptions(globalThis.__e2eItem);

  /** Every card id the item's gates were opened on, by gate (from the record; the inbox lists onboarding cards only). */
  function cardsOf(itemId) {
    const pw = readFileSync(join(composeDir, 'secrets/pg-superuser'), 'utf8').trim();
    const out = execFileSync(
      'docker',
      [
        'compose',
        '--profile',
        'fake-github',
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
        `SELECT body::text FROM record.record_event WHERE stream = 'item:${itemId}' AND type = 'item.gates_opened' ORDER BY seq`,
      ],
      { cwd: composeDir, encoding: 'utf8' },
    );
    const byGate = {};
    for (const line of out.split('\n').filter(Boolean)) {
      const b = JSON.parse(line);
      const p = b.payload ?? b;
      for (const g of p.gates ?? []) (byGate[g.gate] ??= []).push(p.card_ids[0]);
    }
    return byGate;
  }

  async function s7Exceptions(itemOne) {
    const bobCtx = await browser.newContext({
      deviceScaleFactor: 2,
      viewport: { width: 1000, height: 1100 },
    });
    const bp = await bobCtx.newPage();
    bp.setDefaultTimeout(30_000);
    // The card page asks for an onboarding card first; a work-item gate card answers that 404 and the page goes on to
    // its gate (CardPage). That one designed 404 per card visit is expected; every other 4xx is a problem.
    let probes = 0;
    bp.on('response', (r) => {
      if (r.status() === 404 && /\/api\/cards\/[0-9a-f-]{36}$/.test(r.url())) probes += 1;
      else if (r.status() >= 400 && !r.url().endsWith('/api/me'))
        problems.push(`bob saw ${r.status()} from ${r.request().method()} ${r.url()}`);
    });
    bp.on('console', (m) => {
      if (probes > 0 && /status of 404/.test(m.text())) {
        probes -= 1;
        return;
      }
      if (m.type() === 'error' || /Content Security Policy/i.test(m.text()))
        problems.push(`console (bob, ${bp.url()}): ${m.text()}`);
    });
    bp.on('pageerror', (e) => problems.push(`pageerror (bob): ${e.message}`));
    await bp.goto(`${base}/`);
    await bp.getByRole('link', { name: 'Sign in' }).first().click();
    await idpSignIn(bp, 'bob', composeDir);
    await bp.getByRole('button', { name: 'Sign out' }).waitFor();
    problems.length = 0;
    const bobCsrf = (await (await bobCtx.request.get(`${base}/api/me`)).json()).csrf_token;
    const aliceCsrf = (await (await context.request.get(`${base}/api/me`)).json()).csrf_token;
    const readAs = async (ctx, id) => {
      const r = await ctx.request.get(`${base}/api/items/${id}`);
      return r.status() === 200 ? await r.json() : null;
    };
    const pendingGate = (gate) => (v) =>
      v.gates.some((g) => g.gate === gate && g.status === 'pending');
    const waitFor = (id, pred, what) =>
      until(async () => {
        const v = await readAs(bobCtx, id);
        return v && pred(v) ? v : null;
      }, what);
    const cardFor = async (id, gate) =>
      until(async () => cardsOf(id)[gate]?.at(-1) ?? null, `the ${gate} card of ${id}`);
    // A gate this e2e does not test the screen of (G0, G4): decided by bob through the same API the screen uses.
    const decideByApi = async (id, gate) => {
      await waitFor(id, pendingGate(gate), `${gate} to open`);
      const card = await cardFor(id, gate);
      const h = { 'x-csrf-token': bobCsrf };
      const prep = await bobCtx.request.post(`${base}/api/cards/${card}/gate/prepare`, {
        headers: h,
        data: {},
      });
      must(prep.ok(), `${gate} prepare: ${prep.status()} ${await prep.text()}`);
      const gates = (await prep.json()).gates;
      const ev = await bobCtx.request.post(`${base}/api/cards/${card}/gate/evidence`, {
        headers: h,
        data: { views: gates.map((g) => ({ nonce: g.nonce, evidence_hash: g.evidence_hash })) },
      });
      must(ev.ok(), `${gate} evidence: ${ev.status()} ${await ev.text()}`);
      const dec = await bobCtx.request.post(`${base}/api/cards/${card}/gate/decide`, {
        headers: h,
        data: { decision: 'approve', votes: gates.map((g) => ({ nonce: g.nonce })) },
      });
      must(dec.ok(), `${gate} decide: ${dec.status()} ${await dec.text()}`);
      log(`${gate} approved by bob (API) on card ${card}`);
    };
    const humanDone = async (id, key) => {
      await waitFor(
        id,
        (v) => v.waiting === 'human:human_led',
        'the human-led work (D5) to be asked for',
      );
      const r = await bobCtx.request.post(`${base}/api/items/${id}/human-done`, {
        headers: { 'x-csrf-token': bobCsrf },
        data: { key },
      });
      must(r.ok(), `D5 answered ${r.status()}: ${await r.text()}`);
      log(`D5 by bob (${key}): the human-led work of ${id} is done`);
    };
    // One exception gate on its screen: who may decide, the subject hash, read the evidence, a reason, the button.
    const decideOnScreen = async (id, gate, o) => {
      await waitFor(id, pendingGate(gate), `${gate} to open`);
      const card = await cardFor(id, gate);
      await bp.goto(`${base}/cards/${card}`);
      await bp.getByRole('heading', { level: 1, name: o.title }).waitFor();
      await bp.getByTestId('subject-hash').waitFor();
      must(
        /^sha256:[0-9a-f]{64}$/.test((await bp.getByTestId('subject-hash').innerText()).trim()),
        `${gate}: no subject hash`,
      );
      await bp.getByTestId('deciders').waitFor();
      await bp.waitForFunction(
        () => !/Getting the decision form ready/.test(document.body.innerText),
      );
      if (o.choice) await bp.getByRole('radio', { name: o.choice }).check();
      await bp.getByLabel(/I have read the evidence/).check();
      await bp.getByLabel(/Reason \(required/).fill(o.reason);
      await audit(bp, `the ${gate} screen`);
      await bp.mouse.move(0, 0);
      await bp.screenshot({ path: join(shots, o.shot), fullPage: true });
      log(`screenshot: ${join(shots, o.shot)}`);
      await bp.getByRole('button', { name: o.button, exact: true }).click();
      await bp.getByTestId('decided').waitFor();
      const receipt = await bp.getByTestId('decided').innerText();
      must(
        /[0-9a-f]{64}|#\d+/.test(receipt),
        `${gate}: the receipt shows no ledger entry: ${receipt}`,
      );
      log(
        `${gate} decided in the browser (${o.button}${o.choice ? `: ${o.choice}` : ''}); receipt ${receipt.replace(/\s+/g, ' ').slice(0, 160)}`,
      );
      noProblems(`the ${gate} screen`);
    };

    // Item one: G0, D5, then Q1 (SECT confirmed: back to the developer), D5 again, X2, E2, G4.
    await decideByApi(itemOne, 'G0');
    await humanDone(itemOne, 'd5-1');
    const quarantined = await waitFor(itemOne, pendingGate('SECT'), 'Q1: SECT to open after 7.2');
    must(quarantined.waiting?.startsWith('gates'), `Q1 item waits at ${quarantined.waiting}`);
    // the S7 tab shows 7.2 raised
    await bp.goto(`${base}/items/${itemOne}`);
    await bp.getByRole('heading', { level: 1, name: 'Work item' }).waitFor();
    await bp.getByRole('tab', { name: 'Verify' }).click();
    await bp.waitForLoadState('networkidle');
    await audit(bp, 'the Verify tab');
    await bp.mouse.move(0, 0);
    await bp.screenshot({ path: join(shots, 'm14-verify-tab.png'), fullPage: true });
    log(`screenshot: ${join(shots, 'm14-verify-tab.png')}`);
    await decideOnScreen(itemOne, 'SECT', {
      title: 'Test integrity quarantine',
      choice: /Confirmed: bent tests/,
      reason: 'The locked oracle was edited in the head: a real breach.',
      button: 'Record my finding',
      shot: 'm14-q1.png',
    });
    await humanDone(itemOne, 'd5-2');
    await decideOnScreen(itemOne, 'X2', {
      title: 'Protected-path change',
      reason: 'The protected path change is the one the request asked for.',
      button: 'Approve',
      shot: 'm14-x2.png',
    });
    await decideOnScreen(itemOne, 'E2', {
      title: 'Constitution exception',
      reason: 'Accepted for this item; the rule stays as it is.',
      button: 'Approve the exception',
      shot: 'm14-e2.png',
    });
    await decideByApi(itemOne, 'G4');
    const one = await waitFor(itemOne, (v) => !pendingGate('G4')(v), 'G4 to be decided');
    const decided = (g, out) =>
      one.gates.some((x) => x.gate === g && x.status === 'decided' && x.outcome === out);
    must(
      decided('SECT', 'reject') &&
        decided('X2', 'approve') &&
        decided('E2', 'approve') &&
        decided('G4', 'approve'),
      `item one's gates: ${JSON.stringify(one.gates.map((g) => [g.gate, g.outcome]))}`,
    );
    log(`item one ${itemOne}: SECT confirmed, X2 and E2 approved, G4 approved; now ${one.waiting}`);

    // Item two: alice asks, Ready, G0, D5, then E6 at 7.2, rejected in the browser: the D2 handoff.
    const asked = await context.request.post(`${base}/api/requests`, {
      headers: { 'x-csrf-token': aliceCsrf },
      data: {
        project_id: 'testbed',
        repo: `${REPO.owner}/${REPO.name}`,
        lane: 'L4',
        text: 'Rename the export column header.',
      },
    });
    must(asked.status() === 201, `second Ask answered ${asked.status()}: ${await asked.text()}`);
    const itemTwo = (await asked.json()).item_id;
    await until(
      async () => (await readAs(context, itemTwo))?.waiting === 'human:ready',
      'item two at Ready',
    );
    const ready = await context.request.post(`${base}/api/items/${itemTwo}/ready`, {
      headers: { 'x-csrf-token': aliceCsrf },
      data: {},
    });
    must(ready.ok(), `Ready on item two: ${ready.status()} ${await ready.text()}`);
    await decideByApi(itemTwo, 'G0');
    await humanDone(itemTwo, 'd5-1');
    await decideOnScreen(itemTwo, 'E6', {
      title: 'Locked test change',
      reason: 'The spec did not change; the locked test stays.',
      button: 'Reject (D2)',
      shot: 'm14-e6.png',
    });
    const two = await waitFor(
      itemTwo,
      (v) => v.handoff !== null,
      'the D2 handoff after E6 rejected',
    );
    must(two.handoff?.code === 'D2', `item two's handoff is ${JSON.stringify(two.handoff)}`);
    log(`item two ${itemTwo}: E6 rejected in the browser, handoff ${two.handoff.code}`);
    await bobCtx.close();
  }

  // 13. Sign out ends the session.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('link', { name: 'Sign in' }).first().waitFor();
  const me = await page.evaluate(() => fetch('/api/me').then((r) => r.status));
  must(me === 401, `/api/me after sign-out is ${me}`);
  log('signed out: /api/me is 401');
} finally {
  await browser.close();
}
