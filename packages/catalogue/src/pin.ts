import { CatalogueRef } from '@aisdlc/contracts';
import { CATALOGUE, catalogueHash } from './catalogue.js';

let cached: CatalogueRef | undefined;

/**
 * The pin a new request, item or S0 record stores (M1.6): this catalogue's version and the hash of
 * its data. Items keep the pin they started with; a later catalogue does not move them.
 */
export function currentCatalogueRef(): CatalogueRef {
  cached ??= CatalogueRef.parse({ version: CATALOGUE.version, hash: catalogueHash() });
  return { ...cached };
}

/** True when `ref` is the pin of the catalogue this build carries. */
export function isCurrentCatalogue(ref: CatalogueRef): boolean {
  const cur = currentCatalogueRef();
  return ref.version === cur.version && ref.hash === cur.hash;
}
