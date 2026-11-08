// The portal in a real browser against the running local-prod stack (see e2e.sh). Plain Node, no
// test runner: Playwright is used as a library, with no tracing, and the script exits non-zero with
// a message on the first thing that is not as expected.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const base = process.env.E2E_BASE_URL ?? 'http://localhost:8340';
const shot = process.env.E2E_SCREENSHOT ?? 'm8-s0.png';
const REPO = { owner: 'reshif', name: 'asf-factory-testbed' };
const T = 240_000;

const log = (m) => console.log(`  ${m}`);
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

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
      problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

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

  // 2. The dev IdP: sign in as alice.
  await page.waitForURL(/dev-oidc\.localhost:8390\/authorize/);
  // Alice is the first person of config/dev-oidc-users.json (a factory admin by the seed).
  await page.locator('select[name=dev_user]').selectOption('00000000-0000-4000-8000-000000000001');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`${base}/`);
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
  const who = await page.locator('.who-name').innerText();
  log(`signed in as ${who}`);
  must(/Alice/.test(who), `unexpected principal ${who}`);
  // The 401 of /api/me before sign-in is the browser logging a normal answer; from here on nothing may be reported.
  problems.length = 0;
  const cookies = await page.evaluate(() => document.cookie);
  must(!/aisdlc_sid/.test(cookies), 'the session cookie is readable by script');
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
  log(`requested onboarding of ${REPO.owner}/${REPO.name}: ${page.url()}`);

  // 4. The S0 page reaches step 0.1 `card` with card C1 listed (the factory does the rest by itself).
  await page
    .getByRole('heading', { level: 1, name: `Onboarding of ${REPO.owner}/${REPO.name}` })
    .waitFor();
  const step01 = page.locator('[data-step="0.1"]');
  let last = '';
  const end = Date.now() + T;
  for (;;) {
    const state = await step01.getAttribute('data-state');
    if (state !== last) {
      log(`step 0.1 is ${state}`);
      last = state;
    }
    if (state === 'card') break;
    must(Date.now() < end, `step 0.1 did not reach card (last: ${state})`);
    await page.waitForTimeout(1000);
  }
  const c1 = page.locator('[data-card="C1"]');
  await c1.waitFor({ timeout: T });
  must((await c1.getAttribute('data-status')) === 'open', 'card C1 is not open');
  await page.getByRole('link', { name: 'Card C1' }).waitFor();
  const skipped = await page.locator('[data-step="0.2"]').getAttribute('data-state');
  must(skipped === 'skip', `step 0.2 should be skipped at Census, is ${skipped}`);
  log(`card C1 listed: ${(await c1.innerText()).replace(/\s+/g, ' ')}`);

  // 5. The project list and detail show it.
  await page.getByRole('link', { name: 'testbed' }).first().click();
  await page.getByRole('heading', { level: 1, name: 'testbed' }).waitFor();
  await page.getByRole('list', { name: 'Repos' }).getByText(`${REPO.owner}/${REPO.name}`).waitFor();
  log('project detail lists the repo');
  await page.getByRole('list', { name: 'Onboarding records' }).getByRole('link').first().click();
  await page.locator('[data-step="0.1"][data-state="card"]').waitFor();

  must(problems.length === 0, `the browser reported problems:\n  ${problems.join('\n  ')}`);

  // 6. The screenshot of the S0 page (deviceScaleFactor 2).
  mkdirSync(dirname(shot), { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: shot, fullPage: true });
  log(`screenshot: ${shot}`);

  // 7. Sign out ends the session.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('link', { name: 'Sign in' }).first().waitFor();
  const me = await page.evaluate(() => fetch('/api/me').then((r) => r.status));
  must(me === 401, `/api/me after sign-out is ${me}`);
  log('signed out: /api/me is 401');
} finally {
  await browser.close();
}
