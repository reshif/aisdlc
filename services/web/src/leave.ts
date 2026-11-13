/**
 * The portal leaves for another document: the sign-in (the bff's `/auth/login`, then the identity provider) or the
 * identity provider's logout. One place, so tests can watch it (jsdom does not navigate). `replace` keeps the page
 * that sent the browser away out of the history, so Back does not bounce through it again.
 */
export function leave(url: string, how: 'assign' | 'replace' = 'assign'): void {
  if (how === 'replace') window.location.replace(url);
  else window.location.assign(url);
}
