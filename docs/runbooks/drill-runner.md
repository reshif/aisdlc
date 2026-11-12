# Runbook: the runner-killed-mid-session drill (M19)

What this proves: when the runner under a coding session dies (the session's container is killed, or the
sandbox-controller that placed it dies), nothing passes silently, no lease epoch is lost and nothing is left behind
(ADR-0003 §9; Rating item 3 "a runner killed mid-session, recovering without losing a decision").

| What dies | What the caller (core-worker's `HttpSandbox`) gets | What happens to the Unit |
|---|---|---|
| The W session's container (killed, OOM, a crashed shim) | `200` with a void run (`status: killed`): the wrapper never printed its end marker, so there is no `/out` and no exit code | 6.4 throws (`the coding session was void`): the stage command is NOT answered, the agent run is recorded `port_error`, and the outbox delivers the same command (same key) again after its backoff |
| The sandbox-controller itself | the call is cut (`SandboxError unavailable`) | the same: not answered, delivered again |

The recovery path is the stage command's redelivery (`packages/build/src/coding-port.ts`, `services/core/src/work-driver.ts`):
the grant stays `active` at the same lease epoch (only a handoff, the item's end or G4 decided ends it; leaving S6
ends the lease), so the redelivered command's `ensureAdmitted` finds it and its new session names the same grant. A
fresh run key is minted for it. After the outbox's last attempt the command is dead-lettered and the item stays where
it is (visible as a dead command on the work driver's loop): it never advances without an answer.

What the drill also shows about the runner host: the controller frees the slot the moment the driver returns (a killed
container), and a controller that died leaves its session's container RUNNING on the daemon, with its network and
repo copy, where the coding proxy would count it against the caps. The restarted controller sweeps at boot (M19,
`DockerSandboxDriver.sweep`): every sandbox of its proxy's owner (`DOCKER_PROXY_OWNER`, compose
`<project>-coding`) goes, then every `SANDBOX_CONTROLLER_SWEEP_MS` (60 s) whatever no running session owns. The proxy
lists and removes only sandboxes carrying its own owner label, so another runner host's (or another stack's) sessions
on the same daemon are never touched.

Time: about 3 minutes.

## 1. Run it

The stack with the sandbox plane and the deterministic stage ports (the drill item's Unit is admitted by the real
engine; its grant is what the drill's sessions name):

```
cd platform/compose
export SANDBOX_SCRATCH=$(mktemp -d) && chmod 1777 "$SANDBOX_SCRATCH"
export DOCKER_GID=$(stat -c %g /var/run/docker.sock) CORE_WORKER_STAGE_PORTS=fake WORK_DRIVER_INTERVAL_MS=1000
docker compose --profile fake-github --profile sandbox up -d --wait
./drill.sh runner
```

It seeds a load project (`aisdlc-load seed`) and drives one item until its Unit holds an active admission grant and the
item waits at G4 (`aisdlc-load item`), then:

1. places a W session (`sleep 600`) under that grant the way core-worker does (from inside core-worker, with its
   token), kills the session's container, and checks the answer is a void run (`200 killed`), the slot is free and no
   container, network or scratch directory of the session is left;
2. places another, SIGKILLs the sandbox-controller, checks the call was cut and the session's container outlived it,
   starts the controller, and checks its boot sweep removed the orphan's container, network and repo copy and the
   slots read free;
3. checks the grant is still `active` at its epoch, the lease epoch did not move, the item's stream did not move (no
   outcome was recorded for it), and a new session under the same grant runs to its end (the redelivered command's
   session would start); then the common recovery checks: no other factory container restarted, core-worker healthy,
   the ledger verifies offline.

## 2. If a check fails

| The drill says | What it means | What to do |
|---|---|---|
| a killed session answered anything but `200 killed` | the driver passed a dead session off as a run with an outcome: **a defect** (a silent pass) | stop agent work with a hold (Operate, Controls), file it |
| the slot was not freed | the controller lost track of a session (a slot leak: H2 admits fewer Units) | restart the sandbox-controller; file it |
| the boot sweep left the dead session behind | the proxy's owner label or list is wrong, or the sweep failed (its log line says why) | `docker compose logs sandbox-controller docker-proxy-coding`; remove `aisdlc-sbx-*` of this stack by hand |
| the grant is not active / the lease epoch moved / the item's stream moved | something answered for the Unit or ended its grant while its session died: **a defect** | stop agent work with a hold, file it with the item's stream |
| the next session under the grant answered something else | the runner host cannot place a session after the crash (caps held by an orphan, the proxy down) | `GET /v1/slots`, `docker ps --filter label=aisdlc.sandbox=1` |

## 3. Where it is tested

`services/sandbox-controller/test/s6.test.ts` (6.4 with a killed session and with a killed controller: the step is an
error, the redelivery completes under the same grant and epoch, the slot is free, the next controller sweeps first),
`services/sandbox-controller/test/controller.test.ts` (the sweep keeps exactly the running sessions),
`services/sandbox-driver/test/sweep.test.ts` (the sweep through the real proxy: this owner's sandboxes, their networks
and repo copies; never another owner's), `services/docker-proxy/test/proxy.test.ts` (the owner label, the proxy's own
list filter).

## 4. Results

2026-11-12, Stack: `aisdlc/factory:m19c` built from `build/m19c`, `docker compose --profile fake-github --profile sandbox
up -d --wait` (project `aisdlc-m19c`, subnets `10.234.*`, `CORE_WORKER_STAGE_PORTS=fake`), Docker 29.9.2, 4 CPUs.

`./drill.sh runner`: **every check held.**

- The drill item's Unit was admitted by the engine (grant `<item>:main@1`, active, lease epoch 1, 50 item events).
- 1: the W session (`sleep 600`) ran (slots used 1, free W 3); its container killed: `200 killed`, slots back to used
  0 / free W 4, no container, network or scratch directory left.
- 2: the sandbox-controller SIGKILLed mid-session: core's call cut (`UND_ERR_SOCKET`); the session's container, network
  and repo copy were still there (1 1 1); the controller started again and its log said `sweep (boot): removed 1
  container(s), 1 network(s), 1 scratch dir(s)`; slots free again.
- 3: the grant still `active 1`, the lease epoch still 1, the item's stream still 50 events; the next session under
  the same grant answered `200 exited`. No other factory container restarted, core-worker healthy, `verify-ledger` OK
  (110 entries, 10 checkpoints).

The first run found the docker proxies OOM-killed at start under `mem_limit: 64m` (the proxy, about 50 MiB, and its
node healthcheck share the cgroup): both are 96m now.
