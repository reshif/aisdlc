import { RULES } from '../src/index.js';

// The HELD-OUT recall set and the false-positive corpus (PLAN M6.2b, SEC-OB-5 early form).
//
// Written independently of `RULES[].fixtures`: values come from a seeded PRNG (not the rules'
// `fill` pattern), contexts are the shapes real leaks have (.env, INI, YAML, JSON, source code, PEM
// split across lines, tokens inside URLs, word-like passwords). Every value is constructed at run
// time, so this repository never holds a secret-shaped string; the repo self-test checks that.

export interface Planted {
  readonly rule: string;
  readonly label: string;
  readonly text: string;
}

/** mulberry32: a deterministic PRNG, so the set is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rnd = prng(1);
/** Each builder starts from its own seed, so a call gives the same set every time. */
const reseed = (n: number): void => {
  rnd = prng(n);
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
const rand = (alphabet: string, n: number): string =>
  Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGITS = '0123456789';
const ALNUM = LOWER + UPPER + DIGITS;
const B64 = ALNUM + '+/';
const B64URL = ALNUM + '-_';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const WORDS = [
  'Correct',
  'Horse',
  'Battery',
  'Staple',
  'Purple',
  'Monkey',
  'Dishwasher',
  'Tuesday',
  'Orange',
  'Falcon',
  'Winter',
  'Lantern',
  'Marble',
  'Thunder',
  'Velvet',
  'Harbour',
  'Copper',
  'Saffron',
  'Glacier',
  'Whisper',
];
/** `n` capitalised words joined by `sep`: the word-like password the old skip let through. */
const words = (n: number, sep: string): string =>
  Array.from({ length: n }, () => pick(WORDS)).join(sep);

const sp = (...parts: string[]): string => parts.join('');
const lines = (s: string, n: number): string[] =>
  Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, (i + 1) * n));

const pemBody = (n: number): string => rand(B64, n);
const pem = (kind: string, body: string[], eol = '\n'): string =>
  [`-----BEGIN ${kind}-----`, ...body, `-----END ${kind}-----`].join(eol);

