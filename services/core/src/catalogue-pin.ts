import { CATALOGUE, currentCatalogueRef } from '@aisdlc/catalogue';
import { pinCatalogue, type CataloguePin } from '@aisdlc/config';
import { err, ok, type Result } from '@aisdlc/kernel';
import { coreError, type CoreError } from './errors.js';
import { clockOf, type CoreDeps } from './journal.js';

// Portal v2: what a NEW request, item or S0 record pins is the catalogue the published factory settings make (the code
// release when they change nothing; a settings release `<base>+settings.<n>` when they change a section). Read before
// the request's transaction. Fail closed: settings that do not read, or a release that cannot be recorded, refuse the
// request (`unavailable`), never a pin of another catalogue.

export async function catalogueForNew(deps: CoreDeps): Promise<Result<CataloguePin, CoreError>> {
  try {
    const p = await pinCatalogue(deps.pool, clockOf(deps));
    return p.ok ? ok(p.value) : err(coreError('unavailable', p.error.message));
  } catch (e) {
    return err(
      coreError('unavailable', `catalogue pin: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}

/**
 * The catalogue the floor and the fleet draw (display only, never a pin): the factory's current one, or the code
 * release when it cannot be read (the drawing is then of what the code ships, and nothing is decided by it).
 */
export async function displayCatalogue(pool: CoreDeps['pool']): Promise<CataloguePin> {
  try {
    const p = await pinCatalogue(pool);
    if (p.ok) return p.value;
  } catch {
    // fall through
  }
  return { ref: currentCatalogueRef(), data: CATALOGUE };
}
