# Runbook: the Postgres failover drill (M19)

What this proves: when the main Postgres goes away and comes back (a failover in production: every connection drops
at once and new ones reach the new primary), no service crashes, no decision is lost or half-written, and the ledger
still verifies. ADR-0003 §9: "Main Postgres failover: replicas take over; killswitch and witness are on their own
instances and unaffected."

Locally there is one Postgres server with every database in it, so the local drill is harsher than production: the
kill switch's and the Witness's databases go away too. In production they are separate instances (ADR-0003 §2).

What the factory does, and why:

| Who | During the outage | After |
|---|---|---|
| Every service's pool (`createPool`, `@aisdlc/db`) | An idle connection the server kills is dropped from the pool and its error class logged (`db pool: idle connection lost`); the process does **not** crash. | The next query opens a fresh connection. |
| A transaction in flight (`withTransaction`) | It fails to its caller; the server rolled it back, so nothing of it is written. The lost connection is destroyed, never reused. | The caller's retry (a loop's next tick, the person's next click) runs it once. |
| core-worker's loops | Their ticks fail and back off; `/healthz` reads 503 once a loop has failed past its threshold. | They resume on the next tick; the outbox jobs that waited run. |
| Reads (the portal) | Answer 503 `unavailable`; the portal says the read failed. | Normal. |

Time: about 3 minutes.

## 1. Before you start

- The stack is up and healthy (`docker compose --profile fake-github up -d --wait` in `platform/compose`).
- `./verify-ledger.sh` passes.

## 2. Run it

```
cd platform/compose
./drill.sh postgres          # a restart: a clean shutdown, every connection dropped
./drill.sh postgres --hard   # SIGKILL: no clean shutdown (crash recovery from the WAL), then a start
```

It records the ledger head and every factory container's restart count, restarts (or kills and starts) Postgres,
waits for it, then checks that core-worker is healthy again, no factory container restarted, the ledger head did not go
back, and `verify-ledger.sh` passes.

## 3. If a check fails

| The drill says | What it means | What to do |
|---|---|---|
| `a factory container restarted` | a service crashed on a dropped connection (a pool or client with no error listener) | `docker compose logs <service>`; any `pg.Pool` or checked-out client must have an error listener (see `packages/db/src/client.ts`) |
| `core-worker ... answered 503` after 180 s | a loop does not recover from a dropped connection | `docker compose exec core-worker node -e "fetch('http://127.0.0.1:8360/healthz').then(r=>r.text()).then(console.log)"` names the loop |
| `the ledger head went back` | committed ledger entries are gone: the database lost committed data (fsync off, a volume problem) | **stop**: restore from backup, run `./verify-ledger.sh`, investigate the storage |
| verify-ledger fails | the record and the Notary's journal disagree | the reconciler (`ledger_reconciler` loop) inserts what the Notary signed and the record lost; run it again after a minute, then escalate |

## 4. Where it is tested

`packages/db/test/failover.test.ts` terminates every backend of a real test database (what a failover does to the
clients): idle connections killed do not crash the process and the next query reconnects; a transaction cut in the
middle fails to its caller, leaves nothing behind and lands once when retried.

## 5. Results

2026-11-12, Stack: `aisdlc/factory:local` built from `build/m19b`, `docker compose --profile fake-github --profile telemetry up -d --wait` (project `aisdlc-m19b`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`), Docker 29.9.2.

| Run | Result |
|---|---|
| `./drill.sh postgres` | **every check held.** Ledger head 5 before and after; no factory container restarted (all ten at 0); core-worker healthy again; `verify-ledger` OK (5 entries, checkpoint 1 covers the head). |
| `./drill.sh postgres --hard` | **every check held**, the same. The pools logged the drops instead of crashing: `db pool: idle connection lost` in core 3, core-worker 2, identity 2, bff 2, notary 2, killswitch 2, witness 1 (each of those would have been an uncaught exception before the `@aisdlc/db` fix). |

The first `up` of this stack failed before the drill could start: the compose file declares 43 networks and Docker's
default address pools hold about 30 (`all predefined address pools have been fully subnetted`). Every network now has
its own /24 under `AISDLC_SUBNET_PREFIX` (default `10.231`; smoke.sh uses `10.232`, e2e.sh `10.233`).
