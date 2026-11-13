import { createPublicKey, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';

// The GitHub App manifest flow on the fake GitHub (the wizard `platform/compose/setup-github-apps` is tested against
// it): the web side (`POST /settings/apps/new` and `/organizations/:org/settings/apps/new` with a `manifest` form field,
// `GET /apps/:slug/installations/new`) and the API side (`POST /app-manifests/:code/conversions`, and for an App made
// here `GET /app/installations/:id` and `POST /app/installations/:id/access_tokens` with its JWT). Where github.com
// shows a page for a person to confirm, the fake confirms at once and redirects, as the person's click would.
//
// An App made here is held in memory with its PUBLIC key only; the private key is in the conversion's answer and
// nowhere else, as on GitHub.

/** What a manifest the wizard posted said (kept for tests: the permissions and URLs it asked for). */
export interface FakeManifest {
  readonly name: string;
  readonly url: string;
  readonly public: boolean;
  readonly redirect_url: string;
  readonly setup_url?: string;
  readonly setup_on_update?: boolean;
  readonly hook_attributes: { readonly url?: string; readonly active: boolean };
  readonly default_permissions: Readonly<Record<string, string>>;
  readonly default_events: readonly string[];
  readonly request_oauth_on_install?: boolean;
  readonly callback_urls?: readonly string[];
}

export interface FakeManifestApp {
  readonly id: number;
  readonly slug: string;
  readonly owner: string;
  readonly manifest: FakeManifest;
  readonly publicKeyPem: string;
}

export interface FakeManifestInstallation {
  readonly id: number;
  readonly app_id: number;
  readonly account_login: string;
  repository_selection: 'selected' | 'all';
  permissions: Record<string, string>;
  readonly repositories: readonly string[];
}

/** What the server lends the flow: who the account is, its repositories, and where tokens are recorded. */
export interface FakeManifestHost {
  readonly account: string;
  readonly repos: () => readonly string[];
  readonly now: () => Date;
  readonly issue: (t: {
    token: string;
    permissions: Record<string, string>;
    expires_at: Date;
    app_id: number;
  }) => void;
}

interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly location?: string;
}

const notFound: Reply = { status: 404, body: { message: 'Not Found' } };

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

export class FakeManifestFlow {
  /** Every manifest posted, in order. */
  readonly manifests: FakeManifest[] = [];
  readonly apps: FakeManifestApp[] = [];
  readonly installations: FakeManifestInstallation[] = [];
  private readonly codes = new Map<string, { manifest: FakeManifest; owner: string }>();
  private nextApp = 1001;
  private nextInstallation = 101;
  /**
   * How the next installation is made (a person's choices on the install page): `all` repositories instead of the
   * selected ones, permissions granted beyond the manifest's (a person who edited the App afterwards).
   */
  installAs: { selection?: 'selected' | 'all'; extra?: Record<string, string> } = {};

  constructor(private readonly host: FakeManifestHost) {}

