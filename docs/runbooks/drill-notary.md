# Runbook: the Notary-down drill (M19)

What this proves: when the Notary (the only ledger signer) is unreachable, nothing is decided without it and
nothing an operator did is lost. ADR-0003 §9: "Decisions wait as pending and are signed on recovery; kills still
apply and are signed later."

What the factory does while the Notary is down, and why:

| What | While the Notary is down | After it answers again |
|---|---|---|
| A gate decision (any card, G0 to G6, M1, X, E) | **Refused** (fail closed): the decision and its ledger entry are one transaction, so with no signature there is no decision. The gate stays open; the person sees "the Notary is unreachable" on the inbox and the item page. | The same gate is decided normally (a fresh look at the evidence). |
| An operator action (a control: hold, clamp, halt, maintenance; a lift; a banner) | **Executed at once** (DM FD-D8: execute, then ledger). Its OpsAction is `pending`; if it carried a step-up, the StepUpUse (who, bound to which preview, the proof's hash, when) is recorded with it. | core-worker's `ops_backfill` loop (every 60 s) writes its `ops.action` ledger entry, marked `backfilled: true`, with the StepUpUse in its body. Once per action. |
| A kill | Applies at once (the kill switch is its own service and key). | core-worker's `kill_observer` records the journal through the Notary. |
| The checkpointer and the reconciler | Their ticks fail (core-worker's health shows the loops degraded, then failing). | They catch up; the reconciler inserts anything the Notary signed that the record did not commit. |

Time: about 5 minutes.

## 1. Before you start

- The stack is up and healthy: `docker compose --profile fake-github up -d --wait` in `platform/compose`.
- `./verify-ledger.sh` passes (the drill compares against it at the end).
- Optional, to see the backfill: apply a control in the portal (Operate, Controls) while the Notary is down (step 3).

## 2. Run it

```
cd platform/compose
./drill.sh notary
```

It stops the Notary, waits until the Notary's health tile (Operate, Health) reads **down**, checks that the ledger
head does not move for 20 s, starts the Notary, waits for the tile to read **ok** and for every pending operator action
to be ledgered, then checks that no factory container restarted, core-worker is healthy and the ledger verifies.

## 3. What to look at while it is down (by hand, optional)

- Operate, Health: `notary` reads **down** (`unreachable`) within 30 to 60 s. A reading older than two minutes reads
  **unknown**, never ok.
- The inbox and any item page: a red notice says the Notary is unreachable and decisions are refused.
- Decide a card: the portal answers with an error and the card stays open. Nothing is in the ledger.
- Apply a hold on a project: it is in force at once (its items are HELD); the notice counts one operator action
  waiting to be ledgered.

## 4. If a check fails

| The drill says | What it means | What to do |
|---|---|---|
| `the health tile of notary did not read down` | core-worker does not read the Notary (`CORE_WORKER_HEALTH_TARGETS`), or its `health_snapshot` loop is failing | `docker compose logs core-worker | grep health_snapshot`; check the target list in docker-compose.yml |
| `the ledger moved while the Notary was down` | something wrote a ledger entry without the Notary: **stop and investigate**, this is a signing bypass | keep the stack, run `./verify-ledger.sh`, file it as a security defect |
| `operator action(s) still not ledgered` | the backfill cannot ledger them | `docker compose logs core-worker | grep ops_backfill`; a `conflict` means the record and the Notary disagree: run the reconciler's checks (verify-ledger) before anything else |
| `a factory container restarted` | a service crashed instead of failing a request | its logs (`docker compose logs <service>`), then a defect against it |

## 5. Where it is tested

`services/core/test/drill-notary.test.ts` runs the same drill on a real Postgres and a real Notary behind a switch:
the gate decision refused and later decided, the halt with its step-up in force, pending, then backfilled once with
its StepUpUse.
