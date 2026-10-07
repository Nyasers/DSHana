---
name: dshana-install-skill
description: "Install or upgrade the DSHana App from a GitHub Release, not this manual."
---

# Installing DSHana (execution manual)

## When to use

Someone hands you this repo (or one of its Releases) and asks you to install DSHana, or to upgrade it to a version: follow this manual. **What gets installed is the release package**; this manual is the set of steps for you to read and should not, and need not, be installed into yourself as a skill.

Everything below goes through the host endpoints, which is the channel an agent can execute, and lets you pick the smaller per-platform package. A platform package contains only that machine's dependencies and is far smaller than the universal one (which carries every platform's dependency tree). The catalogue's entry format has no platform dimension, so a platform artifact is fetched by target straight from the release assets.

## Picking a package from the release assets

A release carries one `.zip` per target, so the package to install is chosen by name:

```
dshana-v<version>-<target>.zip     # the six platform targets
dshana-v<version>.zip              # universal, no target segment
```

The target name is the segment after `-v<version>` in the artifact name; the universal package has no suffix and is recorded as `universal`.

**Take the concrete values from the release you actually hold** — they differ per release, so do not copy any hard-coded numbers. GitHub reports each asset's size and its `sha256` digest, and those are the values the host's `archive` validation expects:

| Field | Source | Constraint |
|---|---|---|
| `url` | `https://github.com/Nyasers/DSHana/releases/download/<tag>/<asset name>` | must be https |
| `sha256` | the asset's `digest`, without the `sha256:` prefix | 64 lowercase hex digits |
| `size` | the asset's `size` | positive integer |
| `format` | always `zip` | — |

These four constraints are exactly the host's validation rules for `archive` (url must be https, sha256 must be 64 lowercase hex digits, size must be a positive integer, format must be `"zip"`).

Points to note:

- The published entry (`app-dshana-<version>.entry.json`) has a single address slot, `archive`, and by convention it always points at **universal**. Platform packages are described nowhere in the entry; they exist only as release assets and are picked by target here.
- The consumer side matches on the version text and has **no platform dimension**, which is why one entry cannot carry several platform addresses.
- The target packages differ in size (universal is the largest); pick by the local platform and only continue once the fetched `size` matches the listing.

## Platform mapping

| Local machine | target |
|---|---|
| Windows x64 | `win32-x64` |
| Windows on ARM | `win32-arm64` |
| macOS Apple Silicon | `darwin-arm64` |
| macOS Intel | `darwin-x64` |
| Linux x86_64 (glibc) | `linux-x64` |
| Linux arm64 (glibc) | `linux-arm64` |
| Anything else, or unsure | `universal` (the universal fallback, largest) |

The release matrix builds these six platform targets plus universal. Another target can still be produced by name in this repo: `pnpm run package --target=<name>`.

## Steps

1. **Find the release, then list its assets.** A new release is normally marked **prerelease**, and `latest` resolves only to a release that is not marked prerelease, so look the release up rather than assuming `latest`:

   ```
   gh release list -R Nyasers/DSHana        # list tags, prereleases included
   gh release view <tag> -R Nyasers/DSHana --json assets \
     --jq '.assets[] | "\(.name)  \(.size)  \(.digest)"'
   ```

   Without gh, the release page lists the same assets, and an asset URL works directly (a `+` in the tag is written `%2B`):

   ```
   https://github.com/Nyasers/DSHana/releases/download/v<version>/dshana-v<version>-<target>.zip
   ```

   `latest` remains usable when you deliberately want the newest release that is not a prerelease:

   ```
   https://github.com/Nyasers/DSHana/releases/latest/download/dshana-v<version>.zip
   ```

   Package names carry the version (`dshana-v<version>[-<target>].zip`). The asset listing is the authority for both the size and the sha256 — read them from there rather than assuming any URL scheme will produce them.

2. **Pick the target.** Map the local machine to a target, then take the asset named `dshana-v<version>-<target>.zip`. When that asset is absent, fall back to `dshana-v<version>.zip` (universal) and say that the universal package is large.

3. **Download and verify.** Download the asset, check that its sha256 matches the `digest` the listing reported (case-insensitive) and that the size agrees, then continue.

4. **Uninstall the old version first.** Over-installing the same id is not supported and this step cannot be skipped:

   ```
   DELETE <host>/api/extensions/app:<id>
   ```

5. **Install (submit staging)**:

   ```
   POST <host>/api/extensions/install
   { "kind": "app", "source": { "type": "local", "path": "<absolute path to the zip>" } }
   ```

   It returns `awaiting_confirmation` and a `stagedId`.

6. **Confirm**:

   ```
   POST <host>/api/extensions/staged/<stagedId>/confirm
   ```

   It returns `{"status":"installed", ...}`; `record.approval` holds the capability list granted this time. This step completes over the token channel and the host records the approval as a **user decision** (`approval.decidedBy.kind` is `user`), with no interactive confirmation in between — so verify the package and its origin yourself before confirming.

7. **Verify.** `GET <host>/api/extensions` to see the extension's `record.version`; then poll the App's own boot-state route (for DSHana it is `/api/apps/dshana/routes/dshana/boot-state`). The first start after a fresh install takes a while, so do not demand immediate readiness: only `state.phase === "ready"` together with `state.ready === true` counts as success; treat `error` / `stopped` as failure and diagnose from `state.error` and the runtime log.

## How to reach the host endpoints

- Port and token: read `<HANA_HOME>/server-info.json` (`HANA_HOME` defaults to `~/.hanako`).
- Authentication: `Authorization: Bearer <token>`.
- Why prefer these HTTP endpoints: they are the same channel the UI uses, whereas the `extension_manager` tool's kind-level actions (install / list and so on) may be rejected by capability validation (confirm / discard take no kind and are unaffected).

## Known traps

| Symptom | Cause | Handling |
|---|---|---|
| After uninstall+reinstall, this session reports `RPC peer closed; cannot call callback.tools.execute` for that App's tools | The session engine captured the tool objects of the then-current App instance when it was created, and those objects go stale once the instance is replaced | **Compact that session's context**: the tool surface is re-resolved against the host's current registry, so the replacement instance's tools take over. Opening a new session does the same. No host restart is needed; the App itself is fine (routes and runtime are normal) |
| The digest you read does not match the downloaded package | The download was truncated or redirected to something else | Re-download and compare both the size and the digest; the listing's `size` catches truncation before the hash does |
| `latest` resolves to a different version than you expected | `latest` skips prereleases, and a new release is normally marked prerelease | Look the release up itself (`gh release list`) and take its assets from that tag |
| No asset matches the local target | The matrix built six platform targets plus universal; some other target has to be built by name in the repo | Fall back to `dshana-v<version>.zip` (universal), which is functionally identical, only larger |

## This directory is not part of the release package

Packaging assembles from build artifacts (`fs.copySync(distDir, pkgDir)` in `scripts/release/pack/index.mts`), and every directory at the repository root stays outside the package. This manual exists in the repo only for whoever (or whichever agent) reads it, and nothing at runtime depends on it.
