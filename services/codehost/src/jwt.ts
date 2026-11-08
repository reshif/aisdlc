import type { AppKey } from './app-key.js';

const b64url = (s: string | Buffer): string => Buffer.from(s).toString('base64url');

/** GitHub accepts a JWT for at most 10 minutes; `iat` is set back a minute for clock drift. */
export const JWT_BACKDATE_SECONDS = 60;
export const JWT_LIFETIME_SECONDS = 9 * 60;

/** The App JWT (RS256) that authenticates the App itself, never an installation. */
export function appJwt(key: AppKey, appId: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - JWT_BACKDATE_SECONDS;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iat, exp: iat + JWT_BACKDATE_SECONDS + JWT_LIFETIME_SECONDS, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${b64url(key.signRs256(signingInput))}`;
}
