# Runbook: the kill-switch-unreachable drill (M19)

What this proves: when the kill switch cannot be asked, every enforcement point treats it as a kill (AR9; ADR-0003 §9
"killswitch unreachable: every enforcement point treats it as a kill"), and the portal says so on every screen that
shows work.

| Where | While the kill switch is unreachable |
|---|---|
| core-worker admission (`/admission`, the work driver before every agent step) | `423` with `why: unreachable`: no new agent work is admitted |
| The gateway (every model call) | refused, as killed |
| The floor (`/floor`) | the red banner "Kill switch unreachable: treated as killed" |
| The inbox and every item page | the same notice per project (`/api/degraded`); a failure to ask at all reads "treat agent work as stopped" |

People can still decide gates: a kill stops agent work, not people.

Time: about 2 minutes.

## 1. Run it

```
cd platform/compose
./drill.sh killswitch
```

It asks core-worker's admission for a project, stops the kill switch, waits until admission answers 423, starts the
kill switch, waits until admission answers 200 again, then checks that no factory container restarted, core-worker is
healthy and the ledger verifies.

## 2. If a check fails

| The drill says | What it means | What to do |
|---|---|---|
| `admission ... answered 200, not 423` while it is down | an enforcement point admits work without a verdict: **a security defect** (AR9) | stop agent work with a hold (Operate, Controls), file it |
| admission does not answer 200 after the start | the kill switch is up but core-worker cannot reach it, or a kill is active | `docker compose logs killswitch core-worker`; the Kill switch screen lists active kills |

## 3. Where it is tested

`services/core/test/degraded.test.ts` (the kill verdict per project, unreachable reads killed, no verdict configured
reads killed), `services/web/test/degraded.test.tsx` (the notices on the inbox), and the floor's tests in
`services/core/test/floor-live.test.ts`.
