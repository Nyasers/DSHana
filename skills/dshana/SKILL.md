---
name: dshana
description: "DSHana: DeepSeek Harness as a managed sub-agent in Hana. Read before any dshana call, or for DSH troubleshooting."
---

# dshana: usage, troubleshooting and tool manual

## When to use this skill

Read it before acting on anything dshana related. In particular:

- Before calling `dshana` with any action (`open` / `reply` / `close` / `get` / `approve`).
- Submitting, checking or cancelling a DSH task.
- The DSHana card shows not-started / starting / needs-attention (the three-state bootstrap page).
- DSH will not start, or startup times out.
- A DSH task failed and needs diagnosing.
- Configuring the default model.
- The DSH Web UI will not open.
- The theme does not follow the host.
- Any other DeepSeek Harness work.

DSHana wires DeepSeek Harness (DSH) into Hana as a **managed sub-agent executor**: once the App loads it automatically starts a managed Node runtime that runs the DSH web service; the DSH frontend is mounted into the DSHana card by **same-document injection** (not an iframe embed). DSH and its dependency tree are materialized inside the App package, so **nothing needs to be installed at runtime**.

## Architecture in one line

`apply(ctx)` registers tools and routes → a microtask triggers `ctx.runtime.start` to bring up the managed runtime → the shell page polls boot state → once ready it fetches the DSH index and injects it into the current page. Between DSH and the host: commands go over the runtime control plane (`/_control` + loopback HTTP RPC), model inference goes through the host's `ctx.models`, and credentials never enter the DSH process.

## First install (no configuration needed)

