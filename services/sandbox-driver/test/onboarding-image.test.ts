import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planProbe, probeCommand, resultOfRun } from '@aisdlc/onboarding';
import type { Fact } from '@aisdlc/contracts';
import type { SandboxSpec } from '@aisdlc/ports';
import { makeCanary } from '@aisdlc/secrets-rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker, dockerAvailable, startRig, type Rig } from './harness.js';

// M16 (DEC-17 refined; ADR-0003 §7 K-exec): the dedicated onboarding probe image, for real. It is built by
// `platform/sandbox/onboarding/build.sh` (bases by digest, every wheel checked against pins.json on the host and
// again in the build), then a K-exec session through the allow-list proxy runs a small Python repo's own setup and
// test with the image's step runner: the repo's one dependency comes from the package mirror (the session's only
// peer), the image's pinned pytest runs the tests, and a planted network call (DNS, the internet, the metadata IP)
// fails. The output is read by the same `resultOfRun` core records from.

const dk = dockerAvailable();
if (!dk.ok) console.warn(`onboarding image Docker tests SKIPPED: ${dk.why}`);

const ROOT = resolve(import.meta.dirname, '../../..');
const BUILD = join(ROOT, 'platform/sandbox/onboarding/build.sh');
const TAG = 'aisdlc/sandbox-onboarding:test';
const none = { containers: [], networks: [], volumes: [], scratch: [] };

let rig: Rig;
let image = '';
let wheelDir = '';

/** A one-module wheel built by the image's own python (the harness is trusted; the session never sees this). */
function buildWheel(img: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-wheel-'));
  chmodSync(dir, 0o777);
  const py = `
import base64, hashlib, zipfile
files = {
  'probe_dep/__init__.py': 'VALUE = 42\\n',
  'probe_dep-1.0.0.dist-info/METADATA': 'Metadata-Version: 2.1\\nName: probe-dep\\nVersion: 1.0.0\\n',
  'probe_dep-1.0.0.dist-info/WHEEL': 'Wheel-Version: 1.0\\nGenerator: aisdlc-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n',
}
rec = []
for n, c in files.items():
  d = base64.urlsafe_b64encode(hashlib.sha256(c.encode()).digest()).rstrip(b'=').decode()
  rec.append('%s,sha256=%s,%d' % (n, d, len(c.encode())))
rec.append('probe_dep-1.0.0.dist-info/RECORD,,')
files['probe_dep-1.0.0.dist-info/RECORD'] = '\\n'.join(rec) + '\\n'
with zipfile.ZipFile('/w/probe_dep-1.0.0-py3-none-any.whl', 'w') as z:
  for n, c in files.items():
    z.writestr(n, c)
`;
  docker(
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    'python3',
    '-v',
    `${dir}:/w`,
    img,
    '-c',
    py,
  );
  return dir;
}

const WHEEL = 'probe_dep-1.0.0-py3-none-any.whl';

const REPO = [
  { path: 'requirements.txt', content: 'probe-dep==1.0.0\n' },
  {
    path: 'tests/test_app.py',
    content: `import probe_dep

def test_dependency_from_the_mirror():
    assert probe_dep.VALUE == 42

def test_arithmetic():
    assert 1 + 1 == 2
`,
  },
  {
    path: 'tests/test_planted_network.py',
    // the planted calls: each must FAIL inside the sandbox, so the test passes only when they are contained
    content: `import socket, urllib.request, pytest

def test_no_dns():
    with pytest.raises(OSError):
        socket.getaddrinfo('pypi.org', 443)

def test_no_internet_by_ip():
    with pytest.raises(OSError):
        socket.create_connection(('1.1.1.1', 443), timeout=3)

def test_no_metadata_ip():
    with pytest.raises(OSError):
        urllib.request.urlopen('http://169.254.169.254/latest/meta-data/', timeout=3)

def test_the_mirror_is_reachable():
    assert urllib.request.urlopen('http://package-mirror:8420/healthz', timeout=5).status == 200
`,
  },
];

const FACTS: Fact[] = [
  {
    kind: 'task_command',
    detector: 'task_contract',
    evidence: [],
    name: 'setup',
    state: 'found',
    runner: 'make',
    invocation: 'python3 -m pip install -r requirements.txt',
    source: 'Makefile',
  },
  {
    kind: 'task_command',
    detector: 'task_contract',
    evidence: [],
    name: 'test',
    state: 'found',
    runner: 'make',
    invocation: 'python3 -m pytest -q -p no:cacheprovider tests',
    source: 'Makefile',
  },
];

const must = <T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

