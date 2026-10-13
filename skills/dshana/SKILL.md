---
name: dshana
description: "DSHana: DeepSeek Harness as a managed sub-agent in Hana. Read before any dshana call, or for DSH troubleshooting."
---

# dshana: tool manual

DSHana wires DeepSeek Harness (DSH) into Hana as a **managed sub-agent executor**: the App starts a managed Node runtime that runs the DSH web service, and the DSH frontend is mounted into the DSHana card by **same-document injection** (not an iframe embed). DSH and its dependency tree are materialized inside the App package, so **nothing needs to be installed at runtime**.

## When to use this skill

Read it before calling `dshana` with any action (`open` / `reply` / `close` / `get` / `approve`), or when a DSH task, its card, or its approvals need attention. The rest lives in this skill's `references/` directory — read a file when the situation calls for it:

| Read | When |
|---|---|
| `references/parameters.md` | You need exact field names, types or required flags. Generated from the tool's zod definition, so it cannot fall behind. |
| `references/setup.md` | Installing or updating DSHana; the data directory; how a session picks its model. |
| `references/troubleshooting.md` | DSH will not start, a task failed, an approval is stuck — or you need to know what this form cannot do (the known limitations). |
| `references/ui.md` | The DSHana card, theme following, or the workspace directory picker. |

This skill covers **using** `dshana`. Changing this App's own source is a different job with a different reader: see the repo-only manual at `.agents/skills/dshana-dev-loop/SKILL.md` (not shipped in the package).

## Tool manual: `dshana(action, …)`

The host agent side has **exactly this one tool** (one plugin, one same-named tool, actions distinguished by the top-level `action`). Semantics mirror subagent: `open` ≈ `subagent` (created with a task already attached), `reply` ≈ `subagent_reply` (continue the same one by handle), `close` ≈ `subagent_close` (wrap up); `get` and `approve` are specific to this project (subagent has no equivalent).

Inference is initiated from `hana.models` inside the managed runtime, spending host provider quota, and provider credentials stay in the host.

### Parameter contract

