import type { CodeHostRead, DeploymentState, DeploymentTag } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import type { DeploymentCreate, GateRelayHostPort } from './gate-relay-host.js';

// gate-relay's code-host contract (PLAN M15.3): the same behaviour from the in-memory fake's deployment view and from
// gate-relay's GitHub adapter over the in-repo fake GitHub HTTP server. A world has THREE credentials on one host:
// gate-relay's App (`deployments: write`), the Push Broker's and gate-check's (neither has `deployments: write`), so the
// suite shows that only gate-relay's credential creates a deployment, that a deployment carries the tag gate-relay
// wrote, that statuses (written by the deploy system) read back newest first, and that no answer is unknown.

export const GR_REPO = 'acme/gr';
export const GR_SHA_A = 'a'.repeat(40);
export const GR_SHA_B = 'b'.repeat(40);
export const GR_ENV = 'production';

export interface GateRelayHostWorld {
  /** gate-relay's App. */
  readonly deploys: GateRelayHostPort;
  /** The Push Broker's App, seen through a deployment view (its token has no deployments permission). */
  readonly push: GateRelayHostPort;
  /** gate-check's App, likewise. */
  readonly checks: GateRelayHostPort;
  /** The deploy system reports a state on a deployment. */
  setStatus(deploymentId: number, state: DeploymentState): Promise<void>;
  /** Every request answers "no answer" (5xx) until `unbreak`. */
  breakHost(): void;
  unbreak(): void;
  close?: () => Promise<void>;
}

const value = <T>(r: CodeHostRead<T>): T => {
  if (r.state !== 'ok') throw new Error(`${r.state}/${r.reason}: ${r.message}`);
  return r.value;
};

export const grTag = (gate = '01890a5d-ac96-774b-bcce-b302099a8057'): DeploymentTag => ({
  aisdlc: {
    item_id: '01890a5d-ac96-774b-bcce-b302099a8058' as never,
    gate_instance_id: gate as never,
    kind: 'release',
    binding_sha256: 'e'.repeat(64),
  },
});

export const grCreate = (over: Partial<DeploymentCreate> = {}): DeploymentCreate => ({
  repo: GR_REPO,
  sha: GR_SHA_A,
  environment: GR_ENV,
  description: 'aisdlc G5 release',
  tag: grTag(),
  ...over,
});

export function gateRelayHostContract(
  name: string,
  makeWorld: () => Promise<GateRelayHostWorld>,
): void {
  describe(`GateRelayHostPort contract: ${name}`, () => {
    const withWorld = async (f: (w: GateRelayHostWorld) => Promise<void>): Promise<void> => {
      const w = await makeWorld();
      try {
        await f(w);
      } finally {
        await w.close?.();
      }
    };

    it('creates a deployment of the merged commit through gate-relay’s App; it lists back with its tag', () =>
      withWorld(async (w) => {
        expect(
          value(
            await w.deploys.list_deployments({ repo: GR_REPO, sha: GR_SHA_A, environment: GR_ENV }),
          ),
        ).toEqual([]);
        const d = value(await w.deploys.create_deployment(grCreate()));
        expect(d).toMatchObject({ sha: GR_SHA_A, environment: GR_ENV, tag: grTag() });
        expect(d.id).toBeGreaterThan(0);
        const listed = value(
          await w.deploys.list_deployments({ repo: GR_REPO, sha: GR_SHA_A, environment: GR_ENV }),
        );
        expect(listed.map((x) => [x.id, x.tag])).toEqual([[d.id, grTag()]]);
        // another commit, another environment: not listed
        expect(
          value(
            await w.deploys.list_deployments({ repo: GR_REPO, sha: GR_SHA_B, environment: GR_ENV }),
          ),
        ).toEqual([]);
        expect(
          value(
            await w.deploys.list_deployments({
              repo: GR_REPO,
              sha: GR_SHA_A,
              environment: 'staging',
            }),
          ),
        ).toEqual([]);
      }));

    it('the Push Broker’s and gate-check’s Apps cannot create a deployment', () =>
      withWorld(async (w) => {
        for (const other of [w.push, w.checks]) {
          const r = await other.create_deployment(grCreate());
          expect(r.state).toBe('unreadable');
        }
        expect(
          value(
            await w.deploys.list_deployments({ repo: GR_REPO, sha: GR_SHA_A, environment: GR_ENV }),
          ),
        ).toEqual([]);
      }));

    it('refuses a deployment gate-relay may not create (a branch name, a bad environment, no tag)', () =>
      withWorld(async (w) => {
        expect((await w.deploys.create_deployment(grCreate({ sha: 'main' }))).state).toBe(
          'unreadable',
        );
        expect(
          (await w.deploys.create_deployment(grCreate({ environment: 'prod env' }))).state,
        ).toBe('unreadable');
        expect(
          (await w.deploys.create_deployment(grCreate({ tag: { aisdlc: {} } as never }))).state,
        ).toBe('unreadable');
      }));

    it('statuses the deploy system writes read back newest first', () =>
      withWorld(async (w) => {
        const d = value(await w.deploys.create_deployment(grCreate()));
        expect(
          value(await w.deploys.deployment_statuses({ repo: GR_REPO, deployment_id: d.id })),
        ).toEqual([]);
        await w.setStatus(d.id, 'in_progress');
        await w.setStatus(d.id, 'failure');
        const st = value(
          await w.deploys.deployment_statuses({ repo: GR_REPO, deployment_id: d.id }),
        );
        expect(st.map((s) => s.state)).toEqual(['failure', 'in_progress']);
      }));

    it('no answer is unknown, never an empty list', () =>
      withWorld(async (w) => {
        w.breakHost();
        const r = await w.deploys.list_deployments({
          repo: GR_REPO,
          sha: GR_SHA_A,
          environment: GR_ENV,
        });
        expect(r.state).toBe('unknown');
        expect((await w.deploys.create_deployment(grCreate())).state).toBe('unknown');
        w.unbreak();
        expect(
          (await w.deploys.list_deployments({ repo: GR_REPO, sha: GR_SHA_A, environment: GR_ENV }))
            .state,
        ).toBe('ok');
      }));
  });
}
