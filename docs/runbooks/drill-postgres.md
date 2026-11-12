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
