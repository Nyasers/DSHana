---
name: dshana-install-skill
description: "Install or upgrade the DSHana App from a GitHub Release, not this manual."
---

# Installing DSHana (execution manual)

## When to use

Someone hands you this repo (or one of its Releases) and asks you to install DSHana, or to upgrade it to a version: follow this manual. **What gets installed is the release package**; this manual is the set of steps for you to read and should not, and need not, be installed into yourself as a skill.

Everything below goes through the host endpoints, which is the channel an agent can execute and which lets you pick the smaller per-platform package. A platform package contains only that machine's dependencies and is far smaller than the universal one (which carries every platform's dependency tree); the index format itself has no platform dimension, so a platform artifact has to be fetched by target.

## The reserved field in the index

Every entry in `index.v2.json` carries one reserved field, `x-dshana-targets`: target name → that target's release package.

| Field | Meaning |
|---|---|
| `url` | The package's absolute https address, directly downloadable |
| `sha256` | The package's SHA-256, 64 lowercase hex digits |
| `size` | The package's size in bytes (positive integer) |
| `format` | Always `"zip"` |

The target name is the segment after `-v<version>` in the artifact name (the universal package has no suffix and is recorded as `universal`). **Take the concrete values from the index you actually hold** — they differ per release, so do not copy any hard-coded numbers.

### The field's schema

```json
{
  "type": "object",
  "description": "target name → that target's release package; the target name is the segment after `-v<version>` in the artifact name (the universal package has no suffix and is recorded as universal)",
  "additionalProperties": {
    "type": "object",
    "required": ["url", "sha256", "size", "format"],
    "properties": {
      "url":    { "type": "string", "pattern": "^https://", "description": "the package's absolute https address" },
      "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$", "description": "64 lowercase hex digits" },
      "size":   { "type": "integer", "minimum": 1, "description": "size in bytes (positive integer)" },
      "format": { "const": "zip" }
    },
    "additionalProperties": false
  }
}
```

These four constraints are exactly the host's validation rules for `archive` (url must be https, sha256 must be 64 lowercase hex digits, size must be a positive integer, format must be `"zip"`); a block shaped by this schema would pass directly if the host ever did adopt this dimension.

Points to note:

- In the host's official format an entry has only one address slot, `archive` (the format version is the index's top-level `schemaVersion`), and the version dimension is flattened onto the entry's `version` field by default; only when a same `kind:id` has an older version does the old one go into `versions[]` (an array, each item carrying `version`, an optional `minAppVersion` and `archive`). DSHana ships one version per release and `versions[]` normally does not appear — read the version from the entry's `version` and do not count on it. The consumer side matches on the version text only and has **no platform dimension**. `x-dshana-targets` is our own reserved field: the host neither reads nor rejects it, which is why fetching a platform artifact means picking it by target yourself.
- The target packages differ in size (universal is the largest); pick by the local platform and only continue once the fetched `size` matches the index record.
- An entry's `archive` (the primary address) by convention always points at **universal**; platform artifacts exist only under `x-dshana-targets`.

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

1. **Find the release, then take its index.** Each release carries one index named `index.v2.json` among its assets. Find the target release first and download the index from it. A new release is normally marked **prerelease**, and `latest` resolves only to a release that is not marked prerelease, so look the release up rather than assuming `latest`:

   ```
   gh release list -R Nyasers/DSHana        # list tags, prereleases included
   gh release download <tag> -R Nyasers/DSHana -p index.v2.json
   ```

   Without gh, the tagged asset URL does the same (a `+` in the tag is written `%2B`):

   ```
   https://github.com/Nyasers/DSHana/releases/download/v<version>/index.v2.json
   ```

   `latest` remains usable when you deliberately want the newest release that is not a prerelease:

   ```
   https://github.com/Nyasers/DSHana/releases/latest/download/index.v2.json
   ```

   Package names carry the version (`dshana-v<version>[-<target>].zip`), so there is no shortcut around the index: fetch it first, then download the package from the address inside it.

2. **Pick the entry and the target.** In `items[]` find the one with `kind=app` and the `id` equal to the target App (DSHana has exactly one item), then take `["x-dshana-targets"][<local target>]`. When that key is absent, fall back to `universal` and say that the universal package is large.

3. **Download and verify.** Download `url`, check that the sha256 matches the index record (case-insensitive) and that the size agrees, then continue.

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
| After uninstall+reinstall, this session reports `RPC peer closed; cannot call callback.tools.execute` for that App's tools | The session engine captured the tool objects of the then-current App instance when it was created, and those objects go stale once the instance is replaced | Open a new session or restart the host; the App itself is fine (routes and runtime are normal) |
| `index.v2.json`'s primary `archive.url` points at some platform package | The build was fed an entry that should not have entered the manifest | By convention the index should only point at universal, see the target selection in `scripts/release/market-index.mts` |
| `latest` resolves to a different version than you expected | `latest` skips prereleases, and a new release is normally marked prerelease | Look the release up itself (`gh release list`) and take the index from its tag |
| `x-dshana-targets` cannot be obtained | That index does not carry this field | Fall back to the primary `archive` (universal), which is functionally identical, only larger |

## This directory is not part of the release package

Packaging assembles from build artifacts (`fs.copySync(distDir, pkgDir)` in `scripts/release/pack/index.mts`), and every directory at the repository root stays outside the package. This manual exists in the repo only for whoever (or whichever agent) reads it, and nothing at runtime depends on it.
