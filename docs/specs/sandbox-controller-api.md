# Sandbox controller: HTTP contract (M14.2)

The sandbox-controller (`services/sandbox-controller`, ADR-0003 §6 "Placement", §7 "Sandboxes and caps") places the sandbox sessions of one runner host. It owns the `SandboxPort` driver of the host (the `DockerSandboxDriver` in front of the coding Docker proxy; `FakeSandbox` in tests), enforces the class ceilings and the two caps of the host, reports the free slots admission's H2 reads, and starts only sessions core granted. It never decides order: core admits (6.0), records the grant, then asks for a session. Over a cap it refuses (`busy`) and starts nothing; it never queues. Its state is the running sessions, in memory only: a restart forgets them, which is safe because they die with it.

Core reaches it only through `HttpSandbox` (`packages/ports/src/http-sandbox.ts`), which implements `SandboxPort` and `SandboxSlotsPort`. Contracts (Zod, `packages/contracts/src/entities/sandbox.ts`) are the source of truth for every shape below.

## 1. Credentials

| Who | Credential | Scopes | Opens |
|---|---|---|---|
| core-worker (S6 sessions, H2) | service token (`Authorization: Bearer`, a `file:` reference at both ends) | `run`, `read` | `POST /v1/sessions`, `GET /v1/slots` |
| operator | service token | `read`, `admin` | `GET /v1/slots`, `POST /v1/admin/reload` |
| anyone | none | | `GET /healthz` |
| the controller itself, calling core (M19) | service token `tok-sandbox-controller-core` (`SANDBOX_CONTROLLER_CORE_TOKEN_REF`) | `activity` on core | `POST /v1/sessions/heartbeat` on core |

`SANDBOX_CONTROLLER_CALLERS` is `{caller: {token_ref, scopes}}`. A missing or unknown token is `401 unauthenticated`; a scope the caller lacks is `403 forbidden`. The controller holds the coding proxy's token (core-worker no longer does) and, for the length of a session, the session's gateway virtual key (passed to the driver, never stored or logged).

## 2. `POST /v1/sessions`

Body: `SandboxSessionRequest` = `{grant: SandboxGrantRef, spec: SandboxSpecWire}`.

- `grant`: `{grant_id, item_id, unit_id, lease_epoch}`, the admission grant core recorded (`unit.admitted`). Required: a body without it is `403 refused`, and nothing starts.
- `spec`: the `SandboxSpec` of the port, with each repo file as `{path, encoding: "utf8"|"base64", data, executable?}` (text stays text, bytes go as base64; the type is kept). Body limit `SANDBOX_CONTROLLER_BODY_LIMIT_MB` (default 64).

In this order, and the first that fails answers:

1. **Ceilings and spec rules**: `preflightSpec` (the function the driver and the fake run): limits only lower than the class profile, a key only where the class has one and required there, no credential in `env`, argv and repo-copy shape. `400 invalid_spec`, or `403 exec_not_allowed` for a class that runs no repo code asked to run something that is not a trusted command.
2. **The grant**: the row of `core.admission_grant` must be `active` for exactly the `item_id`, `unit_id` and `lease_epoch` named. Otherwise `403 refused`. A record that cannot be read is `503 unavailable` (fail closed).
3. **The caps** of this host, read at this moment: the running sessions across all classes below `total`, and for a coding class (`CODING_CLASSES`: W) the running W sessions below `coding`. Over either: `409 busy`, nothing started. A session id that is already running is `403 refused`.
4. **The run**: the driver runs the session to its end (synchronous, like `SandboxPort.run`). The slot is released when the driver returns, throws or fails, always.

