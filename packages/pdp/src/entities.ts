import {
  ROLE_CATALOGUE,
  gateAttributes,
  pdpResource,
  resourceParents,
  roleDef,
  roleMayBindAt,
  type PdpResource,
  type RoleDef,
} from '@aisdlc/contracts';
import type { PdpPrincipalFacts } from '@aisdlc/ports';
import type { CedarEntity, CedarUid } from './cedar.js';

// The Cedar entities of one request: the principal (in a Role for every in-force binding that
// covers the resource, and in the Group the binding comes through), and the resource with the
// containers above it. A binding of an unknown role, or at a scope kind the role cannot be bound
// at, contributes nothing: unknown means unmet.

const uid = (type: string, id: string): CedarUid => ({ type, id });

function resourceEntity(r: PdpResource): CedarEntity {
  return {
    uid: uid(r.type, r.id),
    attrs: r.type === 'Gate' && r.gate_id !== null ? gateAttributes(r.gate_id) : {},
    parents: resourceParents(r).map((p) => uid(p.type, p.id)),
  };
}

/** The resource and every container above it, as entities. */
export function resourceEntities(r: PdpResource): CedarEntity[] {
  const out: CedarEntity[] = [resourceEntity(r)];
  if (r.type === 'Fleet') return out;
  const project = r.type === 'Project' ? r.id : (r.project as string);
  if (r.type === 'Gate' || r.type === 'Card') {
    if (r.item !== null) out.push(resourceEntity(pdpResource.item(project, r.item, r.lane)));
  }
  if ((r.type === 'Gate' || r.type === 'Card' || r.type === 'Item') && r.lane !== null) {
    out.push(resourceEntity(pdpResource.lane(project, r.lane)));
  }
  if (r.type !== 'Project') out.push(resourceEntity(pdpResource.project(project)));
  out.push(resourceEntity(pdpResource.fleet()));
  return out;
}

export interface BuiltEntities {
  readonly principal: CedarUid;
  readonly entities: CedarEntity[];
  /** The roles the principal holds for this resource (for the decision's explanation). */
  readonly roles: string[];
}

export function buildEntities(
  facts: PdpPrincipalFacts,
  resource: PdpResource,
  catalogue: readonly RoleDef[] = ROLE_CATALOGUE,
): BuiltEntities {
  const roles = new Set<string>();
  const groups = new Set<string>();
  for (const b of facts.bindings) {
    const def = roleDef(b.role_id, catalogue);
    if (!def || !roleMayBindAt(def, b.scope.kind)) continue;
    roles.add(b.role_id);
    groups.add(b.group_id);
  }
  const principal = uid('Principal', facts.principal_id);
  const entities: CedarEntity[] = [
    {
      uid: principal,
      attrs: { kind: facts.kind, status: facts.status, breakglass: facts.breakglass },
      parents: [
        ...[...groups].sort().map((g) => uid('Group', g)),
        ...[...roles].sort().map((r) => uid('Role', r)),
      ],
    },
    ...[...groups]
      .sort()
      .map((g): CedarEntity => ({ uid: uid('Group', g), attrs: {}, parents: [] })),
    ...[...roles].sort().map((r): CedarEntity => ({ uid: uid('Role', r), attrs: {}, parents: [] })),
    ...resourceEntities(resource),
  ];
  return { principal, entities, roles: [...roles].sort() };
}
