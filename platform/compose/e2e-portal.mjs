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
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const base = process.env.E2E_BASE_URL ?? 'http://localhost:8340';
const shots = process.env.E2E_SCREENSHOT_DIR ?? 'docs/screenshots';
const REPO = { owner: 'reshif', name: 'asf-factory-testbed' };
const ALICE = '00000000-0000-4000-8000-000000000001';
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

  const devSignIn = async () => {
    await page.waitForURL(/dev-oidc\.localhost:8390\/authorize/);
    await page.locator('select[name=dev_user]').selectOption(ALICE);
    await page.getByRole('button', { name: 'Sign in' }).click();
  };

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

  // 2. The dev IdP: sign in as alice (the first person of the seed, a factory admin).
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
  await devSignIn(); // the re-login at the dev IdP, bound to the record hash
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

  // 12b. (M12, Gap A) S1 with the REAL planning agents on this stack: core-worker runs the work driver with
  // `CORE_WORKER_STAGE_PORTS=agents`, the gateway's local fake provider answers each planning step with a
  // canned valid output (`fixtures: planning`), the port validates it and stores it as an artefact. A Census
  // project cannot run L4 (OB 2.1: the lane is routed to L8), and there is no Ready decision in the portal
  // yet, so the item rests at 1.6 with what S1 produced: the classification and the intent block.
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
    const item = await until(async () => {
      const r = await context.request.get(`${base}/api/items/${itemId}`);
      const v = r.status() === 200 ? await r.json() : null;
      return v && v.waiting === 'human:ready' ? v : null;
    }, 'the item to reach the Ready decision (S1 run by the agents)');
    must(
      item.proposed_lane === 'L8',
      `a census project routes L4 to L8, not ${item.proposed_lane}`,
    );
    log(
      `S1 ran with the real planning port: item ${itemId} waits at 1.6 (proposed lane ${item.proposed_lane})`,
    );
    globalThis.__e2eItem = itemId;
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