export function heldOutSet(): Planted[] {
  reseed(0x5eed_0b5);
  const out: Planted[] = [];
  const add = (rule: string, label: string, text: string): number =>
    out.push({ rule, label, text });

  // ---- aws-access-key-id
  for (const [i, prefix] of ['AKIA', 'ASIA', 'ABIA', 'ACCA'].entries()) {
    const id = prefix + rand(B32, 16);
    add('aws-access-key-id', `env ${prefix}`, `AWS_ACCESS_KEY_ID=${id}\n`);
    if (i === 0)
      add('aws-access-key-id', 'yaml', `aws:\n  credentials:\n    access_key_id: ${id}\n`);
    if (i === 1) add('aws-access-key-id', 'json', `{"Credentials": {"AccessKeyId": "${id}"}}`);
    if (i === 2)
      add('aws-access-key-id', 'python', `s3 = boto3.client("s3", aws_access_key_id='${id}')`);
    if (i === 3) add('aws-access-key-id', 'ini', `[default]\naws_access_key_id = ${id}\n`);
  }

  // ---- aws-secret-access-key
  const awsSecret = (): string => rand(B64, 40);
  add('aws-secret-access-key', 'ini', `[default]\naws_secret_access_key = ${awsSecret()}\n`);
  add('aws-secret-access-key', 'env quoted', `export AWS_SECRET_ACCESS_KEY="${awsSecret()}"\n`);
  add('aws-secret-access-key', 'yaml', `aws_secret_access_key: ${awsSecret()}\n`);
  add('aws-secret-access-key', 'json', `{"AwsSecretAccessKey": "${awsSecret()}"}`);
  add(
    'aws-secret-access-key',
    'terraform',
    `  secret_key = "${awsSecret()}" # aws secret\n`.replace('secret_key', 'aws_secret_key'),
  );

  // ---- github-token (all five prefixes, in URLs and headers too)
  for (const k of ['p', 'o', 'u', 's', 'r']) {
    add('github-token', `env gh${k}`, `GITHUB_TOKEN=${sp('gh', k, '_')}${rand(ALNUM, 36)}\n`);
  }
  add(
    'github-token',
    'clone url',
    `git clone https://x-access-token:${sp('gh', 's', '_')}${rand(ALNUM, 36)}@github.com/acme/app.git`,
  );
  add(
    'github-token',
    'header',
    `curl -H "Authorization: token ${sp('gh', 'p', '_')}${rand(ALNUM, 40)}" https://api.github.com/user`,
  );
  add('github-token', 'long', `token: ${sp('gh', 'u', '_')}${rand(ALNUM, 80)}\n`);

  // ---- github-fine-grained-pat
  add(
    'github-fine-grained-pat',
    'env',
    `GH_PAT=${sp('github', '_pat_')}${rand(ALNUM, 22)}_${rand(ALNUM, 59)}\n`,
  );
  add(
    'github-fine-grained-pat',
    'url',
    `https://oauth2:${sp('github', '_pat_')}${rand(ALNUM, 82)}@github.com/acme/app`,
  );

  // ---- private-key-pem: split across lines in the ways files really hold them
  const body = lines(pemBody(1600), 64);
  add('private-key-pem', 'RSA 64-col', pem(sp('RSA ', 'PRIVATE', ' KEY'), body));
  add('private-key-pem', 'PKCS8 CRLF', pem(sp('PRIVATE', ' KEY'), body, '\r\n'));
  add('private-key-pem', 'EC', pem(sp('EC ', 'PRIVATE', ' KEY'), lines(pemBody(240), 64)));
  add(
    'private-key-pem',
    'OpenSSH 70-col',
    pem(sp('OPENSSH ', 'PRIVATE', ' KEY'), lines(pemBody(400), 70)),
  );
  add(
    'private-key-pem',
    'PGP block',
    pem(sp('PGP ', 'PRIVATE', ' KEY BLOCK'), ['Version: x', '', ...lines(pemBody(300), 64)]),
  );
  add(
    'private-key-pem',
    'yaml block scalar, indented',
    `ssh:\n  private_key: |\n${[`-----BEGIN ${sp('RSA ', 'PRIVATE', ' KEY')}-----`, ...body, `-----END ${sp('RSA ', 'PRIVATE', ' KEY')}-----`].map((l) => `    ${l}`).join('\n')}\n`,
  );
  add(
    'private-key-pem',
    'json escaped newlines',
    JSON.stringify({ private_key: pem(sp('PRIVATE', ' KEY'), body) }),
  );
  add(
    'private-key-pem',
    'python concatenated literals',
    `KEY = (\n${[`-----BEGIN ${sp('RSA ', 'PRIVATE', ' KEY')}-----`, ...body, `-----END ${sp('RSA ', 'PRIVATE', ' KEY')}-----`].map((l) => `    "${l}\\n"`).join('\n')}\n)\n`,
  );
  add(
    'private-key-pem',
    'encrypted',
    pem(sp('ENCRYPTED ', 'PRIVATE', ' KEY'), lines(pemBody(500), 64)),
  );
  add(
    'private-key-pem',
    'blank line in body',
    pem(sp('RSA ', 'PRIVATE', ' KEY'), [...body.slice(0, 5), '', ...body.slice(5)]),
  );

  // ---- slack-token
  add(
    'slack-token',
    'bot env',
    `SLACK_BOT_TOKEN=${sp('xo', 'xb-')}${rand(DIGITS, 12)}-${rand(DIGITS, 13)}-${rand(ALNUM, 24)}\n`,
  );
  add(
    'slack-token',
    'user json',
    `{"slack": "${sp('xo', 'xp-')}${rand(DIGITS, 11)}-${rand(DIGITS, 11)}-${rand(ALNUM, 28)}"}`,
  );
  add(
    'slack-token',
    'app level',
    `app_token: ${sp('xa', 'pp-')}1-${rand(ALNUM, 11)}-${rand(DIGITS, 13)}-${rand(LOWER + DIGITS, 40)}\n`,
  );
  add(
    'slack-token',
    'curl',
    `curl -d token=${sp('xo', 'xs-')}${rand(DIGITS, 10)}-${rand(ALNUM, 30)} https://slack.com/api/auth.test`,
  );

  // ---- google-api-key
  add(
    'google-api-key',
    'url query',
    `https://maps.googleapis.com/maps/api/geocode/json?address=x&key=${sp('AI', 'za')}${rand(B64URL, 35)}`,
  );
  add(
    'google-api-key',
    'json',
    `{"apiKey": "${sp('AI', 'za')}${rand(B64URL, 35)}", "authDomain": "x.firebaseapp.com"}`,
  );
  add('google-api-key', 'env', `FIREBASE_KEY=${sp('AI', 'za')}${rand(B64URL, 35)}\n`);

  // ---- stripe-key
  add('stripe-key', 'live env', `STRIPE_SECRET=${sp('s', 'k_', 'live_')}${rand(ALNUM, 32)}\n`);
  add(
    'stripe-key',
    'test js',
    `const stripe = require('stripe')('${sp('s', 'k_', 'test_')}${rand(ALNUM, 40)}');`,
  );
  add('stripe-key', 'restricted yaml', `stripe: ${sp('r', 'k_', 'live_')}${rand(ALNUM, 50)}\n`);
  add(
    'stripe-key',
    'url',
    `https://${sp('s', 'k_', 'live_')}${rand(ALNUM, 28)}@api.stripe.com/v1/charges`,
  );

  // ---- jwt
  const jwt = (): string =>
    `${sp('ey', 'J')}${rand(B64URL, 30)}.${sp('ey', 'J')}${rand(B64URL, 60)}.${rand(B64URL, 43)}`;
  add('jwt', 'bearer header', `Authorization: Bearer ${jwt()}`);
  add('jwt', 'url query', `https://app.example.org/callback?access_token=${jwt()}&state=1`);
  add('jwt', 'json', `{"id_token":"${jwt()}"}`);
  add('jwt', 'env', `SESSION=${jwt()}\n`);

  // ---- aisdlc-canary
  add('aisdlc-canary', 'env', `CANARY=${sp('AISDLC', '_CANARY_')}${rand(UPPER + DIGITS, 24)}\n`);
  add(
    'aisdlc-canary',
    'markdown',
    `Notes: the value ${sp('AISDLC', '_CANARY_')}${rand(UPPER + DIGITS, 24)} was pasted here.`,
  );

  // ---- generic-high-entropy-assignment (quoted): random and word-like
  const key = (): string =>
    pick([
      'password',
      'passwd',
      'pwd',
      'secret',
      'api_key',
      'apikey',
      'token',
      'auth_token',
      'client_secret',
      'db_password',
      'passphrase',
    ]);
  const rv = (): string => rand(ALNUM + '!#%^&*-_', 24);
  add('generic-high-entropy-assignment', 'json random', `{"${key()}": "${rv()}"}`);
  add('generic-high-entropy-assignment', 'yaml quoted', `${key()}: '${rv()}'\n`);
  add('generic-high-entropy-assignment', 'python', `${key()} = "${rv()}"`);
  add('generic-high-entropy-assignment', 'js object', `const cfg = { ${key()}: '${rv()}' };`);
  add('generic-high-entropy-assignment', 'env quoted', `DB_PASSWORD="${rv()}"\n`);
  add('generic-high-entropy-assignment', 'ini quoted', `[mail]\n${key()} = "${rv()}"\n`);
  for (const [i, sep] of ['-', '', '.', '_', '-'].entries()) {
    const pw = words(4, sep);
    add(
      'generic-high-entropy-assignment',
      `words(4) sep=${JSON.stringify(sep)}`,
      `${i % 2 === 0 ? 'password' : 'db_password'}: "${pw}"\n`,
    );
  }
  add(
    'generic-high-entropy-assignment',
    'words(3)+digits',
    `{"password": "${words(3, '-')}-${rand(DIGITS, 4)}"}`,
  );
  add('generic-high-entropy-assignment', 'words(5)', `secret = '${words(5, '-')}'`);
  add('generic-high-entropy-assignment', 'words with symbol', `passphrase = "${words(3, '-')}!"`);
  add(
    'generic-high-entropy-assignment',
    'kebab lowercase long',
    `api_key: "${rand(LOWER, 6)}-${rand(LOWER, 6)}-${rand(LOWER, 6)}-${rand(DIGITS, 5)}"\n`,
  );

  // ---- generic-unquoted-assignment: .env, INI, YAML as files hold them
  add('generic-unquoted-assignment', 'env random', `DB_PASSWORD=${rand(ALNUM, 24)}\n`);
  add('generic-unquoted-assignment', 'env export', `export API_TOKEN=${rand(ALNUM + '_-', 32)}\n`);
  add(
    'generic-unquoted-assignment',
    'ini',
    `[database]\nhost = db\npassword = ${rand(ALNUM, 20)}\n`,
  );
  add('generic-unquoted-assignment', 'yaml', `database:\n  password: ${rand(ALNUM + '!%^', 22)}\n`);
  add(
    'generic-unquoted-assignment',
    'yaml nested secret',
    `auth:\n  client_secret: ${rand(B64URL, 40)}\n`,
  );
  add(
    'generic-unquoted-assignment',
    'env with comment',
    `SECRET_KEY_BASE=${rand(LOWER + DIGITS, 64)} # rails\n`,
  );
  add('generic-unquoted-assignment', 'env words', `APP_PASSWORD=${words(4, '-')}\n`);
  add('generic-unquoted-assignment', 'ini words', `[smtp]\npassword = ${words(4, '')}\n`);
  add('generic-unquoted-assignment', 'yaml words', `redis:\n  passphrase: ${words(4, '.')}\n`);
  add('generic-unquoted-assignment', 'crlf env', `API_KEY=${rand(ALNUM, 28)}\r\nDEBUG=1\r\n`);

  // ---- url-credentials: userinfo passwords in any scheme, in the shapes real leaks have
  const upw = (): string => rand(ALNUM + '-_.~', 18);
  const enc = (): string =>
    `${rand(ALNUM, 6)}%40${rand(ALNUM, 4)}%21${rand(DIGITS, 3)}%2F${rand(ALNUM, 3)}`;
  add(
    'url-credentials',
    'env postgres',
    `DATABASE_URL=${sp('post', 'gres')}://app:${upw()}@db.internal:5432/app\n`,
  );
  add(
    'url-credentials',
    'env mysql quoted',
    `export DB="${sp('my', 'sql')}://root:${upw()}@10.0.0.5/shop"\n`,
  );
  add(
    'url-credentials',
    'yaml mongodb+srv',
    `database:\n  uri: ${sp('mongodb', '+srv')}://svc:${upw()}@cluster0.${rand(LOWER, 5)}.example.net/prod\n`,
  );
  add(
    'url-credentials',
    'yaml redis empty user',
    `cache_url: ${sp('re', 'dis')}://:${upw()}@cache:6379/0\n`,
  );
  add(
    'url-credentials',
    'json amqp',
    JSON.stringify({ broker: `${sp('am', 'qp')}://guest:${upw()}@mq.internal:5672/%2F` }),
  );
  add(
    'url-credentials',
    'code connection string',
    `engine = create_engine("${sp('postgres', 'ql')}+psycopg2://web:${upw()}@db/app")`,
  );
  add(
    'url-credentials',
    'url-encoded password',
    `MONGO_URL=${sp('mongo', 'db')}://admin:${enc()}@mongo:27017/admin\n`,
  );
  add(
    'url-credentials',
    'https basic auth',
    `curl ${sp('ht', 'tps')}://deploy:${upw()}@artifacts.example.org/pkg.tgz`,
  );
  add('url-credentials', 'ftp', `${sp('f', 'tp')}://backup:${upw()}@files.example.org/dump`);
  add(
    'url-credentials',
    'smtp',
    `MAIL_URL=${sp('sm', 'tp')}://mailer:${upw()}@smtp.example.org:587\n`,
  );
  add(
    'url-credentials',
    'word-like password',
    `DATABASE_URL=${sp('post', 'gres')}://app:${words(4, '-')}@db/app\n`,
  );

  return out;
}