describe.skipIf(!dk.ok)('the onboarding probe image (real Docker)', () => {
  beforeAll(async () => {
    image = execFileSync('bash', [BUILD, '--tag', TAG], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    }).trim();
    wheelDir = buildWheel(image);
    rig = await startRig({
      canaries: [makeCanary('onb-a'), makeCanary('onb-b')],
      gatewayKey: 'vk_test_0123456789abcdef',
      policy: { images: ['aisdlc/sandbox:local', image] },
      fixtures: (dir) => {
        const whl = readFileSync(join(wheelDir, WHEEL));
        const sha = createHash('sha256').update(whl).digest('hex');
        mkdirSync(join(dir, 'wheels'), { mode: 0o755 });
        copyFileSync(join(wheelDir, WHEEL), join(dir, 'wheels', WHEEL));
        mkdirSync(join(dir, 'simple', 'probe-dep'), { recursive: true, mode: 0o755 });
        const page = `<!DOCTYPE html><html><body><a href="../../wheels/${WHEEL}#sha256=${sha}">${WHEEL}</a></body></html>\n`;
        writeFileSync(join(dir, 'simple', 'probe-dep', 'index.html'), page);
        execFileSync('chmod', ['-R', 'a+rX', dir]);
      },
    });
  }, 900_000);
  afterAll(async () => {
    await rig?.teardown();
    if (wheelDir) rmSync(wheelDir, { recursive: true, force: true });
  });

  it('the image is named by its digest, carries the lock it was built from, and holds the pinned tools', () => {
    expect(image).toMatch(/^sha256:[0-9a-f]{64}$/);
    const lock = createHash('sha256')
      .update(readFileSync(join(ROOT, 'platform/sandbox/onboarding/pins.json')))
      .digest('hex');
    expect(
      docker(
        'image',
        'inspect',
        image,
        '--format',
        '{{index .Config.Labels "aisdlc.onboarding.lock.sha256"}}',
      ),
    ).toBe(lock);
    expect(docker('image', 'inspect', image, '--format', '{{.Config.User}}')).toBe('10002:10002');
    const pins = JSON.parse(
      readFileSync(join(ROOT, 'platform/sandbox/onboarding/pins.json'), 'utf8'),
    ) as {
      wheels: Array<{ name: string; version: string }>;
    };
    const listed = docker(
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'python3',
      image,
      '-c',
      'import json, importlib.metadata as m; print(json.dumps({d.metadata["Name"].lower(): d.version for d in m.distributions()}))',
    );
    const have = new Map(Object.entries(JSON.parse(listed) as Record<string, string>));
    // nothing in the image's environment is credential-shaped (the base's build names are dropped)
    expect(docker('image', 'inspect', image, '--format', '{{json .Config.Env}}')).not.toMatch(
      /GPG_KEY|_SHA256=/,
    );
    for (const w of pins.wheels) expect(have.get(w.name), w.name).toBe(w.version);
  });

  it("a K-exec probe: the repo's setup installs its dependency from the mirror only, its tests pass, the planted network calls fail", async () => {
    const plan = planProbe(FACTS);
    const spec: SandboxSpec = {
      session_id: 'probe-onb-0001',
      class: 'K-exec',
      image,
      command: probeCommand(plan),
      repo: REPO,
    };
    const run = must(await rig.driver({ images: [image] }).run(spec));
    const result = resultOfRun(
      {
        probe_id: `probe-${'0'.repeat(32)}`,
        s0_id: '01930000-0000-7000-8000-000000000001',
        repo: 'acme/app',
        census_hash: 'c'.repeat(64),
        baseline_sha: 'd'.repeat(40),
        image,
        recorded_at: new Date().toISOString(),
      },
      plan,
      run,
    );
    const why = `${result.detail}\nsetup: ${result.setup.log_tail}\ntest: ${result.test.log_tail}\n${run.stderr.slice(-2000)}`;
    expect(result.outcome, why).toBe('passed');
    expect(result.setup.exit_code).toBe(0);
    expect(result.tests).toMatchObject({ total: 6, passed: 6, failed: 0, source: 'junit' });
    expect(run.peers).toEqual(['mirror']);
    expect(result.out_scan.canary).toBe(false);
    expect(rig.leftovers()).toEqual(none);
  });

  it('a planted call to the internet from the repo fails, and a broken dependency fails the probe', async () => {
    const d = rig.driver({ images: [image] });
    const direct = must(
      await d.run({
        session_id: 'probe-onb-0002',
        class: 'K-exec',
        image,
        command: [
          'python3',
          '-c',
          "import urllib.request; urllib.request.urlopen('https://pypi.org/simple/', timeout=5)",
        ],
        repo: [{ path: 'README.md', content: 'x' }],
      }),
    );
    expect(direct.status).toBe('exited');
    expect(direct.exit_code).not.toBe(0);
    expect(direct.stderr).toMatch(/URLError|gaierror|Name or service not known|Temporary failure/);
    // a dependency the mirror does not hold: pip cannot reach the internet for it, setup fails, the probe fails
    const plan = planProbe(FACTS);
    const run = must(
      await d.run({
        session_id: 'probe-onb-0003',
        class: 'K-exec',
        image,
        command: probeCommand(plan),
        repo: [{ path: 'requirements.txt', content: 'requests==2.32.3\n' }, ...REPO.slice(1)],
      }),
    );
    expect(run.exit_code).toBe(1);
    expect(rig.leftovers()).toEqual(none);
  });

  it('the image is refused unless the host allows it, and a tag is never accepted', async () => {
    const r = await rig.driver().run({
      session_id: 'probe-onb-0004',
      class: 'K-exec',
      image,
      command: ['python3', '--version'],
      repo: [{ path: 'README.md', content: 'x' }],
    });
    expect(r.ok ? null : r.error.code).toBe('refused');
    const t = await rig.driver({ images: [TAG] }).run({
      session_id: 'probe-onb-0005',
      class: 'K-exec',
      image: TAG,
      command: ['python3', '--version'],
      repo: [{ path: 'README.md', content: 'x' }],
    });
    expect(t.ok ? null : t.error.code).toBe('invalid_spec');
  });
});
