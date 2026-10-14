# dshana — choosing a preset for delegated work

Read this before passing `agentPreset` to `open`, or when deciding what a delegated session should be able to do. It describes the two presets this App ships (`dshana` / `dshana-ptc`), what each keeps from DSH's own `standard` preset, and what it deliberately drops.

## The roster is open

**These two are not the whole set, and this file does not enumerate it.** A preset is an ordinary `@deepseek-ai/dsh-agent-preset` declaration carried by any installed bundle's patch, so the roster is whatever the profile's bundles declare:

- DSH's own four — `standard`, `ptc`, `minimal`, `cordis`;
- the two this App ships — `dshana`, `dshana-ptc`;
- **any preset a user's installed bundle contributes.** Bundles installed from the Plugins page (or added to the profile by hand) can insert their own `preset-<id>` rows, and those names are as valid here as the shipped ones.

The roster is the set of accepted names: `agentPreset` goes to DSH, which resolves it against that live roster. A name that is not on it fails at submission with `agent-preset/not-found Unknown agent preset: <id>` — **and that error names only the id you passed, not the available ones**, so it cannot be used to discover the set. Read the roster where it is displayed (DSH's own settings carry an agent-preset section listing every declared preset, including activation failures), or ask this App for it with `action=presets`; prefer the shipped names above when you have no reason to pick something else.

## What the two shipped presets are for

A session opened through `dshana` has **no human in front of it**: no parent conversation, no interactive surface, and a reader that is the delegating agent rather than a person. These two presets are the shipped answer to that shape, and the test for whether a row belongs here is "who would answer it", not "is it useful".

They are ordinary DSH agent presets — declarable rows under `presets/` in the composition layer, registered by `@deepseek-ai/dsh-agent-preset`. Nothing about the `dshana` tool changes when one is selected; the preset only decides the session's capability set and its persona.

## Picking one

| Preset | Display name | Tool surface | Choose it when |
|---|---|---|---|
| `dshana` | 标准特调 | the tools themselves | the task is short, or you want the model calling tools directly |
| `dshana-ptc` | PTC 特调 | `run_code` plus a generated SDK | the work is file-heavy and multi-step: one program reaches several tools without a model round trip each |
| `standard` / `ptc` | (DSH's own) | full capability set, shell included | the task needs a shell, or any capability these two drop — see below |

`dshana-ptc` differs from `dshana` by exactly one row (`tool-presentation` with `mode: ptc`). Both carry the same tool list and the same persona; only the form the model sees changes.

The id a preset pins is its `config.id` (`dshana` / `dshana-ptc`), not the row id.

## What both presets keep

Persona, `agent-instructions` (`maxBytes` 65536), `tool-fs`, `tool-fs-search` (`sampleOverCapGlobResults: false`), `tool-todo` (`allowParallelInProgress: true`), `present`, and the compaction group (`compaction-basic` / `command-compact` / `tool-result-pruner` at `thresholdChars` 8192, `headChars` 4096, `tailChars` 1024).

## What they drop, and why

Two different reasons; do not read them as one.

**Rows that would wait for a human.** `tool-ask-user` asks a person; `plan-mode` presents a plan for review through `exit_plan_mode`; `command-goal` / `tool-goal` drive a session-level GoalBar. With no human present these turn a prompt into a hang — the session waits for an answer that cannot come. This subtraction is structural: it follows from what a delegated session is, and it holds wherever the App runs.

**Rows that need the confined shell.** `tool-bash` / `tool-pwsh` are absent, and `tool-jobs` with them (its producers are the shell tools). On Windows a shell call runs through `ctx.sandbox.confine()`, whose confined-token runner cannot write the workspace on every host; a call that touches files therefore fails, and the model's next move is to request sandbox escalation — which asks the delegating agent for approval at a turn boundary. That exchange is the friction these presets exist to avoid. Treat this subtraction as a property of the current form rather than of the shape it serves: a session that genuinely needs a shell is better served by one of the shipped presets, with the delegating session handling the command itself.

Also absent, for the same no-human test: the whole `delegation` group (a delegated session does not delegate further, and the subagent registry is a host-plane singleton), `tool-web`, `skill-filesystem` / `tool-skill`, and `tool-plugin-manager`.

## The persona

Both presets carry one persona, and it says only what the tool catalog cannot:

- the prefix states the identity (`a file-scoped agent`), nothing about which tools exist;
- the suffix tells the session who reads its reply — the delegating agent, which does not see the transcript, tool output, or reasoning — and asks for a self-contained answer that leads with the outcome and keeps the facts the reader needs to act on (paths, exact error text, counts).

Deliberately **not** in the persona: statements that a shell is unavailable, or that an out-of-workspace write needs approval. The tool catalog already carries both — `tool-*` prompt sections describe each tool, the escalation fields appear in the schemas that support them, and `tool-presentation` adds its own `run_code`-only statement under a PTC mode. A persona restating them would be a second copy of a fact the tools own, and would go stale the moment a preset's rows change.

## What a delegated session cannot do

- **No shell.** A task needing a build, a test run, or any command the model cannot express as file work comes back as an explicit limitation in the reply. That is the intended outcome, not a failure: the delegating session runs the command.
- **Writes outside the session cwd are denied** by the file sandbox. `tool-fs` may offer a one-shot escalation (`sandbox_permissions` + `justification`), which reaches the delegating agent as an approval.
- **Under `dshana-ptc`, programs reach files through the generated SDK bindings**, not raw `node:fs`: the PTC runtime confines the child process, so a direct filesystem write from inside the program is denied even inside the workspace. The SDK's tool bindings are the supported path.
