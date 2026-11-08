# ADR-0001: TypeScript end to end, Postgres-native jobs, no Temporal at first

Status: accepted, 2026-11-08.

## Context

The specs describe a factory with twelve bounded contexts, a signed ledger, a long-running lifecycle with human waits measured in business days, a portal, and agents that run inside sandboxes. The earlier code base used Python/Django for the backend, TypeScript for the portal, and Temporal for workflows, in 34 containers.

The domain model's gap list (§8) and the runtime review show what that cost:

- Status enums and lane routes were re-listed in Python, TypeScript and JSON, and drifted (gaps 9 and 12).
- Several shapes for one concept (Assumption, Handoff, CodeHostPort) grew at the boundaries between languages and stores (gaps 4, 5, 7).
- Seven core loops ran as seven Django processes (about 440 MiB) to do polling work.
- Temporal added three containers but is non-authoritative by design (AR1): everything must be rebuildable from the record.

## Decision

1. **One language: TypeScript on Node 22.** Contracts are Zod schemas in one package. The API, the workers, the PDP adapter and the portal import the same types, so an enum exists once. JSON Schema is generated for anything outside the monorepo.
2. **PostgreSQL 16 is the only stateful store** for the record, the ledger and all read models, with one Postgres schema per bounded context. Services that hold keys keep their own small state (the Notary's sequence, the kill switch) in their own schema or store, to keep the independence the review requires.
3. **graphile-worker for jobs and loops.** It is Postgres-native: a job can be enqueued in the same transaction as the record event that causes it, and cron tasks replace the interval loops. All loops run in one `core-worker` (review §3.1, option B).
4. **No Temporal at first.** The item lifecycle is a deterministic interpreter that folds the item's event stream and the catalogue into a state, and emits commands. Timers are worker jobs. Long human waits are just "no event yet", which needs no running workflow. A `WorkflowPort` keeps the option to move execution onto Temporal (it has a TypeScript SDK) if scale or retries ever call for it.
5. **Cedar for policy**, through its WebAssembly build, embedded in each enforcement point (AR2: one kernel, one bundle version, not one network service).
6. **Claude Agent SDK (TypeScript)** for agent sessions inside the sandbox; all model traffic through the gateway (AR5, AR7).

## Consequences

- Repository analysis that the earlier code did in Python (detectors, CODEOWNERS parse, secret scan) is written in TypeScript. Third-party scanners (gitleaks rules, zizmor, OSV-Scanner, Semgrep) are separate binaries that run in sandbox class K anyway, so their language does not matter.
- The process count drops: one core API, one core worker, no Temporal server, UI or database.
- The trust boundaries in the review §2 are unchanged: the Notary, Witness, kms-local, kill switch, gate plane, codehost, gateway and the sandbox drivers remain separate processes.
