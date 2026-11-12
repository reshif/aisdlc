# Portal inventory: every feature, option and setting

Status: 2026-11-12, generated from `origin/main` by a script (not by hand) so the lists are complete. Every row of this file is a row of the review in [`portal-review.md`](portal-review.md). Regenerate: bundle `dump.ts` and `config.ts` (esbuild, from the repo) and run `gen.py`; the scripts are listed in portal-review.md §0.


## 1. Lifecycle

Source: `packages/contracts/src/values.ts` (`STEPS`, `StageId`), `packages/contracts/src/flow.ts` (`GATES`, `BACK_EDGES`, `HANDOFF_DESCRIPTIONS`, `TRIGGER_DESCRIPTIONS`, `HOLD_DESCRIPTIONS`, `RELANE_DESCRIPTIONS`), `packages/contracts/src/entities/gate-lifecycle.ts` (`GATE_POLICIES`, `TWO_PERSON_GATES`), `packages/catalogue/src/snapshots/1.4.0.json` (limits, triggers, gating, eligibility). "Portal surface" lists the web files that name the id as a literal; generic surfaces (the item page's step list, the generic gate card) are stated where they apply.


### 1.1 Stages and steps

| step | stage | actor | title | defined | configurable? | portal surface today |
|---|---|---|---|---|---|---|
| 0.1 | S0 | D+A | Census | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 0.2 | S0 | A+H | Light baseline | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 0.3 | S0 | A+H | Full baseline | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 0.4 | S0 | D+H | Controls and environment | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 0.5 | S0 | H | Sign-off | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 1.1 | S1 | D | Normalise + taint-mark input | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 1.2 | S1 | D+A | De-dupe and conflict scan | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 1.3 | S1 | D+A | Classify, propose lane | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 1.4 | S1 | D+A | Eligibility and suitability | values.ts STEPS | no (catalogue lane route) | named in web: ui/states.tsx |
| 1.5 | S1 | A+H | Clarify questions + intent block | values.ts STEPS | no (catalogue lane route) | named in web: floor/FloorPage.tsx |
| 1.6 | S1 | H | Ready decision | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 2.1 | S2 | A | Ground in code/docs | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 2.1b | S2 | A | Focused reverse-engineering | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 2.2 | S2 | A | Impact and stakeholders | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 2.3 | S2 | A | Options and decision brief | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 2.4 | S2 | A | Initiative elaboration (L6 only) | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 2.5 | S2 | H | G1 intent acceptance, final (L6 only) | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 3.1 | S3 | A | Locate affected requirements | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 3.2 | S3 | A | Draft delta spec | values.ts STEPS | no (catalogue lane route) | named in web: ui/tags.tsx |
| 3.3 | S3 | D | Validate | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 3.4 | S3 | A | Oracle specs | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 3.5 | S3 | A | Clean-context review | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 4.1 | S4 | A | Decisions / ADRs | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 4.2 | S4 | D+A | Contracts | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 4.3 | S4 | A | Data and migration | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 4.4 | S4 | A | NFR, threat, ops | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 4.5 | S4 | D+A | Constitution check, design-time | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 4.6 | S4 | H | Design and threat review | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 5.1 | S5 | A | Split into Units | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 5.2 | S5 | A | Sequence | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 5.3 | S5 | A | Task plan per Unit | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 5.4 | S5 | A | Bind verification | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 5.5 | S5 | D | Budget envelope | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 5.6 | S5 | D+A | Capacity input | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 5.7 | S5 | H | Schedule | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 5.8 | S5 | H | Plan approval | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 6.0 | S6 | D | Admission | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 6.1 | S6 | D | Provision / rehydrate | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 6.2 | S6 | D | Baseline | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 6.3 | S6 | D | Oracles red | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 6.4 | S6 | A | Implement task loop | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 6.5 | S6 | D | Self-check and tripwires | values.ts STEPS | no (catalogue lane route) | named in web: ui/tags.tsx |
| 6.6 | S6 | A | Draft PR via Push Broker | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 7.1 | S7 | D | Deterministic checks | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 7.2 | S7 | D | Test integrity + oracle quality | values.ts STEPS | no (catalogue lane route) | named in web: cards/ExceptionGate.tsx |
| 7.3 | S7 | D+A | Spec conformance | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 7.4 | S7 | D | Secrets and dependencies | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 7.5 | S7 | D+A | Constitution check, all lanes | values.ts STEPS | no (catalogue lane route) | named in web: cards/ExceptionGate.tsx |
| 7.6 | S7 | D | Pack assembly + sign | values.ts STEPS | no (catalogue lane route) | named in web: items/VerifyTab.tsx, pages/PackPage.tsx |
| 8.1 | S8 | H | G4 review | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 8.2 | S8 | H | Human merges on GitHub | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| S8b | S8b | H | Release | values.ts STEPS | no (catalogue lane route) | named in web: floor/FloorPage.tsx, floor/FloorPlanView.tsx, pages/ItemPage.tsx |
| 9.2 | S9 | H | Requester acceptance | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 9.3 | S9 | D | Close-out record | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 9.4 | S9 | A | Learn | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |
| 9.5 | S9 | H | Mode-E audit sample, async | values.ts STEPS | no (catalogue lane route) | generic: item page step list (`ui/sequence.tsx` Steps over contracts `STEPS`) |


### 1.2 Gates

| gate | family | title | slot | quorum | step-up | own request | configurable? | portal surface today |
|---|---|---|---|---|---|---|---|---|
| G0 | stage | Triage | intent | one | no | requester blocked | project gating profile group `g0g1` | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| G1 | stage | Intent, provisional | intent | one | no | requester blocked | project gating profile group `g0g1` | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| G1f | stage | Intent acceptance, final (L6 only, step 2.5) | intent | one | no | requester blocked | conditional, not toggleable | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| G2 | stage | Spec + oracle-spec approval | intent | one | no | requester blocked | project gating profile group `g2` | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| G3 | stage | Plan approval, SHA-bound | design | one | no | requester blocked | project gating profile group `g3_g3s` | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| G3d | stage | Design / threat sign-off | design | one | no | requester blocked | project gating profile group `g3d` | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| G3s | stage | Skeleton | design | one | no | requester blocked | project gating profile group `g3_g3s` | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| G3o | stage | Oracle deviation approval | design | one | no | requester blocked | conditional, not toggleable | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| G4 | stage | Merge approval, never skipped | g4 | one | no | requester blocked | always on (floor) | named in web: items/Governance.tsx |
| G5 | stage | Production release | g5 | one | yes | requester blocked | project gating profile group `g5` | named in web: items/Governance.tsx |
| G6 | stage | Requester acceptance | requesters | one | no | requester allowed | project gating profile group `g6` | named in web: items/Governance.tsx |
| X1 | action | Destructive / irreversible | x | two-person (project) | no | requester blocked | always on (floor) | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| X2 | action | Protected-path change | x | two-person (project) | no | requester blocked | always on (floor) | named in web: cards/ExceptionGate.tsx |
| X3 | action | New dependency | x | one | no | requester blocked | always on (floor) | named in web: cards/ExceptionGate.tsx |
| X4 | action | Break-glass post-hoc review | x | one | no | requester blocked | always on (floor) | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| E1 | exception | Downshift approval (R2) | x | one | no | requester blocked | always on (floor) | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| E2 | exception | Constitution exception | x | two-person (project) | no | requester blocked | always on (floor) | named in web: cards/ExceptionGate.tsx |
| E3 | exception | Envelope extension | x | one | no | requester blocked | always on (floor) | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| E4 | exception | Owner-of-record chooses | x | one | no | requester blocked | always on (floor) | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| E5 | exception | Escalation override | x | one | no | requester blocked | always on (floor) | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| E6 | exception | Test Change Request on locked tests | x | one | no | requester blocked | always on (floor) | named in web: cards/ExceptionGate.tsx |
| M1 | meta | Config | admin | one | no | requester blocked | conditional, not toggleable | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| M2 | meta | Variance | admin | one | no | requester blocked | conditional, not toggleable | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| M3 | meta | Catalogue / permission | admin | one | no | requester blocked | conditional, not toggleable | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| M4 | onboarding | Onboarding sign-off | m4 | two-person (project) | yes | requester blocked | always on (floor) | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| M5 | meta | Autonomy promotion | admin | one | no | requester blocked | conditional, not toggleable | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| M6 | meta | Approver grant | admin | one | no | requester blocked | conditional, not toggleable | generic: gate card (`cards/GateDecide.tsx`) when a card exists |
| Q1 | quarantine | Quarantine | sec | one | no | requester blocked | always on (floor) | named in web: cards/ExceptionGate.tsx, items/VerifyTab.tsx |
| SECT | quarantine | Security triage before any handoff | sec | one | no | requester blocked | always on (floor) | named in web: cards/ExceptionGate.tsx |


### 1.3 Back-edges

| edge | what | limit | then | defined | configurable? | portal surface today |
|---|---|---|---|---|---|---|
| B1 | missing info: ≤2 rounds, park 5 bd | rounds=2 rounds, park=5 business_days | Abandoned | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B2 | intent ambiguous: G1 again, 2×, then E4 | times=2 times | E4 | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B3 | validator/critic fail: 3 auto, then ET8 | auto_rounds=3 rounds | ET8 | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B4 | design reveals spec gap: 1× | times=1 times |  | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | named in web: api.ts, pages/ItemPage.tsx |
| B5 | plan changes requested: 2 rejections, then human writes plan | rejections=2 count | human_writes_plan | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B6 | red baseline / env broken |  |  | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B7 | task check fails: ET3 3 rounds · ET2 5 CI rounds or 2× time | et3_rounds=3 rounds, et2_ci_rounds=5 rounds, et2_time_multiple=2 multiple | D1 | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B8 | scope tripwire, 1st: split Unit, G3 again | times=1 times | D1 | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B9 | repairable finding: ET3/ET4/ET5/ET6 limits | et3_rounds=None rounds, et4_limit=None count, et5_limit=None count, et6_limit=None count | D2 | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B10 | spec ambiguous: G2 portion again, 1× | times=1 times | D2 | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B11 | approach wrong: G3 again, 1× | times=1 times | D2 | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B12 | locked test must change, 1× | times=1 times | D2 | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B13 | G4 changes requested: ET7 2 rounds | et7_rounds=2 rounds | D3 | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B14 | mode-E approver unsure → mode C |  |  | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B15 | B15a base moved, clean rebase: S7 re-run, 2× \| B15b merge conflict: resolve in S6, then S7 | b15a_times=2 times |  | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B16 | deploy unhealthy: rollback, NEW L0/L1 item |  |  | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B17 | escape found post-merge: NEW L0/L1, ET13 |  |  | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B18 | requester rejects: NEW linked item |  |  | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B19 | gate-miss on mode-E merge: NEW item >10% over ≥20 sampled suspends mode E | miss_rate=10 percent, min_sample=20 sample_size | suspend_mode_e | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B20 | requester amends scope, any active stage, 1× | times=1 times |  | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B21 | any gate > 1 bd SLA → backup approver / manager NEVER auto-approve | gate_sla=1 business_days | backup_approver | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B22 | ineligible / unsuitable |  |  | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B23 | spec rejected: 2 rounds, then E4 | rounds=2 rounds | E4 | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B24 | design rejected: 2 rounds, then E4 | rounds=2 rounds | E4 | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B25 | exception denied: redesign 1×, else E4 | times=1 times | E4 | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B26 | release denied |  |  | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B27 | suspected injection in request: content fenced as data, flagged on G0 card |  |  | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |
| B28 | rework budget exhausted | total=5 count, item_age=10 business_days | E4 | flow.ts BACK_EDGES; catalogue 1.4.0 back_edge_limits | catalogue release only (M3) | **none** |


### 1.4 Handoffs

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| D1 | HANDOFF from S6 | flow.ts HANDOFF_DESCRIPTIONS | no | **none** |
| D2 | HANDOFF from S7 | flow.ts HANDOFF_DESCRIPTIONS | no | **none** |
| D3 | HANDOFF from G4 | flow.ts HANDOFF_DESCRIPTIONS | no | **none** |
| D4 | hand back once | flow.ts HANDOFF_DESCRIPTIONS | no | **none** |
| D5 | dev completes | flow.ts HANDOFF_DESCRIPTIONS | no | **none** |


### 1.5 Triggers (ET)

| id | what | catalogue | defined | configurable? | portal surface today |
|---|---|---|---|---|---|
| ET1 | budget 100% | budget=100 -> D1 | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |
| ET2 | time \| 5 CI rounds or 2× time | ci_rounds=5; time_multiple=2 -> D1 | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |
| ET3 | repeat fail \| 3 rounds | rounds=3 -> D1,D2 | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |
| ET4 |  | limit=None -> D2 | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |
| ET5 |  | limit=None -> D2 | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |
| ET6 |  | limit=None -> D2 | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |
| ET7 | two rejection rounds | rejection_rounds=2 -> D3 | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |
| ET8 | agent gave up |  -> D1 | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |
| ET9 | scope drift ×2 | scope_drift=2 -> D1 | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |
| ET10 | misbehaviour |  -> quarantine | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |
| ET11 | oscillation |  -> D1 | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |
| ET12 | instability |  -> D1 | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |
| ET13 | escape found post-merge |  -> new_item | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |
| ET14 | circuit breaker \| project × lane → new items go L8 | trip=3 -> circuit_breaker | flow.ts TRIGGER_DESCRIPTIONS; catalogue triggers | catalogue release only | **none** |


### 1.6 Holds

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| H1 | approver pool | flow.ts HoldReason / HOLD_DESCRIPTIONS | H2: `sandbox.caps`; WIP: `project.wip_limit`; MM-2: `ops.maintenance.mm2`; control: Operate > Controls; others no | **none** |
| H2 | capacity | flow.ts HoldReason / HOLD_DESCRIPTIONS | H2: `sandbox.caps`; WIP: `project.wip_limit`; MM-2: `ops.maintenance.mm2`; control: Operate > Controls; others no | **none** |
| H3 | env | flow.ts HoldReason / HOLD_DESCRIPTIONS | H2: `sandbox.caps`; WIP: `project.wip_limit`; MM-2: `ops.maintenance.mm2`; control: Operate > Controls; others no | **none** |
| WIP | WIP | flow.ts HoldReason / HOLD_DESCRIPTIONS | H2: `sandbox.caps`; WIP: `project.wip_limit`; MM-2: `ops.maintenance.mm2`; control: Operate > Controls; others no | **none** |
| N8 | no active Project Readiness Record | flow.ts HoldReason / HOLD_DESCRIPTIONS | H2: `sandbox.caps`; WIP: `project.wip_limit`; MM-2: `ops.maintenance.mm2`; control: Operate > Controls; others no | **none** |
| kill | kill switch | flow.ts HoldReason / HOLD_DESCRIPTIONS | H2: `sandbox.caps`; WIP: `project.wip_limit`; MM-2: `ops.maintenance.mm2`; control: Operate > Controls; others no | named in web: App.tsx, cards/C4Form.tsx, pages/OperatePages.tsx, router.tsx (+1) |
| maintenance | maintenance MM-2: timers frozen, decisions disabled, drafts kept | flow.ts HoldReason / HOLD_DESCRIPTIONS | H2: `sandbox.caps`; WIP: `project.wip_limit`; MM-2: `ops.maintenance.mm2`; control: Operate > Controls; others no | **none** |
| quota | quota | flow.ts HoldReason / HOLD_DESCRIPTIONS | H2: `sandbox.caps`; WIP: `project.wip_limit`; MM-2: `ops.maintenance.mm2`; control: Operate > Controls; others no | **none** |
| control | operator hold control (M9.6) | flow.ts HoldReason / HOLD_DESCRIPTIONS | H2: `sandbox.caps`; WIP: `project.wip_limit`; MM-2: `ops.maintenance.mm2`; control: Operate > Controls; others no | **none** |


### 1.7 Wait states (PARK, BLOCKED, RELHOLD, spike report)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| Parked |  | contracts WaitState | no | named in web: pages/S0Page.tsx, vocab.ts |
| Blocked |  | contracts WaitState | no | named in web: pages/S0Page.tsx, vocab.ts |
| ReleaseHeld |  | contracts WaitState | no | **none** |
| SpikeReport |  | contracts WaitState | no | **none** |


### 1.8 Re-lanes

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| R1 | UPSHIFT, free and logged | flow.ts RELANE_DESCRIPTIONS | no | **none** |
| R2 | DOWNSHIFT needs E1, re-run G0 | flow.ts RELANE_DESCRIPTIONS | no | named in web: api.ts, pages/ItemPage.tsx |
| R3 | CIRCUIT BREAKER ET14 | flow.ts RELANE_DESCRIPTIONS | no | **none** |
| R4 | Hotfix done | flow.ts RELANE_DESCRIPTIONS | no | **none** |


### 1.9 Floor rooms

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| SCHED |  | contracts entities/floor.ts FloorRoom | no | **none** |
| HOLD |  | contracts entities/floor.ts FloorRoom | no | **none** |
| QUAR |  | contracts entities/floor.ts FloorRoom | no | **none** |
| DESK |  | contracts entities/floor.ts FloorRoom | no | **none** |
| BIN |  | contracts entities/floor.ts FloorRoom | no | **none** |
| DONE |  | contracts entities/floor.ts FloorRoom | no | named in web: floor/FloorPlanView.tsx, floor/geometry.ts |


### 1.10 Work item phases

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| Draft |  | contracts WorkItemPhase | no | **none** |
| Clarifying |  | contracts WorkItemPhase | no | **none** |
| S1 |  | contracts WorkItemPhase | no | named in web: floor/geometry.ts |
| S2 |  | contracts WorkItemPhase | no | named in web: floor/FloorPlanView.tsx, floor/geometry.ts |
| S3 |  | contracts WorkItemPhase | no | named in web: floor/FloorPlanView.tsx, floor/geometry.ts |
| S4 |  | contracts WorkItemPhase | no | named in web: floor/FloorPlanView.tsx, floor/geometry.ts |
| S5 |  | contracts WorkItemPhase | no | named in web: floor/FloorPlanView.tsx, floor/geometry.ts |
| Scheduling |  | contracts WorkItemPhase | no | **none** |
| S6 |  | contracts WorkItemPhase | no | named in web: floor/FloorPlanView.tsx, floor/geometry.ts |
| S7 |  | contracts WorkItemPhase | no | named in web: floor/geometry.ts, pages/ItemPage.tsx |
| G4 |  | contracts WorkItemPhase | no | named in web: items/Governance.tsx |
| S8a |  | contracts WorkItemPhase | no | named in web: floor/FloorPage.tsx, floor/FloorPlanView.tsx |
| S8b |  | contracts WorkItemPhase | no | named in web: floor/FloorPage.tsx, floor/FloorPlanView.tsx, pages/ItemPage.tsx |
| G5 |  | contracts WorkItemPhase | no | named in web: items/Governance.tsx |
| S9 |  | contracts WorkItemPhase | no | named in web: floor/geometry.ts, items/Governance.tsx, pages/ItemPage.tsx |
| G6 |  | contracts WorkItemPhase | no | named in web: items/Governance.tsx |
| Held |  | contracts WorkItemPhase | no | named in web: pages/HomePage.tsx, pages/OperatePages.tsx |
| Handoff |  | contracts WorkItemPhase | no | **none** |
| Quarantined |  | contracts WorkItemPhase | no | named in web: pages/ItemPage.tsx |
| Parked |  | contracts WorkItemPhase | no | named in web: pages/S0Page.tsx, vocab.ts |
| Done |  | contracts WorkItemPhase | no | named in web: vocab.ts |
| Declined |  | contracts WorkItemPhase | no | **none** |
| Abandoned |  | contracts WorkItemPhase | no | **none** |
| Withdrawn |  | contracts WorkItemPhase | no | named in web: vocab.ts |
| HandedOverClosed |  | contracts WorkItemPhase | no | **none** |
| Superseded |  | contracts WorkItemPhase | no | named in web: vocab.ts |
| Deferred |  | contracts WorkItemPhase | no | **none** |


### 1.11 Blockers (S0)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| B1 |  | contracts BlockerId | no | **none** |
| B2 |  | contracts BlockerId | no | **none** |
| B3 |  | contracts BlockerId | no | **none** |
| B4 |  | contracts BlockerId | no | named in web: api.ts, pages/ItemPage.tsx |
| B5 |  | contracts BlockerId | no | **none** |
| B6 |  | contracts BlockerId | no | **none** |


### 1.12 Lanes: route per catalogue version and eligibility

Route = the lane's stages with their mode and the gates it carries (`catalogue.lanes[L].stages/gates`), per snapshot in `packages/catalogue/src/snapshots/`. Eligibility = `catalogue.eligibility.by_level`; `tier_min_level` and `lane_requires_floor` below.

Stage mode: plain = full, `~` partial, `-` skipped. Gate presence: plain = required, `*` by profile, `?` conditional.

| lane | label | catalogue | enters at | stages | gates | eligible by level |
|---|---|---|---|---|---|---|
| L0 | hotfix | 1.0.0 | SCHED | S1 S2- S3- S4- S5- S6 S7 S8 S8b S9 | G0* G1* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:unspecified, light:unspecified, full:unspecified |
| L0 | hotfix | 1.1.0 | SCHED | S1 S2- S3- S4- S5- S6 S7 S8 S8b S9 | G0* G1* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:unspecified, light:unspecified, full:unspecified |
| L0 | hotfix | 1.2.0 | SCHED | S1 S2- S3- S4- S5- S6 S7 S8 S8b S9 | G0* G1* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:unspecified, light:unspecified, full:unspecified |
| L0 | hotfix | 1.3.0 | SCHED | S1 S2- S3- S4- S5- S6 S7 S8 S8b S9 | G0* G1* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:unspecified, light:unspecified, full:unspecified |
| L0 | hotfix | 1.4.0 | SCHED | S1 S2- S3- S4- S5- S6 S7 S8 S8b S9 | G0* G1* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:eligible, full:eligible |
| L1 |  | 1.0.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:eligible, full:eligible |
| L1 |  | 1.1.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:eligible, full:eligible |
| L1 |  | 1.2.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:eligible, full:eligible |
| L1 |  | 1.3.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:eligible, full:eligible |
| L1 |  | 1.4.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:eligible, full:eligible |
| L2 | remediation | 1.0.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:unspecified, light:eligible, full:eligible |
| L2 | remediation | 1.1.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:unspecified, light:eligible, full:eligible |
| L2 | remediation | 1.2.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:unspecified, light:eligible, full:eligible |
| L2 | remediation | 1.3.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:unspecified, light:eligible, full:eligible |
| L2 | remediation | 1.4.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:unspecified, light:eligible, full:eligible |
| L3 |  | 1.0.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:eligible, full:eligible |
| L3 |  | 1.1.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:eligible, full:eligible |
| L3 |  | 1.2.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:eligible, full:eligible |
| L3 |  | 1.3.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:eligible, full:eligible |
| L3 |  | 1.4.0 | 3.1 | S1 S2- S3~ S4- S5~ S6 S7 S8 S8b S9 | G0* G1* G2* G3* G3s* G3o? X1? X3? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:eligible, full:eligible |
| L4 |  | 1.0.0 | 2.1 | S1 S2~ S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L4 |  | 1.1.0 | 2.1 | S1 S2~ S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L4 |  | 1.2.0 | 2.1 | S1 S2~ S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L4 |  | 1.3.0 | 2.1 | S1 S2~ S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L4 |  | 1.4.0 | 2.1 | S1 S2~ S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L5 |  | 1.0.0 | 2.1 | S1 S2~ S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L5 |  | 1.1.0 | 2.1 | S1 S2~ S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L5 |  | 1.2.0 | 2.1 | S1 S2~ S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L5 |  | 1.3.0 | 2.1 | S1 S2~ S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L5 |  | 1.4.0 | 2.1 | S1 S2~ S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L6 | initiative | 1.0.0 | 2.1 | S1 S2 S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G1f G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L6 | initiative | 1.1.0 | 2.1 | S1 S2 S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G1f G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L6 | initiative | 1.2.0 | 2.1 | S1 S2 S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G1f G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L6 | initiative | 1.3.0 | 2.1 | S1 S2 S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G1f G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L6 | initiative | 1.4.0 | 2.1 | S1 S2 S3 S4 S5 S6 S7 S8 S8b S9 | G0* G1* G1f G2* G3d* G3* G3s* G3o? X1? X3? E2? E6? X2? E2? G4 G5* G6* X4? | census:not_eligible, light:not_eligible, full:eligible |
| L7 | spike | 1.0.0 | 2.1 | S1 S2~ S3- S4- S5- S6~ S7- S8- S8b- S9~ | G0* G1* X4? | census:unspecified, light:unspecified, full:unspecified |
| L7 | spike | 1.1.0 | 2.1 | S1 S2~ S3- S4- S5- S6~ S7- S8- S8b- S9~ | G0* G1* X4? | census:unspecified, light:unspecified, full:unspecified |
| L7 | spike | 1.2.0 | 2.1 | S1 S2~ S3- S4- S5- S6~ S7- S8- S8b- S9~ | G0* G1* X4? | census:unspecified, light:unspecified, full:unspecified |
| L7 | spike | 1.3.0 | 2.1 | S1 S2~ S3- S4- S5- S6~ S7- S8- S8b- S9~ | G0* G1* X4? | census:unspecified, light:unspecified, full:unspecified |
| L7 | spike | 1.4.0 | 2.1 | S1 S2~ S3- S4- S5- S6~ S7- S8- S8b- S9~ | G0* G1* X4? | census:eligible, light:eligible, full:eligible |
| L8 | human-led | 1.0.0 | None | S1 S2- S3- S4- S5- S6- S7 S8 S8b- S9- | G0* G1* E6? X2? E2? G4 | census:eligible, light:eligible, full:eligible |
| L8 | human-led | 1.1.0 | None | S1 S2- S3- S4- S5- S6- S7 S8 S8b- S9- | G0* G1* E6? X2? E2? G4 | census:eligible, light:eligible, full:eligible |
| L8 | human-led | 1.2.0 | None | S1 S2- S3- S4- S5- S6- S7 S8 S8b- S9- | G0* G1* E6? X2? E2? G4 | census:eligible, light:eligible, full:eligible |
| L8 | human-led | 1.3.0 | None | S1 S2- S3- S4- S5- S6- S7 S8 S8b- S9- | G0* G1* E6? X2? E2? G4 | census:eligible, light:eligible, full:eligible |
| L8 | human-led | 1.4.0 | None | S1 S2- S3- S4- S5- S6- S7 S8 S8b- S9- | G0* G1* E6? X2? E2? G4 | census:eligible, light:eligible, full:eligible |

`tier_min_level` (1.4.0): `{"T2": {"level": "full", "lanes": ["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7"]}}`; `lane_requires_floor`: `{"L5": "FF2"}`. Gating defaults (1.4.0): `{"g0g1": {"kind": "fixed", "value": "on", "exceptions": []}, "g2": {"kind": "by_lane", "lanes": {"L1": "off", "L2": "off", "L3": "off", "L4": "on", "L5": "on", "L6": "on"}}, "g3d": {"kind": "by_lane", "lanes": {"L4": "on", "L5": "on", "L6": "on"}}, "g3_g3s": {"kind": "by_lane", "lanes": {"L4": "on", "L5": "on", "L6": "on"}}, "g5": {"kind": "by_deploys", "deploys": "on", "otherwise": "off"}, "g6": {"kind": "fixed", "value": "on", "exceptions": [{"when": "requester is the operator", "value": "off"}]}}`; T2 floor: `{"lanes": ["L4", "L5", "L6"], "groups": ["g2", "g3d", "g3_g3s"], "deploy_group": "g5"}`.

Per-area levels (DEC-25) apply the same table per area; the portal surface for lanes: none.


## 2. Settings (config keys)

Source: the registry core boots with: `registerGatewayConfig(registerCoreConfig(registerPdpConfig(new ConfigRegistry())))` (`services/core/src/boot.ts`), dumped key by key with its Zod schema as JSON Schema. Layer: `factory` = factory only (`overridable: false`), `project` = a project layer may set it. Proposer/decider: factory layer = `config.propose` on the fleet, decided under `factory.m1_policy` (default: one factory admin other than the proposer); project layer = the project admin slot (M1, `GATE_POLICIES.M1.slot = admin`). Readers: services whose non-test source names the key or its constant.

| key | kind | layer | what | fields (type [bounds]) | default | read by | portal surface today |
|---|---|---|---|---|---|---|---|
| audit.retention | setting | factory | retention classes of the payloads kept off the hash chain (days before the audit service’s sweep erases them; null keeps them until an erasure request). A legal | classes:object | {"classes": {"conversation_payload": {"days": null}}} | audit, contracts | `/config/audit.retention` (ConfigConsole, factory layer) |
| codehost.merge_bypass | setting | factory | DEC-10: per repo, the named people who may merge a PR whose aisdlc/gate check did not pass (never an App). Every such merge is recorded and gets an X4 review. E | object | {} | contracts, core, gate-check | `/config/codehost.merge_bypass` (ConfigConsole, factory layer) |
| factory.constitution | setting | factory | the factory constitution 4.5 checks a design against: deterministic rules (egress, migrations). Factory layer only, M1-gated | version:integer [min 1, max 9007199254740991]; rules:array [max 50] | {"version": 1, "rules": [{"rule_id": "C-EGRESS", "kind": "no_unapproved_egress", | contracts, core | `/config/factory.constitution` (ConfigConsole, factory layer) |
| factory.floor | setting | factory | the floor (M19): minutes of silence after which an item in a session is drawn stuck (per station when set), and the eval or acceptance rate below which an agent | silence_minutes:integer [min 1, max 1440]; by_stage:object; low_score:number [min 0, max 1] | {"silence_minutes": 30, "by_stage": {}, "low_score": 0.85} | contracts | `/config/factory.floor` (ConfigConsole, factory layer) |
| factory.learn | setting | factory | 9.4 Learn: when the factory turns close-out evidence into a META proposal (M1 config, M2 variance, M3 catalogue, M5 autonomy, M6 approver). They decide nothing: | window:integer [min 1, max 500]; clean_streak:integer [min 1, max 500]; variance_rework:integer [min 1, max 100]; edge_hotspot:integer [min 2, max 500]; break_glass:integer [min 1, max 500]; single_approver:integer [min 2, max 500] | {"window": 50, "clean_streak": 20, "variance_rework": 3, "edge_hotspot": 5, "bre | contracts | `/config/factory.learn` (ConfigConsole, factory layer) |
| factory.m1_policy | setting | factory | who decides a factory-layer revision (its M1): the holders of a fleet role, never the proposer, one or two of them. Default: one factory admin other than the pr | role:string [max 128]; approvers:integer [min 1, max 2] | {"role": "factory.admin", "approvers": 1} | contracts | `/config/factory.m1_policy` (ConfigConsole, factory layer) |
| gateway.models | setting | factory | models of the registry providers, with limits and prices (the cost table) | model_id:string [max 64]; provider_id:string [max 64]; provider_model:string [max 128]; tools_capable:boolean; context_window:integer [min 1, max 100000000]; max_tokens_cap:integer [min 1, max 1000000]; usd_in_per_mtok:number [min 0, max 100000]; usd_out_per_m | [] | contracts, core, gateway, integrations | `/config/gateway.models` (ConfigConsole, factory layer) |
| gateway.routes | setting | factory | (environment, data class) -> model; D3 never has a route | environment:string [local/staging/prod]; data_class:string [D0/D1/D2]; model_id:string [max 64] | [] | contracts, core, gateway, integrations | `/config/gateway.routes` (ConfigConsole, factory layer) |
| integrations.installs | setting | factory | integrations enabled per project, with repo and model overrides | install_id:string [max 64]; integration_id:string [max 64]; project_id:string [max 128]; enabled:boolean; overrides:object | [] | contracts, core, integrations | `/config/integrations.installs` (ConfigConsole, factory layer) |
| integrations.registry | setting | factory | integrations (code hosts, model providers) with credential references and scopes | integration_id:string [max 64]; kind:string [code_host/model_provider/notifier/tracke]; adapter:string [github_app/fake_github/anthropic/openai_]; display_name:string [max 120]; config:object; status:string [draft/enabled/disabled/retired]; owner:string [max 1 | [] | contracts, core, integrations | `/config/integrations.registry` (ConfigConsole, factory layer) |
| notifications.channels | setting | factory | the notifier’s Slack (incoming webhook) and email (SMTP) channels: credentials as file: references, a data class cap per channel (D0 or D1), which rows a person | array | [] | contracts, notifier | `/config/notifications.channels` (ConfigConsole, factory layer) |
| onboarding.instruction_template | setting | factory | DEC-11 (refined): the factory template card 2 checks every AGENTS.md and CLAUDE.md section against: what is taken and what never is (tools, permissions, network | schema:string; accepted:array; rejected:array; lint_rejects:object; required:array; max_lines:integer [min 10, max 150] | {"schema": "instruction-template/1", "accepted": [{"kind": "commands", "headings | contracts, core | `/config/onboarding.instruction_template` (ConfigConsole, factory layer) |
| onboarding.light_tests | setting | factory | M16: the W image LF4 is about (by digest; null: LF4 unknown) and the Light spikes' thresholds (SP-STD-1 runs, SP-STD-3 false-positive ceiling, planted catch flo | worker_image:string\|null; isolation_min_runs:integer [min 1, max 100]; lint_max_false_positive_rate:number [min 0, max 1]; lint_min_planted_catch_rate:number [min 0, max 1]; lint_policy_rules:array [max 20] | {"worker_image": null, "isolation_min_runs": 3, "lint_max_false_positive_rate":  | contracts, core | `/config/onboarding.light_tests` (ConfigConsole, factory layer) |
| onboarding.reonboard_triggers | setting | factory | M17 (OB §8): how many knowledge defects in one area within how many days trigger a re-onboarding proposal (the spec: 3 in 30). Factory layer only, M1-gated | knowledge_defects:object | {"knowledge_defects": {"count": 3, "window_days": 30}} | contracts, core | `/config/onboarding.reonboard_triggers` (ConfigConsole, factory layer) |
| onboarding.sandbox_image | setting | factory | DEC-17 (refined): the dedicated onboarding probe image, by digest only, with the sha256 of the pin lock it was built from. Null: no probe runs. An image update  | anyOf | null | contracts | `/config/onboarding.sandbox_image` (ConfigConsole, factory layer) |
| ops.maintenance.mm2 | ops_flag | factory | maintenance mode MM-2 (FL): timers frozen, decisions disabled, drafts kept. An ops flag: factory layer only | boolean | false | contracts, core | `/config/ops.maintenance.mm2` (ConfigConsole, factory layer) |
| pdp.bundle | setting | factory | the policy bundle every enforcement point evaluates (schema, policies, hash) | anyOf | null | contracts, core, pdp | `/config/pdp.bundle` (ConfigConsole, factory layer) |
| project.default_envelope | setting | project | the project's default envelope: the envelope of an item with no plan, and the most one Unit reserves (null: the lane profile and the coder contract). Per projec | anyOf | null | contracts, core | `/config/project.default_envelope` (ConfigConsole, factory layer); project layer: project settings revision (`pages/RevisionPage.tsx`) only via card 4/M1 |
| project.gating_profile | setting | project | which human gates the project has, above the safety floor (OB §1C) | gates:object; schedule:string [auto/human]; tier_floor_applied:boolean; by_lane:object | {"gates": {"g0g1": "on", "g2": "on", "g3d": "on", "g3_g3s": "on", "g5": "on", "g | contracts, core | `/config/project.gating_profile` (ConfigConsole, factory layer); project layer: project settings revision (`pages/RevisionPage.tsx`) only via card 4/M1 |
| project.kill_delegations | setting | project | project kill delegations, until revoked (DEC-29) | delegate:string [max 128]; scope:?; granted_by:string [max 128]; granted_at:string; revoked_at:string\|null | [] | contracts, core | `/config/project.kill_delegations` (ConfigConsole, factory layer); project layer: project settings revision (`pages/RevisionPage.tsx`) only via card 4/M1 |
| project.release | setting | project | G5 release: off (no S8b release, no G5) or a deploy target (a GitHub environment) that gate-relay deploys merged commits to after an approved G5. Not chosen: no | anyOf | null | contracts, core | `/config/project.release` (ConfigConsole, factory layer); project layer: named in web: cards/C4Form.tsx |
| project.role_map | setting | project | who holds each of the ten slots of the project (OB §1B) | object | {"admin": {"kind": "principals", "principals": []}, "requesters": {"kind": "prin | contracts, core | `/config/project.role_map` (ConfigConsole, factory layer); project layer: project settings revision (`pages/RevisionPage.tsx`) only via card 4/M1 |
| project.two_person | setting | project | two-person rule for X1, X2, E2, M4 and kill release (DEC-28) | enabled:boolean; default:string; locked_on:boolean | {"enabled": true, "default": "on_if_2plus", "locked_on": false} | contracts, core | `/config/project.two_person` (ConfigConsole, factory layer); project layer: project settings revision (`pages/RevisionPage.tsx`) only via card 4/M1 |
| project.wip_limit | setting | project | the project's WIP limit: at most this many of its Units hold an admission grant at once (null: none beyond the sandbox caps). Per project, M1-gated | anyOf | null | contracts, core | `/config/project.wip_limit` (ConfigConsole, factory layer); project layer: project settings revision (`pages/RevisionPage.tsx`) only via card 4/M1 |
| s0.calendar | setting | factory | the business-day calendar of the S0 timers and of the work lifecycle (PARK, item age) | weekend:array [max 6]; holidays:array; utc_offset_minutes:integer [min -720, max 840] | {"weekend": [0, 6], "holidays": [], "utc_offset_minutes": 0} | contracts, core | `/config/s0.calendar` (ConfigConsole, factory layer) |
| s0.failure_model | setting | factory | S0 failure model: send-backs, PARK after silence, machine retries (DEC-9) | send_backs_per_step:integer [min 1, max 9007199254740991]; park_business_days:integer [min 1, max 9007199254740991]; machine_retries:integer [min 0, max 9007199254740991]; machine_retry_delay_seconds:integer [min 0, max 9007199254740991] | {"send_backs_per_step": 1, "park_business_days": 5, "machine_retries": 3, "machi | contracts, core | `/config/s0.failure_model` (ConfigConsole, factory layer) |
| s0.t0_attestation_required | setting | factory | DEC-4: a T0 tier needs the owner's positive attestation on card 1 | boolean | true | contracts, core | `/config/s0.t0_attestation_required` (ConfigConsole, factory layer) |
| s0.timeboxes | setting | factory | S0 step time boxes (OB §6.2), with the reminder at 2 business days on 0.1 | object | {"0.1": {"machine_minutes": 30, "human_minutes": 15, "overall_business_days": nu | contracts, core | `/config/s0.timeboxes` (ConfigConsole, factory layer) |
| sandbox.caps | setting | factory | the two sandbox caps of a runner host (a total and the coding W cap), with optional per-host rows. Factory layer only, M1-gated | total:integer [min 1, max 32]; coding:integer [min 0, max 8]; hosts:object | {"total": 4, "coding": 1} | contracts, sandbox-controller | `/config/sandbox.caps` (ConfigConsole, factory layer) |
| sandbox.exec_allowed_repos | setting | factory | DEC-18: the repositories whose code may run in a container-class sandbox (the owner allow-list). Empty: none. Factory layer only, M1-gated | array | [] | contracts, core | `/config/sandbox.exec_allowed_repos` (ConfigConsole, factory layer) |


## 3. Permissions

Source (the "web names it" column below is a literal match only; §7.1 adds the bff routes guarded by the action that the web calls, which is the authoritative surface): `packages/contracts/src/entities/policy.ts` (`ACTION_CATALOGUE`), `packages/contracts/src/entities/access.ts` (`ROLE_CATALOGUE`). Proposed actions: `docs/design/portal-coverage.md` §5 item 6.

| action | class | resources | grants | what | portal surface today (web names it) |
|---|---|---|---|---|---|
| project.onboard | write | Fleet,Team | roles:factory.admin,factory.onboarder | Request that a repository is onboarded as a project (S0, DEC-2) | named in web: App.tsx, pages/HomePage.tsx, shell/nav.ts |
| work.request | write | Project | slots:requesters,admin | Ask for work on a project: a request on an entry channel (S1, M9.1) | named in web: pages/IssueTwinPage.tsx, pages/MyAccessPage.tsx |
| item.ready | write | Item | slots:requesters,intent,admin | Say a request is ready for G0 (S1 step 1.6) and answer S1 clarification questions | **none** |
| item.observe | write | Item | slots:design | Raise an observed signal while G3d is open: B4 (the design reveals a gap in the spec) or R2 (smaller than the lane) | **none** |
| item.plan | write | Item | slots:design | Write the plan by hand after B5 (the human never pushes code; G3 decides the plan) | **none** |
| item.release | write | Item | slots:g5,admin | Re-request a held release (RELHOLD) after the fix window: G5 opens again | named in web: items/Governance.tsx |
| item.human_done | write | Item | slots:design | Say the human-led work of an L8 item is done (D5): S7 checks it next | **none** |
| item.unsure | write | Item | slots:g4 | Say you are unsure of a mode-E G4 review (B14): a codeowner reviews it (mode C) | named in web: items/Governance.tsx |
| item.escape | write | Item | slots:requesters,g4,x,admin; roles:factory.admin | Report an escape found after the merge of a closed-out item (B17): a new L0/L1 item | named in web: pages/CloseoutPage.tsx |
| audit.record | write | Item | slots:g4 | Record the audit of a drawn mode-E merge (9.5): ok or a gate miss (B19) | named in web: pages/CloseoutPage.tsx |
| closeout.read | read | Item | view_level: | Read the close-out record of an item (9.3), its escapes and its audit | named in web: pages/CloseoutPage.tsx |
| learn.propose | config | Project | slots:admin; roles:factory.admin | Run 9.4 Learn for a project, or ask for the lift of a mode-E suspension: a META gate (M1, M2, M3, M5, M6) to decide | named in web: pages/LearnPage.tsx |
| project.view | read | Project | view_level: | See a project and its settings | named in web: assistant/OnboardingAssistant.tsx, pages/KnowledgePage.tsx, pages/MyAccessPage.tsx, pages/ProjectDetail.tsx |
| project.settings.edit | config | Project | slots:admin; roles:factory.admin | Change a project: role map, two-person rule, gating profile, kill delegations | named in web: pages/MyAccessPage.tsx |
| floor.read | read | Fleet,Project | view_level: | Open the floor of a project, or the fleet floor | named in web: floor/FloorPage.tsx, shell/nav.ts |
| item.view_floor | read | Item | view_level: | See an item on the floor | **none** |
| gate.view | read | Gate | view_level: | See a gate instance and its evidence | **none** |
| gate.decide | decide | Gate | gate_slot: | Decide a gate (approve, reject, request changes); only the gate policy slot | **none** |
| card.decide | decide | Card | decides_gates: | Decide an inbox card (a decision on each gate the card carries) | named in web: cards/ExceptionGate.tsx |
| kill.request | kill | Fleet,Project,Lane | slots:kill,admin; roles:factory.admin | Request a kill of a project or lane; the fleet kill is factory.admin only (DEC-29) | **none** |
| kill.release | kill | Fleet,Project,Lane | slots:kill,admin; roles:factory.admin | Release a kill (the two-person rule is the decision kernel's) | **none** |
| config.propose | config | Fleet,Project | slots:admin; roles:factory.admin | Propose a configuration revision (publishing needs an M1 gate) | named in web: config/ConfigConsole.tsx, pages/IssueTwinPage.tsx, pages/MyAccessPage.tsx, shell/nav.ts |
| config.decide | decide | Fleet | roles:factory.admin | Decide a factory-layer configuration revision (its M1), under factory.m1_policy | named in web: pages/AuditPanels.tsx, pages/FactoryRevisionPage.tsx |
| audit.read | read | Fleet,Project | view_level: | Read the audit views of a project or of the whole factory | named in web: pages/AdminPages.tsx, pages/FactoryRevisionPage.tsx, pages/GovernPages.tsx, pages/HomePage.tsx (+5) |
| control.apply | config | Fleet,Project,Lane | slots:admin; roles:factory.admin | Preview and apply a control (hold, clamp, halt, maintenance) on a scope | named in web: pages/OperatePages.tsx |
| control.lift | config | Fleet,Project,Lane | slots:admin; roles:factory.admin | Lift a control | named in web: pages/OperatePages.tsx |
| banner.publish | config | Fleet,Project | slots:admin; roles:factory.admin | Publish or withdraw a banner for a scope | **none** |
| access.explain | read | Fleet,Project | view_level: | Ask who can decide what on a project (effective access) | named in web: pages/AdminPages.tsx, pages/MyAccessPage.tsx, shell/nav.ts |
| access.manage |  |  |  | PROPOSED, not in ACTION_CATALOGUE | **none** |
| identity.admin |  |  |  | PROPOSED, not in ACTION_CATALOGUE | named in web: pages/AuditPanels.tsx |
| ops.read |  |  |  | PROPOSED, not in ACTION_CATALOGUE | named in web: shell/nav.ts |
| session.stop |  |  |  | PROPOSED, not in ACTION_CATALOGUE | **none** |
| quality.read |  |  |  | PROPOSED, not in ACTION_CATALOGUE | named in web: shell/nav.ts |
| assistant.use |  |  |  | PROPOSED, not in ACTION_CATALOGUE | **none** |

| role | slot | view | data class | what | actions granted (by role or slot) |
|---|---|---|---|---|---|
| project.admin | admin | V3 |  | Project administrator: role map, settings, project gates | banner.publish, config.propose, control.apply, control.lift, item.escape, item.ready, item.release, kill.release, kill.request, learn.propose, project.settings.edit, work.request |
| project.requester | requesters | V2 |  | May request work; decides G6 acceptance | item.escape, item.ready, work.request |
| project.intent_approver | intent | V2 |  | Approves intent and spec (G0, G1, G2) | item.ready |
| project.design_approver | design | V2 |  | Approves design and plan (G3d, G3, G3s) | item.human_done, item.observe, item.plan |
| project.code_owner | g4 | V2 |  | Merge review (G4): the code owners on GitHub | audit.record, item.escape, item.unsure |
| project.release_approver | g5 | V2 |  | Approves release (G5), step-up kept | item.release |
| project.exception_approver | x | V2 |  | Decides exception gates (X1, X2, E1-E6) | item.escape |
| project.security_approver | sec | V2 |  | Security gates (Q1, SECT) |  |
| project.onboarding_signer | m4 | V2 |  | Signs onboarding (M4), step-up required |  |
| project.kill_holder | kill | V2 |  | Requests a project or lane kill; releases it | kill.release, kill.request |
| project.viewer |  | V1 |  | Read access to a project |  |
| factory.admin |  | V3 |  | Factory administrator: every administrative action (onboard, settings, kill, config, audit, access e | banner.publish, config.decide, config.propose, control.apply, control.lift, item.escape, kill.release, kill.request, learn.propose, project.onboard, project.settings.edit |
| factory.onboarder |  | V1 |  | May request an onboarding (project.onboard); decides no gate and no card | project.onboard |
| factory.auditor |  | V3 |  | Reads the whole factory record; decides nothing |  |


## 4. Integrations and credentials

Source: contracts `*_APP_PERMISSIONS`, `CODEHOST_ROLE_PERMISSIONS`, `ADAPTER_KIND`; `platform/compose/docker-compose.yml` (secrets, `file:` references, environment); `platform/compose/init-secrets`.

| constant | value | defined | configurable? | portal surface today |
|---|---|---|---|---|
| ADAPTER_KIND | {"github_app": "code_host", "fake_github": "code_host", "anthropic": "model_provider", "openai_compat": "model_provider", "fake": "model_provider"} | contracts | no (constant) | **none** |
| ANTHROPIC_DEFAULT_MODELS | {"opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5", "haiku": "claude-haiku-5-5"} | contracts | no (constant) | **none** |
| CODEHOST_ROLE_PERMISSIONS | {"hub": {"contents": "read", "metadata": "read"}, "posture": {"metadata": "read"}, "docs": {"contents": "write", "pull_requests": "write", "metadata": "read"}, "tracker": {"issues": "write", "metadata": "read"}} | contracts | no (constant) | **none** |
| GATE_CHECK_APP_PERMISSIONS | {"checks": "write", "pull_requests": "read", "metadata": "read"} | contracts | no (constant) | **none** |
| GATE_RELAY_APP_PERMISSIONS | {"deployments": "write", "metadata": "read"} | contracts | no (constant) | **none** |
| GITHUB_FORBIDDEN_PERMS | ["administration", "workflows", "secrets", "dependabot_secrets", "environments", "security_events", "secret_scanning_alerts", "repository_advisories", "repository_hooks", "organization_hooks", "organization_administration", "organization_secrets", "statuses"] | contracts | no (constant) | **none** |
| GITHUB_FORBIDDEN_WRITE_PERMS | ["actions"] | contracts | no (constant) | **none** |
| TRACKER_APP_PERMISSIONS | {"issues": "write", "metadata": "read"} | contracts | no (constant) | **none** |

Code host roles: `['hub', 'posture', 'docs', 'tracker']`.

`IntegrationKind`: `['code_host', 'model_provider', 'notifier', 'tracker', 'identity']`.

`IntegrationAdapter`: `['github_app', 'fake_github', 'anthropic', 'openai_compat', 'fake']`.


### 4.1 Secrets mounted by compose

| secret | mounted in | configurable? | portal surface today |
|---|---|---|---|
| anthropic-api-key | gateway | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| bff-oidc-client-secret | bff, dev-oidc | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| db-url-aisdlc | migrate, identity, seed, core, core-worker, knowledge, bff | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| db-url-audit | audit | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| db-url-gate-check | gate-check | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| db-url-gate-relay | gate-relay | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| db-url-gateway | gateway | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| db-url-killswitch | migrate, killswitch | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| db-url-notary | migrate, notary | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| db-url-notifier | notifier | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| db-url-sandbox-controller | sandbox-controller | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| db-url-verify | verify | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| db-url-witness | migrate, witness | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| gate-check-app.pem | gate-check | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| gate-check-app.pub.pem | fake-github | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| gate-relay-app.pem | gate-relay | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| gate-relay-app.pub.pem | fake-github | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| github-app.pem | codehost | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| github-app.pub.pem | fake-github | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| object-store-access-key | core, core-worker, gate-check, gate-relay, audit, object-store | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| object-store-secret-key | core, core-worker, gate-check, gate-relay, audit, object-store | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| pg-pass-aisdlc | db-init | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| pg-pass-audit | db-init | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| pg-pass-gate-check | db-init | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| pg-pass-gate-relay | db-init | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| pg-pass-gateway | db-init | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| pg-pass-killswitch | db-init | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| pg-pass-notary | db-init | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| pg-pass-notifier | db-init | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| pg-pass-sandbox-controller | db-init | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| pg-pass-verify | db-init | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| pg-pass-witness | db-init | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| pg-superuser | postgres, db-init | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-audit-core | core, audit | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-audit-kms | kms-local, audit | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-audit-notary | notary, audit | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-bff-audit | bff, audit | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-bff-core | core, bff | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-bff-gate-check | bff, gate-check | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-bff-kms | kms-local, bff | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-bff-notifier | bff, notifier | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-bff-sandbox-controller | bff, sandbox-controller | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-codehost-core | core, codehost | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-codehost-identity | identity, codehost | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-codehost | core, codehost | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-gateway | gateway, core | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-kms | kms-local, seed, core | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-knowledge | core, knowledge | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-notary | notary, seed, core | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-worker-codehost | core-worker, codehost | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-worker-gateway | gateway, core-worker | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-worker-identity | identity, core-worker | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-worker-killswitch | killswitch, core-worker | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-worker-kms | kms-local, core-worker | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-worker-knowledge | core-worker, knowledge | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-worker-notary | notary, core-worker | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-worker-sandbox-controller | core-worker, sandbox-controller | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-worker-verify | core-worker, verify | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-core-worker-witness | witness, core-worker | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-cvw-docker-cvw | docker-proxy-cvw | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-gate-check-kms | kms-local, gate-check | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-gate-relay-kms | kms-local, gate-relay | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-gateway-killswitch | killswitch, gateway | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-identity-core | identity, core | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-identity-kms | kms-local, identity | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-identity-notary | notary, identity | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-killswitch-kms | kms-local, killswitch | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-knowledge-codehost | codehost, knowledge | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-knowledge-identity | identity, knowledge | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-knowledge-kms | kms-local, knowledge | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-notary-kms | kms-local, notary | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-operator-codehost | codehost | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-operator-core | core | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-operator-gate-check | gate-check | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-operator-gate-relay | gate-relay | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-operator-gateway | gateway | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-operator-killswitch | killswitch | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-operator-sandbox-controller | sandbox-controller | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-sandbox-controller-docker-coding | docker-proxy-coding, sandbox-controller | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-seed-identity | identity, seed | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-smoke-docker-coding | docker-proxy-coding, sandbox-smoke | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-verify-codehost | codehost, verify | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-verify-sandbox-controller | sandbox-controller, verify | deployment only (file under platform/compose/secrets, init-secrets) | **none** |
| tok-witness-kms | kms-local, witness | deployment only (file under platform/compose/secrets, init-secrets) | **none** |


### 4.2 `file:` references and environment per service

283 environment variables across 28 compose services; 99 carry a `file:` reference. All are deployment-only (none is read from config or set in the portal).

| service | variable | compose value |
|---|---|---|
| postgres | POSTGRES_PASSWORD_FILE | /run/secrets/pg-superuser |
| db-init | PGHOST | postgres |
| migrate | AISDLC_DATABASE_URL | file:/run/secrets/db-url-aisdlc |
| migrate | AISDLC_NOTARY_DATABASE_URL | file:/run/secrets/db-url-notary |
| migrate | AISDLC_WITNESS_DATABASE_URL | file:/run/secrets/db-url-witness |
| migrate | AISDLC_KILLSWITCH_DATABASE_URL | file:/run/secrets/db-url-killswitch |
| kms-local | FACTORY_ENV | local |
| kms-local | KMS_DIR | /kms |
| kms-local | KMS_HOST | 0.0.0.0 |
| kms-local | KMS_PORT | 8300 |
| kms-local | KMS_CALLERS | {"notary":{"token_ref":"file:/run/secrets/tok-notary-kms"}, "witness":{"token_ref":"file:/run/secrets/tok-witness-kms"}, |
| notary | NOTARY_DATABASE_URL | file:/run/secrets/db-url-notary |
| notary | NOTARY_CALLERS | {"core":{"token_ref":"file:/run/secrets/tok-core-notary","scopes":["ledger","read"]}, "core-worker":{"token_ref":"file:/ |
| notary | KMS_URL | http://kms-local:8300 |
| notary | KMS_TOKEN_REF | file:/run/secrets/tok-notary-kms |
| notary | NOTARY_HOST | 0.0.0.0 |
| notary | NOTARY_PORT | 8310 |
| witness | WITNESS_DATABASE_URL | file:/run/secrets/db-url-witness |
| witness | WITNESS_CALLERS | {"core-worker":{"token_ref":"file:/run/secrets/tok-core-worker-witness"}} |
| witness | KMS_URL | http://kms-local:8300 |
| witness | KMS_TOKEN_REF | file:/run/secrets/tok-witness-kms |
| witness | WITNESS_HOST | 0.0.0.0 |
| witness | WITNESS_PORT | 8320 |
| killswitch | KILLSWITCH_DATABASE_URL | file:/run/secrets/db-url-killswitch |
| killswitch | KILLSWITCH_CALLERS | {"core-worker":{"token_ref":"file:/run/secrets/tok-core-worker-killswitch","scopes":["read","sync"]}, "operator":{"token |
| killswitch | KILLSWITCH_FACTORY_ADMINS | ["alice","bob"] |
| killswitch | KMS_URL | http://kms-local:8300 |
| killswitch | KMS_TOKEN_REF | file:/run/secrets/tok-killswitch-kms |
| killswitch | KILLSWITCH_HOST | 0.0.0.0 |
| killswitch | KILLSWITCH_PORT | 8400 |
| gateway | GATEWAY_DATABASE_URL | file:/run/secrets/db-url-gateway |
| gateway | GATEWAY_ENVIRONMENT | local |
| gateway | GATEWAY_CALLERS | {"core":{"token_ref":"file:/run/secrets/tok-core-gateway","scopes":["admin","read"]}, "core-worker":{"token_ref":"file:/ |
| gateway | GATEWAY_SECRET_REFS | ["file:/run/secrets/anthropic-api-key"] |
| gateway | GATEWAY_EGRESS_HOSTS | ["api.anthropic.com"] |
| gateway | GATEWAY_KILLSWITCH_URL | http://killswitch:8400 |
| gateway | GATEWAY_KILLSWITCH_TOKEN_REF | file:/run/secrets/tok-gateway-killswitch |
| gateway | GATEWAY_MAX_PROVIDER_CALLS | ${GATEWAY_MAX_PROVIDER_CALLS:-1000} |
| gateway | GATEWAY_HOST | 0.0.0.0 |
| gateway | GATEWAY_PORT | 8410 |
| identity | IDENTITY_DATABASE_URL | file:/run/secrets/db-url-aisdlc |
| identity | IDENTITY_CALLERS | {"core-worker":{"token_ref":"file:/run/secrets/tok-core-worker-identity","scopes":["reconcile"]}, "codehost":{"token_ref |
| identity | NOTARY_URL | http://notary:8310 |
| identity | IDENTITY_NOTARY_TOKEN_REF | file:/run/secrets/tok-identity-notary |
| identity | KMS_URL | http://kms-local:8300 |
| identity | KMS_TOKEN_REF | file:/run/secrets/tok-identity-kms |
| identity | IDENTITY_IDP_SEED_FILE | /config/idp-seed.json |
| identity | IDENTITY_CORE_URL | http://core:8380 |
| identity | IDENTITY_CORE_TOKEN_REF | file:/run/secrets/tok-identity-core |
| identity | IDENTITY_HOST | 0.0.0.0 |
| identity | IDENTITY_PORT | 8330 |
| seed | FACTORY_ENV | local |
| seed | CORE_DATABASE_URL | file:/run/secrets/db-url-aisdlc |
| seed | CORE_NOTARY_URL | http://notary:8310 |
| seed | CORE_NOTARY_TOKEN_REF | file:/run/secrets/tok-core-notary |
| seed | KMS_URL | http://kms-local:8300 |
| seed | KMS_TOKEN_REF | file:/run/secrets/tok-core-kms |
| seed | SEED_IDENTITY_URL | http://identity:8330 |
| seed | SEED_IDENTITY_TOKEN_REF | file:/run/secrets/tok-seed-identity |
| seed | SEED_FACTORY_ADMIN | alice |
| seed | SEED_GITHUB_APP_ID | ${GITHUB_APP_ID:?run ./init-secrets first} |
| seed | SEED_GITHUB_INSTALLATION_ID | ${GITHUB_INSTALLATION_ID:?run ./init-secrets first} |
| seed | SEED_GITHUB_APP_KEY_REF | file:/run/secrets/github-app.pem |
| seed | SEED_GITHUB_API_URL | ${CODEHOST_GITHUB_API_URL:-} |
| seed | SEED_GITHUB_GIT_URL | ${CODEHOST_GIT_URL:-} |
| core | CORE_DATABASE_URL | file:/run/secrets/db-url-aisdlc |
| core | CORE_CALLERS | {"codehost":{"token_ref":"file:/run/secrets/tok-codehost-core","scopes":["registry","integrations"]}, "identity":{"token |
| core | CORE_NOTARY_URL | http://notary:8310 |
| core | CORE_NOTARY_TOKEN_REF | file:/run/secrets/tok-core-notary |
| core | KMS_URL | http://kms-local:8300 |
| core | KMS_TOKEN_REF | file:/run/secrets/tok-core-kms |
| core | CORE_KNOWLEDGE_URL | http://knowledge:8370 |
| core | CORE_KNOWLEDGE_TOKEN_REF | file:/run/secrets/tok-core-knowledge |
| core | CORE_CODEHOST_URL | http://codehost:8350 |
| core | CORE_CODEHOST_TOKEN_REF | file:/run/secrets/tok-core-codehost |
| core | CORE_OBJECT_STORE_URL | http://object-store:9000 |
| core | CORE_OBJECT_STORE_ACCESS_KEY_REF | file:/run/secrets/object-store-access-key |
| core | CORE_OBJECT_STORE_SECRET_KEY_REF | file:/run/secrets/object-store-secret-key |
| core | CORE_GATEWAY_URL | http://gateway:8410 |
| core | CORE_GATEWAY_TOKEN_REF | file:/run/secrets/tok-core-gateway |
| core | CORE_ASSISTANT_EXTRA_MODELS | fake-model |
| core | CORE_HOST | 0.0.0.0 |
| core | CORE_PORT | 8380 |
| core | CORE_ADMISSION_URL | http://core-worker:8360 |
| core-worker | CORE_WORKER_DATABASE_URL | file:/run/secrets/db-url-aisdlc |
| core-worker | CORE_WORKER_CODEHOST_URL | http://codehost:8350 |
| core-worker | CORE_WORKER_CODEHOST_TOKEN_REF | file:/run/secrets/tok-core-worker-codehost |
| core-worker | CORE_WORKER_KNOWLEDGE_URL | http://knowledge:8370 |
| core-worker | CORE_WORKER_KNOWLEDGE_TOKEN_REF | file:/run/secrets/tok-core-worker-knowledge |
| core-worker | CORE_WORKER_IDENTITY_URL | http://identity:8330 |
| core-worker | CORE_WORKER_IDENTITY_TOKEN_REF | file:/run/secrets/tok-core-worker-identity |
| core-worker | CORE_WORKER_NOTARY_URL | http://notary:8310 |
| core-worker | CORE_WORKER_NOTARY_TOKEN_REF | file:/run/secrets/tok-core-worker-notary |
| core-worker | CORE_WORKER_WITNESS_URL | http://witness:8320 |
| core-worker | CORE_WORKER_WITNESS_TOKEN_REF | file:/run/secrets/tok-core-worker-witness |
| core-worker | CORE_WORKER_CHECKPOINT_INTERVAL_MS | ${CHECKPOINT_INTERVAL_MS:-300000} |
| core-worker | CORE_WORKER_KILLSWITCH_URL | http://killswitch:8400 |
| core-worker | CORE_WORKER_KILLSWITCH_TOKEN_REF | file:/run/secrets/tok-core-worker-killswitch |
| core-worker | CORE_WORKER_KILL_OBSERVER_INTERVAL_MS | ${KILL_OBSERVER_INTERVAL_MS:-5000} |
| core-worker | CORE_WORKER_KILL_HOLDERS_INTERVAL_MS | ${KILL_HOLDERS_INTERVAL_MS:-10000} |
| core-worker | CORE_WORKER_STAGE_PORTS | ${CORE_WORKER_STAGE_PORTS:-none} |
| core-worker | CORE_WORKER_FAKE_VERIFY | ${CORE_WORKER_FAKE_VERIFY:-default} |
| core-worker | FACTORY_ENV | local |
| core-worker | CORE_WORKER_GATEWAY_URL | http://gateway:8410 |
| core-worker | CORE_WORKER_GATEWAY_TOKEN_REF | file:/run/secrets/tok-core-worker-gateway |
| core-worker | CORE_WORKER_AGENT_EXTRA_MODELS | fake-model |
| core-worker | CORE_WORKER_SANDBOX_CONTROLLER_URL | ${CORE_WORKER_SANDBOX_CONTROLLER_URL:-} |
| core-worker | CORE_WORKER_SANDBOX_CONTROLLER_TOKEN_REF | file:/run/secrets/tok-core-worker-sandbox-controller |
| core-worker | CORE_WORKER_VERIFY_URL | ${CORE_WORKER_VERIFY_URL:-} |
| core-worker | CORE_WORKER_VERIFY_TOKEN_REF | file:/run/secrets/tok-core-worker-verify |
| core-worker | CORE_WORKER_OBJECT_STORE_URL | http://object-store:9000 |
| core-worker | CORE_WORKER_OBJECT_STORE_ACCESS_KEY_REF | file:/run/secrets/object-store-access-key |
| core-worker | CORE_WORKER_OBJECT_STORE_SECRET_KEY_REF | file:/run/secrets/object-store-secret-key |
| core-worker | KMS_URL | http://kms-local:8300 |
| core-worker | KMS_TOKEN_REF | file:/run/secrets/tok-core-worker-kms |
| core-worker | CORE_WORKER_HOST | 0.0.0.0 |
| core-worker | CORE_WORKER_PORT | 8360 |
| codehost | CODEHOST_REGISTRY_INTEGRATION | github-app |
| codehost | CODEHOST_SECRET_REFS | ["file:/run/secrets/github-app.pem"] |
| codehost | CODEHOST_EGRESS_HOSTS | ["api.github.com","github.com","127.0.0.1"] |
| codehost | CODEHOST_REGISTRY_INTERVAL_MS | ${CODEHOST_REGISTRY_INTERVAL_MS:-5000} |
| codehost | CODEHOST_CALLERS | {"knowledge":{"token_ref":"file:/run/secrets/tok-knowledge-codehost","scopes":["census"]}, "operator":{"token_ref":"file |
| codehost | CODEHOST_IDENTITY_URL | http://identity:8330 |
| codehost | CODEHOST_IDENTITY_TOKEN_REF | file:/run/secrets/tok-codehost-identity |
| codehost | CODEHOST_CORE_URL | http://core:8380 |
| codehost | CODEHOST_CORE_TOKEN_REF | file:/run/secrets/tok-codehost-core |
| codehost | TMPDIR | /work |
| codehost | CODEHOST_HOST | 0.0.0.0 |
| codehost | CODEHOST_PORT | 8350 |
| knowledge | KNOWLEDGE_DATABASE_URL | file:/run/secrets/db-url-aisdlc |
| knowledge | KNOWLEDGE_CALLERS | {"core":{"token_ref":"file:/run/secrets/tok-core-knowledge","scopes":["census","security","search"]}, "core-worker":{"to |
| knowledge | KNOWLEDGE_CODEHOST_URL | http://codehost:8350 |
| knowledge | KNOWLEDGE_CODEHOST_TOKEN_REF | file:/run/secrets/tok-knowledge-codehost |
| knowledge | KNOWLEDGE_IDENTITY_URL | http://identity:8330 |
| knowledge | KNOWLEDGE_IDENTITY_TOKEN_REF | file:/run/secrets/tok-knowledge-identity |
| knowledge | KMS_URL | http://kms-local:8300 |
| knowledge | KMS_TOKEN_REF | file:/run/secrets/tok-knowledge-kms |
| knowledge | KNOWLEDGE_WORK_DIR | /work |
| knowledge | TMPDIR | /work |
| knowledge | KNOWLEDGE_HOST | 0.0.0.0 |
| knowledge | KNOWLEDGE_PORT | 8370 |
| bff | BFF_DATABASE_URL | file:/run/secrets/db-url-aisdlc |
| bff | BFF_PUBLIC_URL | http://localhost:8340 |
| bff | BFF_OIDC_ISSUER | http://dev-oidc.localhost:8390 |
| bff | BFF_OIDC_CLIENT_ID | aisdlc-bff |
| bff | BFF_OIDC_CLIENT_SECRET_REF | file:/run/secrets/bff-oidc-client-secret |
| bff | KMS_URL | http://kms-local:8300 |
| bff | KMS_TOKEN_REF | file:/run/secrets/tok-bff-kms |
| bff | BFF_CORE_URL | http://core:8380 |
| bff | BFF_CORE_TOKEN_REF | file:/run/secrets/tok-bff-core |
| bff | BFF_NOTIFIER_URL | http://notifier:8460 |
| bff | BFF_NOTIFIER_TOKEN_REF | file:/run/secrets/tok-bff-notifier |
| bff | BFF_WEB_DIR | /app/services/web/dist |
| bff | BFF_GATE_CHECK_URL | http://gate-check:8450 |
| bff | BFF_GATE_CHECK_TOKEN_REF | file:/run/secrets/tok-bff-gate-check |
| bff | BFF_SANDBOX_CONTROLLER_URL | http://sandbox-controller:8430 |
| bff | BFF_SANDBOX_CONTROLLER_TOKEN_REF | file:/run/secrets/tok-bff-sandbox-controller |
| bff | BFF_AUDIT_URL | http://audit:8480 |
| bff | BFF_AUDIT_TOKEN_REF | file:/run/secrets/tok-bff-audit |
| bff | BFF_COOKIE_SECURE | false |
| bff | BFF_HOST | 0.0.0.0 |
| bff | BFF_PORT | 8340 |
| dev-oidc | FACTORY_ENV | local |
| dev-oidc | DEV_OIDC_USERS_FILE | /config/dev-oidc-users.json |
| dev-oidc | DEV_OIDC_CLIENT_ID | aisdlc-bff |
| dev-oidc | DEV_OIDC_CLIENT_SECRET_REF | file:/run/secrets/bff-oidc-client-secret |
| dev-oidc | DEV_OIDC_REDIRECT_URIS | http://localhost:8340/auth/callback |
| dev-oidc | DEV_OIDC_ISSUER | http://dev-oidc.localhost:8390 |
| dev-oidc | DEV_OIDC_HOST | 0.0.0.0 |
| dev-oidc | DEV_OIDC_PORT | 8390 |
| docker-proxy-cvw | DOCKER_PROXY_MODE | cvw |
| docker-proxy-cvw | DOCKER_PROXY_CALLERS | cvw=file:/run/secrets/tok-cvw-docker-cvw |
| docker-proxy-cvw | DOCKER_PROXY_IMAGES | ${SANDBOX_IMAGE:-aisdlc/sandbox:local},${SANDBOX_AGENT_IMAGE:-aisdlc/sandbox-agent:local} |
| docker-proxy-cvw | DOCKER_PROXY_SCRATCH_ROOT | ${SANDBOX_SCRATCH:-/var/lib/aisdlc/sandbox-scratch} |
| docker-proxy-cvw | DOCKER_PROXY_HOST | 0.0.0.0 |
| docker-proxy-cvw | DOCKER_PROXY_PORT | 2375 |
| docker-proxy-coding | DOCKER_PROXY_MODE | coding |
| docker-proxy-coding | DOCKER_PROXY_CALLERS | sandbox-controller=file:/run/secrets/tok-sandbox-controller-docker-coding,smoke=file:/run/secrets/tok-smoke-docker-codin |
| docker-proxy-coding | DOCKER_PROXY_IMAGES | ${SANDBOX_IMAGE:-aisdlc/sandbox:local},${SANDBOX_AGENT_IMAGE:-aisdlc/sandbox-agent:local},${SANDBOX_ONBOARDING_IMAGE:-} |
| docker-proxy-coding | DOCKER_PROXY_SCRATCH_ROOT | ${SANDBOX_SCRATCH:-/var/lib/aisdlc/sandbox-scratch} |
| docker-proxy-coding | DOCKER_PROXY_MAX_SANDBOXES | 4 |
| docker-proxy-coding | DOCKER_PROXY_CODING_CAP | 1 |
| docker-proxy-coding | DOCKER_PROXY_HOST | 0.0.0.0 |
| docker-proxy-coding | DOCKER_PROXY_PORT | 2375 |
| sandbox-controller | SANDBOX_CONTROLLER_DATABASE_URL | file:/run/secrets/db-url-sandbox-controller |
| sandbox-controller | SANDBOX_CONTROLLER_CALLERS | {"core-worker":{"token_ref":"file:/run/secrets/tok-core-worker-sandbox-controller","scopes":["run","read"]}, "operator": |
| sandbox-controller | SANDBOX_CONTROLLER_HOST_ID | local |
| sandbox-controller | SANDBOX_CONTROLLER_PROXY_URL | http://docker-proxy-coding:2375 |
| sandbox-controller | SANDBOX_CONTROLLER_PROXY_TOKEN_REF | file:/run/secrets/tok-sandbox-controller-docker-coding |
| sandbox-controller | SANDBOX_CONTROLLER_IMAGE | ${SANDBOX_AGENT_IMAGE:-aisdlc/sandbox-agent:local} |
| sandbox-controller | SANDBOX_CONTROLLER_PROBE_IMAGES | ${SANDBOX_ONBOARDING_IMAGE:-} |
| sandbox-controller | SANDBOX_CONTROLLER_SCRATCH | ${SANDBOX_SCRATCH:-/var/lib/aisdlc/sandbox-scratch} |
| sandbox-controller | SANDBOX_CONTROLLER_MIRROR | ${COMPOSE_PROJECT_NAME:-aisdlc}-package-mirror |
| sandbox-controller | SANDBOX_CONTROLLER_GATEWAY | ${COMPOSE_PROJECT_NAME:-aisdlc}-gateway |
| sandbox-controller | SANDBOX_CONTROLLER_HOST | 0.0.0.0 |
| sandbox-controller | SANDBOX_CONTROLLER_PORT | 8430 |
| verify | VERIFY_DATABASE_URL | file:/run/secrets/db-url-verify |
| verify | VERIFY_CALLERS | {"core-worker":{"token_ref":"file:/run/secrets/tok-core-worker-verify","scopes":["run","read"]}} |
| verify | VERIFY_SANDBOX_CONTROLLER_URL | http://sandbox-controller:8430 |
| verify | VERIFY_SANDBOX_CONTROLLER_TOKEN_REF | file:/run/secrets/tok-verify-sandbox-controller |
| verify | VERIFY_CODEHOST_URL | http://codehost:8350 |
| verify | VERIFY_CODEHOST_TOKEN_REF | file:/run/secrets/tok-verify-codehost |
| verify | VERIFY_GATEWAY_URL | http://gateway:8410 |
| verify | TMPDIR | /tmp |
| verify | VERIFY_HOST | 0.0.0.0 |
| verify | VERIFY_PORT | 8440 |
| gate-check | GATE_CHECK_DATABASE_URL | file:/run/secrets/db-url-gate-check |
| gate-check | GATE_CHECK_CALLERS | {"operator":{"token_ref":"file:/run/secrets/tok-operator-gate-check","scopes":["read"]}, "bff":{"token_ref":"file:/run/s |
| gate-check | GATE_CHECK_APP_ID | ${GATE_CHECK_APP_ID:-654321} |
| gate-check | GATE_CHECK_INSTALLATION_ID | ${GATE_CHECK_INSTALLATION_ID:-2} |
| gate-check | GATE_CHECK_APP_KEY_REF | file:/run/secrets/gate-check-app.pem |
| gate-check | GATE_CHECK_GITHUB_API_URL | ${GATE_CHECK_GITHUB_API_URL:-https://api.github.com} |
| gate-check | GATE_CHECK_GITHUB_PLAIN_HTTP_HOSTS | ["codehost"] |
| gate-check | GATE_CHECK_PUSH_BROKER_LOGIN | ${GATE_CHECK_PUSH_BROKER_LOGIN:-aisdlc[bot]} |
| gate-check | GATE_CHECK_OBJECT_STORE_URL | http://object-store:9000 |
| gate-check | GATE_CHECK_OBJECT_STORE_ACCESS_KEY_REF | file:/run/secrets/object-store-access-key |
| gate-check | GATE_CHECK_OBJECT_STORE_SECRET_KEY_REF | file:/run/secrets/object-store-secret-key |
| gate-check | KMS_URL | http://kms-local:8300 |
| gate-check | KMS_TOKEN_REF | file:/run/secrets/tok-gate-check-kms |
| gate-check | GATE_CHECK_HOST | 0.0.0.0 |
| gate-check | GATE_CHECK_PORT | 8450 |
| gate-relay | GATE_RELAY_DATABASE_URL | file:/run/secrets/db-url-gate-relay |
| gate-relay | GATE_RELAY_CALLERS | {"operator":{"token_ref":"file:/run/secrets/tok-operator-gate-relay","scopes":["read"]}} |
| gate-relay | GATE_RELAY_APP_ID | ${GATE_RELAY_APP_ID:-765432} |
| gate-relay | GATE_RELAY_INSTALLATION_ID | ${GATE_RELAY_INSTALLATION_ID:-3} |
| gate-relay | GATE_RELAY_APP_KEY_REF | file:/run/secrets/gate-relay-app.pem |
| gate-relay | GATE_RELAY_GITHUB_API_URL | ${GATE_RELAY_GITHUB_API_URL:-https://api.github.com} |
| gate-relay | GATE_RELAY_GITHUB_PLAIN_HTTP_HOSTS | ["codehost"] |
| gate-relay | GATE_RELAY_OBJECT_STORE_URL | http://object-store:9000 |
| gate-relay | GATE_RELAY_OBJECT_STORE_ACCESS_KEY_REF | file:/run/secrets/object-store-access-key |
| gate-relay | GATE_RELAY_OBJECT_STORE_SECRET_KEY_REF | file:/run/secrets/object-store-secret-key |
| gate-relay | KMS_URL | http://kms-local:8300 |
| gate-relay | KMS_TOKEN_REF | file:/run/secrets/tok-gate-relay-kms |
| gate-relay | GATE_RELAY_HOST | 0.0.0.0 |
| gate-relay | GATE_RELAY_PORT | 8470 |
| notifier | NOTIFIER_DATABASE_URL | file:/run/secrets/db-url-notifier |
| notifier | NOTIFIER_CALLERS | {"bff":{"token_ref":"file:/run/secrets/tok-bff-notifier","scopes":["people"]}} |
| notifier | NOTIFIER_PORTAL_URL | ${NOTIFIER_PORTAL_URL:-http://localhost:8340} |
| notifier | NOTIFIER_SECRET_REFS | ${NOTIFIER_SECRET_REFS:-[]} |
| notifier | NOTIFIER_EGRESS_HOSTS | ${NOTIFIER_EGRESS_HOSTS:-["hooks.slack.com"]} |
| notifier | NOTIFIER_HOST | 0.0.0.0 |
| notifier | NOTIFIER_PORT | 8460 |
| audit | AUDIT_DATABASE_URL | file:/run/secrets/db-url-audit |
| audit | AUDIT_CALLERS | {"bff":{"token_ref":"file:/run/secrets/tok-bff-audit","scopes":["read","export","govern"]}} |
| audit | AUDIT_NOTARY_URL | http://notary:8310 |
| audit | AUDIT_NOTARY_TOKEN_REF | file:/run/secrets/tok-audit-notary |
| audit | KMS_URL | http://kms-local:8300 |
| audit | KMS_TOKEN_REF | file:/run/secrets/tok-audit-kms |
| audit | AUDIT_CORE_URL | http://core:8380 |
| audit | AUDIT_CORE_TOKEN_REF | file:/run/secrets/tok-audit-core |
| audit | AUDIT_OBJECT_STORE_URL | http://object-store:9000 |
| audit | AUDIT_OBJECT_STORE_ACCESS_KEY_REF | file:/run/secrets/object-store-access-key |
| audit | AUDIT_OBJECT_STORE_SECRET_KEY_REF | file:/run/secrets/object-store-secret-key |
| audit | AUDIT_HOST | 0.0.0.0 |
| audit | AUDIT_PORT | 8480 |
| package-mirror | PACKAGE_MIRROR_ROOT | /fixtures |
| package-mirror | PACKAGE_MIRROR_HOST | 0.0.0.0 |
| package-mirror | PACKAGE_MIRROR_PORT | 8420 |
| sandbox-smoke | SANDBOX_PROXY | http://docker-proxy-coding:2375 |
| sandbox-smoke | SANDBOX_PROXY_TOKEN_REF | file:/run/secrets/tok-smoke-docker-coding |
| sandbox-smoke | SANDBOX_IMAGE | ${SANDBOX_IMAGE:-aisdlc/sandbox:local} |
| sandbox-smoke | SANDBOX_AGENT_IMAGE | ${SANDBOX_AGENT_IMAGE:-aisdlc/sandbox-agent:local} |
| sandbox-smoke | SANDBOX_SCRATCH | ${SANDBOX_SCRATCH:-/var/lib/aisdlc/sandbox-scratch} |
| sandbox-smoke | SANDBOX_MIRROR | ${COMPOSE_PROJECT_NAME:-aisdlc}-package-mirror |
| sandbox-smoke | SANDBOX_GATEWAY | ${COMPOSE_PROJECT_NAME:-aisdlc}-gateway |
| object-store | MINIO_ROOT_USER_FILE | /run/secrets/object-store-access-key |
| object-store | MINIO_ROOT_PASSWORD_FILE | /run/secrets/object-store-secret-key |
| object-store | MINIO_BROWSER | off |
| object-store | HOME | /tmp |
| fake-github | FAKE_GITHUB_APP_ID | ${GITHUB_APP_ID:?run ./init-secrets first} |
| fake-github | FAKE_GITHUB_INSTALLATION_ID | ${GITHUB_INSTALLATION_ID:?run ./init-secrets first} |
| fake-github | FAKE_GITHUB_APP_PUBLIC_KEY_FILE | /run/secrets/github-app.pub.pem |
| fake-github | FAKE_GITHUB_API_PORT | 8353 |
| fake-github | FAKE_GITHUB_GIT_PORT | 8354 |
| fake-github | FAKE_GITHUB_DIR | /tmp/fake-github |
| fake-github | FAKE_GITHUB_CHECKS_APP_ID | ${GATE_CHECK_APP_ID:-654321} |
| fake-github | FAKE_GITHUB_CHECKS_INSTALLATION_ID | ${GATE_CHECK_INSTALLATION_ID:-2} |
| fake-github | FAKE_GITHUB_CHECKS_APP_PUBLIC_KEY_FILE | /run/secrets/gate-check-app.pub.pem |
| fake-github | FAKE_GITHUB_GATE_CHECK_PORT | 8355 |
| fake-github | FAKE_GITHUB_DEPLOY_APP_ID | ${GATE_RELAY_APP_ID:-765432} |
| fake-github | FAKE_GITHUB_DEPLOY_INSTALLATION_ID | ${GATE_RELAY_INSTALLATION_ID:-3} |
| fake-github | FAKE_GITHUB_DEPLOY_APP_PUBLIC_KEY_FILE | /run/secrets/gate-relay-app.pub.pem |
| fake-github | FAKE_GITHUB_GATE_RELAY_PORT | 8356 |


## 5. Agents

Source: `packages/agents/src/spec-data.ts` → `AGENT_DEFINITIONS` (registry.ts), prompts pinned by `packages/agents/src/prompts.lock.json`.

| agent | name | role | steps | specialist | tools | data class | budget | prompt sha | contract | portal surface today |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | triage | triage | 1.2,1.3,1.4 |  |  | D1 | {"max_tokens": 20000, "max_cost_micro_usd": 100000, "ttl_seconds": 1800} |  | 1.1.0 | `/agents` list (registry rows) |
| A2 | intent | intent | 1.5,3.1,3.2 |  | Read,Grep,Glob,KnowledgeSearch | D2 | {"max_tokens": 60000, "max_cost_micro_usd": 500000, "ttl_seconds": 3600} |  | 1.1.0 | `/agents` list (registry rows) |
| A3 | planner | plan | 2.1,2.2,2.3,2.4,4.1,4.2,4.3,4.4,4.5,5.1,5.2,5.3,5.4,5.6,9.4 |  | Read,Grep,Glob,KnowledgeSearch | D2 | {"max_tokens": 150000, "max_cost_micro_usd": 1500000, "ttl_seconds": 7200} |  | 1.2.0 | `/agents` list (registry rows) |
| A4 | coding | code | 6.4,6.6 |  | Read,Grep,Glob,Edit,Write,Bash | D2 | {"max_tokens": 2000000, "max_cost_micro_usd": 25000000, "ttl_seconds": 21600} |  | 1.0.0 | `/agents` list (registry rows) |
| A5 | review | review | 3.5,4.5,7.3,7.5 |  | Read,Grep,Glob | D2 | {"max_tokens": 80000, "max_cost_micro_usd": 500000, "ttl_seconds": 3600} |  | 1.1.0 | `/agents` list (registry rows) |
| A6 | test | test | 3.4 | 6.3 | Read,Grep,Glob,Edit,Write | D2 | {"max_tokens": 400000, "max_cost_micro_usd": 3000000, "ttl_seconds": 3600} |  | 1.1.0 | `/agents` list (registry rows) |
| A7 | None | None |  |  |  | D0 | {"max_tokens": 1000, "max_cost_micro_usd": 1000, "ttl_seconds": 60} |  | 1.0.0 | `/agents` list (registry rows) |
| A8 | None | None |  |  |  | D0 | {"max_tokens": 1000, "max_cost_micro_usd": 1000, "ttl_seconds": 60} |  | 1.0.0 | `/agents` list (registry rows) |
| A9 | reverse engineering | re | 0.1,0.2,0.3,2.1b |  | Read,Grep,Glob,KnowledgeSearch | D2 | {"max_tokens": 200000, "max_cost_micro_usd": 2000000, "ttl_seconds": 7200} |  | 1.0.0 | `/agents` list (registry rows) |
| A10 | None | None |  |  |  | D0 | {"max_tokens": 1000, "max_cost_micro_usd": 1000, "ttl_seconds": 60} |  | 1.0.0 | `/agents` list (registry rows) |
| A11 | handoff pack | handoff | 6.4,7.3,7.5 |  | Read | D2 | {"max_tokens": 40000, "max_cost_micro_usd": 300000, "ttl_seconds": 1800} |  | 1.0.0 | `/agents` list (registry rows) |
| A12 | extraction | extraction | 0.3 |  | Read,Grep,Glob | D2 | {"max_tokens": 150000, "max_cost_micro_usd": 1500000, "ttl_seconds": 7200} |  | 1.0.0 | `/agents` list (registry rows) |
| coder | coder | code | 6.4,6.6 |  | Read,Grep,Glob,Edit,Write,Bash | D2 | {"max_tokens": 2000000, "max_cost_micro_usd": 25000000, "ttl_seconds": 21600} |  | 1.0.0 | `/agents` list (registry rows) |
| assistant | assistant | assistant |  |  | KnowledgeSearch | D1 | {"max_tokens": 200000, "max_cost_micro_usd": 2000000, "ttl_seconds": 600} |  | 1.0.0 | named in web: assistant/AskPage.tsx, assistant/OnboardingAssistant.tsx |

`EvalCaseKind`: `regression` (none), `holdout` (none), `pooled` (none), `canary` (none), `seeded_defect` (none)

`AgentRunResult`: `completed` (none), `classified` (none), `questions` (named in web: items/waiting.ts), `gate_needed` (none), `held` (named in web: floor/FleetPage.tsx, pages/HomePage.tsx, vocab.ts), `rework` (named in web: pages/PackPage.tsx), `relane` (none), `trigger` (named in web: items/VerifyTab.tsx, pages/QualityPages.tsx), `failed` (named in web: items/VerifyTab.tsx)

`AgentRunVerdict`: `pending` (named in web: access/AccessProvider.tsx, api.ts, assistant/OnboardingAssistant.tsx, cards/DecideShell.tsx (+9)), `accepted` (none), `rejected` (named in web: cards/DecideShell.tsx, pages/S0Page.tsx), `sent_back` (none), `reworked` (none), `handed_off` (none)

`AgentRunState`: `dispatched` (none), `finished` (none), `failed` (named in web: items/VerifyTab.tsx)

`EVAL_SUMMARY_FIELDS`: `['task_id', 'profile', 'suite', 'provider', 'trials', 'passes', 'pass_rate', 'pass_k', 'k', 'status']`; scores: `foldAgentScores`/`passPowK` (packages/agents/src/scores.ts).


## 6. HTTP routes, events, ledger entries, read models


### 6.1 `audit` (14 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/audit/src/app.ts:82 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /metrics |  |  | services/audit/src/app.ts:87 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/exports |  |  | services/audit/src/app.ts:152 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/exports/:id |  |  | services/audit/src/app.ts:185 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/exports/:id/signed |  |  | services/audit/src/app.ts:191 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/exports |  |  | services/audit/src/app.ts:203 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/holds |  |  | services/audit/src/app.ts:222 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/holds |  |  | services/audit/src/app.ts:231 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/holds/:id/release |  |  | services/audit/src/app.ts:246 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/erasures |  |  | services/audit/src/app.ts:265 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/erasures/:id |  |  | services/audit/src/app.ts:274 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/erasures |  |  | services/audit/src/app.ts:285 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/erasures/:id/${verb} |  |  | services/audit/src/app.ts:301 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/retention |  |  | services/audit/src/app.ts:326 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.2 `bff` (109 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /api/me/access |  |  | services/bff/src/access.ts:99 | web calls it |
| POST | /api/me/decisions |  | project.view | services/bff/src/access.ts:178 | web calls it |
| GET | /healthz |  |  | services/bff/src/app.ts:174 | n/a (auth/static) |
| GET | /auth/login |  |  | services/bff/src/app.ts:219 | n/a (auth/static) |
| GET | /auth/callback |  |  | services/bff/src/app.ts:247 | n/a (auth/static) |
| GET | /api/me |  |  | services/bff/src/app.ts:394 | web calls it |
| POST | /api/logout |  |  | services/bff/src/app.ts:437 | web calls it |
| POST | /api/step-up |  |  | services/bff/src/app.ts:446 | web calls it |
| GET | /api/step-up/:id |  |  | services/bff/src/app.ts:509 | web calls it |
| POST | /api/assistant/ask |  | project.view | services/bff/src/assistant.ts:134 | web calls it |
| GET | /api/assistant/threads |  |  | services/bff/src/assistant.ts:157 | web calls it |
| GET | /api/assistant/threads/:id |  | project.view | services/bff/src/assistant.ts:171 | web calls it |
| GET | /api/assistant/budget |  |  | services/bff/src/assistant.ts:192 | web calls it |
| GET | /api/audit/exports |  |  | services/bff/src/audit.ts:135 | web calls it |
| POST | /api/audit/exports |  |  | services/bff/src/audit.ts:151 | web calls it |
| GET | /api/audit/exports/:id |  |  | services/bff/src/audit.ts:166 | **none** (no web call found) |
| GET | /api/audit/exports/:id/signed |  |  | services/bff/src/audit.ts:176 | web calls it |
| GET | /api/audit/holds |  |  | services/bff/src/audit.ts:201 | web calls it |
| POST | /api/audit/holds |  |  | services/bff/src/audit.ts:208 | web calls it |
| POST | /api/audit/holds/:id/release |  |  | services/bff/src/audit.ts:221 | web calls it |
| GET | /api/audit/erasures |  |  | services/bff/src/audit.ts:236 | web calls it |
| POST | /api/audit/erasures |  |  | services/bff/src/audit.ts:243 | web calls it |
| POST | /api/audit/erasures/:id/${verb} |  |  | services/bff/src/audit.ts:257 | **none** (no web call found) |
| GET | /api/audit/retention |  |  | services/bff/src/audit.ts:275 | web calls it |
| GET | /.well-known/openid-configuration |  |  | services/bff/src/dev-oidc/provider.ts:123 | n/a (auth/static) |
| GET | /jwks |  |  | services/bff/src/dev-oidc/provider.ts:134 | n/a (auth/static) |
| GET | /authorize |  |  | services/bff/src/dev-oidc/provider.ts:193 | n/a (auth/static) |
| POST | /authorize |  |  | services/bff/src/dev-oidc/provider.ts:238 | n/a (auth/static) |
| POST | /token |  |  | services/bff/src/dev-oidc/provider.ts:263 | n/a (auth/static) |
| GET | /api/fleet |  | floor.read,project.view | services/bff/src/floor.ts:84 | web calls it |
| GET | /api/floor/:project |  | floor.read | services/bff/src/floor.ts:126 | web calls it |
| POST | /api/items/:id/release/re-request |  | item.release | services/bff/src/governance.ts:98 | web calls it |
| POST | /api/items/:id/review/unsure |  | item.unsure | services/bff/src/governance.ts:103 | web calls it |
| POST | /api/items/:id/escape |  | item.escape | services/bff/src/governance.ts:108 | web calls it |
| POST | /api/items/:id/audit |  | audit.record | services/bff/src/governance.ts:113 | web calls it |
| GET | /api/items/:id/closeout |  | closeout.read | services/bff/src/governance.ts:119 | web calls it |
| GET | /api/projects/:id/learn |  | audit.read,learn.propose | services/bff/src/governance.ts:144 | web calls it |
| POST | /api/projects/:id/learn/run |  |  | services/bff/src/governance.ts:180 | web calls it |
| POST | /api/projects/:id/learn/mode-e-lift |  |  | services/bff/src/governance.ts:181 | web calls it |
| GET | /api/config/revisions/:gate |  | audit.read,config.decide | services/bff/src/governance.ts:194 | web calls it |
| POST | /api/config/revisions/:gate/${verb} |  | config.decide | services/bff/src/governance.ts:220 | **none** (no web call found) |
| GET | /api/projects/:id/issue-twin |  | config.propose,project.view,work.request | services/bff/src/issue-twin.ts:102 | web calls it |
| POST | /api/projects/:id/issue-twin/batches |  | config.propose | services/bff/src/issue-twin.ts:141 | web calls it |
| POST | /api/projects/:id/issue-twin/links |  | config.propose | services/bff/src/issue-twin.ts:149 | **none** (no web call found) |
| POST | /api/projects/:id/issue-twin/requests |  | work.request | services/bff/src/issue-twin.ts:157 | web calls it |
| GET | /api/me/notifications |  | project.view | services/bff/src/notifications.ts:86 | web calls it |
| GET | /api/me/notifications/preferences |  |  | services/bff/src/notifications.ts:113 | web calls it |
| PUT | /api/me/notifications/preferences |  |  | services/bff/src/notifications.ts:121 | web calls it |
| GET | /api/items |  | project.view | services/bff/src/portal-lists.ts:153 | web calls it |
| GET | /api/agents |  |  | services/bff/src/portal-lists.ts:184 | web calls it |
| GET | /api/catalogue |  |  | services/bff/src/portal-lists.ts:192 | web calls it |
| GET | /api/audit/decisions |  |  | services/bff/src/portal-lists.ts:198 | web calls it |
| GET | /api/integrations |  |  | services/bff/src/portal-lists.ts:219 | web calls it |
| GET | /api/admission |  |  | services/bff/src/portal-lists.ts:235 | web calls it |
| GET | /api/slots |  | audit.read | services/bff/src/portal-lists.ts:243 | web calls it |
| GET | /api/controls |  | control.apply | services/bff/src/portal-lists.ts:271 | web calls it |
| POST | /api/controls/preview |  |  | services/bff/src/portal-lists.ts:308 | web calls it |
| POST | /api/controls |  |  | services/bff/src/portal-lists.ts:311 | web calls it |
| POST | /api/controls/:id/lift |  | audit.read,control.lift | services/bff/src/portal-lists.ts:313 | web calls it |
| GET | /api/kills |  |  | services/bff/src/portal-lists.ts:338 | web calls it |
| GET | /api/directory |  | audit.read | services/bff/src/portal-lists.ts:348 | web calls it |
| GET | /api/projects/:id/explain |  | access.explain | services/bff/src/portal-lists.ts:362 | web calls it |
| GET | /api/projects |  | project.view | services/bff/src/portal.ts:241 | web calls it |
| GET | /api/projects/:id |  | project.view | services/bff/src/portal.ts:258 | web calls it |
| POST | /api/onboard |  | project.onboard | services/bff/src/portal.ts:272 | web calls it |
| POST | /api/requests |  | item.view_floor,work.request | services/bff/src/portal.ts:290 | **none** (no web call found) |
| GET | /api/items/:id |  | item.observe,item.plan,item.ready | services/bff/src/portal.ts:326 | web calls it |
| POST | /api/items/:id/ready |  | item.ready | services/bff/src/portal.ts:371 | web calls it |
| POST | /api/items/:id/answers |  | item.ready | services/bff/src/portal.ts:374 | web calls it |
| POST | /api/items/:id/observe |  | item.observe | services/bff/src/portal.ts:377 | web calls it |
| POST | /api/items/:id/plan |  | item.plan | services/bff/src/portal.ts:380 | web calls it |
| POST | /api/items/:id/human-done |  | audit.read,config.propose,item.human_done | services/bff/src/portal.ts:384 | **none** (no web call found) |
| GET | /api/config/keys |  |  | services/bff/src/portal.ts:409 | web calls it |
| GET | /api/config/keys/:key |  |  | services/bff/src/portal.ts:418 | web calls it |
| POST | /api/config/keys/:key/proposals |  | config.propose | services/bff/src/portal.ts:432 | web calls it |
| GET | /api/items/:id/verify |  |  | services/bff/src/portal.ts:489 | web calls it |
| GET | /api/items/:id/evidence |  |  | services/bff/src/portal.ts:516 | web calls it |
| GET | /api/items/:id/evidence/:pack/signed |  |  | services/bff/src/portal.ts:546 | web calls it |
| GET | /api/items/:id/gate-check |  |  | services/bff/src/portal.ts:581 | web calls it |
| GET | /api/cards/:id/gate/context |  |  | services/bff/src/portal.ts:633 | web calls it |
| GET | /api/agent-runs |  | project.view | services/bff/src/portal.ts:652 | **none** (no web call found) |
| GET | /api/agents/:id/stats |  | audit.read | services/bff/src/portal.ts:679 | **none** (no web call found) |
| GET | /api/evals/summary |  |  | services/bff/src/portal.ts:727 | web calls it |
| GET | /api/evals/runs |  |  | services/bff/src/portal.ts:735 | web calls it |
| GET | /api/agents/:id/scores |  | project.view | services/bff/src/portal.ts:743 | **none** (no web call found) |
| GET | /api/s0/:id |  |  | services/bff/src/portal.ts:772 | web calls it |
| GET | /api/s0/:id/cards |  | card.decide | services/bff/src/portal.ts:779 | web calls it |
| GET | /api/cards/:id/artefacts |  | project.view | services/bff/src/portal.ts:815 | web calls it |
| GET | /api/cards/:id |  | card.decide,project.view | services/bff/src/portal.ts:830 | web calls it |
| GET | /api/cards/:id/gate |  | card.decide,project.view | services/bff/src/portal.ts:868 | web calls it |
| POST | /api/cards/:id/gate/prepare |  |  | services/bff/src/portal.ts:928 | web calls it |
| POST | /api/cards/:id/gate/evidence |  |  | services/bff/src/portal.ts:931 | web calls it |
| POST | /api/cards/:id/gate/decide |  | card.decide | services/bff/src/portal.ts:934 | web calls it |
| POST | /api/cards/:id/prepare |  |  | services/bff/src/portal.ts:965 | web calls it |
| POST | /api/cards/:id/evidence |  |  | services/bff/src/portal.ts:966 | web calls it |
| POST | /api/cards/:id/decide |  |  | services/bff/src/portal.ts:969 | web calls it |
| POST | /api/cards/:id/recheck |  |  | services/bff/src/portal.ts:972 | web calls it |
| POST | /api/cards/:id/instructions |  |  | services/bff/src/portal.ts:973 | web calls it |
| POST | /api/cards/:id/probe/retry |  |  | services/bff/src/portal.ts:977 | web calls it |
| GET | /api/inbox |  | card.decide,gate.decide,project.view | services/bff/src/portal.ts:984 | web calls it |
| GET | /api/s0/:id/revision |  |  | services/bff/src/portal.ts:1027 | web calls it |
| GET | /api/revisions/:gate |  | project.view | services/bff/src/portal.ts:1048 | web calls it |
| POST | /api/revisions/:gate/prepare |  |  | services/bff/src/portal.ts:1102 | web calls it |
| POST | /api/revisions/:gate/evidence |  |  | services/bff/src/portal.ts:1105 | web calls it |
| POST | /api/revisions/:gate/decide |  |  | services/bff/src/portal.ts:1108 | web calls it |
| POST | /api/revisions/:gate/publish |  |  | services/bff/src/portal.ts:1111 | web calls it |
| GET | /api/projects/:id/prr |  | project.view | services/bff/src/portal.ts:1117 | web calls it |
| GET | /api/projects/:id/knowledge |  | project.view | services/bff/src/portal.ts:1133 | web calls it |
| GET | /api/projects/:id/ledger |  | audit.read | services/bff/src/portal.ts:1162 | web calls it |


### 6.3 `codehost` (15 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/codehost/src/app.ts:68 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos | census |  | services/codehost/src/app.ts:109 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos/:owner/:name/file | census |  | services/codehost/src/app.ts:114 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos/:owner/:name/head | census |  | services/codehost/src/app.ts:123 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos/:owner/:name/codeowners | census |  | services/codehost/src/app.ts:131 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos/:owner/:name/bundle | census |  | services/codehost/src/app.ts:144 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/repos/:owner/:name/push | push |  | services/codehost/src/app.ts:176 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos/:owner/:name/pulls/:number | push |  | services/codehost/src/app.ts:188 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/installation | posture |  | services/codehost/src/app.ts:199 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos/:owner/:name/rules | posture |  | services/codehost/src/app.ts:204 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos/:owner/:name/collaborators | posture |  | services/codehost/src/app.ts:212 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos/:owner/:name/codeowners/errors | posture |  | services/codehost/src/app.ts:219 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos/:owner/:name/b4 | posture |  | services/codehost/src/app.ts:231 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/admin/reload | reload |  | services/codehost/src/app.ts:257 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/projects/:project/codeowners/sync | codeowners_sync |  | services/codehost/src/app.ts:267 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.4 `core` (108 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/core/src/app.ts:221 | **none** (bff does not call it) |
| GET | /v1/projects | portal |  | services/core/src/app.ts:274 | via bff |
| GET | /v1/projects/:id/overview | portal |  | services/core/src/app.ts:284 | via bff |
| GET | /v1/projects/:id | read |  | services/core/src/app.ts:299 | **none** (bff does not call it) |
| GET | /v1/projects/:id/settings | read |  | services/core/src/app.ts:307 | **none** (bff does not call it) |
| GET | /v1/integrations | registry |  | services/core/src/app.ts:322 | **none** (bff does not call it) |
| POST | /v1/integrations/health | integrations |  | services/core/src/app.ts:339 | via bff |
| GET | /v1/integrations/health | portal |  | services/core/src/app.ts:355 | via bff |
| GET | /v1/integrations/events | portal |  | services/core/src/app.ts:366 | via bff |
| GET | /v1/push-guards/:item/units/:unit/lease | push_guard |  | services/core/src/app.ts:416 | **none** (bff does not call it) |
| GET | /v1/push-guards/:item/x2 | push_guard |  | services/core/src/app.ts:430 | **none** (bff does not call it) |
| GET | /v1/registered-repos | registry |  | services/core/src/app.ts:444 | **none** (bff does not call it) |
| GET | /v1/repos/:owner/:name/eligibility | read |  | services/core/src/app.ts:460 | **none** (bff does not call it) |
| GET | /v1/s0/:id | read |  | services/core/src/app.ts:484 | via bff |
| GET | /v1/repos/:owner/:name/s0 | read |  | services/core/src/app.ts:493 | **none** (bff does not call it) |
| POST | /v1/onboard | onboard | project.onboard | services/core/src/app.ts:502 | via bff |
| POST | /v1/requests | work | work.request | services/core/src/app.ts:517 | via bff |
| GET | /v1/projects/:id/breakers | work | project.view | services/core/src/app.ts:547 | **none** (bff does not call it) |
| POST | /v1/projects/:id/breakers/:lane/reset | work | config.propose | services/core/src/app.ts:558 | **none** (bff does not call it) |
| POST | /v1/controls/preview | ops | control.apply | services/core/src/app.ts:591 | via bff |
| POST | /v1/controls | ops | control.apply | services/core/src/app.ts:610 | via bff |
| POST | /v1/controls/:id/lift | ops | control.lift | services/core/src/app.ts:641 | via bff |
| GET | /v1/projects/:id/controls | ops | project.view | services/core/src/app.ts:662 | **none** (bff does not call it) |
| POST | /v1/banners | ops | banner.publish | services/core/src/app.ts:680 | **none** (bff does not call it) |
| GET | /v1/items/:id | work | item.view_floor | services/core/src/app.ts:710 | via bff |
| POST | /v1/items/:id/ready | work | item.ready | services/core/src/app.ts:784 | via bff |
| POST | /v1/items/:id/answers | work | item.ready | services/core/src/app.ts:802 | via bff |
| POST | /v1/items/:id/observe | work | item.observe | services/core/src/app.ts:819 | via bff |
| POST | /v1/items/:id/release/re-request | work | item.release | services/core/src/app.ts:855 | via bff |
| POST | /v1/items/:id/plan | work | item.plan | services/core/src/app.ts:877 | via bff |
| POST | /v1/items/:id/human-done | work | item.human_done | services/core/src/app.ts:905 | via bff |
| GET | /v1/agent-runs | work | project.view | services/core/src/app.ts:931 | via bff |
| GET | /v1/items/:id/verify |  |  | services/core/src/app.ts:1002 | via bff |
| GET | /v1/items/:id/evidence |  |  | services/core/src/app.ts:1015 | via bff |
| GET | /v1/items/:id/evidence/:pack/signed |  |  | services/core/src/app.ts:1029 | via bff |
| GET | /v1/agents/:id/stats | work | audit.read | services/core/src/app.ts:1050 | via bff |
| POST | /v1/evals/runs | evals,work | audit.read | services/core/src/app.ts:1083 | via bff |
| GET | /v1/evals/summary |  |  | services/core/src/app.ts:1127 | via bff |
| GET | /v1/evals/runs |  |  | services/core/src/app.ts:1138 | via bff |
| GET | /v1/agents/:id/scores | onboard | project.onboard | services/core/src/app.ts:1163 | via bff |
| POST | /v1/s0/:id/withdraw |  |  | services/core/src/app.ts:1210 | **none** (bff does not call it) |
| POST | /v1/s0/:id/resume |  |  | services/core/src/app.ts:1215 | **none** (bff does not call it) |
| POST | /v1/s0/:id/signable-level | onboard | project.onboard | services/core/src/app.ts:1221 | **none** (bff does not call it) |
| PUT | /v1/projects/:id/settings | settings | project.settings.edit | services/core/src/app.ts:1240 | **none** (bff does not call it) |
| GET | /v1/s0/:id/cards | read |  | services/core/src/app.ts:1291 | via bff |
| POST | /v1/s0/:id/cards/sync | onboard |  | services/core/src/app.ts:1301 | **none** (bff does not call it) |
| GET | /v1/cards/:cardId/summary | read |  | services/core/src/app.ts:1312 | via bff |
| GET | /v1/cards/:cardId | read |  | services/core/src/app.ts:1321 | via bff |
| GET | /v1/cards/:cardId/artefacts | read |  | services/core/src/app.ts:1335 | via bff |
| GET | /v1/cards/:cardId/gate | read |  | services/core/src/app.ts:1357 | via bff |
| GET | /v1/cards/:cardId/gate/context | onboard,read | card.decide | services/core/src/app.ts:1374 | via bff |
| POST | /v1/cards/:cardId/gate/prepare |  |  | services/core/src/app.ts:1432 | via bff |
| POST | /v1/cards/:cardId/gate/evidence |  |  | services/core/src/app.ts:1437 | via bff |
| POST | /v1/cards/:cardId/gate/decide | onboard | card.decide | services/core/src/app.ts:1442 | via bff |
| POST | /v1/cards/:cardId/prepare |  |  | services/core/src/app.ts:1484 | via bff |
| POST | /v1/cards/:cardId/evidence |  |  | services/core/src/app.ts:1489 | via bff |
| POST | /v1/cards/:cardId/decide |  |  | services/core/src/app.ts:1498 | via bff |
| POST | /v1/cards/:cardId/instructions |  |  | services/core/src/app.ts:1512 | via bff |
| POST | /v1/cards/:cardId/recheck |  |  | services/core/src/app.ts:1524 | via bff |
| POST | /v1/cards/:cardId/probe/retry |  |  | services/core/src/app.ts:1534 | via bff |
| GET | /v1/s0/:id/light-floors | read |  | services/core/src/app.ts:1541 | **none** (bff does not call it) |
| POST | /v1/onboarding/spikes | ops |  | services/core/src/app.ts:1553 | **none** (bff does not call it) |
| GET | /v1/onboarding/spikes/:kind | read |  | services/core/src/app.ts:1568 | **none** (bff does not call it) |
| GET | /v1/inbox | portal |  | services/core/src/app.ts:1588 | via bff |
| GET | /v1/s0/:id/revision | read |  | services/core/src/app.ts:1601 | via bff |
| GET | /v1/revisions/:gate | onboard,read | gate.decide | services/core/src/app.ts:1610 | via bff |
| POST | /v1/revisions/:gate/prepare |  |  | services/core/src/app.ts:1654 | via bff |
| POST | /v1/revisions/:gate/evidence |  |  | services/core/src/app.ts:1659 | via bff |
| POST | /v1/revisions/:gate/decide |  |  | services/core/src/app.ts:1664 | via bff |
| POST | /v1/revisions/:gate/publish |  |  | services/core/src/app.ts:1670 | via bff |
| GET | /v1/config/keys | read |  | services/core/src/app.ts:1684 | via bff |
| GET | /v1/config/keys/:key | read |  | services/core/src/app.ts:1691 | via bff |
| POST | /v1/config/keys/:key/proposals | portal | config.propose | services/core/src/app.ts:1705 | via bff |
| GET | /v1/projects/:id/prr | read |  | services/core/src/app.ts:1726 | via bff |
| GET | /v1/projects/:id/knowledge | read |  | services/core/src/app.ts:1742 | via bff |
| GET | /v1/repos/:owner/:name/reonboarding | read |  | services/core/src/app.ts:1757 | **none** (bff does not call it) |
| GET | /v1/projects/:id/ledger | erasure,read,work |  | services/core/src/app.ts:1768 | via bff |
| GET | /v1/erasable-payloads |  |  | services/core/src/conversation/erasable.ts:90 | **none** (bff does not call it) |
| POST | /v1/erasable-payloads/:id/erase |  |  | services/core/src/conversation/erasable.ts:108 | **none** (bff does not call it) |
| POST | /v1/assistant/ask |  |  | services/core/src/conversation/routes.ts:77 | via bff |
| GET | /v1/assistant/threads |  |  | services/core/src/conversation/routes.ts:133 | via bff |
| GET | /v1/assistant/threads/:id |  |  | services/core/src/conversation/routes.ts:165 | via bff |
| GET | /v1/assistant/budget |  |  | services/core/src/conversation/routes.ts:185 | via bff |
| GET | /v1/fleet | work |  | services/core/src/fleet.ts:179 | via bff |
| POST | /v1/sessions/heartbeat | activity |  | services/core/src/fleet.ts:189 | **none** (bff does not call it) |
| GET | /v1/floor/:project | work | floor.read,item.view_floor | services/core/src/floor.ts:575 | via bff |
| POST | /v1/items/:id/review/unsure | work | item.unsure | services/core/src/governance-routes.ts:121 | via bff |
| POST | /v1/items/:id/escape | work | item.escape | services/core/src/governance-routes.ts:134 | via bff |
| GET | /v1/items/:id/closeout | work | closeout.read | services/core/src/governance-routes.ts:152 | via bff |
| POST | /v1/items/:id/audit | work | audit.record | services/core/src/governance-routes.ts:171 | via bff |
| GET | /v1/projects/:id/learn | work | audit.read | services/core/src/governance-routes.ts:189 | via bff |
| POST | /v1/projects/:id/learn/run | work | learn.propose | services/core/src/governance-routes.ts:198 | via bff |
| POST | /v1/projects/:id/learn/mode-e-lift | work | learn.propose | services/core/src/governance-routes.ts:209 | via bff |
| GET | /v1/config/revisions/:gate | portal,read | config.decide | services/core/src/governance-routes.ts:230 | via bff |
| POST | /v1/config/revisions/:gate/prepare |  |  | services/core/src/governance-routes.ts:269 | via bff |
| POST | /v1/config/revisions/:gate/evidence |  |  | services/core/src/governance-routes.ts:274 | via bff |
| POST | /v1/config/revisions/:gate/decide |  |  | services/core/src/governance-routes.ts:279 | via bff |
| GET | /v1/projects/:id/issue-twin |  | project.view | services/core/src/issue-twin/routes.ts:84 | via bff |
| POST | /v1/projects/:id/issue-twin/batches |  | config.propose | services/core/src/issue-twin/routes.ts:99 | via bff |
| POST | /v1/projects/:id/issue-twin/links |  | config.propose | services/core/src/issue-twin/routes.ts:110 | via bff |
| POST | /v1/projects/:id/issue-twin/requests |  | work.request | services/core/src/issue-twin/routes.ts:120 | via bff |
| GET | /v1/items | work |  | services/core/src/portal-lists.ts:108 | via bff |
| GET | /v1/agents |  |  | services/core/src/portal-lists.ts:180 | via bff |
| GET | /v1/catalogue | work |  | services/core/src/portal-lists.ts:204 | via bff |
| GET | /v1/admission |  |  | services/core/src/portal-lists.ts:241 | via bff |
| GET | /v1/controls |  |  | services/core/src/portal-lists.ts:284 | via bff |
| GET | /v1/kills |  |  | services/core/src/portal-lists.ts:297 | via bff |
| GET | /v1/audit/decisions |  |  | services/core/src/portal-lists.ts:329 | via bff |


### 6.5 `core-worker` (3 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/core-worker/src/app.ts:22 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /metrics |  |  | services/core-worker/src/app.ts:26 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /admission |  |  | services/core-worker/src/app.ts:29 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.6 `gate-check` (4 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/gate-check/src/app.ts:32 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /metrics |  |  | services/gate-check/src/app.ts:36 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/verdicts |  |  | services/gate-check/src/app.ts:47 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/merges |  |  | services/gate-check/src/app.ts:62 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.7 `gate-relay` (3 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/gate-relay/src/app.ts:27 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /metrics |  |  | services/gate-relay/src/app.ts:31 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/releases |  |  | services/gate-relay/src/app.ts:42 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.8 `gateway` (12 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/gateway/src/app.ts:56 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/messages |  |  | services/gateway/src/app.ts:76 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/admin/budget-groups |  |  | services/gateway/src/app.ts:138 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/admin/budget-groups/:id |  |  | services/gateway/src/app.ts:145 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/admin/vkeys |  |  | services/gateway/src/app.ts:151 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/admin/vkeys/:id |  |  | services/gateway/src/app.ts:159 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/admin/vkeys/:id/revoke |  |  | services/gateway/src/app.ts:165 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/admin/reload |  |  | services/gateway/src/app.ts:171 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/admin/integrations |  |  | services/gateway/src/app.ts:178 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/messages |  |  | services/gateway/src/fake-messages-server.ts:70 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/chat/completions |  |  | services/gateway/src/fake-openai-server.ts:209 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /chat/completions |  |  | services/gateway/src/fake-openai-server.ts:210 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.9 `identity` (23 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/identity/src/app.ts:78 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /metrics |  |  | services/identity/src/app.ts:79 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/principals/:id | read |  | services/identity/src/app.ts:140 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/principals/:id/groups | read |  | services/identity/src/app.ts:147 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/principals/:id/bindings | read |  | services/identity/src/app.ts:164 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/resolve | read |  | services/identity/src/app.ts:186 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/projects/:project/explain | read |  | services/identity/src/app.ts:206 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/access-sync | read |  | services/identity/src/app.ts:216 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/principals | write |  | services/identity/src/app.ts:227 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/principals/:id/update | write |  | services/identity/src/app.ts:241 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/principals/:id/status | write |  | services/identity/src/app.ts:259 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/principals/:id/qualifications | write |  | services/identity/src/app.ts:281 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/identity-links | write |  | services/identity/src/app.ts:295 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/groups | write |  | services/identity/src/app.ts:306 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/groups/:id/members | write |  | services/identity/src/app.ts:317 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/groups/:id/members/remove | write |  | services/identity/src/app.ts:344 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/bindings | write |  | services/identity/src/app.ts:366 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/bindings/:id/revoke | write |  | services/identity/src/app.ts:397 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/teams | write |  | services/identity/src/app.ts:410 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/projects/:project/reconcile | reconcile |  | services/identity/src/app.ts:423 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/projects/:project/codeowners/members | codeowners |  | services/identity/src/app.ts:452 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/idp/sync | sync |  | services/identity/src/app.ts:473 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/access-sync/run | sync |  | services/identity/src/app.ts:488 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.10 `killswitch` (11 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/killswitch/src/app.ts:38 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/status |  |  | services/killswitch/src/app.ts:83 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/kills |  |  | services/killswitch/src/app.ts:94 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/events |  |  | services/killswitch/src/app.ts:106 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/delegations |  |  | services/killswitch/src/app.ts:119 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/capabilities |  |  | services/killswitch/src/app.ts:127 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/kills |  |  | services/killswitch/src/app.ts:140 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/kills/:id/release |  |  | services/killswitch/src/app.ts:151 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/delegations |  |  | services/killswitch/src/app.ts:158 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/delegations/:id/revoke |  |  | services/killswitch/src/app.ts:169 | none (service API; the portal reaches it only through core/bff where noted) |
| PUT | /v1/holders/:project |  |  | services/killswitch/src/app.ts:178 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.11 `kms-local` (1 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/kms-local/src/app.ts:41 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.12 `knowledge` (10 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/knowledge/src/app.ts:57 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/jobs/census-intake | census |  | services/knowledge/src/app.ts:84 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/jobs/:id | census |  | services/knowledge/src/app.ts:93 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos/:owner/:name/security-summary | census |  | services/knowledge/src/app.ts:106 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos/:owner/:name/census/latest | census |  | services/knowledge/src/app.ts:135 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos/:owner/:name/search | search |  | services/knowledge/src/app.ts:147 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/repos/:owner/:name/codegraph | census |  | services/knowledge/src/app.ts:168 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/security/findings | security |  | services/knowledge/src/app.ts:186 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/security/findings/:id | security |  | services/knowledge/src/app.ts:201 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/security/findings/:id/state | security |  | services/knowledge/src/app.ts:216 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.13 `notary` (9 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/notary/src/app.ts:39 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/reserve | ledger |  | services/notary/src/app.ts:77 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/sign | ledger |  | services/notary/src/app.ts:85 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/confirm | ledger |  | services/notary/src/app.ts:94 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/unconfirmed | ledger |  | services/notary/src/app.ts:102 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/checkpoint | checkpoint |  | services/notary/src/app.ts:112 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/verify | read |  | services/notary/src/app.ts:120 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/evidence/sign | evidence |  | services/notary/src/app.ts:129 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/audit-export/sign | audit_export |  | services/notary/src/app.ts:137 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.14 `notifier` (5 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/notifier/src/app.ts:56 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /metrics |  |  | services/notifier/src/app.ts:60 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/people/:principal/notifications |  |  | services/notifier/src/app.ts:79 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/people/:principal/preferences |  |  | services/notifier/src/app.ts:100 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/people/:principal/preferences |  |  | services/notifier/src/app.ts:106 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.15 `sandbox-controller` (4 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/sandbox-controller/src/app.ts:37 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/sessions |  |  | services/sandbox-controller/src/app.ts:53 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/slots |  |  | services/sandbox-controller/src/app.ts:74 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/admin/reload |  |  | services/sandbox-controller/src/app.ts:79 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.16 `verify` (4 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/verify/src/app.ts:29 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/checks |  |  | services/verify/src/app.ts:45 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/results |  |  | services/verify/src/app.ts:70 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/results/:sha |  |  | services/verify/src/app.ts:78 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.17 `witness` (3 routes)

| method | path | scope | PDP action | defined | portal surface today |
|---|---|---|---|---|---|
| GET | /healthz |  |  | services/witness/src/app.ts:21 | none (service API; the portal reaches it only through core/bff where noted) |
| POST | /v1/cosign |  |  | services/witness/src/app.ts:34 | none (service API; the portal reaches it only through core/bff where noted) |
| GET | /v1/last |  |  | services/witness/src/app.ts:42 | none (service API; the portal reaches it only through core/bff where noted) |


### 6.x Record event types

278 event types (from contracts `*_EVENT` constants, `*EventType` enums). Portal: events are never shown raw; the ledger page and item timelines show folded state.

| event type | constant |
|---|---|
| agent.run_dispatched | AGENT_EVENT |
| agent.run_failed | AGENT_EVENT |
| artefact.stored | PLANNING_EVENT |
| audit.considered | AUDIT_EVENT |
| audit.erasure_approved | AUDIT_SERVICE_EVENT |
| audit.erasure_blocked | AUDIT_SERVICE_EVENT |
| audit.erasure_executed | AUDIT_SERVICE_EVENT |
| audit.erasure_rejected | AUDIT_SERVICE_EVENT |
| audit.erasure_requested | AUDIT_SERVICE_EVENT |
| audit.export_written | AUDIT_SERVICE_EVENT |
| audit.legal_hold_placed | AUDIT_SERVICE_EVENT |
| audit.legal_hold_released | AUDIT_SERVICE_EVENT |
| audit.mode_e_lifted | MODE_E_LIFTED_EVENT |
| audit.mode_e_suspended | AUDIT_EVENT |
| audit.payload_erased | AUDIT_SERVICE_EVENT |
| audit.result_recorded | AUDIT_EVENT |
| audit.retention_swept | AUDIT_SERVICE_EVENT |
| banner.published | CONTROL_EVENT |
| banner.withdrawn | CONTROL_EVENT |
| binding.created | ACCESS_EVENT_TYPES |
| binding.created | IDENTITY_EVENT |
| binding.created | IdentityEventType |
| binding.revoked | ACCESS_EVENT_TYPES |
| binding.revoked | IDENTITY_EVENT |
| binding.revoked | IdentityEventType |
| binding.updated | ACCESS_EVENT_TYPES |
| binding.updated | IDENTITY_EVENT |
| binding.updated | IdentityEventType |
| breaker.counted | BREAKER_EVENT |
| breaker.reset | BREAKER_EVENT |
| breaker.reset_requested | BREAKER_EVENT |
| breaker.tripped | BREAKER_EVENT |
| card.decided | CARD_EVENT |
| card.decided | CardEventType |
| card.escalated | CARD_EVENT |
| card.escalated | CardEventType |
| card.opened | CARD_EVENT |
| card.opened | CardEventType |
| card.payload_recorded | CARD_EVENT |
| card.payload_recorded | CardEventType |
| card.withdrawn | CARD_EVENT |
| card.withdrawn | CardEventType |
| census.assembled | KNOWLEDGE_EVENT |
| closeout.escape_reported | CLOSEOUT_EVENT |
| closeout.recorded | CLOSEOUT_EVENT |
| config.proposed | CONFIG_EVENT |
| config.proposed | ConfigEventType |
| config.published | CONFIG_EVENT |
| config.published | ConfigEventType |
| control.applied | CONTROL_EVENT |
| control.expired | CONTROL_EVENT |
| control.lifted | CONTROL_EVENT |
| conversation.ask_recorded | CONVERSATION_EVENT |
| conversation.payload_erased | CONVERSATION_EVENT |
| conversation.thread_opened | CONVERSATION_EVENT |
| conversation.turn_recorded | CONVERSATION_EVENT |
| eval.run_recorded | EVAL_EVENT |
| evidence.pack_signed | EVIDENCE_EVENT |
| finding.detected | KNOWLEDGE_EVENT |
| finding.state_changed | KNOWLEDGE_EVENT |
| gate.closed | GATE_EVENT |
| gate.closed | GateEventType |
| gate.evidence_viewed | GATE_EVENT |
| gate.evidence_viewed | GateEventType |
| gate.expired | GATE_EVENT |
| gate.expired | GateEventType |
| gate.opened | GATE_EVENT |
| gate.opened | GateEventType |
| gate.superseded | GATE_EVENT |
| gate.superseded | GateEventType |
| gate.vote | GATE_EVENT |
| gate.vote | GateEventType |
| gatecheck.bypass_merge | GATECHECK_EVENT |
| gatecheck.merge_gated | GATECHECK_EVENT |
| gatecheck.pre_watch_merge | GATECHECK_EVENT |
| gatecheck.repo_watched | GATECHECK_EVENT |
| gatecheck.unauthorised_merge | GATECHECK_EVENT |
| gatecheck.verdict_recorded | GATECHECK_EVENT |
| gaterelay.deploy_healthy | GATERELAY_EVENT |
| gaterelay.deploy_unhealthy | GATERELAY_EVENT |
| gaterelay.deployment_created | GATERELAY_EVENT |
| gaterelay.release_intended | GATERELAY_EVENT |
| gaterelay.release_refused | GATERELAY_EVENT |
| gateway.budget_exhausted | GATEWAY_EVENT |
| gateway.model_call | GATEWAY_EVENT |
| gateway.reservation_abandoned | GATEWAY_EVENT |
| gateway.vkey_minted | GATEWAY_EVENT |
| gateway.vkey_revoked | GATEWAY_EVENT |
| group.created | IDENTITY_EVENT |
| group.created | IdentityEventType |
| group.member_added | ACCESS_EVENT_TYPES |
| group.member_added | IDENTITY_EVENT |
| group.member_added | IdentityEventType |
| group.member_removed | ACCESS_EVENT_TYPES |
| group.member_removed | IDENTITY_EVENT |
| group.member_removed | IdentityEventType |
| group.updated | IDENTITY_EVENT |
| group.updated | IdentityEventType |
| identity_link.linked | IDENTITY_EVENT |
| identity_link.linked | IdentityEventType |
| identity_link.unlinked | IDENTITY_EVENT |
| identity_link.unlinked | IdentityEventType |
| inbound.fact_observed | INBOUND_FACT_EVENT |
| issue_twin.batch_approved | ISSUE_TWIN_EVENT |
| issue_twin.file_intended | ISSUE_TWIN_EVENT |
| issue_twin.linked | ISSUE_TWIN_EVENT |
| issue_twin.rechecked | ISSUE_TWIN_EVENT |
| issue_twin.request_made | ISSUE_TWIN_EVENT |
| issue_twin.signal_observed | ISSUE_TWIN_EVENT |
| issue_twin.state_changed | ISSUE_TWIN_EVENT |
| issue_twin.write_done | ISSUE_TWIN_EVENT |
| issue_twin.write_intended | ISSUE_TWIN_EVENT |
| item.abandoned | ITEM_EVENT |
| item.abandoned | ItemEventType |
| item.assumption_decided | ITEM_EVENT |
| item.assumption_decided | ItemEventType |
| item.assumption_raised | ITEM_EVENT |
| item.assumption_raised | ItemEventType |
| item.command_done | ITEM_EVENT |
| item.command_done | ItemEventType |
| item.created | ITEM_EVENT |
| item.created | ItemEventType |
| item.eligibility_checked | ITEM_EVENT |
| item.eligibility_checked | ItemEventType |
| item.env_fixed | ITEM_EVENT |
| item.env_fixed | ItemEventType |
| item.gate_decided | ITEM_EVENT |
| item.gate_decided | ItemEventType |
| item.gates_opened | ITEM_EVENT |
| item.gates_opened | ItemEventType |
| item.hand_back | ITEM_EVENT |
| item.hand_back | ItemEventType |
| item.handoff_chosen | ITEM_EVENT |
| item.handoff_chosen | ItemEventType |
| item.hold_placed | ITEM_EVENT |
| item.hold_placed | ItemEventType |
| item.hold_released | ITEM_EVENT |
| item.hold_released | ItemEventType |
| item.human_work_done | ITEM_EVENT |
| item.human_work_done | ItemEventType |
| item.merge_observed | ITEM_EVENT |
| item.merge_observed | ItemEventType |
| item.question_answered | ITEM_EVENT |
| item.question_answered | ItemEventType |
| item.questions_raised | ITEM_EVENT |
| item.questions_raised | ItemEventType |
| item.ready_decided | ITEM_EVENT |
| item.ready_decided | ItemEventType |
| item.relane_requested | ITEM_EVENT |
| item.relane_requested | ItemEventType |
| item.release_re_requested | ITEM_EVENT |
| item.release_re_requested | ItemEventType |
| item.rework_requested | ITEM_EVENT |
| item.rework_requested | ItemEventType |
| item.scheduled | ITEM_EVENT |
| item.scheduled | ItemEventType |
| item.spawn_requested | ITEM_EVENT |
| item.spawn_requested | ItemEventType |
| item.spawned | ITEM_EVENT |
| item.spawned | ItemEventType |
| item.stage_completed | ITEM_EVENT |
| item.stage_completed | ItemEventType |
| item.stage_failed | ITEM_EVENT |
| item.stage_failed | ItemEventType |
| item.stage_gate_needed | ITEM_EVENT |
| item.stage_gate_needed | ItemEventType |
| item.stage_held | ITEM_EVENT |
| item.stage_held | ItemEventType |
| item.submitted | ITEM_EVENT |
| item.submitted | ItemEventType |
| item.timer_fired | ITEM_EVENT |
| item.timer_fired | ItemEventType |
| item.trigger_fired | ITEM_EVENT |
| item.trigger_fired | ItemEventType |
| item.withdrawn | ITEM_EVENT |
| item.withdrawn | ItemEventType |
| kill.delegation_granted | KILL_EVENT |
| kill.delegation_revoked | KILL_EVENT |
| kill.holders_synced | KILL_EVENT |
| kill.observed | KILL_OBSERVED_EVENT |
| kill.release_approved | KILL_EVENT |
| kill.released | KILL_EVENT |
| kill.requested | KILL_EVENT |
| kill.signature_attested | KILL_EVENT |
| kjob.done | KNOWLEDGE_EVENT |
| kjob.error | KNOWLEDGE_EVENT |
| kjob.queued | KNOWLEDGE_EVENT |
| kjob.started | KNOWLEDGE_EVENT |
| knowledge.defect_recorded | KDEFECT_EVENT |
| learn.proposed | LEARN_EVENT |
| learn.settled | LEARN_EVENT |
| merge.reconciled | MERGE_EVENT |
| notifier.delivery_failed | NOTIFIER_EVENT |
| notifier.delivery_failed | NotifierEventType |
| notifier.delivery_succeeded | NOTIFIER_EVENT |
| notifier.delivery_succeeded | NotifierEventType |
| notifier.notification_raised | NOTIFIER_EVENT |
| notifier.notification_raised | NotifierEventType |
| notifier.preferences_set | NOTIFIER_EVENT |
| notifier.preferences_set | NotifierEventType |
| ops.action | CONTROL_EVENT |
| ops.ledgered | CONTROL_EVENT |
| ops.preview_consumed | CONTROL_EVENT |
| ops.previewed | CONTROL_EVENT |
| pack.rendered | PACK_EVENT |
| pack.x2_opened | PACK_EVENT |
| pdp.decision | PDP_EVENT |
| principal.created | IDENTITY_EVENT |
| principal.created | IdentityEventType |
| principal.qualification_granted | ACCESS_EVENT_TYPES |
| principal.qualification_granted | IDENTITY_EVENT |
| principal.qualification_granted | IdentityEventType |
| principal.qualification_revoked | ACCESS_EVENT_TYPES |
| principal.qualification_revoked | IDENTITY_EVENT |
| principal.qualification_revoked | IdentityEventType |
| principal.status_changed | ACCESS_EVENT_TYPES |
| principal.status_changed | IDENTITY_EVENT |
| principal.status_changed | IdentityEventType |
| principal.updated | IDENTITY_EVENT |
| principal.updated | IdentityEventType |
| probe.granted | PROBE_EVENT |
| probe.recorded | PROBE_EVENT |
| probe.retry_requested | PROBE_EVENT |
| project.attested | PROJECT_EVENT |
| project.ready | PROJECT_EVENT |
| project.registered | PROJECT_EVENT |
| project.signed | PROJECT_EVENT |
| proposal.recorded | PLANNING_EVENT |
| prr.activated | PRR_EVENT |
| prr.proposed | PRR_EVENT |
| prr.status_changed | PRR_EVENT |
| push.intended | PUSH_EVENT |
| push.receipt_recorded | PUSH_EVENT |
| reonboard.proposed | REONBOARD_EVENT |
| repo.level_set | REPO_EVENT |
| repo.observed | REPO_EVENT |
| repo.registered | REPO_EVENT |
| s0.bootstrap_granted | S0_EVENT |
| s0.card_applied | S0_EVENT |
| s0.card_required | S0_EVENT |
| s0.census_ready | S0_EVENT |
| s0.controls_checked | S0_EVENT |
| s0.controls_recorded | S0_EVENT |
| s0.full_proposed | S0_EVENT |
| s0.instruction_edited | S0_EVENT |
| s0.job_started | S0_EVENT |
| s0.light_proposed | S0_EVENT |
| s0.machine_failed | S0_EVENT |
| s0.prr_proposed | S0_EVENT |
| s0.reminder | S0_EVENT |
| s0.requested | S0_EVENT |
| s0.send_back | S0_EVENT |
| s0.signable_level_set | S0_EVENT |
| s0.signoff_ready | S0_EVENT |
| s0.status_changed | S0_EVENT |
| s0.step_changed | S0_EVENT |
| s0.timebox_exceeded | S0_EVENT |
| s0.waiting | S0_EVENT |
| session.heartbeat | SESSION_EVENT |
| spike.recorded | SPIKE_EVENT |
| team.created | IDENTITY_EVENT |
| team.created | IdentityEventType |
| team.updated | IDENTITY_EVENT |
| team.updated | IdentityEventType |
| unit.admitted | UNIT_EVENT |
| unit.grant_released | UNIT_EVENT |
| unit.lease_changed | UNIT_EVENT |
| unit.state_changed | UNIT_EVENT |
| unit.wait_entered | UNIT_EVENT |
| units.planned | PLANNING_EVENT |
| verify.check_recorded | VERIFY_EVENT |
| work.admitted | WORK_EVENT |
| work.held | WORK_EVENT |
| work.item_created | WORK_EVENT |
| work.l8_offered | WORK_EVENT |
| work.released | WORK_EVENT |
| work.requested | WORK_EVENT |
| work.routed_l8 | WORK_EVENT |


### 6.y Ledger entry types

| entry type | constant | portal surface today |
|---|---|---|
| access.binding_created | ACCESS_ENTRY_TYPES | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| access.binding_revoked | ACCESS_ENTRY_TYPES | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| access.binding_updated | ACCESS_ENTRY_TYPES | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| access.membership_added | ACCESS_ENTRY_TYPES | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| access.membership_removed | ACCESS_ENTRY_TYPES | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| access.principal_status | ACCESS_ENTRY_TYPES | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| access.qualification_granted | ACCESS_ENTRY_TYPES | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| access.qualification_revoked | ACCESS_ENTRY_TYPES | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| audit.export | AUDIT_LEDGER_ENTRY_TYPE | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| audit.export | AUDIT_LEDGER_ENTRY_TYPES | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| audit.mode_e_suspended | MODE_E_SUSPENDED_LEDGER_ENTRY_TYPE | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| card.step_decision | CARD_STEP_ENTRY_TYPE | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| closeout.recorded | CLOSEOUT_LEDGER_ENTRY_TYPE | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| erasure.execute | AUDIT_LEDGER_ENTRY_TYPE | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| erasure.execute | AUDIT_LEDGER_ENTRY_TYPES | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| evidence.pack_signed | EVIDENCE_LEDGER_ENTRY_TYPE | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| issue_twin.batch | ISSUE_TWIN_LEDGER_ENTRY_TYPE | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| kill.event | KILL_LEDGER_ENTRY_TYPE | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| legal_hold.place | AUDIT_LEDGER_ENTRY_TYPE | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| legal_hold.place | AUDIT_LEDGER_ENTRY_TYPES | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| legal_hold.release | AUDIT_LEDGER_ENTRY_TYPE | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| legal_hold.release | AUDIT_LEDGER_ENTRY_TYPES | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| push.receipt | PUSH_LEDGER_ENTRY_TYPE | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |
| s0.bootstrap_grant | BOOTSTRAP_ENTRY_TYPE | project/fleet ledger list (`pages/LedgerPage.tsx`, `/ledger`) shows every entry generically |


### 6.z Read models (tables created by migrations)

108 tables.

| table | migration |
|---|---|
| config.config_revision | packages/config/migrations/0001_config.sql |
| config.config_published | packages/config/migrations/0001_config.sql |
| decisions.gate_instance | packages/decisions/migrations/0001_gate_instance.sql |
| decisions.gate_vote | packages/decisions/migrations/0001_gate_instance.sql |
| decisions.gate_event | packages/decisions/migrations/0001_gate_instance.sql |
| decisions.gate_nonce | packages/decisions/migrations/0001_gate_instance.sql |
| decisions.inbox_card | packages/decisions/migrations/0002_inbox_cards.sql |
| decisions.inbox_card_gate | packages/decisions/migrations/0002_inbox_cards.sql |
| decisions.inbox_card_step | packages/decisions/migrations/0002_inbox_cards.sql |
| decisions.inbox_entry | packages/decisions/migrations/0002_inbox_cards.sql |
| decisions.card_nonce | packages/decisions/migrations/0003_card_nonce.sql |
| directory.principal | packages/directory/migrations/0001_directory.sql |
| directory.team | packages/directory/migrations/0001_directory.sql |
| integrations.integration_health | packages/integrations/migrations/0001_integrations.sql |
| ledger.ledger_entry | packages/ledger/migrations/0001_ledger.sql |
| ledger.checkpoint | packages/ledger/migrations/0001_ledger.sql |
| record.record_event | packages/record/migrations/0001_record_event.sql |
| record.global_counter | packages/record/migrations/0001_record_event.sql |
| record.outbox | packages/record/migrations/0002_outbox.sql |
| record.projection_checkpoint | packages/record/migrations/0003_projections.sql |
| record.stream_type_counts | packages/record/migrations/0003_projections.sql |
| audit.export | services/audit/migrations/0001_audit.sql |
| audit.legal_hold | services/audit/migrations/0001_audit.sql |
| audit.erasure | services/audit/migrations/0001_audit.sql |
| audit.erasure_target | services/audit/migrations/0001_audit.sql |
| audit.retention_sweep | services/audit/migrations/0001_audit.sql |
| bff.oidc_attempt | services/bff/migrations/0001_bff.sql |
| bff.session | services/bff/migrations/0001_bff.sql |
| bff.step_up_proof | services/bff/migrations/0001_bff.sql |
| core.project | services/core/migrations/0001_core.sql |
| core.repo | services/core/migrations/0001_core.sql |
| core.s0_record | services/core/migrations/0001_core.sql |
| core.s0_step | services/core/migrations/0001_core.sql |
| core.role_map_sync | services/core/migrations/0001_core.sql |
| core.work_item | services/core/migrations/0003_work.sql |
| core.observer_cursor | services/core/migrations/0004_gateway_observer.sql |
| core.agent_run | services/core/migrations/0005_agent_runs.sql |
| core.agent_call | services/core/migrations/0005_agent_runs.sql |
| core.eval_run | services/core/migrations/0006_evals.sql |
| core.artefact | services/core/migrations/0007_planning.sql |
| core.unit | services/core/migrations/0008_units.sql |
| core.lease | services/core/migrations/0009_admission.sql |
| core.lease_history | services/core/migrations/0009_admission.sql |
| core.admission_grant | services/core/migrations/0009_admission.sql |
| core.push_receipt | services/core/migrations/0010_push.sql |
| core.pull_request | services/core/migrations/0010_push.sql |
| core.evidence_pack | services/core/migrations/0012_evidence.sql |
| core.conversation_payload | services/core/migrations/0013_conversation.sql |
| core.conversation_thread | services/core/migrations/0013_conversation.sql |
| core.conversation_turn | services/core/migrations/0013_conversation.sql |
| core.ask_session | services/core/migrations/0013_conversation.sql |
| core.closeout | services/core/migrations/0014_closeout.sql |
| core.audit_sample | services/core/migrations/0014_closeout.sql |
| core.mode_e_suspension | services/core/migrations/0014_closeout.sql |
| core.learn_proposal | services/core/migrations/0015_learn.sql |
| core.autonomy_earned | services/core/migrations/0015_learn.sql |
| core.mode_e_window | services/core/migrations/0015_learn.sql |
| core.onboarding_probe | services/core/migrations/0016_onboarding_probe.sql |
| core.light_spike | services/core/migrations/0017_light_spikes_and_pack.sql |
| core.onboarding_pack | services/core/migrations/0017_light_spikes_and_pack.sql |
| core.floor_position | services/core/migrations/0018_floor.sql |
| core.floor_move | services/core/migrations/0018_floor.sql |
| core.session_activity | services/core/migrations/0019_floor_activity.sql |
| core.knowledge_defect | services/core/migrations/0021_knowledge_defects.sql |
| core.reonboard_proposal | services/core/migrations/0021_knowledge_defects.sql |
| gatecheck.verdict | services/gate-check/migrations/0001_gatecheck.sql |
| gatecheck.merge | services/gate-check/migrations/0001_gatecheck.sql |
| gatecheck.repo_watch | services/gate-check/migrations/0001_gatecheck.sql |
| gaterelay.intent | services/gate-relay/migrations/0001_gaterelay.sql |
| gaterelay.refusal | services/gate-relay/migrations/0001_gaterelay.sql |
| gaterelay.deploy_marker | services/gate-relay/migrations/0001_gaterelay.sql |
| gaterelay.deploy_health | services/gate-relay/migrations/0001_gaterelay.sql |
| gateway.budget_group | services/gateway/migrations/0001_gateway.sql |
| gateway.vkey | services/gateway/migrations/0001_gateway.sql |
| gateway.reservation | services/gateway/migrations/0002_reservations.sql |
| identity.principal | services/identity/migrations/0001_identity.sql |
| identity.grp | services/identity/migrations/0001_identity.sql |
| identity.membership | services/identity/migrations/0001_identity.sql |
| identity.binding | services/identity/migrations/0001_identity.sql |
| identity.qualification | services/identity/migrations/0001_identity.sql |
| identity.identity_link | services/identity/migrations/0001_identity.sql |
| identity.team | services/identity/migrations/0001_identity.sql |
| identity.access_sync | services/identity/migrations/0001_identity.sql |
| killswitch.head | services/killswitch/migrations/0001_killswitch.sql |
| killswitch.journal | services/killswitch/migrations/0001_killswitch.sql |
| killswitch.kill | services/killswitch/migrations/0001_killswitch.sql |
| killswitch.release_approval | services/killswitch/migrations/0001_killswitch.sql |
| killswitch.factory_admin | services/killswitch/migrations/0001_killswitch.sql |
| killswitch.holder | services/killswitch/migrations/0001_killswitch.sql |
| killswitch.project_policy | services/killswitch/migrations/0001_killswitch.sql |
| killswitch.delegation | services/killswitch/migrations/0001_killswitch.sql |
| knowledge.knowledge_job | services/knowledge/migrations/0001_knowledge.sql |
| security_findings.finding | services/knowledge/migrations/0001_knowledge.sql |
| security_findings.finding_location | services/knowledge/migrations/0001_knowledge.sql |
| knowledge.census | services/knowledge/migrations/0002_census.sql |
| knowledge.repo_index | services/knowledge/migrations/0003_repo_index.sql |
| knowledge.repo_file | services/knowledge/migrations/0003_repo_index.sql |
| notary.state | services/notary/migrations/0001_journal.sql |
| notary.journal | services/notary/migrations/0001_journal.sql |
| notary.checkpoint_journal | services/notary/migrations/0001_journal.sql |
| notary.evidence_signature | services/notary/migrations/0002_evidence_signatures.sql |
| notary.audit_export_signature | services/notary/migrations/0003_audit_export_signatures.sql |
| notifier.notification | services/notifier/migrations/0001_notifier.sql |
| notifier.delivery | services/notifier/migrations/0001_notifier.sql |
| notifier.preference | services/notifier/migrations/0001_notifier.sql |
| notifier.source_cursor | services/notifier/migrations/0001_notifier.sql |
| verify.check_result | services/verify/migrations/0001_verify.sql |
| witness.cosigned | services/witness/migrations/0001_cosigned.sql |


## 7. Portal routes, navigation, guarded actions

| path | screen | defined |
|---|---|---|
| /floor | floor | router.tsx STATIC_SCREENS |
| /fleet | fleet | router.tsx STATIC_SCREENS |
| /projects | projects | router.tsx STATIC_SCREENS |
| /items | items | router.tsx STATIC_SCREENS |
| /board | board | router.tsx STATIC_SCREENS |
| /agents | agents | router.tsx STATIC_SCREENS |
| /evals | evals | router.tsx STATIC_SCREENS |
| /models | models | router.tsx STATIC_SCREENS |
| /integrations | integrations | router.tsx STATIC_SCREENS |
| /scheduler | scheduler | router.tsx STATIC_SCREENS |
| /sandboxes | sandboxes | router.tsx STATIC_SCREENS |
| /controls | controls | router.tsx STATIC_SCREENS |
| /kill | kill | router.tsx STATIC_SCREENS |
| /health | health | router.tsx STATIC_SCREENS |
| /ledger | fleetLedger | router.tsx STATIC_SCREENS |
| /audit | audit | router.tsx STATIC_SCREENS |
| /catalogue | catalogue | router.tsx STATIC_SCREENS |
| /people | people | router.tsx STATIC_SCREENS |
| /teams | teams | router.tsx STATIC_SCREENS |
| /roles | roles | router.tsx STATIC_SCREENS |
| /access-requests | accessRequests | router.tsx STATIC_SCREENS |
| /access-explain | explain | router.tsx STATIC_SCREENS |
| /onboard |  | router.tsx parseRoute |
| /inbox |  | router.tsx parseRoute |
| /me/access |  | router.tsx parseRoute |
| /config |  | router.tsx parseRoute |
| /ask |  | router.tsx parseRoute |
| /me/notifications |  | router.tsx parseRoute |
| /me/notifications/preferences |  | router.tsx parseRoute |
| /config/:id |  | router.tsx parseRoute (pattern) |
| /items/:id/closeout |  | router.tsx parseRoute (pattern) |
| /projects/:id/learn |  | router.tsx parseRoute (pattern) |
| /config/revisions/:id |  | router.tsx parseRoute (pattern) |
| /items/:id/evidence |  | router.tsx parseRoute (pattern) |
| /projects/:id/(readiness\|ledger\|issues\|knowledge) |  | router.tsx parseRoute (pattern) |
| /(projects\|s0\|cards\|revisions\|items)/:id |  | router.tsx parseRoute (pattern) |

| group | path | label | guard |
|---|---|---|---|
| Work | / | Home | SIGNED_IN |
| Work | /floor | Floor | { kind: 'somewhere' |
| Work | /fleet | Fleet | SIGNED_IN |
| Work | /board | Board | SIGNED_IN |
| Work | /items | Items | SIGNED_IN |
| Work | /ask | Ask the factory | SIGNED_IN |
| Decide | /inbox | Inbox | SIGNED_IN |
| Decide | /me/notifications | Notifications | SIGNED_IN |
| Projects | /projects | Projects | SIGNED_IN |
| Projects | /onboard | Onboard a repo | { kind: 'fleet_action' |
| Operate | /scheduler | Scheduler | FLEET_AUDIT |
| Operate | /sandboxes | Sandboxes | FLEET_AUDIT |
| Operate | /controls | Controls | FLEET_AUDIT |
| Operate | /kill | Kill switch | FLEET_AUDIT |
| Operate | /health | Health | FLEET_AUDIT |
| Quality | /agents | Agents | FLEET_AUDIT |
| Quality | /evals | Evals | FLEET_AUDIT |
| Quality | /models | Models and routes | FLEET_AUDIT |
| Quality | /integrations | Integrations | FLEET_AUDIT |
| Govern | /ledger | Ledger | { kind: 'somewhere' |
| Govern | /audit | Audit | FLEET_AUDIT |
| Govern | /catalogue | Catalogue | SIGNED_IN |
| Govern | /config | Configuration | { kind: 'fleet_any' |
| Admin | /people | People | FLEET_AUDIT |
| Admin | /teams | Teams | FLEET_AUDIT |
| Admin | /roles | Roles | SIGNED_IN |
| Admin | /access-requests | Access requests | SIGNED_IN |
| Admin | /access-explain | Who can do what | { kind: 'somewhere' |


### 7.1 Actions the web names (hint guards)

| action | web files |
|---|---|
| project.onboard | App.tsx, pages/HomePage.tsx, shell/nav.ts |
| work.request | pages/IssueTwinPage.tsx, pages/MyAccessPage.tsx |
| item.ready | via bff route(s) the web calls: GET /api/items/:id, POST /api/items/:id/ready, POST /api/items/:id/answers |
| item.observe | via bff route(s) the web calls: GET /api/items/:id, POST /api/items/:id/observe |
| item.plan | via bff route(s) the web calls: GET /api/items/:id, POST /api/items/:id/plan |
| item.release | items/Governance.tsx |
| item.human_done | **none** |
| item.unsure | items/Governance.tsx |
| item.escape | pages/CloseoutPage.tsx |
| audit.record | pages/CloseoutPage.tsx |
| closeout.read | pages/CloseoutPage.tsx |
| learn.propose | pages/LearnPage.tsx |
| project.view | assistant/OnboardingAssistant.tsx, pages/KnowledgePage.tsx, pages/MyAccessPage.tsx, pages/ProjectDetail.tsx |
| project.settings.edit | pages/MyAccessPage.tsx |
| floor.read | floor/FloorPage.tsx, shell/nav.ts |
| item.view_floor | **none** |
| gate.view | **none** |
| gate.decide | via bff route(s) the web calls: GET /api/inbox |
| card.decide | cards/ExceptionGate.tsx |
| kill.request | **none** |
| kill.release | **none** |
| config.propose | config/ConfigConsole.tsx, pages/IssueTwinPage.tsx, pages/MyAccessPage.tsx, shell/nav.ts |
| config.decide | pages/AuditPanels.tsx, pages/FactoryRevisionPage.tsx |
| audit.read | pages/AdminPages.tsx, pages/FactoryRevisionPage.tsx, pages/GovernPages.tsx, pages/HomePage.tsx, pages/LearnPage.tsx, pages/MyAccessPage.tsx, pages/OperatePages.tsx, pages/QualityPages.tsx, shell/nav.ts |
| control.apply | pages/OperatePages.tsx |
| control.lift | pages/OperatePages.tsx |
| banner.publish | **none** |
| access.explain | pages/AdminPages.tsx, pages/MyAccessPage.tsx, shell/nav.ts |


## 8. Onboarding

Source: contracts `CardKind`, `FloorId`, catalogue criteria (`criteria.criteria[].floors`), `OnboardingStatus`, `GapDisposition`.


### 8.1 Cards

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| C1 |  | contracts CardKind | no | named in web: pages/CardPage.tsx |
| C2 |  | contracts CardKind | no | named in web: pages/CardPage.tsx |
| C3 |  | contracts CardKind | no | named in web: pages/CardPage.tsx |
| C4 |  | contracts CardKind | no | named in web: pages/CardPage.tsx |
| C5 |  | contracts CardKind | no | named in web: pages/CardPage.tsx |
| SECR |  | contracts CardKind | no | named in web: pages/CardPage.tsx |
| BATCH |  | contracts CardKind | no | **none** |
| X2 |  | contracts CardKind | no | named in web: cards/ExceptionGate.tsx |


### 8.2 Floors (CF, LF, FF)

| floor | criteria | portal surface today |
|---|---|---|
| CF1 | RS-ID-1 App installation scoped to the repo; repo reachabl | generic: PRR page criteria list |
| CF2 | RS-ID-2 Owner confirmed | generic: PRR page criteria list |
| CF3 | RS-ID-3 Tier signed, raise-only | generic: PRR page criteria list |
| CF4 | RS-ID-4 Visibility, owner type and plan recorded | generic: PRR page criteria list |
| LF1 | RS-SEC Security assessment exists; no open BLOCKING findi | generic: PRR page criteria list |
| LF2 | RS-CC-3 Default-branch rules (as LF2); the bypass clause i; RS-CC-4 App may only create or update agent/** | generic: PRR page criteria list |
| LF3 | RS-BT-1 Task-contract targets discoverable; test and check; RS-BT-2 setup and test pass headless in K-exec from clean; RS-BT-7 Default test is hermetic; external-service tests m; RS-TH-1 Tests exist and the gating set pa | named in web: cards/C2Form.tsx |
| LF4 | RS-AI-7 Harness and auto-run config inventoried, protected | named in web: cards/C2Form.tsx |
| LF5 | RS-AI-3 Content lint clean (L-rules); RS-AI-4 Text affirmed by a human | generic: PRR page criteria list |
| LF6 | RS-KN-4 ≥90% of ≤50 claims affirmed or unknown; unknowns r; RS-KN-5 Business intent (card answers) and sensitive-path  | generic: PRR page criteria list |
| LF7 | RS-OP-1 Apply-on-merge known; RS-OP-2 operations.md attested (L5 also: staging separatio | generic: PRR page criteria list |
| LF8 | RS-EN-1 Egress needs declared | named in web: cards/C2Form.tsx |
| FF1 | RS-KN-7 Full codekb, system map, seeds | named in web: cards/C3Form.tsx |
| FF2 | RS-OP-2 operations.md attested (L5 also: staging separatio | generic: PRR page criteria list |


### 8.3 Readiness criteria

| criterion | pillar | title | class by level | portal surface today |
|---|---|---|---|---|
| RS-ID-1 | ID | App installation scoped to the repo; repo reachable; default branch known | {"census": "FLOOR", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-ID-2 | ID | Owner confirmed | {"census": "FLOOR", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-ID-3 | ID | Tier signed, raise-only | {"census": "FLOOR", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-ID-4 | ID | Visibility, owner type and plan recorded | {"census": "FLOOR", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-AI-1 | AI | Root AGENTS.md ≤150 lines; the whole chain ≤32 KiB (Codex cut-off) | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-AI-2 | AI | Template sections present | {"census": null, "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-AI-3 | AI | Content lint clean (L-rules) | {"census": "RECORDED", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-AI-4 | AI | Text affirmed by a human | {"census": null, "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-AI-5 | AI | One source: CLAUDE.md = @AGENTS.md stub, other harness files absent or stubs | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-AI-6 | AI | Nested AGENTS.md only at subproject roots, ≤60 lines | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-AI-7 | AI | Harness and auto-run config inventoried, protected, never loaded; isolation test | {"census": "RECORDED", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-BT-1 | BT | Task-contract targets discoverable; test and check exist | {"census": "RECORDED", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-BT-2 | BT | setup and test pass headless in K-exec from clean | {"census": "RECORDED", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-BT-3 | BT | Lockfile per manifest; frozen install | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-BT-4 | BT | Toolchain pinned | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-BT-5 | BT | Environment builds within the ≤10 min rehydration budget | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-BT-6 | BT | Test wall time recorded; if test > 15 min, a test-fast ≤5 min exists | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-BT-7 | BT | Default test is hermetic; external-service tests marked and excluded | {"census": "RECORDED", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-BT-8 | BT | CI runs check; required check = what the sandbox ran | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-ST-1 | ST | Formatter | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-ST-2 | ST | Linter (diff-scoped against a baseline) | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-ST-3 | ST | Type checker | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-ST-4 | ST | AGENTS.md conventions = non-standard practices only, tagged (enforced:) or (advi | {"census": null, "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-ST-5 | ST | Generated and vendored paths declared | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-ST-6 | ST | pre-commit hooks | {"census": "ADVISORY", "light": "ADVISORY", "full": "ADVISORY"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-TH-1 | TH | Tests exist and the gating set passes | {"census": "RECORDED", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-TH-2 | TH | Flake baseline (CI history or later item runs) | {"census": "RECORDED", "light": "RECORDED", "full": "RECORDED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-TH-3 | TH | Quarantine manifest with issue, owner and expiry; tests never deleted | {"census": null, "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-TH-4 | TH | Skip/xfail inventory | {"census": "RECORDED", "light": "RECORDED", "full": "RECORDED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-TH-5 | TH | Coverage report producible | {"census": null, "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-TH-6 | TH | Mutation testing | {"census": null, "light": null, "full": "ADVISORY"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-CC-1 | CC | CODEOWNERS parses with zero errors; owners resolve | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-CC-2 | CC | CODEOWNERS covers the protected set | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-CC-3 | CC | Default-branch rules (as LF2); the bypass clause is H-attested | {"census": "RECORDED", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-CC-4 | CC | App may only create or update agent/** | {"census": "RECORDED", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-CC-5 | CC | Push ruleset on protected paths | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-CC-6 | CC | Merge method recorded | {"census": "RECORDED", "light": "RECORDED", "full": "RECORDED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-CC-7 | CC | Signed commits | {"census": "ADVISORY", "light": "ADVISORY", "full": "ADVISORY"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-KN-1 | KN | README purpose and how to run | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-KN-2 | KN | .factory/knowledge/ pack in git, front-matter valid, kn-check clean | {"census": null, "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-KN-3 | KN | build-and-run.md generated from the probe | {"census": null, "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-KN-4 | KN | ≥90% of ≤50 claims affirmed or unknown; unknowns register | {"census": null, "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-KN-5 | KN | Business intent (card answers) and sensitive-path list | {"census": null, "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-KN-6 | KN | Decision records seeded | {"census": null, "light": "ADVISORY", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-KN-7 | KN | Full codekb, system map, seeds | {"census": null, "light": null, "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-OP-1 | OP | Apply-on-merge known | {"census": "RECORDED", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-OP-2 | OP | operations.md attested (L5 also: staging separation) | {"census": null, "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-OP-3 | OP | Runbook pointers | {"census": null, "light": "ADVISORY", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-EN-1 | EN | Egress needs declared | {"census": null, "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-EN-2 | EN | .env.example placeholders only; test needs no real secret | {"census": "RECORDED", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-EN-3 | EN | Repo size, LFS, binaries | {"census": "RECORDED", "light": "RECORDED", "full": "RECORDED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-PUB-1 | PUB | LICENSE | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-PUB-2 | PUB | SECURITY.md with private reporting (human-authored) | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-PUB-4 | PUB | CONTRIBUTING, PR template | {"census": "ADVISORY", "light": "ADVISORY", "full": "ADVISORY"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-PUB-5 | PUB | Dependabot or Renovate config | {"census": "RECORDED", "light": "SCORED", "full": "SCORED"} | generic: PRR page (`pages/PrrPage.tsx`) |
| RS-SEC | SEC | Security assessment exists; no open BLOCKING finding | {"census": "RECORDED", "light": "FLOOR", "full": "FLOOR"} | generic: PRR page (`pages/PrrPage.tsx`) |

DEC decisions that are a setting (named in a config key description): DEC-10 (codehost.merge_bypass), DEC-11 (onboarding.instruction_template), DEC-17 (onboarding.sandbox_image), DEC-18 (sandbox.exec_allowed_repos), DEC-28 (project.two_person), DEC-29 (project.kill_delegations), DEC-4 (s0.t0_attestation_required), DEC-9 (s0.failure_model).


## 9. Operate and govern vocabularies


### 9.1 control kinds (`ControlKind`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| hold |  | contracts ControlKind | no | named in web: pages/OperatePages.tsx |
| clamp |  | contracts ControlKind | no | **none** |
| halt |  | contracts ControlKind | no | **none** |
| maintenance |  | contracts ControlKind | no | **none** |


### 9.2 onboarding controls (`ControlId`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| B4a |  | contracts ControlId | no | **none** |
| B4b |  | contracts ControlId | no | **none** |
| B4c |  | contracts ControlId | no | **none** |
| protect_main |  | contracts ControlId | no | **none** |
| app_scope |  | contracts ControlId | no | **none** |
| codeowners |  | contracts ControlId | no | named in web: cards/C4Form.tsx, pages/RevisionPage.tsx |
| instructions |  | contracts ControlId | no | **none** |


### 9.3 ops verbs (`OpsVerb`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| control.hold |  | contracts OpsVerb | no | **none** |
| control.clamp |  | contracts OpsVerb | no | **none** |
| control.halt |  | contracts OpsVerb | no | **none** |
| control.maintenance |  | contracts OpsVerb | no | **none** |
| control.lift |  | contracts OpsVerb | no | named in web: pages/OperatePages.tsx |
| banner.publish |  | contracts OpsVerb | no | **none** |


### 9.4 banner targets (`BannerTarget`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| banner |  | contracts BannerTarget | no | **none** |
| channel |  | contracts BannerTarget | no | **none** |
| statuspage |  | contracts BannerTarget | no | **none** |


### 9.5 kill states (`KillState`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| active |  | contracts KillState | no | named in web: pages/AdminPages.tsx, pages/AuditPanels.tsx, pages/ItemPage.tsx, vocab.ts |
| release_pending |  | contracts KillState | no | **none** |
| released |  | contracts KillState | no | **none** |


### 9.6 notification kinds (`NotificationKind`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| gate_waiting |  | contracts NotificationKind | no | **none** |
| sla_escalated |  | contracts NotificationKind | no | **none** |
| quarantine |  | contracts NotificationKind | no | **none** |
| handoff |  | contracts NotificationKind | no | named in web: floor/FleetPage.tsx, items/waiting.ts, pages/PackPage.tsx |
| kill_engaged |  | contracts NotificationKind | no | **none** |
| kill_released |  | contracts NotificationKind | no | **none** |


### 9.7 notification reasons (`NotificationReason`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| slot_holder |  | contracts NotificationReason | no | **none** |
| escalated_backup |  | contracts NotificationReason | no | **none** |
| project_admin |  | contracts NotificationReason | no | **none** |
| factory_admin |  | contracts NotificationReason | no | **none** |


### 9.8 notification channels (`NotificationChannelKind`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| slack_webhook |  | contracts NotificationChannelKind | no | named in web: pages/NotificationsPage.tsx |
| email_smtp |  | contracts NotificationChannelKind | no | **none** |


### 9.9 legal hold (`LegalHoldState`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| active |  | contracts LegalHoldState | no | named in web: pages/AdminPages.tsx, pages/AuditPanels.tsx, pages/ItemPage.tsx, vocab.ts |
| released |  | contracts LegalHoldState | no | **none** |


### 9.10 erasure states (`ErasureState`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| requested |  | contracts ErasureState | no | named in web: pages/AuditPanels.tsx |
| blocked |  | contracts ErasureState | no | named in web: cards/DecideShell.tsx, components/StepList.tsx, items/VerifyTab.tsx, items/waiting.ts (+2) |
| approved |  | contracts ErasureState | no | named in web: cards/DecideShell.tsx |
| executed |  | contracts ErasureState | no | **none** |
| rejected |  | contracts ErasureState | no | named in web: cards/DecideShell.tsx, pages/S0Page.tsx |


### 9.11 health states (`HealthState`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| ok |  | contracts HealthState | no | named in web: assistant/AskPage.tsx, assistant/Conversation.tsx, cards/C3Form.tsx, cards/ExceptionGate.tsx (+24) |
| degraded |  | contracts HealthState | no | **none** |
| down |  | contracts HealthState | no | **none** |
| unknown |  | contracts HealthState | no | named in web: cards/C2Form.tsx, cards/C3Form.tsx, config/ConfigConsole.tsx, floor/FleetPage.tsx (+5) |


### 9.12 sandbox classes (`SandboxClass`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| K |  | contracts SandboxClass | no | **none** |
| K-exec |  | contracts SandboxClass | no | **none** |
| P |  | contracts SandboxClass | no | **none** |
| W |  | contracts SandboxClass | no | named in web: floor/FloorPage.tsx, pages/OperatePages.tsx |
| O |  | contracts SandboxClass | no | **none** |
| V |  | contracts SandboxClass | no | **none** |


### 9.13 floor item status (`FloorItemStatus`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| working |  | contracts FloorItemStatus | no | named in web: floor/geometry.ts, vocab.ts |
| waiting |  | contracts FloorItemStatus | no | named in web: floor/FloorPage.tsx, items/waiting.ts, vocab.ts |
| held |  | contracts FloorItemStatus | no | named in web: floor/FleetPage.tsx, pages/HomePage.tsx, vocab.ts |
| stuck |  | contracts FloorItemStatus | no | named in web: floor/FloorPage.tsx, floor/FloorPlanView.tsx, items/waiting.ts, vocab.ts |
| done |  | contracts FloorItemStatus | no | named in web: floor/FloorPage.tsx, ui/sequence.tsx, vocab.ts |
| declined |  | contracts FloorItemStatus | no | named in web: floor/FloorPage.tsx, vocab.ts |


### 9.14 gate feasibility (`GateFeasibilityState`)

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| feasible |  | contracts GateFeasibilityState | no | named in web: pages/InboxPage.tsx |
| infeasible |  | contracts GateFeasibilityState | no | **none** |
| unknown |  | contracts GateFeasibilityState | no | named in web: cards/C2Form.tsx, cards/C3Form.tsx, config/ConfigConsole.tsx, floor/FleetPage.tsx (+5) |


### 9.x `KILL_SCOPE_KINDS`

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| fleet |  | contracts KILL_SCOPE_KINDS | no | named in web: App.tsx, floor/FleetPage.tsx, pages/AdminPages.tsx, pages/AuditPanels.tsx (+6) |
| project |  | contracts KILL_SCOPE_KINDS | no | named in web: App.tsx, access/AccessProvider.tsx, api.ts, assistant/AskPage.tsx (+13) |
| lane |  | contracts KILL_SCOPE_KINDS | no | named in web: cards/C4Form.tsx, pages/ItemsPage.tsx, pages/OperatePages.tsx |
| session |  | contracts KILL_SCOPE_KINDS | no | named in web: lib/decideErrors.ts |


### 9.x `CONTROL_SCOPE_KINDS`

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| fleet |  | contracts CONTROL_SCOPE_KINDS | no | named in web: App.tsx, floor/FleetPage.tsx, pages/AdminPages.tsx, pages/AuditPanels.tsx (+6) |
| team |  | contracts CONTROL_SCOPE_KINDS | no | named in web: pages/Onboard.tsx |
| project |  | contracts CONTROL_SCOPE_KINDS | no | named in web: App.tsx, access/AccessProvider.tsx, api.ts, assistant/AskPage.tsx (+13) |
| lane |  | contracts CONTROL_SCOPE_KINDS | no | named in web: cards/C4Form.tsx, pages/ItemsPage.tsx, pages/OperatePages.tsx |
| release |  | contracts CONTROL_SCOPE_KINDS | no | named in web: cards/C4Form.tsx |
| budget |  | contracts CONTROL_SCOPE_KINDS | no | named in web: assistant/AskPage.tsx, assistant/OnboardingAssistant.tsx |


### 9.x `AUDIT_ACTION`

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| read | audit.read | contracts AUDIT_ACTION | no | **none** |
| export | audit.read | contracts AUDIT_ACTION | no | **none** |
| govern | config.decide | contracts AUDIT_ACTION | no | **none** |


### 9.x `UNMUTABLE_NOTIFICATION_KINDS`

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| kill_engaged |  | contracts UNMUTABLE_NOTIFICATION_KINDS | no | **none** |
| kill_released |  | contracts UNMUTABLE_NOTIFICATION_KINDS | no | **none** |


### 9.x `DEFAULT_SANDBOX_CAPS`

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| total | 4 | contracts DEFAULT_SANDBOX_CAPS | no | **none** |
| coding | 1 | contracts DEFAULT_SANDBOX_CAPS | no | **none** |


### 9.x `SANDBOX_PROFILES`

| id | what | defined | configurable? | portal surface today |
|---|---|---|---|---|
| K | third-party scanners: no NIC, repo read-only, no key, no execution | contracts SANDBOX_PROFILES | no | **none** |
| K-exec | build/test probe: the package mirror only, no gateway key, repo code runs | contracts SANDBOX_PROFILES | no | **none** |
| P | planning agents: the gateway only, repo read-only, a per-job key, no execution | contracts SANDBOX_PROFILES | no | **none** |
| W | coding session: the gateway and the mirror, a disposable repo copy, a per-Unit key, runs code | contracts SANDBOX_PROFILES | no | named in web: floor/FloorPage.tsx, pages/OperatePages.tsx |
| O | oracle runs: the mirror only, no key, repo code runs | contracts SANDBOX_PROFILES | no | **none** |
| V | reviewers and verifiers: the gateway only, repo read-only, a per-job key, no execution | contracts SANDBOX_PROFILES | no | **none** |


## 10. Counts per family

| family | items | no portal surface |
|---|---|---|
| steps | 56 | 0 |
| gates | 29 | 0 |
| back-edges | 28 | 27 |
| handoffs | 5 | 5 |
| triggers | 14 | 14 |
| holds | 9 | 8 |
| wait states | 4 | 2 |
| relanes | 4 | 3 |
| rooms | 6 | 5 |
| phases | 27 | 8 |
| blockers | 6 | 5 |
| lanes | 9 | 0 |
| settings | 30 | 0 |
| actions | 34 | 9 |
| roles | 14 | 0 |
| integration constants | 8 | 8 |
| secrets | 84 | 84 |
| env vars | 283 | 283 |
| agents | 14 | 0 |
| agent/eval signals | 23 | 15 |
| routes:audit | 14 | 0 |
| routes:bff | 109 | 9 |
| routes:codehost | 15 | 0 |
| routes:core | 108 | 25 |
| routes:core-worker | 3 | 0 |
| routes:gate-check | 4 | 0 |
| routes:gate-relay | 3 | 0 |
| routes:gateway | 12 | 0 |
| routes:identity | 23 | 0 |
| routes:killswitch | 11 | 0 |
| routes:kms-local | 1 | 0 |
| routes:knowledge | 10 | 0 |
| routes:notary | 9 | 0 |
| routes:notifier | 5 | 0 |
| routes:sandbox-controller | 4 | 0 |
| routes:verify | 4 | 0 |
| routes:witness | 3 | 0 |
| record events | 278 | 0 |
| ledger entry types | 24 | 0 |
| tables | 108 | 0 |
| web routes | 36 | 0 |
| cards | 8 | 1 |
| floors | 14 | 0 |
| criteria | 56 | 0 |
| control kinds | 4 | 3 |
| onboarding controls | 7 | 6 |
| ops verbs | 6 | 5 |
| banner targets | 3 | 3 |
| kill states | 3 | 2 |
| notification kinds | 6 | 5 |
| notification reasons | 4 | 4 |
| notification channels | 2 | 1 |
| legal hold | 2 | 1 |
| erasure states | 5 | 1 |
| health states | 4 | 2 |
| sandbox classes | 6 | 5 |
| floor item status | 6 | 0 |
| gate feasibility | 3 | 1 |
| KILL_SCOPE_KINDS | 4 | 0 |
| CONTROL_SCOPE_KINDS | 6 | 0 |
| AUDIT_ACTION | 3 | 3 |
| UNMUTABLE_NOTIFICATION_KINDS | 2 | 2 |
| DEFAULT_SANDBOX_CAPS | 2 | 2 |
| SANDBOX_PROFILES | 6 | 5 |


## 11. Items with no portal surface at all

Mechanical: no web file names the id as a literal and no generic surface applies (for core routes: the bff never calls the path; for bff routes: the web never calls it). Env vars and compose secrets are deployment-only by design; they are counted, not listed again here.

- **back-edges** (27): `B1`, `B2`, `B3`, `B5`, `B6`, `B7`, `B8`, `B9`, `B10`, `B11`, `B12`, `B13`, `B14`, `B15`, `B16`, `B17`, `B18`, `B19`, `B20`, `B21`, `B22`, `B23`, `B24`, `B25`, `B26`, `B27`, `B28`

- **handoffs** (5): `D1`, `D2`, `D3`, `D4`, `D5`

- **triggers** (14): `ET1`, `ET2`, `ET3`, `ET4`, `ET5`, `ET6`, `ET7`, `ET8`, `ET9`, `ET10`, `ET11`, `ET12`, `ET13`, `ET14`

- **holds** (8): `H1`, `H2`, `H3`, `WIP`, `N8`, `maintenance`, `quota`, `control`

- **wait states** (2): `ReleaseHeld`, `SpikeReport`

- **relanes** (3): `R1`, `R3`, `R4`

- **rooms** (5): `SCHED`, `HOLD`, `QUAR`, `DESK`, `BIN`

- **phases** (8): `Draft`, `Clarifying`, `Scheduling`, `Handoff`, `Declined`, `Abandoned`, `HandedOverClosed`, `Deferred`

- **blockers** (5): `B1`, `B2`, `B3`, `B5`, `B6`

- **actions** (9): `item.human_done`, `item.view_floor`, `gate.view`, `kill.request`, `kill.release`, `banner.publish`, `access.manage (proposed)`, `session.stop (proposed)`, `assistant.use (proposed)`

- **integration constants** (8): `ADAPTER_KIND`, `ANTHROPIC_DEFAULT_MODELS`, `CODEHOST_ROLE_PERMISSIONS`, `GATE_CHECK_APP_PERMISSIONS`, `GATE_RELAY_APP_PERMISSIONS`, `GITHUB_FORBIDDEN_PERMS`, `GITHUB_FORBIDDEN_WRITE_PERMS`, `TRACKER_APP_PERMISSIONS`

- **secrets** (84): `anthropic-api-key`, `bff-oidc-client-secret`, `db-url-aisdlc`, `db-url-audit`, `db-url-gate-check`, `db-url-gate-relay`, `db-url-gateway`, `db-url-killswitch`, `db-url-notary`, `db-url-notifier`, `db-url-sandbox-controller`, `db-url-verify`, `db-url-witness`, `gate-check-app.pem`, `gate-check-app.pub.pem`, `gate-relay-app.pem`, `gate-relay-app.pub.pem`, `github-app.pem`, `github-app.pub.pem`, `object-store-access-key`, `object-store-secret-key`, `pg-pass-aisdlc`, `pg-pass-audit`, `pg-pass-gate-check`, `pg-pass-gate-relay`, `pg-pass-gateway`, `pg-pass-killswitch`, `pg-pass-notary`, `pg-pass-notifier`, `pg-pass-sandbox-controller`, `pg-pass-verify`, `pg-pass-witness`, `pg-superuser`, `tok-audit-core`, `tok-audit-kms`, `tok-audit-notary`, `tok-bff-audit`, `tok-bff-core`, `tok-bff-gate-check`, `tok-bff-kms`, `tok-bff-notifier`, `tok-bff-sandbox-controller`, `tok-codehost-core`, `tok-codehost-identity`, `tok-core-codehost`, `tok-core-gateway`, `tok-core-kms`, `tok-core-knowledge`, `tok-core-notary`, `tok-core-worker-codehost`, `tok-core-worker-gateway`, `tok-core-worker-identity`, `tok-core-worker-killswitch`, `tok-core-worker-kms`, `tok-core-worker-knowledge`, `tok-core-worker-notary`, `tok-core-worker-sandbox-controller`, `tok-core-worker-verify`, `tok-core-worker-witness`, `tok-cvw-docker-cvw`, `tok-gate-check-kms`, `tok-gate-relay-kms`, `tok-gateway-killswitch`, `tok-identity-core`, `tok-identity-kms`, `tok-identity-notary`, `tok-killswitch-kms`, `tok-knowledge-codehost`, `tok-knowledge-identity`, `tok-knowledge-kms`, `tok-notary-kms`, `tok-operator-codehost`, `tok-operator-core`, `tok-operator-gate-check`, `tok-operator-gate-relay`, `tok-operator-gateway`, `tok-operator-killswitch`, `tok-operator-sandbox-controller`, `tok-sandbox-controller-docker-coding`, `tok-seed-identity`, `tok-smoke-docker-coding`, `tok-verify-codehost`, `tok-verify-sandbox-controller`, `tok-witness-kms`

- **agent/eval signals** (15): `EvalCaseKind.regression`, `EvalCaseKind.holdout`, `EvalCaseKind.pooled`, `EvalCaseKind.canary`, `EvalCaseKind.seeded_defect`, `AgentRunResult.completed`, `AgentRunResult.classified`, `AgentRunResult.gate_needed`, `AgentRunResult.relane`, `AgentRunVerdict.accepted`, `AgentRunVerdict.sent_back`, `AgentRunVerdict.reworked`, `AgentRunVerdict.handed_off`, `AgentRunState.dispatched`, `AgentRunState.finished`

- **routes:bff** (9): `GET /api/audit/exports/:id`, `POST /api/audit/erasures/:id/${verb}`, `POST /api/config/revisions/:gate/${verb}`, `POST /api/projects/:id/issue-twin/links`, `POST /api/requests`, `POST /api/items/:id/human-done`, `GET /api/agent-runs`, `GET /api/agents/:id/stats`, `GET /api/agents/:id/scores`

- **routes:core** (25): `GET /healthz`, `GET /v1/projects/:id`, `GET /v1/projects/:id/settings`, `GET /v1/integrations`, `GET /v1/push-guards/:item/units/:unit/lease`, `GET /v1/push-guards/:item/x2`, `GET /v1/registered-repos`, `GET /v1/repos/:owner/:name/eligibility`, `GET /v1/repos/:owner/:name/s0`, `GET /v1/projects/:id/breakers`, `POST /v1/projects/:id/breakers/:lane/reset`, `GET /v1/projects/:id/controls`, `POST /v1/banners`, `POST /v1/s0/:id/withdraw`, `POST /v1/s0/:id/resume`, `POST /v1/s0/:id/signable-level`, `PUT /v1/projects/:id/settings`, `POST /v1/s0/:id/cards/sync`, `GET /v1/s0/:id/light-floors`, `POST /v1/onboarding/spikes`, `GET /v1/onboarding/spikes/:kind`, `GET /v1/repos/:owner/:name/reonboarding`, `GET /v1/erasable-payloads`, `POST /v1/erasable-payloads/:id/erase`, `POST /v1/sessions/heartbeat`

- **cards** (1): `BATCH`

- **control kinds** (3): `clamp`, `halt`, `maintenance`

- **onboarding controls** (6): `B4a`, `B4b`, `B4c`, `protect_main`, `app_scope`, `instructions`

- **ops verbs** (5): `control.hold`, `control.clamp`, `control.halt`, `control.maintenance`, `banner.publish`

- **banner targets** (3): `banner`, `channel`, `statuspage`

- **kill states** (2): `release_pending`, `released`

- **notification kinds** (5): `gate_waiting`, `sla_escalated`, `quarantine`, `kill_engaged`, `kill_released`

- **notification reasons** (4): `slot_holder`, `escalated_backup`, `project_admin`, `factory_admin`

- **notification channels** (1): `email_smtp`

- **legal hold** (1): `released`

- **erasure states** (1): `executed`

- **health states** (2): `degraded`, `down`

- **sandbox classes** (5): `K`, `K-exec`, `P`, `O`, `V`

- **gate feasibility** (1): `infeasible`

- **AUDIT_ACTION** (3): `read`, `export`, `govern`

- **UNMUTABLE_NOTIFICATION_KINDS** (2): `kill_engaged`, `kill_released`

- **DEFAULT_SANDBOX_CAPS** (2): `total`, `coding`

- **SANDBOX_PROFILES** (5): `K`, `K-exec`, `P`, `O`, `V`
