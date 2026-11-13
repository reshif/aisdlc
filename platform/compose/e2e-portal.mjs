// The portal in a real browser against the running local-prod stack (see e2e.sh): the whole Census
// onboarding of reshif/asf-factory-testbed, decided by a person in the browser (PLAN M8.1 to M8.4).
// Plain Node, no test runner: Playwright is used as a library, with no tracing, and the script exits
// non-zero with a message on the first thing that is not as expected.
//
//   portal v2, agent-led: alice picks the repo the GitHub App sees -> the onboarding agent reads it and proposes
//   (findings, fix PRs, what only a person can do) -> she adjusts the one summary (T0, the GitHub attestations, the
//   role map with alice in admin and m4, two-person off) -> ONE sign-off decides cards 1 and 4 underneath, the
//   settings revision card 4 proposed (decided and published), and card 5 after a step-up re-login at the IdP ->
//   PRR active, repo level census, S0 done -> the project page, the PRR page and the ledger page show it. Screenshots at deviceScaleFactor 2, accessibility checks on every page,
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
  // portal v2: the person is the avatar menu (their name in its label; Sign out inside it)
  const account = page.getByRole('button', { name: /^Account: / });
  await account.waitFor();
  const who = (await account.getAttribute('aria-label')) ?? '';
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

  // 3. Onboard a repo (portal v2, agent-led): pick the repo the GitHub App sees, start.
  await page.getByRole('link', { name: 'Onboard a repo' }).first().click();
  await page.getByRole('heading', { level: 1, name: 'Onboard a repo' }).waitFor();
  const listed = page.getByRole('radio', { name: new RegExp(`${REPO.owner}/${REPO.name}`) });
  await until(
    async () =>
      (await listed.count()) > 0 || (await page.getByText('No repos visible').count()) > 0,
    'the repos the GitHub App can see',
  );
  if ((await listed.count()) > 0) {
    await listed.check();
    log('picked the repo from the GitHub App installation');
  } else {
    await page.getByRole('button', { name: /type it/ }).click();
    await page.getByLabel('Repository owner').fill(REPO.owner);
    await page.getByLabel('Repository name').fill(REPO.name);
    log('the repo is not listed: typed it');
  }
  await page.getByLabel('Project name').fill('testbed');
  await page.getByRole('radio', { name: /^Read only/ }).check();
  await audit(page, 'onboard: pick a repo');
  await shot('v2-onboard-1-pick.png');
  await page.getByRole('button', { name: 'Start onboarding' }).click();
  await page.waitForURL(/\/onboard\/[0-9a-f-]{36}$/);
  const s0Url = page.url();
  const s0Id = s0Url.split('/').pop();
  log(`requested onboarding of ${REPO.owner}/${REPO.name}: ${s0Url}`);
  await page
    .getByRole('heading', { level: 1, name: `Onboarding of ${REPO.owner}/${REPO.name}` })
    .waitFor();

  // 4. The onboarding agent works by itself: the census, card 1 underneath, then its proposal.
  await page.getByTestId('agent-summary').waitFor({ timeout: T });
  log(`agent: ${(await page.getByTestId('agent-summary').innerText()).slice(0, 200)}`);
  const fixes = await page
    .locator('[data-fix]')
    .evaluateAll((xs) =>
      xs.map((x) => `${x.getAttribute('data-fix')}=${x.getAttribute('data-state')}`),
    );
  log(`fixes proposed: ${fixes.join(', ') || 'none'}`);
  await audit(page, 'onboard: the agent worked');
  await shot('v2-onboard-2-agent.png');

  // 5. The one summary, adjusted in place: risk, the GitHub settings only a person can state, who decides what.
  await page.getByRole('button', { name: 'Sign off' }).waitFor();
  const t0 = page.getByRole('checkbox', { name: /no production use/ });
  if ((await t0.count()) > 0) await t0.check();
  const reg = page.getByRole('checkbox', { name: /no regulatory obligation/ });
  if ((await reg.count()) > 0) await reg.check();
  const crit = page.getByRole('checkbox', { name: /how critical/ });
  if ((await crit.count()) > 0) await crit.check();
  for (const t of [
    /bypass list of main/,
    /selected repositories only/,
    /GITHUB_TOKEN of workflows is read-only/,
    /may not create or approve pull requests/,
    /fork pull requests need approval/,
  ]) {
    await page.getByRole('checkbox', { name: t }).check();
  }
  await page.getByRole('combobox', { name: 'Secret scanning' }).selectOption('on');
  await page.getByRole('combobox', { name: 'GitHub plan' }).selectOption('free');
  const slot = (s) => page.locator(`[data-slot="${s}"] input.ui-input`);
  await slot('admin').fill('alice');
  await slot('m4').fill('alice');
  // M14.6: bob decides the work item's gates (alice requests it, so she may not) and does its human-led work;
  // the code reviewer defaults to the code owners on GitHub (the testbed's are alice's login): bob instead
  const owners = page.locator('[data-slot="g4"] input[type=checkbox]');
  if (await owners.isChecked()) await owners.uncheck();
  for (const s of ['intent', 'design', 'g4', 'x', 'sec']) await slot(s).fill('bob');
  const two = page.getByRole('checkbox', { name: /need two people here/ });
  if (await two.isChecked()) await two.uncheck();
  await audit(page, 'onboard: the summary');
  await shot('v2-onboard-3-summary.png');
  noProblems('the summary');

  // 6. Sign off ONCE: the factory decides each step underneath as alice, as the driver opens it (card 1, card 4 and
  // its settings, published), then asks her to confirm it's her for the readiness scorecard.
  await page.getByRole('button', { name: 'Sign off' }).click();
  const signState = () => page.getByTestId('sign-off-state').getAttribute('data-state');
  let lastState = '';
  await until(async () => {
    const s = await signState();
    if (s !== lastState) {
      log(`sign-off: ${s}`);
      lastState = s;
    }
    return s === 'needs_step_up' || s === 'done';
  }, 'the sign-off to reach the readiness scorecard');
  const sum = await (await context.request.get(`${base}/api/s0/${s0Id}/summary`)).json();
  const recordHash = sum.readiness.prr?.record_hash ?? '';
  must(/^[0-9a-f]{64}$/.test(recordHash), `no readiness scorecard to sign: ${recordHash}`);
  log(
    `scorecard to sign: readiness ${sum.readiness.prr.composite} of 4, record ${recordHash.slice(0, 12)}`,
  );
  await shot('v2-onboard-4-confirm.png');

  // 7. Confirm it's you: the re-login at the identity provider, bound to the scorecard's record hash; back on the
  // page the sign-off goes on by itself and ends.
  await page.getByRole('button', { name: 'Confirm it’s you' }).click();
  await devSignIn();
  await page.waitForURL(/\/onboard\/[0-9a-f-]{36}/);
  must(!page.url().includes('step_up'), 'the step-up attempt id is left in the address bar');
  await until(async () => (await signState()) === 'done', 'the sign-off to end');
  await page.locator('[data-testid="onboarding-status"][data-status="done"]').waitFor();
  log('onboarding signed off: done');
  await audit(page, 'onboard: signed off');
  await shot('v2-onboard-5-done.png');
  noProblems('the sign-off');

  // 8. The project page shows what onboarding set: the scorecard, the tracks, the approvals each track has.
  await page.goto(`${base}/projects/testbed`);
  await page.getByRole('heading', { level: 1, name: 'testbed' }).waitFor();
  await audit(page, 'the project page');
  await shot('v2-project-overview.png');
  await page.getByRole('tab', { name: 'Readiness scorecard' }).click();
  await page.getByRole('heading', { name: /Readiness scorecard of/ }).waitFor();
  await shot('v2-project-readiness.png');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByTestId('track-approvals').waitFor();
  await page.getByTestId('repos').waitFor();
  await audit(page, 'the project settings');
  await shot('v2-project-settings.png');
  const projectUrl = `${base}/projects/testbed`;

  // 9. The readiness record page: active, level census, the same record the sign-off bound.
  await page.goto(`${base}/projects/testbed/readiness`);
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
    'the PRR page shows another record hash than the sign-off bound',
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
  for (const [name, url, file] of [
    ['inbox', `${base}/inbox`, null],
    ['onboarding', s0Url, 'v2-phone-onboard.png'],
    ['project', projectUrl, 'v2-phone-project.png'],
    ['projects', `${base}/projects`, 'v2-phone-projects.png'],
    ['readiness record', prrUrl, null],
    ['ledger', ledgerUrl, null],
  ]) {
    await page.goto(url);
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    await page.waitForLoadState('networkidle');
    await audit(page, `${name} at phone width`);
    if (file) await shot(file);
  }
  log(`phone width ok (s0 ${s0Id})`);
  noProblems('phone width');
  await page.setViewportSize({ width: 1000, height: 1100 });

  // 12. The onboarding at its end, and the projects list.
  await page.goto(`${base}/projects`);
  await page.getByRole('table', { name: 'Projects' }).waitFor();
  await shot('v2-projects.png');
  await page.goto(s0Url);
  await page.locator('[data-testid="onboarding-status"][data-status="done"]').waitFor();
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
    await bp.getByRole('button', { name: /^Account: / }).waitFor();
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
  await page.getByRole('button', { name: /^Account: / }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('link', { name: 'Sign in' }).first().waitFor();
  const me = await page.evaluate(() => fetch('/api/me').then((r) => r.status));
  must(me === 401, `/api/me after sign-out is ${me}`);
  log('signed out: /api/me is 401');
} finally {
  await browser.close();
}
