import {
  CARD_EVENT,
  CardOpenedPayload,
  GATE_EVENT,
  GateOpenedPayload,
  cardStream,
  gateStream,
  roleForSlot,
  type PdpResource,
  type PrincipalId,
  type Scope,
  BOOTSTRAP_CARDS,
} from '@aisdlc/contracts';
import { ok, type Result } from '@aisdlc/kernel';
import type {
  PdpAsk,
  PdpBindingFact,
  PdpEntityError,
  PdpEntityPort,
  PdpPrincipalFacts,
} from '@aisdlc/ports';
import type { Executor } from '@aisdlc/record';
import { liveBootstrap } from './live.js';

// The PDP's entity source with the bootstrap grant in it (PLAN M7.4, user decision 2026-11-08; the
// gap M8.1 found: a first-onboarding requester holds only `factory.admin`, which has no project
// role, so the PDP denied `card.decide` and the person the decision made provisional admin could
// never decide card 1).
//
// While the grant is live (`liveBootstrap`: no published project revision, the granting S0 record
// not ended) the grantee is given the project admin ROLE for that project, but only for the one
// request in front of the PDP when that request is one the admin slot needs on that onboarding:
//
//   - `card.decide` on a card 1, 2, 4 or 5 (those the grant was recorded with) of the S0 record that holds the grant (prepare, evidence,
//     decide and re-check are all `card.decide`);
//   - `gate.decide` on an M1 gate of that project over a config revision (the one card 4 opens to
//     publish the role map).
//
// Nothing else: not the security card, not M4, not another project, not settings edits, kills or
// any other gate. The narrowness is decided here, from the record, per request (`PdpAsk`); the
// policies and the role catalogue are untouched. Every failure, an unreadable record included,
// leaves the base answer: the grant never appears by accident.

const ADMIN_ROLE = roleForSlot('admin');

const projectOf = (r: PdpResource): string | null => (r.type === 'Project' ? r.id : r.project);

export class BootstrapPdpEntities implements PdpEntityPort {
  constructor(
    private readonly base: PdpEntityPort,
    private readonly o: {
      readonly db: Executor;
      /** The live grant of a project (default `liveBootstrap`; a batch view memoises it). */
      readonly live?: (db: Executor, project: string) => ReturnType<typeof liveBootstrap>;
    },
  ) {}

  async principalFacts(
    principal: PrincipalId,
    scopes: readonly Scope[],
    at: Date,
    ask?: PdpAsk,
  ): Promise<Result<PdpPrincipalFacts | null, PdpEntityError>> {
    const base = await this.base.principalFacts(principal, scopes, at, ask);
    if (!base.ok || base.value === null || ask === undefined) return base;
    if (base.value.status !== 'active') return base;
    const project = projectOf(ask.resource);
    if (project === null) return base;
    let binding: PdpBindingFact | null = null;
    try {
      const grant = await (this.o.live ?? liveBootstrap)(this.o.db, project);
      if (
        grant !== null &&
        grant.grantee === principal &&
        (await this.covers(grant.s0_id, grant.cards, ask))
      ) {
        binding = {
          binding_id: `bootstrap:${grant.s0_id}`,
          role_id: ADMIN_ROLE,
          group_id: `bootstrap:${grant.s0_id}`,
          scope: { kind: 'project', ref: project },
        };
      }
    } catch {
      return base; // fail closed: an error finds no grant
    }
    if (binding === null) return base;
    return ok({ ...base.value, bindings: [...base.value.bindings, binding] });
  }

  /** One batch (M19): the base's own batch view, and the live bootstrap grant of each project read once. */
  batch(): PdpEntityPort {
    const grants = new Map<string, ReturnType<typeof liveBootstrap>>();
    return new BootstrapPdpEntities(this.base.batch?.() ?? this.base, {
      db: this.o.db,
      live: (db, project) => {
        let g = grants.get(project);
        if (!g) grants.set(project, (g = (this.o.live ?? liveBootstrap)(db, project)));
        return g;
      },
    });
  }

  /** Is this request one of the few the grant covers, on the record that holds it? */
  private async covers(s0Id: string, cards: readonly string[], ask: PdpAsk): Promise<boolean> {
    const r = ask.resource;
    const project = projectOf(r);
    if (project === null) return false;
    if (ask.action === 'card.decide' && r.type === 'Card') {
      const opened = await this.firstEvent(cardStream(r.id), CARD_EVENT.opened);
      const p = CardOpenedPayload.safeParse(opened);
      return (
        p.success &&
        p.data.card_id === r.id &&
        p.data.project_id === project &&
        p.data.subject_kind === 's0_record' &&
        p.data.subject_id === s0Id &&
        p.data.label !== null &&
        // the cards the grant was recorded with, and only the onboarding steps' own cards
        cards.includes(p.data.label) &&
        (BOOTSTRAP_CARDS as readonly string[]).includes(p.data.label)
      );
    }
    if (ask.action === 'gate.decide' && r.type === 'Gate' && r.gate_id === 'M1') {
      const opened = await this.firstEvent(gateStream(r.id), GATE_EVENT.opened);
      const p = GateOpenedPayload.safeParse(opened);
      return (
        p.success &&
        p.data.gate_instance_id === r.id &&
        p.data.gate_id === 'M1' &&
        p.data.project_id === project &&
        p.data.subject_kind === 'config'
      );
    }
    return false;
  }

  private async firstEvent(stream: string, type: string): Promise<unknown> {
    const q = await this.o.db.query<{ body: unknown }>(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2
        ORDER BY record_event.seq LIMIT 1`,
      [stream, type],
    );
    return q.rows[0]?.body;
  }
}