  /** Answers a request of the flow, or `null` when it is not one. */
  handle(method: string, url: URL, body: string, authorization: string | undefined): Reply | null {
    const path = url.pathname;
    const create = /^(?:\/organizations\/([^/]+))?\/settings\/apps\/new$/.exec(path);
    if (create) {
      if (method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
      return this.created(new URLSearchParams(body), url.searchParams.get('state'), create[1]);
    }
    const conv = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (conv) {
      if (method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
      return this.convert(conv[1] as string);
    }
    const inst = /^\/apps\/([^/]+)\/installations\/new$/.exec(path);
    if (inst) {
      if (method !== 'GET') return { status: 405, body: { message: 'Method Not Allowed' } };
      return this.install(inst[1] as string, url.searchParams.get('state'));
    }
    const m = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(path);
    if (m) {
      const app = this.jwtApp(authorization);
      if (!app) return null; // not an App of this flow: the server's own Apps answer
      const i = this.installations.find((x) => x.id === Number(m[1]) && x.app_id === app.id);
      if (!i) return notFound;
      if (m[2] === undefined) {
        if (method !== 'GET') return { status: 405, body: { message: 'Method Not Allowed' } };
        return { status: 200, body: this.installationJson(i) };
      }
      if (method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
      return this.mint(i, body);
    }
    return null;
  }

  private created(form: URLSearchParams, state: string | null, org: string | undefined): Reply {
    let manifest: FakeManifest;
    try {
      manifest = JSON.parse(form.get('manifest') ?? '') as FakeManifest;
    } catch {
      return { status: 422, body: { message: 'Invalid manifest' } };
    }
    if (
      typeof manifest.name !== 'string' ||
      manifest.name.length === 0 ||
      manifest.name.length > 34 ||
      typeof manifest.url !== 'string' ||
      typeof manifest.redirect_url !== 'string' ||
      typeof manifest.default_permissions !== 'object' ||
      manifest.default_permissions === null
    ) {
      return { status: 422, body: { message: 'Invalid manifest' } };
    }
    this.manifests.push(manifest);
    const code = randomBytes(10).toString('hex');
    this.codes.set(code, { manifest, owner: org ?? this.host.account });
    const to = new URL(manifest.redirect_url);
    to.searchParams.set('code', code);
    if (state !== null) to.searchParams.set('state', state);
    return { status: 302, location: to.toString() };
  }

  private convert(code: string): Reply {
    const pending = this.codes.get(code);
    if (!pending) return notFound;
    this.codes.delete(code); // a code converts once
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const id = this.nextApp++;
    const slug = pending.manifest.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const app: FakeManifestApp = {
      id,
      slug,
      owner: pending.owner,
      manifest: pending.manifest,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
    this.apps.push(app);
    return {
      status: 201,
      body: {
        id,
        slug,
        node_id: `A_${id}`,
        name: pending.manifest.name,
        owner: { login: pending.owner, type: 'User' },
        external_url: pending.manifest.url,
        html_url: `https://github.com/apps/${slug}`,
        permissions: { ...pending.manifest.default_permissions },
        events: [...(pending.manifest.default_events ?? [])],
        client_id: `Iv1.${randomBytes(8).toString('hex')}`,
        client_secret: randomBytes(20).toString('hex'),
        webhook_secret: null,
        pem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
      },
    };
  }

  private install(slug: string, state: string | null): Reply {
    const app = this.apps.find((a) => a.slug === slug);
    if (!app) return notFound;
    const i: FakeManifestInstallation = {
      id: this.nextInstallation++,
      app_id: app.id,
      account_login: app.owner,
      repository_selection: this.installAs.selection ?? 'selected',
      permissions: { ...app.manifest.default_permissions, ...(this.installAs.extra ?? {}) },
      repositories: [...this.host.repos()],
    };
    this.installations.push(i);
    const back = app.manifest.setup_url;
    if (!back) return { status: 200, body: { installed: i.id } };
    const to = new URL(back);
    to.searchParams.set('installation_id', String(i.id));
    to.searchParams.set('setup_action', 'install');
    if (state !== null) to.searchParams.set('state', state);
    return { status: 302, location: to.toString() };
  }

  private installationJson(i: FakeManifestInstallation): Record<string, unknown> {
    return {
      id: i.id,
      app_id: i.app_id,
      app_slug: this.apps.find((a) => a.id === i.app_id)?.slug,
      account: { login: i.account_login, type: 'User' },
      repository_selection: i.repository_selection,
      permissions: { ...i.permissions },
      events: [],
      suspended_at: null,
      target_type: 'User',
    };
  }

  private mint(i: FakeManifestInstallation, body: string): Reply {
    let asked: Record<string, string>;
    try {
      asked =
        (JSON.parse(body || '{}') as { permissions?: Record<string, string> }).permissions ?? {};
    } catch {
      return { status: 400, body: { message: 'Problems parsing JSON' } };
    }
    for (const [name, level] of Object.entries(asked)) {
      if ((LEVEL[i.permissions[name] ?? ''] ?? 0) < (LEVEL[level] ?? 99)) {
        return {
          status: 422,
          body: { message: 'The permissions requested are not granted to this installation.' },
        };
      }
    }
    const permissions = Object.keys(asked).length > 0 ? asked : { ...i.permissions };
    const expires = new Date(this.host.now().getTime() + 3_600_000);
    const token = `ghs_${randomBytes(27).toString('base64url')}`;
    this.host.issue({ token, permissions, expires_at: expires, app_id: i.app_id });
    return {
      status: 201,
      body: {
        token,
        expires_at: expires.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        permissions,
        repository_selection: i.repository_selection,
      },
    };
  }

  /** The App of this flow an `Authorization: Bearer <jwt>` verifies for, or `null`. */
  private jwtApp(authorization: string | undefined): FakeManifestApp | null {
    const m = /^Bearer (\S+\.\S+\.\S+)$/.exec(authorization ?? '');
    if (!m) return null;
    const [h, p, s] = (m[1] as string).split('.') as [string, string, string];
    let claims: { iss?: unknown; iat?: unknown; exp?: unknown };
    try {
      claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as typeof claims;
    } catch {
      return null;
    }
    const app = this.apps.find((a) => String(a.id) === String(claims.iss));
    if (!app) return null;
    const now = Math.floor(this.host.now().getTime() / 1000);
    let signed: boolean;
    try {
      signed = createVerify('RSA-SHA256')
        .update(`${h}.${p}`)
        .verify(createPublicKey(app.publicKeyPem), Buffer.from(s, 'base64url'));
    } catch {
      signed = false;
    }
    const ok =
      signed &&
      typeof claims.iat === 'number' &&
      typeof claims.exp === 'number' &&
      claims.iat <= now + 60 &&
      claims.exp > now &&
      claims.exp - claims.iat <= 11 * 60;
    return ok ? app : null;
  }
}
