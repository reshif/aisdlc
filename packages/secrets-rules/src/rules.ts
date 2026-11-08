// The ONE shared secret ruleset (PLAN §3 `secrets-rules`; OB §5.3 item 9, §11 row 4): used by the
// knowledge scan (M6.2), and later by the push broker and S7 7.4. Never a second list anywhere.
//
// A rule: an id, a description, a regex run over the whole text of a blob (so a PEM block can span
// lines), a keyword prefilter (the regex only runs on text that contains one of the keywords,
// case-insensitively), an optional entropy floor for the secret itself, and fixtures. Every
// quantifier is bounded, so a hostile blob cannot make a rule run for long.
//
// FIXTURES ARE BUILT AT RUN TIME FROM PARTS (`cat`), never written out, so this repository never
// holds a token-shaped string (push protection, and the repo self-test, would trip on one). The
// values are obviously fake and, where a provider has a documented live format, only shaped like it.

export interface RuleFixtures {
  /** Texts the rule must match (at least once). */
  readonly positive: () => readonly string[];
  /** Texts the rule must not match. */
  readonly negative: () => readonly string[];
}

export interface SecretRule {
  readonly id: string;
  readonly description: string;
  /** Global. The secret is `secretGroup` of a match (default: the whole match). */
  readonly regex: RegExp;
  /** Lowercase. Empty: no prefilter. */
  readonly keywords: readonly string[];
  readonly secretGroup?: number;
  /** Minimum Shannon entropy (bits per character) of the secret. */
  readonly entropy?: number;
  /** A secret matching any of these is a placeholder, not a finding. */
  readonly allow?: readonly RegExp[];
  readonly fixtures: RuleFixtures;
}

/** Joins parts: how fixtures avoid ever holding a token-shaped literal. */
const cat = (...parts: string[]): string => parts.join('');
/** `n` characters cycling through `alphabet`: deterministic, obviously not a real credential. */
const fill = (alphabet: string, n: number): string =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join('');
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const PLACEHOLDER =
  /(?:example|placeholder|changeme|change-me|dummy|sample|your[_-]|xxxx|<[a-z_ -]+>)/i;

/** A value that is a reference to a secret held elsewhere, never the secret: `${VAR}`, `{{ var }}`, `%VAR%`, `<token>`. */
const REFERENCE: readonly RegExp[] = [
  /^\$\{[A-Za-z_][A-Za-z0-9_.:-]{0,80}\}$/,
  /^\{\{[^{}]{1,80}\}\}$/,
  /^%[A-Za-z_][A-Za-z0-9_]{0,80}%$/,
  /^<[^<>\s]{1,80}>$/,
];

/** A password part that is an obvious stand-in, not a secret. */
const URL_PASSWORD_PLACEHOLDER =
  /^(?:password|passwd|pass|pwd|secret|changeme|change-me|redacted|username|your[_-]?password|\*+|x+|\.{3,})$/i;

/** `process.env.X`, `os.environ.X`, `settings.X`: reading a secret from somewhere, not holding one. */
const ACCESSOR_CHAIN =
  /^(?:process\.env|os\.environ|os\.getenv|ENV|env|settings|config|self|this|args|opts|options|params|secrets|vault|context|req|request)\.[A-Za-z_][\w.]*$/;

/**
 * Floor for the generic rules, in bits per character. Random credentials sit above 4; a password
 * made of a few repeated words sits near 3.2. Placeholders and references are removed by `allow`,
 * not by a high floor.
 */
const GENERIC_ENTROPY = 3;

