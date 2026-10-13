# dshana — parameter reference

Generated from the tool's zod definition (`packages/tools/src/`), the same source that produces
the model-facing `parameters` JSON Schema and validates every call before dispatch. It cannot
drift from what the tool accepts: edit that source and run
`node scripts/derive/index.mts skill-params` (`derive --check` fails on drift).

Field descriptions are the model-facing text, and `Required` mirrors the schema's `required`
array. Cross-field rules that no argument schema can express — a target must be exactly one of
`taskId` / `sessionId`, `close` and `get` need at least one, `open` takes no `sessionId` —
are stated in `SKILL.md`, not here.

## `open` — start a DSH sub-agent with a first task

| Field | Type | Required | Description |
|---|---|---|---|
| `task` | string | yes | First task for the sub-agent |
| `cwd` | string | yes | Absolute sandbox working directory (required; no fallback) |
| `label` | string | no | Optional display name |
| `agentPreset` | string | no | Agent preset (names defined by DSH) |
| `timeout` | number | no | Seconds; defaults to the App's defaultTimeoutSec |
| `reasoningEffort` | string | no | Reasoning effort (host-side levels) |
| `provider` | string | no | Explicit provider for this request only |
| `model` | string | no | Explicit model id (fallback rules in the SKILL) |

## `reply` — continue it

| Field | Type | Required | Description |
|---|---|---|---|
| `task` | string | yes | Message to send |
| `timeout` | number | no | Seconds; defaults to the App's defaultTimeoutSec |
| `reasoningEffort` | string | no | Reasoning effort (host-side levels) |
| `provider` | string | no | Explicit provider for this request only |
| `model` | string | no | Explicit model id (fallback rules in the SKILL) |
| `taskId` | string | no | taskId returned by open/reply (handle path) |
| `sessionId` | string | no | Session id; passing it means cross-conversation · `pattern` = `^[sS][eE][sS][sS][iI][oO][nN]-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |

## `close` — cancel its running task

| Field | Type | Required | Description |
|---|---|---|---|
| `taskId` | string | no | taskId returned by open/reply (handle path) |
| `sessionId` | string | no | Session id; passing it means cross-conversation · `pattern` = `^[sS][eE][sS][sS][iI][oO][nN]-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |

## `get` — read the last round's conclusion

| Field | Type | Required | Description |
|---|---|---|---|
| `taskId` | string | no | taskId returned by open/reply (handle path) |
| `sessionId` | string | no | Session id; passing it means cross-conversation · `pattern` = `^[sS][eE][sS][sS][iI][oO][nN]-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |

## `approve` — answer a pending approval

| Field | Type | Required | Description |
|---|---|---|---|
| `approvalId` | string | yes | From the approval notice |
| `outcome` | `allowed-once` \| `rejected` | no | allowed-once = this one operation (default) / rejected |
| `taskId` | string | no | taskId returned by open/reply (handle path) |
| `sessionId` | string | no | Session id; passing it means cross-conversation · `pattern` = `^[sS][eE][sS][sS][iI][oO][nN]-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