Success: `200 SandboxRunWire`: the `SandboxRun` with `/out` files as `{path, size, sha256, content_b64}`. A void run (`timed_out`, `oom_killed`, `out_oversized`, `killed`) is a `200` run, not an error. A driver error is passed on with its own code (`503 unavailable`, `409 busy` from the proxy's own count, ...); a driver that throws is `502 driver_failure`.

Errors: `{"error": {"code": <SandboxErrorCode>, "message": ...}}` (`invalid_spec 400`, `exec_not_allowed 403`, `b1_blocked 403`, `refused 403`, `busy 409`, `unavailable 503`, `driver_failure 502`).

`HttpSandbox` fails closed: a spec with no `grant` is refused before anything is sent; a transport error, the deadline (the session's `time_s` plus a margin, default 120 s) or a non-2xx is a `SandboxError` (a code it does not know reads `unavailable`); a body that does not parse, an answer for another session, or an `/out` file whose bytes do not match its size and sha256 is `driver_failure`. It uses `node:http` for this call, not `fetch`, so a 60-minute W session is not cut by a 300 s header timeout.

The DEC-18 owner allow-list and B1 stay in front of the port in core (`GuardedSandbox`, `checkSessionAllowed`): the controller does not read knowledge's findings.

## 2a. Heartbeats (M19)

While a session holds its slot, the controller is its heartbeat reporter (DM Heartbeat; PLAN M19): it posts a `SessionHeartbeat` (`{item_id, project_id, session_id, unit_id, sandbox_class, at}`, content-free) to core's `POST /v1/sessions/heartbeat` when the session starts and every `SANDBOX_CONTROLLER_HEARTBEAT_MS` (default 30 000) until the driver returns. `project_id` is read from the grant's row of `core.admission_grant`; `unit_id` is the grant's Unit key (without the item prefix). An onboarding probe has no work item and never beats. A beat is best effort: core unreachable or refusing is counted and logged, never touches the session, and the floor then reads silence (stuck), never life. `SANDBOX_CONTROLLER_CORE_URL` and `SANDBOX_CONTROLLER_CORE_TOKEN_REF` are set together or not at all; without them nothing beats.

## 3. `GET /v1/slots`

`200 SandboxSlots`:

| Field | Meaning |
|---|---|
| `host_id` | `SANDBOX_CONTROLLER_HOST_ID` (default `local`) |
| `caps` | `{total, coding}` in force now |
| `caps_source` | `config` (a published revision set them) or `default` (nothing published, or the fallback below) |
| `used_total`, `used` | running sessions, in all and per class |
| `free` | per class, under BOTH caps: W is `min(coding - used W, total - used_total)`, every other class `total - used_total` (never below 0) |
| `sessions` | `{session_id, class, grant_id, started_at}` of each running session |

**H2 reads this** (`services/core/src/admission`): where core-worker is given `CORE_WORKER_SANDBOX_CONTROLLER_URL`, the free coding sessions are the lower of the grant count (`cap - active grants`) and the controller's free W slots, minus the capacity port's outstanding pledges. An unreachable controller, a refusal or a malformed answer is 0 free: the item is HELD (`H2`) in core's queue and released when a slot frees. Without the controller, H2 is the grant count alone (unchanged).

## 4. `POST /v1/admin/reload`

Reads the published config again and answers `200 SandboxSlots` with the caps now in force. The controller also reloads every `SANDBOX_CONTROLLER_CAPS_RELOAD_MS` (default 5000) and on a config publish notification.

## 5. The caps (config)

`sandbox.caps` (`SANDBOX_CAPS_KEY`, schema `SandboxCapsConfig`), factory layer only, M1-gated like every revision (`registerSandboxConfig`, also registered by core so its revisions validate):

```json
{ "total": 4, "coding": 1, "hosts": { "runner-b": { "total": 8, "coding": 2 } } }
```

`total` 1 to 32, `coding` 0 to 8 and never above `total` (a document that breaks it is refused before an approver sees it). A host with its own row in `hosts` takes it; every other host takes the top level. Default (nothing published): `{total: 4, coding: 1}` (`DEFAULT_SANDBOX_CAPS`; `coding` is `CODING_SESSION_CAP`).

Fail closed, never higher than the defaults: a published value the schema no longer takes reads as the defaults; a reload that fails makes the caps the lower of the last good value and the defaults until a reload succeeds.

## 6. Its database role

`sandbox_controller` (db-init), a member of `aisdlc_sandbox_controller`, which the config migration grants SELECT on `config.genuine_publish` (the effective config, the ledger join done by the view's owner) and the core migration SELECT on `core.admission_grant`. Nothing else: no other table of core, config, the ledger or the record; no write. The reader does not fold the config projection (`catchUp: false`): core and core-worker do. A test checks every table of the whole migrate plan against the role.