- **No dependencies, no Node setup**: DSH and its dependency tree ship inside the install directory's `node_modules`, and our sub-plugins land there too (`node_modules/@dshana`); startup only performs the DSH boot and service listening, and writes nothing into the data directory.
- **No API key, no model setup**: inference is initiated from `hana.models` inside the managed runtime, and provider credentials stay in the host. The two LLM adapter rows DSH ships with (`llm-deepseek` / `llm-pi-ai`) are disabled in our composition-layer patch, so the llm routes are only the ones in the host catalog (those two rows want keys from the credential store, and the credentials are held by the host; left alone they would only advertise routes that report `no API key` the moment one is selected). The 「模型」 ("Models") page in settings is disabled along with them (it only edits those two rows' settings block, so with them disabled there is nothing to edit and only an empty shell remains). A session's model follows whoever opened it: a tool-created session opens with **the model configured on the calling agent card** (`models.chat` of `agents/<id>/config.yaml`, read through `agent:list` / `agent:config`, see `app/agents.read`); the App settings page's 「会话模型」 ("Session model") can be switched to 「自定义模型」 ("Custom model") to pin one entry (`sessionModelProvider` / `sessionModelModel`, plus `sessionModelReasoningEffort` for a reasoning effort that model supports; the default is 「复用调用方」, "reuse the caller"). DSH's own default-model slot (`agent-default-model`) is not handled by that page: if you set it by hand and that entry is no longer in the host catalog, it is reconciled in place to a serviceable one (preferring another entry in the same provider, then falling back to the agent-card model, then the catalog's first entry; the log records a 「默认模型对账」, "default-model reconciliation", entry — see `packages/models/src/model-default-guard.ts`).
- **One session card, two mount states**: both `open` and `reply` receipts carry a `details.card` (distinguished by `act=` on the route, always titled `DSHana`), served from `ui/stream.html`. In the chat stream it draws only an entry row (the small heading for `act`, plus a three-line coordinate block: directory / session / task); it does not inject DSH and carries no ticket, so it neither stacks nor freezes. When the user **takes the card out** (the chat card's top-right menu / dragging — a host gesture that does not go through App code) onto the blackboard or into a detached window, the host mounts the same route on the new mount, and only then does the page assemble the relay and inject the full DSH scene. The App does not declare a manifest card for it and does not call `hana.cards.open` — the card center takes no slot, session history belongs to DSH's own sidebar (open the DSH UI to browse it), and the App keeps no separate list. How a page recognizes its mount state: the chat-stream card's `hana.envelope` height is `flexible`, blackboard / detached is `fixed` (see `packages/ui/src/stream-entry.ts`). The chat-stream state pulls in only the light half (`stream.html`'s inline script writes the coordinates on the first frame and `stream-entry.ts` recognizes the state, putting this session's tracking state on the small-heading row with details on hover); only the blackboard / detached state dynamically `import()`s the heavy chunk (`stream-stage.tsx`: React three states + DSH injection + theme), and that face carries no App status rows. The task chip at the bottom of the conversation is still derived by the host (`chipVisibility: "show"`, declared explicitly).
- **The session card carries a sid**: when a card route has `?sid=<DSH session id>` it pins that session; a card without `sid` (for example one taken out of an entry row and then hand-edited) follows the current selection shared across faces. Session history belongs to DSH's own sidebar (open the DSH UI to browse it), and the App keeps no separate list.
- **Default model**: DSH's own `agent-default-model` (`DSH_HOME/settings.yaml`) — when the user layer is empty it falls back to the official route in the base layer. A session opened directly in the UI picks one entry in DSH's own model selector, whose candidates come from the host catalog; the App settings page only lists candidates for 「会话模型」 ("Session model") and does not touch this slot.
- **Directory picker**: DSH's workspace chooser dialog is provided by the `directory-picker` seam, and `directory-picker-auto` in the composition layer (derived from the official web-app) picks the native one on win32 + loopback. The native client half first reads `__DSH_DIRECTORY_PICKER__` from the page (the official desktop shell injects it from preload and pops an Electron dialog); with no bridge it calls the host process's OS chooser — the latter spawns a child process inside the host process to run `IFileOpenDialog` (koffi over COM, synthesizing an Alt first to steal foreground), and upstream states it only suits "the operator sitting in front of the host screen", whereas the managed runtime in this form is a background subprocess inside a sandbox and cannot open one at all. The shell page installs the bridge before injecting the DSH index (`installDirectoryPickerBridge` in `packages/ui/src/dsh-inject.ts`), so the dialog is raised by the host instead: `hana.resources.pick` with `mode=directory`. What the user sees is a system dialog on their own machine, and the picker does not go through the sandbox.
- **Data directory**: fixed to an App-private directory (`.dsh` under the App data directory), ready out of the box; sharing an existing directory or switching data sources is not offered.
- Every `dshana(action="open")` call **must pass `cwd` explicitly**, and it must be an **existing absolute directory** (validated before submission, in two stages: relative paths are rejected outright on the App side; "exists / is a directory" is decided by the managed runtime's control-plane action `cwd-check` — the App host half's `node:fs` only covers the App's own directory, and using it to stat a user path would always fail, indistinguishably from "the directory does not exist"). Once a session is created the cwd is the recorded value, and every later spawn (commands, terminal) starts from it — do not use a throwaway scratch directory as a session root. This existence check is **best effort**: if the control-plane query itself fails it only logs and lets the call through (a single control-plane wobble must not reject a valid cwd); in that case an invalid cwd reaches session creation, where the provider-level working-directory guard catches it at spawn time.

## Updating DSHana

Updating means **installing a new App package and reloading the App**; there is no separate upgrade channel. The DSH version is fixed by the dependency the App declares (`@deepseek-ai/dsh`) and shows up in the artifact's version segment.

1. **Pick the package for this machine.** A release carries one `.zip` per target (`dshana-v<version>-<target>.zip`) plus `dshana-v<version>.zip` for universal. Take the platform one, which is far smaller: it carries only that machine's dependency tree. The full target table and the exact commands live in `dshana-install-skill/SKILL.md` in the repository — that manual is deliberately not shipped inside the package, so read it from the repo.
2. **Verify against the release's own metadata.** GitHub reports each asset's `size` and `sha256` `digest`; compare both before installing. Nothing else publishes those values for the platform packages.
3. **Uninstall the old version first.** Over-installing the same id is not supported, so the uninstall call (`DELETE <host>/api/extensions/app:dshana`) comes before the install submission.
4. **Install and reload.** Submit the package, confirm the staged install, then reload the App so the server entry is re-imported and tools and routes are re-registered. The managed runtime restarts through the automatic chain; no host restart is needed.
5. **Re-check readiness.** Poll the App's boot-state route until `state.phase === "ready"` and `state.ready === true`. A first start after an install takes a while.

One caveat that bites after any update: **already-established sessions** hold the tool objects resolved when their session state was last rebuilt, so continuing to call tools in such a session needs a **context compaction** (or a new session) — the tool surface is re-resolved against the host's current registry.

## DSHana card: the three states

The shell page polls `GET /api/apps/dshana/routes/dshana/boot-state` and renders by `phase`:

| State | What you see | What to do |
|---|---|---|
| Not started (`idle`) | Only one line on the surface: 「DSH 未启动」 ("DSH not started") | Opening this card issues one more start request; you can also wait for the automatic chain |
| Starting (`starting`) | A thin ring plus 「正在启动 DSH…」 ("starting DSH…") | Just wait (the first one includes the DSH boot) |
| Ready (`ready`) | The page loads the DSH Web UI | Use it |
| Needs attention (`error` / `stopped`) | A status line plus a `<pre>` block (code / message / note / runtimeId / port) | Read the `<pre>` to locate the fault; the automatic chain retries with backoff and switches ports when one is occupied |

**Where state is read from**: `boot-state` (used by both the shell page and the agent; carries phase/error/userText). The App side writes no file logs — logs always go through the host's `ctx.logger`, and managed-subprocess output is captured by the host run log.

## Tool manual: `dshana(action, …)`

The host agent side has **exactly this one tool** (one plugin, one same-named tool, actions distinguished by the top-level `action`). Assembly is `packages/tools/src/index.ts`, each action is `packages/tools/src/actions/<action>.ts`, and each file is one same-named operation.

Semantics mirror subagent: `open` ≈ `subagent` (created with a task already attached), `reply` ≈ `subagent_reply` (continue the same one by handle), `close` ≈ `subagent_close` (wrap up); `get` and `approve` are specific to this project (subagent has no equivalent).

Inference is initiated from `hana.models` inside the managed runtime, spending host provider quota, and provider credentials stay in the host.

### Parameter contract

The top-level `action` is required, and each subcommand accepts only its own fields (`oneOf` branches + `additionalProperties: false`, so `open`'s schema has no `approvalId`).

| action | Required | Optional | Semantics |
|---|---|---|---|
| `open` | task, cwd | label, timeout, agentPreset, reasoningEffort, provider, model | Start a DSH sub-agent and hand it a first task (new session + immediately submit the first prompt) |
| `reply` | task | taskId or sessionId (exactly one), timeout, reasoningEffort, provider, model | Send a follow-up message to the same sub-agent |
| `close` | none | taskId or sessionId (at least one) | Cancel the task that is running |
| `get` | none | taskId or sessionId (at least one) | Read back the final conclusion of the session's most recent round |
| `approve` | approvalId | outcome, taskId or sessionId | Answer a suspended approval |

> To inspect tasks, use the host's built-in task-query tool for the agent (on the model side that is `check_pending_tasks` in this environment): `dshana`'s open/reply create background tasks of this very session, so they already appear in that list; this tool deliberately does not open a second, read-only door for listing.

**Shared fields**: `timeout` is in seconds (App default `defaultTimeoutSec`), and `label` is a display name shown in the host task list and result notifications. `agentPreset` and `reasoningEffort` are pass-through values whose vocabulary this App does not fix. Accepted preset names are DSH's own (empty leaves it to DSH, and `code` is accepted as an alias of `ptc`), and **the preset belongs to `open` alone**: DSH pins it to the session, rejects a differing value on resume as `agent-preset/conflict`, and locks it outright once a turn has started, so `reply` takes no `agentPreset` (`provider` / `model` / `reasoningEffort`, by contrast, can be changed on every `reply`). Accepted effort levels are the **host's**: the model is the host's, the host validates the level against that model's thinking levels, and an empty value leaves it to DSH. (`supportedEfforts` in `packages/dsh/provider/lib/catalog.ts` intersects the host catalog item's declared levels with the canonical effort vocabulary.)

**Choosing the model** (`open` / `reply`): pass `provider` + `model` together to override for this request; passing `reasoningEffort` alone fills the model in from the DSH default; passing none of the three uses the model configured on the calling agent card (`open`) or keeps the session's own choice (`reply`). `provider` / `model` never change DSH's global default.

**Handles and credentials**: `taskId` (returned by open/reply) and `approvalId` are the **handle path** — the tool resolves the session itself and checks ownership against the source session recorded by the host; `sessionId` (of the form `session-<uuid>`) is the **credential path** — passing it explicitly means "I intend to operate across conversations", which skips the ownership check.

### action=open: start a sub-agent with a first task

- **task + cwd are required**; passing `sessionId` is not allowed (use `reply` to continue a session)
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

## After changing source (the development loop)

All three tools live in the repo; do not hand-roll temporary scripts:

| What you want | Command |
|---|---|
| Install a local package into the host (uninstall → submit staging → confirm → wait for ready; cross-platform) | `pnpm run install:local -- --zip releases/<package>.zip` |
| Inspect the **installed** tree (preflight: dependencies in place + DSH located + artifacts present) | `pnpm run smoke:packed -- --preflight` |
| The same without `--preflight`: a full boot through to a relay answer | `pnpm run smoke:packed` |
| Inspect the host capability surface: which bus verbs an App may call, which event names it may not (the published SDK contract); where a literal appears in the host bundle | `pnpm run probe:host [-- --look models-changed]` |

Run `smoke:packed` after upgrading DSH or reinstalling a package: passing in the repo tree does not mean passing in the installed tree (the 0.1.6 profile-boot was the one that only failed in the installed tree — hashed artifacts were compressed and every export name was gone).

## Theme

Host colours are followed only while the DSH theme preference is **system** (injected through the `@dshana/dsh-theme` sub-plugin); when light/dark is chosen explicitly inside DSH, DSH's own theme is used entirely and host colours do not intervene. The label for this option in Appearance is **「跟随宿主」** ("follow the host") — upstream's original wording is 「跟随系统」 ("follow the system"); the preference value is still `system`, only the wording was changed to match our form. See the overlay in `integrations/ui-theme`.

## Troubleshooting

| Symptom | Cause | Handling |
|---|---|---|
| Stuck on 「启动中」 ("starting") for a long time | The first boot is slow (plugin placement plus service listening) | Just wait; if it never moves, check the host log and `error.userText` (the boot snapshot does not carry the log tail) |
| State flips to 「需要处理」 ("needs attention") | The runtime failed to start | Read `error.userText` and the original error; locate it via logs |
| Told the port is occupied | Port contention | It switches to a random port and retries automatically; check logs if it keeps failing |
| The DSH Web UI will not open although the state is ready | Injection failed / the surface ticket is missing | Reopen the card; if it recurs, check the relay prefix and the surface authorization |
| `dshana` reports the runtime is not ready | DSH has not come up yet | Just wait for ready (the tool's first call starts it again); check boot state and the host log if it keeps failing |
| Host providers/models changed but DSH's candidates did not | On the DSH side the provider routes and model catalog are a startup snapshot | The normal path is a re-pull triggered over the control plane by the `models-changed` subscription (no runtime restart); restart the runtime when the subscription surface is unavailable |
| A model reports `no API key for provider route "deepseek-official"` | The official LLM adapter is still serving that route (it cannot get a key in this form), which means the composition-layer package did not land or was edited | Confirm that `llm-deepseek` / `llm-pi-ai` are `disabled: true` in `node_modules/@dshana/dsh-app/cordis.patch.yml` of the installed tree, then restart DSH |
| The default model points at a provider/model the host does not have configured (the one you set by hand disappeared) | The host switched providers or deleted credentials | No manual edit: after the runtime becomes ready and after host model changes, the App reconciles to a serviceable entry in the host catalog (the log has 「默认模型对账」, "default-model reconciliation"); this slot is now maintained only by DSH itself and by reconciliation, and the App settings page has no entry for it |
| A session opened directly in the UI reports `no API key for provider route "deepseek-official"` | `agent-default-model`'s user layer is empty, so the value falls back to that official route in the base layer (tool-created sessions are unaffected: they open by the calling agent card) | Pick a serviceable entry in DSH's own model selector (session-scoped; the App settings page has no entry for the default model) |
| The theme does not follow the host | The DSH theme preference is light/dark rather than system | Choose 「跟随宿主」 ("follow the host") in DSH Appearance (the preference value is system) |
| The 「模型」 ("Models") page is missing from DSH settings | That page (`ui-settings-models`) is disabled together with the two official LLM adapters — it only edits those two rows' settings block | Not a fault: configure the model used by tool-created sessions on the App settings page's 「会话模型」 ("Session model"), whose candidates come from the host catalog; choose the model for DSH-side sessions in DSH's own model selector |
| Picking a workspace directory raises an error | The directory dialog landed on the DSH host process's OS chooser (which has to spawn a subprocess inside the sandbox to open `IFileOpenDialog`), whereas the runtime in this form is a background subprocess | The normal path should never get there: the directory bridge injected by the shell page makes the host raise the dialog (`hana.resources.pick`). If it still errors, confirm the bridge is installed (`__DSH_DIRECTORY_PICKER__`) and that the host granted resource picking |
| No `bash` tool in command execution | Shell rows are mounted mutually exclusively by platform: on win32 `bash` / `bash-sandbox` are stopped and only `pwsh` / `pwsh-sandbox` are mounted | Run commands with the `pwsh` tool (PowerShell); file reads and writes still go through the filesystem tools |
| `reply` times out for 30 seconds in a row (`RPC callback.tools.execute`) / every later submission to that session fails | The previous round's approval was never answered at a turn boundary, the host tool callback timed out, and the session is wedged | Do not retry in place: start a new session (`open`); converge the old one with `close` (the receipt only says cancellation was requested, and the escalation mark settles with the background task) |
| The `close` receipt only says "cancellation requested" | Normal semantics: cancel confirmation does not enter the tool callback (it settles in the background), and the escalation mark settles with the background task | Nothing to do; to confirm the outcome use `get` or the task notification |
| A page in a window (or card) sits on 「历史加载失败」 ("history failed to load") / `gateway/internal` | The managed runtime that page was bound to was rebuilt and the relay prefix is stale, or the surface credential is missing | Reopen the window; if it recurs, check boot state and the host log |

## Known limitations

- **The shell page has no "start / restart DSH" entry**: the surface only reports state. Bringing it up is the job of the automatic chain after `apply`, the tool's first call, and the extra request issued when the card page is opened; failures retry with backoff (starting at 5s, capped at 5min). A real restart means uninstall+reinstall, reloading the App or restarting the host.
- **Detaching a window, pinning it back, or switching pages never stops DSH in the background**: only uninstalling/reloading the App or quitting Hana makes the host collect the managed runtime.
- **The data source is fixed to an App-private directory** (`<dataDir>/.dsh`, i.e. `DSH_HOME` in this form); the user's home `~/.dsh` is not touched, and sharing an existing DSH directory / switching data sources is not enabled (`POST /dshana/settings/restart` answers 503).
- **The session↔task binding is not written to App files**: the source of truth is the host task record (`sessionId` / `rpcId` / `timeoutSec` / `approvalTimeoutMs` / `cancel` under `metadata.dsh`), and a failed read fails closed. While DSH is not running, `list` / `get` are unavailable.
- **Out-of-scope permission defaults to approval, and can only be answered in a new turn**: after an `open` / `reply` submission you must end the turn, and the approval notice (carrying the `approvalId`) arrives only next turn; idling inside the same turn hits the host tool callback's 30-second limit and may wedge the session. An approval nobody answers within `approvalTimeoutSec` is rejected automatically (30 seconds by default; setting 0 disables it). A session opened directly in the DSH Web UI has no delegated task, so its approval requests have no responder and are handled fail-closed.
- **A session stream does not close when its task ends**: a session pinned by `?sid=` stays readable after the terminal state (historical sessions are exactly what the user opens to browse). The relay side has no "is the task active" gate.
- **Models take two paths**: tool-created sessions open with the model configured on the calling agent card (the App settings page can pin one custom entry instead); sessions opened directly in the DSH Web UI use the entry chosen in DSH's own model selector, whose candidates come only from the host catalog and are a startup snapshot — after the host changes providers, the `models-changed` subscription triggers a re-pull, and only an unavailable subscription surface requires a runtime restart.
