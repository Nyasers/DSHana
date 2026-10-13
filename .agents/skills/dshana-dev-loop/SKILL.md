---
name: dshana-dev-loop
description: "How to change the DSHana App's own source and verify it: the repo's build/test/package/install commands, and which files are generated (edit the source, not the output). Read before editing code in the DSHana repository, or when a change needs to be installed and verified on the real machine."
---

# DSHana — the development loop

This manual is for **working on this repository**. It is not shipped inside the App package: the manual for *using* the tool is `skills/dshana/SKILL.md` (which ships), and the manual for *installing* a release is `dshana-install-skill/SKILL.md` (which also ships in the repo but not in the package).

Everything here runs from the repository root.

## Tools (do not hand-roll temporary scripts)

| What you want | Command |
|---|---|
| Install a local package into the host (uninstall → submit staging → confirm → wait for ready; cross-platform) | `pnpm run install:local -- --zip releases/<package>.zip` |
| Inspect the **installed** tree (preflight: dependencies in place + DSH located + artifacts present) | `pnpm run smoke:packed -- --preflight` |
| The same without `--preflight`: a full boot through to a relay answer | `pnpm run smoke:packed` |
| Inspect the host capability surface: which bus verbs an App may call, which event names it may not (the published SDK contract); where a literal appears in the host bundle | `pnpm run probe:host [-- --look models-changed]` |

The verification chain that matters, in order: `check:type` → `node --test tests/` → `derive:check` → `package:<target>` → `install:local` → `smoke:packed`. Passing in the repo tree does not mean passing in the installed tree — the 0.1.6 profile-boot was the one that only failed in the installed tree (hashed artifacts were compressed and every export name was gone). Run `smoke:packed` after upgrading DSH or reinstalling a package.

## Generated files

Some files are generated; edit the source, not the output.

- `skills/dshana/references/parameters.md` — the tool's parameter reference, from the zod definition in `packages/tools/src/`. Regenerate with `node scripts/derive/index.mts skill-params`.
- `THIRD_PARTY_NOTICES.md`, `packages/app/src/manifest.json`, `packages/dsh/*/package.json`, `integrations/tsconfig.paths.json` — all derived; see the task table at the top of `scripts/derive/index.mts` for each one's source.

The `derive:check` gate fails on drift, and `prepackage` runs `derive` before `build`, so a package never ships a stale generated file. `NOTICE` is **not** derived: it is our own licence statement and is hand-maintained (only the repo URL in it can drift).

## Two surfaces, two readers

- `skills/dshana/` is **shipped** (copied into the package by `build:app`) and read by an agent that *calls* the tool. Its content must be about using `dshana`, not about changing it.
- `.agents/skills/` is **repo-only** (never copied into the package) and read by a collaborator working on the source. This manual lives here.

Keeping the split honest matters: content that only a collaborator needs must not spend the calling agent's context on every trigger, and content a caller needs must not end up somewhere the package does not carry.