/** Benign lookalikes: each is something a scanned repo legitimately holds. */
export interface Benign {
  readonly kind: string;
  readonly text: string;
}

export function benignCorpus(): Benign[] {
  reseed(0xbe_1a19);
  const out: Benign[] = [];
  const add = (kind: string, text: string): number => out.push({ kind, text });
  const hex = (n: number): string => rand('0123456789abcdef', n);
  const uuid = (): string => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

  for (let i = 0; i < 9; i++) {
    add('uuid', `{"id": "${uuid()}", "request_id": "${uuid()}"}`);
    add('uuid assigned', `session_id = "${uuid()}"\ntoken_id: ${uuid()}\n`);
    add('git sha', `commit ${hex(40)}\nparent ${hex(40)}\n`);
    add('sha256 assigned', `checksum = "${hex(64)}"\nsha256: ${hex(64)}\n`);
    add('docker digest', `image: registry.example.org/app@sha256:${hex(64)}\n`);
    add('md5', `etag="${hex(32)}"`);
  }
  for (let i = 0; i < 6; i++) {
    add(
      'npm lockfile integrity',
      `    "node_modules/pkg${i}": {\n      "version": "1.${i}.0",\n      "resolved": "https://registry.npmjs.org/pkg${i}/-/pkg${i}-1.${i}.0.tgz",\n      "integrity": "sha512-${rand(B64, 86)}=="\n    },\n`,
    );
    add(
      'yarn lockfile',
      `"pkg@^1.${i}.0":\n  version "1.${i}.0"\n  integrity sha512-${rand(B64, 86)}==\n`,
    );
    add(
      'go.sum',
      `github.com/acme/lib v1.${i}.0 h1:${rand(B64, 43)}=\ngithub.com/acme/lib v1.${i}.0/go.mod h1:${rand(B64, 43)}=\n`,
    );
    add(
      'cargo.lock',
      `[[package]]\nname = "crate${i}"\nversion = "0.1.${i}"\nchecksum = "${hex(64)}"\n`,
    );
    add('base64 png', `<img src="data:image/png;base64,${rand(B64, 600)}==" alt="logo">`);
    add('base64 css', `background: url(data:image/svg+xml;base64,${rand(B64, 400)});`);
  }
  for (const p of [
    'changeme',
    'change-me-please-now',
    'your-password-here-1234',
    '<token>',
    '<your-api-key-here>',
    '${DATABASE_PASSWORD}',
    '${{ secrets.GITHUB_TOKEN }}',
    '{{ vault_db_password }}',
    '%DB_PASSWORD%',
    'xxxxxxxxxxxxxxxxxxxxxxxx',
    'example-secret-value-1234',
    'dummy-token-for-tests-0001',
    'sample_api_key_do_not_use',
    '',
  ]) {
    add('placeholder quoted', `password = "${p}"\n`);
    add('placeholder unquoted', `DB_PASSWORD=${p}\n`);
    add('placeholder yaml', `secret: ${p}\n`);
  }
  for (const code of [
    'token = process.env.GITHUB_ACCESS_TOKEN',
    'password = os.environ["DB_PASSWORD"]',
    'api_key = os.getenv("STRIPE_SECRET_KEY")',
    'const secret = settings.SECRET_KEY_BASE_VALUE;',
    'token = self.config.auth_token_value',
    'password = get_password_from_vault(user)',
    'password: !secret db_password_entry',
    'token = request.headers["authorization"]',
    'secret_key_ref = vault.read_secret_key',
    'export API_TOKEN="$(cat /run/secrets/api_token)"',
    'DB_PASSWORD_FILE=/run/secrets/db_password',
    'token_url: https://auth.example.org/oauth2/token',
    'passwordPolicy: minimum-length-twelve-characters',
    'secretName: my-application-tls-secret',
    'tokenizer = AutoTokenizer.from_pretrained("bert-base-uncased")',
    'const apiKeyHeaderName = "x-api-key";',
    'api_key_header: X-Api-Key-Header-Name',
    'password_field = forms.CharField(widget=forms.PasswordInput)',
  ]) {
    add('code or config reference', `${code}\n`);
  }
  for (const url of [
    'https://example.com/path/to/page',
    'https://example.com:8443/api/v1/items',
    'postgres://app@db.internal/app',
    'ssh://git@github.com/org/repo.git',
    'git@github.com:org/repo.git',
    'contact: someone@example.com',
    'redis://cache:6379/0',
    'https://user:@example.com/x',
    'postgres://app:password@db/app',
    'postgres://app:changeme@db/app',
    'postgres://app:${DB_PASSWORD}@db/app',
    'postgres://app:%DB_PASSWORD%@db/app',
    'postgres://app:<password>@db/app',
    'postgres://app:***@db/app',
    'postgres://app:$DB_PASS@db/app',
    'https://host:8080/a@b',
    'https://example.com/?next=a:b@c',
  ]) {
    add('url lookalike', `service_url: ${url}\n`);
    add('url lookalike env', `ENDPOINT=${url}\n`);
  }
  add('url lookalike ref', 'DATABASE_URL=${DATABASE_URL}\n');
  add('url lookalike ref', 'DATABASE_URL: ${{ secrets.DATABASE_URL }}\n');
  add('url lookalike ref', 'database_url = os.environ["DATABASE_URL"]\n');
  add(
    'prose',
    'Rotate the API key every 90 days and store the password in the vault, never in the repo.',
  );
  add(
    'hostname/url',
    'endpoint: https://api.example.org/v1/resources/identifiers/long-path-segment-here',
  );
  add(
    'public key',
    `-----BEGIN ${sp('PUBLIC', ' KEY')}-----\n${lines(pemBody(300), 64).join('\n')}\n-----END ${sp('PUBLIC', ' KEY')}-----`,
  );
  add(
    'certificate',
    `-----BEGIN CERTIFICATE-----\n${lines(pemBody(900), 64).join('\n')}\n-----END CERTIFICATE-----`,
  );
  add(
    'ssh public key',
    `ssh-ed25519 ${sp('AAAAC3Nza', 'C1lZDI1NTE5')}${rand(B64, 43)} deploy@host`,
  );
  return out;
}

export const RULE_IDS: readonly string[] = RULES.map((r) => r.id);
