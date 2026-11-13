import { spawn } from 'node:child_process';
import { githubAppPermissions, type GithubAppKind } from '@aisdlc/contracts';
import { DEFAULT_API_URL, DEFAULT_WEB_URL, startWizard } from './app-wizard.js';

// The command line of the GitHub App setup wizard; `platform/compose/setup-github-apps` runs it (see app-wizard.ts).

const USAGE = `usage: ./setup-github-apps [options]

Creates the factory's two GitHub Apps from manifests, writes their keys to secrets/ (mode 600) and their ids to .env,
and checks each installation. Default: both Apps; the factory App reads and pushes.

  --org <org>            create the Apps under this organisation (default: your user account)
  --with-tracker         the factory App also files onboarding-gap issues (Issues: write; tracker-app.pem, TRACKER_*)
  --with-gate-relay      the factory App also writes deployments after G5 (Deployments: write; gate-relay-app.pem, GATE_RELAY_*)
  --only factory|gate-check   create one of the two
  --rotate               replace keys already in secrets/ (delete the old Apps on GitHub yourself)
  --prefix <name>        App name prefix (default aisdlc); a random suffix is added
  --homepage-url <url>   the Apps' homepage URL (default https://github.com/apps)
  --no-open              print the URL, do not open a browser
  --timeout-minutes <n>  give up after n minutes (default 30)
  --api-url, --web-url   another GitHub (tests: the fake GitHub)
  --compose-dir <dir>    where secrets/, .env and init-secrets are (default: this script's directory)`;

function parse(argv: readonly string[]) {
  const o = {
    composeDir: '',
    apiUrl: DEFAULT_API_URL,
    webUrl: DEFAULT_WEB_URL,
    org: undefined as string | undefined,
    tracker: false,
    gateRelay: false,
    kinds: ['factory', 'gate-check'] as GithubAppKind[],
    rotate: false,
    prefix: 'aisdlc',
    homepageUrl: 'https://github.com/apps',
    open: true,
    timeoutMinutes: 30,
  };
  const value = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case '--org':
        o.org = value(i++, a);
        if (!/^[A-Za-z0-9-]{1,39}$/.test(o.org))
          throw new Error('--org is not an organisation login');
        break;
      case '--with-tracker':
        o.tracker = true;
        break;
      case '--with-gate-relay':
        o.gateRelay = true;
        break;
      case '--only': {
        const k = value(i++, a);
        if (k !== 'factory' && k !== 'gate-check')
          throw new Error('--only is factory or gate-check');
        o.kinds = [k];
        break;
      }
      case '--rotate':
        o.rotate = true;
        break;
      case '--prefix':
        o.prefix = value(i++, a);
        if (!/^[a-z][a-z0-9-]{0,14}$/.test(o.prefix))
          throw new Error('--prefix: lowercase, at most 15');
        break;
      case '--homepage-url':
        o.homepageUrl = new URL(value(i++, a)).toString();
        break;
      case '--no-open':
        o.open = false;
        break;
      case '--timeout-minutes':
        o.timeoutMinutes = Number(value(i++, a));
        if (!(o.timeoutMinutes > 0)) throw new Error('--timeout-minutes is a positive number');
        break;
      case '--api-url':
        o.apiUrl = new URL(value(i++, a)).toString().replace(/\/$/, '');
        break;
      case '--web-url':
        o.webUrl = new URL(value(i++, a)).toString().replace(/\/$/, '');
        break;
      case '--compose-dir':
        o.composeDir = value(i++, a);
        break;
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument ${a}`);
    }
  }
  if (o.composeDir === '') throw new Error('--compose-dir is required');
  return o;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const c = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
  } catch {
    // no browser here: the URL is printed
  }
}

async function main(): Promise<number> {
  let o: ReturnType<typeof parse>;
  try {
    o = parse(process.argv.slice(2));
  } catch (e) {
    console.error(`setup-github-apps: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const log = (l: string): void => console.log(l);
  const factory = { tracker: o.tracker, gateRelay: o.gateRelay };
  log('setup-github-apps: the Apps it will create');
  for (const k of o.kinds) {
    const p = Object.entries(githubAppPermissions(k, factory)).map(([n, l]) => `${n}:${l}`);
    log(`  ${k.padEnd(10)} ${p.join(', ')}`);
  }
  let w: Awaited<ReturnType<typeof startWizard>>;
  try {
    w = await startWizard({ ...o, factory, log });
  } catch (e) {
    console.error(`setup-github-apps: ${(e as Error).message}`);
    return 1;
  }
  log(
    `\nOpen this page in the browser where you are signed in to GitHub (only this machine can reach it):\n\n  ${w.url}\n`,
  );
  if (o.open) openBrowser(w.url);
  const stopAll = async (code: number) => {
    await w.stop();
    process.exit(code);
  };
  process.on('SIGINT', () => void stopAll(130));
  process.on('SIGTERM', () => void stopAll(143));
  const timer = setTimeout(() => {
    console.error(`setup-github-apps: no answer in ${o.timeoutMinutes} minutes; stopped`);
    void stopAll(1);
  }, o.timeoutMinutes * 60_000);
  const apps = await w.done;
  clearTimeout(timer);
  // the browser follows the last redirect before the helper stops
  await new Promise((r) => setTimeout(r, 1500));
  await w.stop();
  log('\nsetup-github-apps: done');
  for (const a of apps) {
    log(`  ${a.kind.padEnd(10)} ${a.slug} App ID ${a.appId}, installation ${a.installationId}`);
  }
  log(`
Next, by hand on GitHub (the factory never changes branch protection):
  the testbed's default branch: a rule (ruleset or branch protection) requiring the status check
  "aisdlc/gate" from the gate-check App. Then: docker compose up -d --wait (see docs/getting-started.md §4).`);
  return 0;
}

process.exit(await main());
