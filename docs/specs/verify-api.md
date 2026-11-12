# Verify service: HTTP contract and the checks of S7 (M14.3)

The verify service (`services/verify`, the plan's `cvw`; ADR-0003 §1 Control plane) runs S7's checks 7.1 to 7.5 over one Unit head (FL S7, X2, Q1). Its pure check logic is `packages/verify` (one module per check); its vocabulary is `packages/contracts/src/entities/verify.ts` (check ids, finding kinds and severities, results, the request), the source of truth for every shape below. 7.6, the Evidence Pack, is M14.4: it binds the results below by their hashes.

Core reaches the service only through `HttpVerify` (`packages/verify/src/client.ts`) from its `AgentVerifyPort` (`services/core/src/verify/`), which core-worker uses when `CORE_WORKER_VERIFY_URL` is set (with `CORE_WORKER_STAGE_PORTS=agents`); otherwise S7 stays over the stage-port fakes.

## 1. Credentials

| Who | Credential | Scopes | Opens |
|---|---|---|---|
| core-worker (the verify stage port) | service token (`Authorization: Bearer`, a `file:` reference at both ends) | `run`, `read` | `POST /v1/checks`, `GET /v1/results`, `GET /v1/results/:sha` |
| anyone | none | | `GET /healthz` |

`VERIFY_CALLERS` is `{caller: {token_ref, scopes}}`. A missing or unknown token is `401 unauthenticated`; a scope the caller lacks is `403 forbidden`.

The service holds three outbound credentials of its own: its token at the sandbox-controller (scope `run`), its token at the codehost (scope `census`: the bundle route) and its database role. It holds **no** vendor key, no code-host credential and no Docker right. A D+A step's request carries the run's gateway virtual key, lent by core for the length of that one call; it is used for one header of one gateway call and is never recorded, logged or answered (tests grep the record and the read model).

## 2. `POST /v1/checks`

Body: `VerifyRunRequest`: the command key, the item, Unit, step (`7.1` to `7.5`), lane, the base commit (G3 bound it) and the Unit head, the locked oracles (`path -> sha256`), the oracles G2 approved, the approvals the checks weigh (`approved_gates`, `x2_covered`, `x3_approved`, `approved_hosts`), the constitution in force, the item's live admission grant, and for 7.3 and 7.5 the A5 binding with its key and the approved artefacts it reads (as data). The repo itself is never in the body: the service reads it at the two commits from the codehost.

The service, in this order:

1. A command key that has a result is answered from the record (`duplicate: true`); nothing runs again.
2. The repo at the base and at the head (`GitBundleFiles` over the codehost's bundle route). Unreachable: `503`. A commit that does not exist: a result with verdict `unknown` (`kit_error`).
3. The step's check (§4). Its kits are O sessions through the sandbox-controller, each naming the grant; its reviewer is one gateway call.
4. The result is recorded (§5), then answered.

Success: `200 VerifyRunResponse` = `{result_sha256, result, duplicate}`. `result_sha256` is `verifyResultHash(result)`: the sha256 of the result's canonical JSON. A result holds no clock and no secret, so the same inputs give the same hash.

Errors: `400 invalid_request` (field paths only, never values: the body may hold a key), `503 unavailable` (TRANSIENT: the sandbox was `busy` or `unavailable`, the codehost or the gateway could not be reached; nothing was recorded and the stage command is delivered again with the same key).

## 3. `GET /v1/results?item=&head=` and `GET /v1/results/:sha`

Every recorded result of an item's head in record order (`{results}`), or one result by its hash (`{result_sha256, result}`, `404` when there is none). Scope `read`. Core's 7.6 guard reads the first; the Evidence Pack (M14.4) reads both.

## 4. The checks

Verdicts are three-valued and fail closed: `passed`, `failed`, `unknown`. A kit with no verdict (a void session: time, memory, output size, a canary in its output; a session the controller refused; a reviewer with no valid answer) makes the check `unknown`, and `unknown` is unmet. `high` and `critical` findings fail a check; `medium` and below are recorded. The repo's commands are read from the BASE commit's task contract (`taskContractOf`), so a head cannot rename them.

| Step | Check | What runs | Fails / raises |
|---|---|---|---|
| 7.1 | `deterministic` | each distinct command of the task contract (`build`, `typecheck`, `lint`, `format-check`, `test`, `check`) once over the head, in O | a red command (`command_failed`); no `test` command (`no_test_command`) |
| 7.2 | `test_integrity` | the locks (every locked oracle in the head with its lock hash); the static stub probe (`stubReason`) over new and changed test files; the **stub probe**: each locked oracle over the base with only the head's test files on it, in O (it was red there at 6.3; green now means the tests were bent to pass); **mutation**: mutants of the lines the head added to implementation files (13 operators, at most `max_mutants`, default 6), each a test run in O, killed when the run is red (score below `min_mutation_score`, default 0.5, fails); **holdout**: the Unit's hidden tests through `HoldoutPort`, each must pass on the head | **ET10 (Q1)** on a locked-test edit, a stub test, or a stub probe that passes, before anything else runs; `mutation_score_low`, `holdout_failed` fail |
| 7.3 | `spec_conformance` | the oracle binding of the head (`checkOracleBinding`, the same check as 6.3), every locked oracle run on the head in O, then A5 (`review.v1`, check `spec_conformance`) over the change and the approved spec | a binding deviation or a red oracle; a high A5 finding |
| 7.4 | `secrets_dependencies` | the shared secret ruleset over the files the head added or changed, NEW only (a fingerprint of rule and value hash nowhere in the base tree); the manifests' new dependencies; the protected set (`protectedPushPath`, `DEFAULT_PROTECTED_GLOBS`) | a new secret (critical); a new dependency no X3 approved; **X2** on a protected-path change, with the result bound to it, unless the head is the Push Broker's own write under an X2 approved at 6.6, or X2 was approved here |
| 7.5 | `constitution` | the ONE constitution evaluator (`evaluateConstitution`, shared with 4.5) over the facts of the code: hosts in URL literals of added implementation lines (approved when the approved design names them), migrations added (reversible with a `down` file or section, or flagged `aisdlc: irreversible`); then A5 (check `constitution`). It reads no lane: it runs in every lane that has an S7 | **E2** on a violation (rules or a high A5 finding), with the result bound to it |

The secret and dependency scans and the constitution rules run in-process (data only, no repo code runs: like knowledge's census scan); every kit that runs repo code is an O session. A5 is one gateway call with no tools (class V's runner, an agent in a sandbox, is not built).

## 5. The record

Each result is one `verify.check_recorded` event on `verify:<item>` (`{command_key, result_sha256, result}`, idempotency key `verify:<command_key>`), and the `verify.check_result` read model is written in the same transaction. The read model is rebuildable from the record alone (`rebuildCheckResults`) and checked on every read (a row whose result does not hash to its address is an error).

## 6. What core does with a result

`outcomeOf(result)` is the step's stage outcome: a raised ET10 is `trigger ET10` (Q1: the session is tainted, SECT before any handoff; the result's hash is the quarantine's evidence), a raised gate is `gate_needed` (X2 at 7.4, E2 at 7.5; the result's hash is bound into the gate), anything else is `completed` with the result's hash as the step's output. A `failed` or `unknown` check still completes its step: what to do with it (B9 to B12, D2) is 7.6's, M14.4. Until then core guards 7.6 (`unmetSteps`): the item goes on to 7.6 only when the latest result of EVERY step 7.1 to 7.5 for the head is `passed` and every gate a check raised was approved at that step; otherwise it stops (`failed`, `s7_unmet`).

Before any check, core asks DEC-18's owner allow-list and B1 (`checkSessionAllowed`, class O): a repo off the list never has its code run (`failed`, `exec_not_allowed`). A step with no Unit head (nothing pushed) fails (`no_unit_head`); unreadable constitution config fails 7.5 (`constitution_unreadable`). The service's answer is checked: its result must hash to its address and be about exactly the command's item, step and head.

## 7. Its database role

`verify` (db-init), a member of `aisdlc_verify`, which the verify migration grants SELECT and INSERT on `verify.check_result`, SELECT and INSERT on `record.record_event` for `verify:%` streams only (row-level security), SELECT and UPDATE on `record.global_counter`. Nothing else: no UPDATE or DELETE of its own rows, no table of another context. A test checks every table of the whole migrate plan against the role.

## 8. Not built yet (each behind a port with a deterministic fake)

- Holdouts: `HoldoutPort`; the deployment answers `NoHoldouts` (`holdout_none`) until a repo holdout store exists. The eval store's holdouts stay behind `@aisdlc/evals`' `holdout.ts`.
- Dependency advisories: no advisory database; 7.4 checks what was added and whether X3 approved it.
- A V-class reviewer session: A5 is one gateway call.
- An L8 (human-led) head that the Push Broker did not write: core finds the head from the Unit and the push receipts only.
