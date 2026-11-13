import {
  ACTION_CATALOGUE,
  ActionId,
  GrantRule,
  PDP_CONFIG_KEY,
  ROLE_CATALOGUE,
  RoleDef,
  type ActionDef,
  type PolicyBundle,
} from '@aisdlc/contracts';
import type { ConfigRegistry } from '@aisdlc/config';
import { canonicalJson, hashCanonical } from '@aisdlc/kernel';
import { z } from 'zod';
import { registerPdpConfig, verifyBundle } from './bundle.js';
import { BUNDLE_VERSION, buildBundle } from './generate.js';

// Roles and what each can do as settings (portal v2, screen map H11; config `access.roles`, factory layer, M1-gated):
// the role catalogue (each role's slot, view level, data class, scope kinds) and, per action, which roles hold it
// (its grant rules). The action ids, their resource types and classes stay code: an action is something the code
// enforces. The policy bundle is REGENERATED from the setting when a revision is proposed (`registry.prepare`), so the
// M1 approver decides the roles and the bundle they make together and the publish makes both effective at once; a
// rule refuses a document whose `pdp.bundle` is not the one its `access.roles` makes (fail closed), and one whose
// roles make a bundle that does not verify. Today's catalogues are the default; while the setting equals them the
// published bundle is left as it is.

export const ACCESS_ROLES_KEY = 'access.roles';

export const AccessRolesConfig = z
  .strictObject({
    roles: z.array(RoleDef).min(1).max(64),
    /** Per action, who holds it. An action left out keeps its code grants. */
    grants: z.partialRecord(ActionId, z.array(GrantRule).min(1)),
  })
  .refine((v) => new Set(v.roles.map((r) => r.role_id)).size === v.roles.length, {
    message: 'a role is listed twice',
  })
  .refine((v) => v.roles.some((r) => r.role_id === 'factory.admin' && r.privileged), {
    message: 'the factory admin role stays, and stays privileged',
  });
export type AccessRolesConfig = z.infer<typeof AccessRolesConfig>;

export const DEFAULT_ACCESS_ROLES: AccessRolesConfig = {
  roles: ROLE_CATALOGUE.map((r) => ({ ...r })),
  grants: {},
};

/** The action catalogue with the setting's grants in place. */
export function actionsOf(v: AccessRolesConfig): Record<string, ActionDef> {
  const base = ACTION_CATALOGUE as unknown as Record<string, ActionDef>;
  return Object.fromEntries(
    Object.entries(base).map(([id, a]) => {
      const g = v.grants[id as ActionId];
      return [id, g ? { ...a, grants: g } : a];
    }),
  );
}

const isDefault = (v: AccessRolesConfig): boolean =>
  canonicalJson(v) === canonicalJson(DEFAULT_ACCESS_ROLES);

/** The bundle the setting makes; its version names the setting's hash so two settings never share one. */
export function bundleForRoles(v: AccessRolesConfig): PolicyBundle {
  return buildBundle({
    catalogue: v.roles,
    actions: actionsOf(v) as never,
    bundle_version: `${BUNDLE_VERSION}.settings-${hashCanonical(v).slice(0, 12)}`,
  });
}

/** Registers `access.roles` with its derivation and its rule (and `pdp.bundle` when missing). Idempotent. */
export function registerRolesConfig(registry: ConfigRegistry): ConfigRegistry {
  if (registry.get(ACCESS_ROLES_KEY)) return registry;
  if (!registry.get(PDP_CONFIG_KEY)) registerPdpConfig(registry);
  return registry
    .setting({
      key: ACCESS_ROLES_KEY,
      schema: AccessRolesConfig,
      default: DEFAULT_ACCESS_ROLES,
      overridable: false,
      description:
        'Roles and what they can do (H11): each role (slot, view level, data class, where it may be bound) and, per action, which roles hold it. A change regenerates the policy bundle in the same revision. Factory layer only, M1-gated',
    })
    .derive({
      name: 'policy bundle from access.roles',
      apply(doc) {
        const p = AccessRolesConfig.safeParse(doc[ACCESS_ROLES_KEY]);
        if (!p.success || isDefault(p.data)) return { ...doc };
        return { ...doc, [PDP_CONFIG_KEY]: bundleForRoles(p.data) };
      },
    })
    .rule({
      name: 'policy bundle matches access.roles',
      check(values) {
        const p = AccessRolesConfig.safeParse(values[ACCESS_ROLES_KEY]);
        if (!p.success || isDefault(p.data)) return [];
        const want = bundleForRoles(p.data);
        const v = verifyBundle(want);
        if (!v.ok)
          return [`the roles make a policy bundle that does not verify: ${v.error.detail}`];
        const have = values[PDP_CONFIG_KEY] as { bundle_hash?: string } | null | undefined;
        return have?.bundle_hash === want.bundle_hash
          ? []
          : ['pdp.bundle is not the bundle access.roles makes (propose through the settings path)'];
      },
    });
}
