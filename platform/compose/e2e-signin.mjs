// The identity provider's side of a browser sign-in, for the compose e2e runs (e2e-pr.mjs, e2e-portal.mjs).
//
// Keycloak (the stack's IdP, portal v2): its login page at http://keycloak.localhost:<port>/realms/aisdlc/... with
// Keycloak's own field ids (username, password, kc-login, kept by the AISDLC theme); every test person's username is
// their principal id and their password is the local stack's test-people password (secrets/keycloak-persona-password,
// read here, never printed). E2E_IDP=dev drives the dev IdP of the `dev-oidc` test profile instead (its user picker).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The page is the IdP's (its console messages are not the portal's). */
export const IDP_URL = /(keycloak|dev-oidc)\.localhost:\d+\//;

const subjectOf = (who) => {
  const order = ['alice', 'bob', 'lt', 'oh', 'rb', 'ar', 'pm', 'dn', 'ks', 'jm', 'mw', 'nf', 'tb'];
  const n = order.indexOf(who) + 1;
  if (n === 0) throw new Error(`no dev IdP subject for ${who}`);
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
};

/**
 * Signs `who` in at the IdP the browser was just sent to (a sign-in or a step-up re-login), then leaves the browser on
 * its way back to the portal.
 */
export async function idpSignIn(page, who, composeDir) {
  if (process.env.E2E_IDP === 'dev') {
    await page.waitForURL(/dev-oidc\.localhost:\d+\/authorize/);
    await page.locator('select[name=dev_user]').selectOption(subjectOf(who));
    await page.getByRole('button', { name: 'Sign in' }).click();
    return;
  }
  await page.waitForURL(/keycloak\.localhost:\d+\/realms\/aisdlc\//);
  const file = join(
    composeDir,
    'secrets',
    who === 'factory-admin' ? 'keycloak-factory-admin-password' : 'keycloak-persona-password',
  );
  const password = readFileSync(file, 'utf8').trim();
  const user = page.locator('#username');
  if ((await user.count()) > 0) await user.fill(who);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
}