The top-level `action` is required, and each subcommand accepts only its own fields (`oneOf` branches + `additionalProperties: false`, so `open`'s schema has no `approvalId`).

**The per-action field list lives in `references/parameters.md`** — read it when you need the exact field names, types or required flags. That file is generated from the same zod definition that produces the tool's `parameters` and validates each call, so it cannot fall behind; the prose here covers what a schema cannot express.

The `parameters` are generated from one zod definition that also validates the incoming arguments before dispatch (the host itself does not validate tool arguments). A malformed call is refused with every failed field listed — `dshana: invalid arguments` followed by `<path>: [<code>] <message>` lines — rather than being silently coerced; notable cases: an unknown `action`, a key that does not belong to the subcommand, a missing required field, and an `outcome` that is neither `allowed-once` nor `rejected` (a typo there used to fall through to `allowed-once`, i.e. allow).

**Target: exactly one, and which subset is legal varies.** `reply` needs exactly one of `taskId` (handle) / `sessionId` (credential); `close` and `get` need at least one (either resolves to the same session); `approve` is keyed by `approvalId`, which resolves through the parent task, so it needs neither. `open` takes no `sessionId` at all — use `reply` to continue an existing session. These are cross-field rules no argument schema can carry, which is why they stay in prose here rather than in `references/parameters.md`.

> To inspect tasks, use the host's built-in task-query tool for the agent (on the model side that is `check_pending_tasks` in this environment): `dshana`'s open/reply create background tasks of this very session, so they already appear in that list; this tool deliberately does not open a second, read-only door for listing.

**Shared fields**: `timeout` is in seconds (App default `defaultTimeoutSec`), and `label` is a display name shown in the host task list and result notifications. `agentPreset` and `reasoningEffort` are pass-through values whose vocabulary this App does not fix. Accepted preset names are DSH's own (empty leaves it to DSH, and `code` is accepted as an alias of `ptc`), and **the preset belongs to `open` alone**: DSH pins it to the session, rejects a differing value on resume as `agent-preset/conflict`, and locks it outright once a turn has started, so `reply` takes no `agentPreset` (`provider` / `model` / `reasoningEffort`, by contrast, can be changed on every `reply`). Accepted effort levels are the **host's**: the model is the host's, the host validates the level against that model's thinking levels, and an empty value leaves it to DSH. (`supportedEfforts` in `packages/dsh/provider/lib/catalog.ts` intersects the host catalog item's declared levels with the canonical effort vocabulary.)

**Choosing the model** (`open` / `reply`): pass `provider` + `model` together to override for this request; passing `reasoningEffort` alone fills the model in from the DSH default; passing none of the three uses the model configured on the calling agent card (`open`) or keeps the session's own choice (`reply`). `provider` / `model` never change DSH's global default.

**Handles and credentials**: `taskId` (returned by open/reply) and `approvalId` are the **handle path** — the tool resolves the session itself and checks ownership against the source session recorded by the host; `sessionId` (of the form `session-<uuid>`) is the **credential path** — passing it explicitly means "I intend to operate across conversations", which skips the ownership check.

### action=open: start a sub-agent with a first task

- **task + cwd are required**; passing `sessionId` is not allowed (use `reply` to continue a session)
- **cwd must be an existing absolute directory** (validated before submission: a relative path is rejected outright, and "exists / is a directory" is decided by the managed runtime's control-plane `cwd-check`). Once a session is created the cwd is the recorded value and every later spawn (commands, terminal) starts from it — do not use a throwaway scratch directory as a session root. The existence check is **best effort**: if the control-plane query itself fails it only logs and lets the call through, and the provider-level working-directory guard catches a bad cwd at spawn time
- **Always asynchronous**: returns immediately with `{ content, details: { dsh: { action: "open", taskId, sessionId, rpcId, status: "running", delivery: "next-step", cwd } } }` (the receipt carries only text and dsh coordinates, with no in-stream card); the task runs in the background and its completion/failure is delivered back to the originating session according to the `delivery` tier in the receipt: the result is pasted back automatically at the next input point, so you do not need to end your turn to wait for it (an idle session starts a new round automatically); use `get` to see progress or the final conclusion
- **Delivery tiers** (the `delivery` value in the receipt): the host does not pick a tier for the author, the App declares it explicitly at create time, and once fixed a tier cannot be changed by update. `next-step` (the current value) means the result is pasted back into this session at the next input-collection point, equivalent to `session:send` with `steer`: it neither interrupts an in-flight request nor requires the model to end its turn to wait; `next-turn` is what starts a separate round after this turn ends (`followUp`). The value in the receipt is the actual tier, so do not infer one.
- **Handle**: the `taskId` in the return value is the handle for later `reply` / `close` / `get`; prefer it
- `label` is a display name (visible in the host task list and result notifications), defaulting to an action-specific prefix
- Submission chain: `ctx.tasks.create` → managed runtime ready → `session.create` → (only when provider/model/effort are passed explicitly, `selectModel`) → bind and write back to the host task record (`ctx.tasks.update`'s `metadata.dsh`, the source of truth for DSH coordinates) → `session.prompt` (queue) → the runtime task-bridge posts the terminal state back

### action=reply: continue the same sub-agent

- **task is required**; the target is one of two: `taskId` (handle, the recommended default) or `sessionId` (credential, for cross-conversation use)
- cwd reuses the session's existing value (a persistent but inactive session resumes automatically)
- Multiple replies to the same session are serialized by the App side, queued in submission order, never concurrent

### action=close: cancel the running task

- The target is one of two: `taskId` (handle, the default) or `sessionId` (credential)
- Chain: tell DSH to `session.cancel` (aborting the model stream / tools / terminal) → settle into a cancelled terminal state; it stops only this work and does not affect other sessions on the shared runtime
- **Asynchronous**: the receipt only says "cancellation requested" and **does not wait for the confirmation window** (the 15s window runs in the background); the evidence of either confirmation or escalation past the window is settled afterwards by a background task notification (delivered back to the originating session) and the App log. Holding the tool callback open waiting for confirmation would block the host channel, especially with several cards cancelling at once
- **When the cancel lands changes the outcome**: landing on a turn that has not started running yet (a fresh open / reply) lets DSH confirm the abort (and it often goes straight down the asynchronous receipt above); landing on a task whose turn has **already finished** leaves nothing in flight to abort, so the host task is escalated to canceled (normal semantics: the record follows the last command issued)
- **Difference from subagent_close**: a DSH session is persistent and can be resumed at any time; there is no instance slot to release, so `close` only cancels the current active task
- If the handle cannot be resolved (the task was collected, or the binding in the host record is gone) it **reports the error explicitly** rather than continuing with a guessed session

### action=get: read back one round's final conclusion

| | |
|---|---|
| Target | `taskId` (handle) or `sessionId` (credential) |
| Data | `session/list` to fix the session's read position `projections.asOfSeq` → `session/page` to take a tail window of records at that cut |
| Rule | **the last assistant output after the last user message** is this round's conclusion (one open/reply = one round); text is truncated to ≤4000 |
| Title | `session/list` also yields the session title |

Cases that are labelled explicitly rather than silently altered: this round has no output yet (falls back to the most recent earlier conclusion) / no user message inside the window / the round was interrupted / **the round ended in an error** (when the model or a tool fails, DSH writes only `attempt` + `turn/end`, so the error reason is surfaced here) / earlier rounds remain unread.

Note: session logs are V3 format, and **the App does not read `session_projcache.json` / `session.jsonl.zstd` itself** (format evolution goes back to upstream); when DSH is not running, list/get are unavailable.

### action=approve: answer a suspended approval

- **approvalId is required** (it comes with the approval notice; one task can have several approvals suspended, answered one by one) — it is the only handle, and the tool resolves the session (the handle path checks ownership); `sessionId` is only passed explicitly for "I intend to cross conversations"
- **outcome**: `allowed-once` (the default, allow this one) / `rejected` (reject)
- **Decide on args (what exactly is about to run), not on reason (the model's own account is not trustworthy)**: allow what is reasonable, reject what is dangerous. The approval request's `label` reads "tool name + the concrete operation + the permission tier requested", and `details` carries `operation` / `escalationMode` / `escalationNote` / `approvalTimeoutMs` from the same source
- **Turn boundary**: approval notices arrive only **at a turn boundary**. After an `open`/`reply` submission you must **end your turn**; only the next turn receives `app-task-approval-requested` (with the `approvalId`). Idling or re-sending within the same turn hits the host tool callback's 30-second limit (`RPC callback.tools.execute timed out after 30000ms`), and that session may wedge from then on (every later `reply` times out and `close` struggles to get a DSH confirmation); start a new session for such a case instead of retrying in place
- An approval that is not answered within `approvalTimeoutSec` is rejected automatically (this App defaults to 30 seconds; setting it explicitly to 0 disables the auto-reject). Note that the host's own `timeoutMs` defaults to 0 (which does not disable, i.e. does not time out) — the 30 seconds is an App-side policy

### Typical usage

- Start work: `open` (new task) or `reply` (continue an existing sub-agent; `get` first to confirm)
- Read back: `get` (the final conclusion)
- Stop the bleeding: `close`; out-of-scope permission: `approve` (yield the turn right after submission — the approval notice only arrives next turn)

`sessionId` is an access credential; `get` reads through the managed runtime's official query surface, does not read session files and does not initiate inference, and is unavailable while DSH is not running.
