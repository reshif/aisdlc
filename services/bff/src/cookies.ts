// Cookies by hand: the bff needs three attributes done exactly right and no other feature, so it
// carries no cookie library.

export interface CookieOptions {
  readonly secure: boolean;
  /** Seconds; omitted: a session cookie. 0 deletes. */
  readonly maxAge?: number;
}

/**
 * HttpOnly (script cannot read it), SameSite=Lax (not sent on cross-site POSTs; sent on the
 * top-level GET of the OIDC redirect back), Path=/ and Secure unless local plain http is configured.
 */
export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (o.secure) parts.push('Secure');
  if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
  return parts.join('; ');
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** `__Host-` pins a cookie to the exact host, Secure, Path=/ and no Domain. Only valid with Secure. */
export const cookieName = (base: string, secure: boolean): string =>
  secure ? `__Host-${base}` : base;