export const RULES: readonly SecretRule[] = [
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id (AKIA, ASIA, ABIA, ACCA prefixes)',
    regex: /\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/g,
    keywords: ['akia', 'asia', 'abia', 'acca'],
    secretGroup: 1,
    fixtures: {
      positive: () => [
        `key_id = ${cat('AK', 'IA', fill('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16))}`,
        `{"id":"${cat('AS', 'IA', fill('QWERTYUIOPASDFGH', 16))}"}`,
      ],
      negative: () => [
        cat('AK', 'IA', 'TOOSHORT'),
        cat('ak', 'ia', fill('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16)),
        cat('AK', 'IA', fill('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16), 'ZZZ'),
      ],
    },
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key assigned to an aws-named variable',
    regex:
      /aws[\w ]{0,24}(?:secret|private)[\w ]{0,24}["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi,
    keywords: ['aws'],
    secretGroup: 1,
    entropy: 3.5,
    fixtures: {
      positive: () => [
        cat(
          'aws_secret',
          '_access_key = "',
          'wJalrXUtnFEMI',
          '/K7MDENG/',
          'bPxRfiCYEXAMPLEKEY',
          '"',
        ),
        cat('AWS_SECRET', '_ACCESS_KEY=', fill(ALNUM, 40)),
      ],
      negative: () => [
        cat('aws_secret', '_access_key = "', 'a'.repeat(40), '"'),
        cat('aws_region = "', 'eu-west-1', '"'),
        cat('secret_access_key = "', fill(ALNUM, 40), '"'),
      ],
    },
  },
  {
    id: 'github-token',
    description: 'GitHub token (ghp_, gho_, ghu_, ghs_, ghr_ prefixes)',
    regex: /\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/g,
    keywords: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'],
    secretGroup: 1,
    fixtures: {
      positive: () =>
        ['p', 'o', 'u', 's', 'r'].map((k) => `token ${cat('gh', k, '_', fill(ALNUM, 36))}`),
      negative: () => [
        cat('gh', 'p_', 'short'),
        cat('gh', 'x_', fill(ALNUM, 36)),
        'ghp is a prefix',
      ],
    },
  },
  {
    id: 'github-fine-grained-pat',
    description: 'GitHub fine-grained personal access token (github_pat_)',
    regex: /\b(github_pat_[A-Za-z0-9_]{50,255})\b/g,
    keywords: ['github_pat_'],
    secretGroup: 1,
    fixtures: {
      positive: () => [cat('github', '_pat_', fill(ALNUM, 22), '_', fill(ALNUM, 59))],
      negative: () => [cat('github', '_pat_', 'short'), 'the github_pat_ prefix'],
    },
  },
  {
    id: 'private-key-pem',
    description: 'PEM private key block (RSA, EC, DSA, OpenSSH, PGP, PKCS8, encrypted)',
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{16,8192}?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    keywords: ['private key-----', 'private key block-----'],
    fixtures: {
      positive: () => {
        const body = `${fill(ALNUM, 64)}\n${fill(ALNUM, 64)}`;
        return [
          cat(
            '-----BEGIN ',
            'RSA PRIVATE',
            ' KEY-----\n',
            body,
            '\n-----END ',
            'RSA PRIVATE',
            ' KEY-----',
          ),
          cat(
            '-----BEGIN ',
            'PRIVATE',
            ' KEY-----\n',
            body,
            '\n-----END ',
            'PRIVATE',
            ' KEY-----\n',
          ),
          cat(
            '-----BEGIN ',
            'OPENSSH PRIVATE',
            ' KEY-----\n',
            body,
            '\n-----END ',
            'OPENSSH PRIVATE',
            ' KEY-----',
          ),
        ];
      },
      negative: () => [
        cat(
          '-----BEGIN ',
          'PUBLIC',
          ' KEY-----\n',
          fill(ALNUM, 64),
          '\n-----END ',
          'PUBLIC',
          ' KEY-----',
        ),
        cat('-----BEGIN ', 'PRIVATE', ' KEY-----'),
        'a private key is needed here',
      ],
    },
  },
  {
    id: 'slack-token',
    description: 'Slack token (xoxa, xoxb, xoxp, xoxr, xoxs, xapp)',
    regex: /\b((?:xox[abprs]|xapp)-[A-Za-z0-9-]{10,72})\b/g,
    keywords: ['xox', 'xapp-'],
    secretGroup: 1,
    fixtures: {
      positive: () => [
        cat('xo', 'xb-', '1234567890-', fill(ALNUM, 24)),
        cat('xa', 'pp-', '1-', fill(ALNUM, 30)),
      ],
      negative: () => [
        cat('xo', 'xb-', 'short'),
        cat('xo', 'xz-', fill(ALNUM, 24)),
        'xoxo gossip girl',
      ],
    },
  },
  {
    id: 'google-api-key',
    description: 'Google API key (AIza)',
    regex: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
    keywords: ['aiza'],
    secretGroup: 1,
    fixtures: {
      positive: () => [`key=${cat('AI', 'za', fill(ALNUM, 35))}`],
      negative: () => [cat('AI', 'za', 'short'), cat('ai', 'za', fill(ALNUM, 35))],
    },
  },
  {
    id: 'stripe-key',
    description: 'Stripe secret or restricted key (sk_/rk_ live or test)',
    regex: /\b((?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{24,99})\b/g,
    keywords: ['sk_live_', 'sk_test_', 'rk_live_', 'rk_test_'],
    secretGroup: 1,
    fixtures: {
      positive: () => [
        cat('s', 'k_', 'live_', fill(ALNUM, 24)),
        cat('r', 'k_', 'test_', fill(ALNUM, 30)),
      ],
      negative: () => [cat('s', 'k_', 'live_', 'short'), cat('p', 'k_', 'live_', fill(ALNUM, 24))],
    },
  },
  {
    id: 'jwt',
    description: 'JSON Web Token (three base64url segments, header and payload starting eyJ)',
    regex: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    keywords: ['eyj'],
    secretGroup: 1,
    fixtures: {
      positive: () => [
        cat('ey', 'J', fill(ALNUM, 20), '.', 'ey', 'J', fill(ALNUM, 24), '.', fill(ALNUM, 24)),
      ],
      negative: () => [
        cat('ey', 'J', fill(ALNUM, 20), '.', fill(ALNUM, 24)),
        cat('ey', 'J', 'short', '.', 'ey', 'J', 'short', '.', 'short'),
      ],
    },
  },
  {
    id: 'generic-high-entropy-assignment',
    description:
      'High-entropy string assigned to a variable named api key, secret, token or password',
    regex:
      /(?:api[_-]?key|secret|token|passw(?:or)?d|passphrase|pwd)(?![\w.-]{0,20}?(?:id|ids|name|url|uri|ref|file|path|type|field|header|endpoint|policy|length)[ \t]*["']?[ \t]*[:=])[\w-]{0,20}["']?\s*[:=]\s*["']([^"'\s]{16,128})["']/gi,
    keywords: ['api', 'secret', 'token', 'passw', 'passphrase', 'pwd'],
    secretGroup: 1,
    entropy: GENERIC_ENTROPY,
    // Explicit placeholders and structural references only (`changeme`, `<token>`, `${VAR}`,
    // `{{ var }}`, `%VAR%`). There is NO skip for word-like values: a password made of words
    // ("Correct-Horse-Battery-Staple") is a real secret shape, and the repo self-test excludes its
    // own fixture paths instead of the rule weakening detection in every scanned repo (PLAN M6.2b).
    allow: [PLACEHOLDER, ...REFERENCE],
    fixtures: {
      positive: () => [
        cat('api_key', ' = "', 'k8Zq3vN7xW2mB9tR5yL1pC6dF4hJ0sGa', '"'),
        cat('{"pass', 'word": "', 'Zx9!Qw3#Er5$Ty7%Ui1&Op', '"}'),
        cat('sec', "ret: '", 'v3Rx9Lm2Qz7Wc5Tn8Bk4Hd', "'"),
      ],
      negative: () => [
        cat('pass', 'word = "', 'changeme-placeholder', '"'),
        cat('to', 'ken = process.env.', 'TOKEN'),
        cat('sec', 'ret: "', 'a'.repeat(32), '"'),
        cat('api_key', ' = "', 'short', '"'),
        cat('pass', 'word = "', '${DATABASE_PASSWORD_VALUE}', '"'),
      ],
    },
  },
  {
    id: 'generic-unquoted-assignment',
    description:
      'High-entropy unquoted value on a whole-line `key = value` or `key: value` (.env, INI, YAML) whose key names an api key, secret, token, password or passphrase',
    regex:
      /^[ \t]*(?:export[ \t]+)?[\w.-]{0,40}?(?:api[_-]?key|secret|token|passw(?:or)?d|passphrase|pwd)(?![\w.-]{0,20}?(?:id|ids|name|url|uri|ref|file|path|type|field|header|endpoint|policy|length)[ \t]*["']?[ \t]*[:=])[\w.-]{0,20}[ \t]*[:=][ \t]*([^\s"'#;,(){}<>[\]]{16,128})[ \t]*(?:[#;].*)?$/gim,
    keywords: ['api', 'secret', 'token', 'passw', 'passphrase', 'pwd'],
    secretGroup: 1,
    entropy: GENERIC_ENTROPY,
    // As the quoted rule: placeholders and references only. Code that reads a secret from the
    // environment or a settings object is an accessor chain, not a value.
    allow: [PLACEHOLDER, ...REFERENCE, ACCESSOR_CHAIN],
    fixtures: {
      positive: () => [
        cat('DB_PASS', 'WORD=', 'n4Xv8Qz2Lr6Tm1Wb9Kc3'),
        cat('api_', 'key: ', 'h7Yd2Pq9Vs4Nx8Zc1Mb5'),
        cat('[db]\npass', 'word = ', 'Lq3Zr8Xv2Nm7Tc4Wk9Hd'),
      ],
      negative: () => [
        cat('DB_PASS', 'WORD=', '${DATABASE_PASSWORD_VALUE}'),
        cat('to', 'ken = process.env.', 'GITHUB_ACCESS_TOKEN'),
        cat('pass', 'word: ', 'a'.repeat(24)),
        cat('api_', 'key = ', 'short'),
        cat('to', 'ken = ', 'x'.repeat(8), ' # a comment'),
      ],
    },
  },
  {
    id: 'url-credentials',
    description:
      'Password in the userinfo of a URL (scheme://user:password@host: postgres, mysql, mongodb, redis, amqp, https, ftp, smtp, any scheme)',
    // Provider-independent and NOT subject to the generic rules' key-name exclusion: a
    // `DATABASE_URL=` or `*_url:` key still holds a secret when its value carries a password.
    regex:
      /\b[a-z][a-z0-9+.-]{1,19}:\/\/[^\s:@/?#"'<>]{0,64}:([^\s@/?#"'<>]{1,128})@[^\s/?#"'<>]{1,255}/gi,
    keywords: ['://'],
    secretGroup: 1,
    // Only obvious placeholders in the password part (an empty password does not match at all).
    allow: [
      URL_PASSWORD_PLACEHOLDER,
      ...REFERENCE,
      /^\$[A-Za-z_][A-Za-z0-9_]*$/,
      /^\$\([^)]{1,80}\)$/,
    ],
    fixtures: {
      positive: () => [
        cat('postgres', '://app:', 'Zq7!xW2mB9tR', '@db.internal:5432/app'),
        cat('mongodb+srv', '://u:', 'p4Ss%40w0rd%21', '@cluster0.example.net/db'),
        cat('DATABASE_URL=', 'redis', '://default:', 'hunter2hunter2', '@cache:6379/0'),
      ],
      negative: () => [
        cat('https', '://example.com/path'),
        cat('postgres', '://app@db.internal/app'),
        cat('postgres', '://app:', 'password', '@db/app'),
        cat('amqp', '://u:', '${AMQP_PASSWORD}', '@mq/'),
        cat('git@github.com', ':org/repo.git'),
        cat('https', '://host:8080/a@b'),
      ],
    },
  },
  {
    id: 'aisdlc-canary',
    description:
      'Factory-only canary (AISDLC_CANARY_ + 24 of [A-Z0-9]); never a real-provider format',
    regex: /\b(AISDLC_CANARY_[A-Z0-9]{24})\b/g,
    keywords: ['aisdlc_canary_'],
    secretGroup: 1,
    fixtures: {
      positive: () => [
        cat('AISDLC', '_CANARY', '_', fill(UPPER_DIGITS, 24)),
        `canary=${cat('AISDLC', '_CANARY', '_', 'ABCDEFGHIJKLMNOP01234567')}`,
      ],
      negative: () => [
        cat('AISDLC', '_CANARY', '_', 'SHORT'),
        cat('aisdlc', '_canary', '_', fill(UPPER_DIGITS, 24)),
        cat('AISDLC', '_CANARY', '_', fill(UPPER_DIGITS, 24).toLowerCase()),
      ],
    },
  },
];
