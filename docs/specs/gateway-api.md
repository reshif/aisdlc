# Model gateway: HTTP contract (M10)

The gateway (`services/gateway`) is the only process that holds a model-vendor key (RV §2 "Model key custody"). Every model call of the factory goes through it. Sandboxes and the work engine never see a vendor key: a sandbox holds one **virtual key** per Unit, minted by the work engine through the admin API.

Contracts (Zod, `packages/contracts/src/entities/gateway.ts`) are the source of truth for every shape below.

## 1. Credentials

| Who | Credential | Opens |
|---|---|---|
| Sandbox, agent harness | a virtual key `aisk_<48 hex>` | `POST /v1/messages` only |
| Work engine (`core`), operator | a service token with scope `admin` and/or `read` (`Authorization: Bearer`) | `/v1/admin/*` |
| Anyone | none | `GET /healthz` |

A virtual key opens nothing of the admin API, and a service token is not a virtual key. The secret of a virtual key is returned **once**, at mint; only its sha256 is stored. A vendor key is never in any response, error, log line, record event or table.

## 2. `POST /v1/messages` (Anthropic Messages compatible subset)

To point the Claude Agent SDK (or any Anthropic client) at it:

```
ANTHROPIC_BASE_URL=http://gateway:8410
ANTHROPIC_API_KEY=<the unit's virtual key>        # sent as x-api-key (or as Authorization: Bearer, which the TypeScript SDK 1.x does)
ANTHROPIC_MODEL=<anything>                         # see "model" below
```

