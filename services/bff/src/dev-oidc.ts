import { readFileSync } from 'node:fs';
import {
  ServiceConfigError,
  listenConfig,
  requiredEnv,
  resolveSecretRef,
  runService,
} from '@aisdlc/service-kit';
import { z } from 'zod';
import { startDevOidcProvider } from './dev-oidc/provider.js';

// The dev identity provider as a process (local development only):
//   DEV_OIDC_USERS_FILE    JSON [{subject, name, email?}]
//   DEV_OIDC_CLIENT_ID, DEV_OIDC_CLIENT_SECRET_REF (env:/file:), DEV_OIDC_REDIRECT_URIS (comma list)
//   DEV_OIDC_ISSUER        optional; default the URL it listens on
//   DEV_OIDC_HOST / _PORT  default 127.0.0.1:8350
// It refuses to start unless FACTORY_ENV=local.

const Users = z.array(
  z.strictObject({
    subject: z.string().min(1),
    name: z.string().min(1),
    email: z.string().optional(),
  }),
);

await runService('dev-oidc', async () => {
  if (process.env['FACTORY_ENV'] !== 'local') {
    throw new ServiceConfigError('the dev OIDC provider runs only with FACTORY_ENV=local');
  }
  const file = requiredEnv(process.env, 'DEV_OIDC_USERS_FILE');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new ServiceConfigError(`${file} is not readable JSON`, { cause });
  }
  const users = Users.safeParse(raw);
  if (!users.success) throw new ServiceConfigError(`${file}: ${users.error.message}`);
  const listenOpts = listenConfig(process.env, 'DEV_OIDC', 8350);
  const p = await startDevOidcProvider({
    users: users.data.map((u) => ({
      subject: u.subject,
      name: u.name,
      ...(u.email ? { email: u.email } : {}),
    })),
    clients: [
      {
        client_id: requiredEnv(process.env, 'DEV_OIDC_CLIENT_ID'),
        client_secret: resolveSecretRef(requiredEnv(process.env, 'DEV_OIDC_CLIENT_SECRET_REF')),
        redirect_uris: requiredEnv(process.env, 'DEV_OIDC_REDIRECT_URIS')
          .split(',')
          .map((s) => s.trim()),
      },
    ],
    ...(process.env['DEV_OIDC_ISSUER'] ? { issuer: process.env['DEV_OIDC_ISSUER'] } : {}),
    ...listenOpts,
  });
  return { url: p.url, close: () => p.stop() };
});