Request headers: the key as `x-api-key: <key>` or `Authorization: Bearer <key>`; `content-type: application/json`; optionally `x-aisdlc-data-class: D0|D1|D2|D3` (default: the key's `data_class_max`). `anthropic-version` is accepted and ignored.

Request body (anything else is ignored, never forwarded):

| Field | Notes |
|---|---|
| `model` | **Advisory.** The gateway serves the model its route names for `(environment, data class)`; the response says which. The key's `models` allow-list applies to the routed model |
| `max_tokens` | required; clamped to the routed model's `max_tokens_cap` and to what the key's budget group can still pay for |
| `messages` | `user`/`assistant`; content is a string or blocks `text`, `tool_use`, `tool_result`. **Image and thinking blocks are refused (400)** |
| `system` | string or text blocks (joined) |
| `tools`, `tool_choice` | only tools on the key's allow-list; `tool_choice: {type:"tool", name}` likewise. A `tool_use` in `messages` naming a tool outside it is also refused |
| `temperature`, `stop_sequences` | passed on |
| `stream` | **`true` is refused (400 `invalid_request`).** Streaming is not implemented in the gateway yet (the port has an optional `stream`; the Anthropic adapter does not provide one). The Agent SDK must be run with streaming off until a later milestone |

Success: `200`, an Anthropic message: `{id, type:"message", role:"assistant", model, content:[text|tool_use], stop_reason, stop_sequence:null, usage:{input_tokens, output_tokens}}`. `model` is the factory's model id (`gateway.models[].model_id`).

Errors: `{"type":"error","error":{"type":<anthropic type>,"code":<code>,"message":...}}`.

| HTTP | `code` | When |
|---|---|---|
| 401 | `unauthenticated` | no key, malformed or unknown key (not recorded) |
| 401 | `key_revoked`, `key_expired` | |
| 400 | `invalid_request` | bad body, `stream: true`, bad data-class header |
| 400 | `tools_unsupported` | tools offered to a model that cannot take them |
| 403 | `d3_never_routed` | the call's data class is D3, whatever the key says |
| 403 | `data_class_exceeds_key` | asked class above the key's `data_class_max` |
| 403 | `no_route` | no route for `(environment, data class)` (fail closed) |
| 403 | `model_not_allowed` | the routed model is not on the key's allow-list |
| 403 | `tool_not_allowed` | the request names a tool outside the key's allow-list; the request is refused as a whole |
| 403 | `budget_unknown` | the key's budget group is gone |
| 423 | `killed` | the kill switch covers the key's project, lane or session |
| 429 | `budget_exhausted` | the budget group is spent (tokens or cost). First time: ET1 is raised |
| 429, 400, 502 | `provider_error` | the vendor failed (rate limit, refusal, down); nothing is charged |
| 502 | `tool_not_allowed_in_response` | the model asked for a tool outside the allow-list; the output is dropped, the tokens are charged |
| 503 | `spend_guard` | this process made `GATEWAY_MAX_PROVIDER_CALLS` vendor calls |
| 503 | `kill_switch_unreachable` | the kill switch could not be asked (unreachable means killed) |
| 503 | `route_broken` | the route leads to a missing or disabled model or provider, or an adapter the gateway does not hold |
| 503 | `metering_failed` | the call could not be recorded; its output is not delivered |

Order of checks: key, body, spend guard, kill switch, data class, route, model allow-list, tool allow-list, redaction, budget reservation, vendor call, response tool check, settlement. Every call of a known key is recorded as one `gateway.model_call` record event, refusals included.

## 3. Admin API (`Authorization: Bearer <service token>`)

Errors: `{"error":{"code","message"}}`.

| Method and path | Scope | Body / result |
|---|---|---|
| `POST /v1/admin/budget-groups` | admin | `{group_id, max_tokens, max_cost_micro_usd}` -> `201` (created) or `200` (exists with the same limits; other limits: `400`) -> `BudgetGroupView` |
| `GET /v1/admin/budget-groups/:id` | read | `BudgetGroupView` (`used_*`, `reserved_*`, `exhausted_at`) |
| `POST /v1/admin/vkeys` | admin | `VKeyMint` -> `201 {vkey: VKeyView, key}`; the budget group must exist |
| `GET /v1/admin/vkeys/:id` | read | `VKeyView` (never the secret) |
| `POST /v1/admin/vkeys/:id/revoke` | admin | `VKeyView`; effective on the next call |

`VKeyMint`: `scope {kind: unit|job|session, ref}`, `project_id`, `lane?`, `data_class_max`, `models[]` (factory model ids), `tools[]`, `budget_group`, `expires_at`, `item_id?`, `unit_id?`, `step?` (where ET1 is attributed; default 6.4). The kill switch is asked with `{project_id, lane?, session_id (scope session)}`.

## 4. Routing, budgets, redaction, tools

- **Routes are config** (`gateway.providers`, `gateway.models`, `gateway.routes`, factory layer, published through `config_publish` behind an M1 gate). A route is `(environment, data_class in D0..D2) -> model_id`; the schema has no D3, and D3 is also refused at call time. The gateway reads the effective config on every call, so a published revision applies from the next call, with no restart. Providers carry no key and no URL: those are the gateway's own deployment (`GATEWAY_PROVIDER_ADAPTERS`).
- **Budgets** are hard stops in tokens and in cost (micro-USD; the price per model is `usd_in_per_mtok`/`usd_out_per_mtok`, which is micro-USD per token). A call reserves `estimated input + clamped output` under the group's row lock, so calls in flight cannot overspend; settlement adds what the vendor reported. Spent (>= 100% of either limit) raises `gateway.budget_exhausted` (ET1) once per group; core turns it into the item's D1 handoff.
- **Redaction**: the shared ruleset (`@aisdlc/secrets-rules`) runs over the system prompt, message text, tool results, tool-call inputs and tool descriptions before anything leaves for the vendor; a found value becomes `[REDACTED:<rule>]` and the count is in the `ModelCall` event.
- **Tool allow-list**: the key's, fixed at mint. A request cannot widen it (text in a prompt changes nothing; naming a tool outside it is a refusal), and a `tool_use` the model returns outside it is dropped.
- **Record events** (`gateway.*`, no text ever): `model_call` (ids, hashes of the redacted request and of the response content, token counts, cost, latency, outcome, redaction count), `budget_exhausted`, `vkey_minted`, `vkey_revoked`.

## 5. Configuration (environment)

| Variable | Meaning |
|---|---|
| `GATEWAY_DATABASE_URL` | the record database (`file:`/`env:` reference): the gateway writes `gateway.*` events and reads config |
| `GATEWAY_ENVIRONMENT` | `local`, `staging` or `prod`: which routes apply |
| `GATEWAY_CALLERS` | `{caller: {token_ref, scopes: [admin, read]}}` |
| `GATEWAY_PROVIDER_ADAPTERS` | `{provider_id: {kind: "anthropic", key_ref: "file:...", base_url?, models?} \| {kind: "fake"}}`; `fake` is refused in `prod` |
| `GATEWAY_KILLSWITCH_URL`, `GATEWAY_KILLSWITCH_TOKEN_REF` | the kill switch's read API |
| `GATEWAY_MAX_PROVIDER_CALLS` | hard ceiling of vendor calls per process (default 1000) |
| `GATEWAY_HOST`, `GATEWAY_PORT` | default `127.0.0.1:8410` |
