---
name: dshana-market
description: "How to enroll a DSHana release in the official Hana market: which branch to push, how the enrollment PR title and body are derived, what has to be written by hand, and where the two catalog files get edited. Read when a release is being published to the catalog, or whenever an enrollment PR has to be opened or brought up to a newer version."
---

# DSHana — market enrollment

How this repository submits to the official catalog (`liliMozi/hana-marketplace`). The catalog's own rules live in its `CONTRIBUTING.md`; this page is only the repository-side procedure.

## Three separate acts

1. **Version bump** — its own PR. `pnpm version` moves the version and the derived files; it carries no feature work. Keeping it separate is what makes "this tag is version N" and "this tag contains change X" independently reviewable.
2. **Release** — pushing the tag runs CI, which leaves a **pre-release**. That is the default output and it says nothing about the market. `publish` only removes the draft; the pre-release flag stays.
3. **Publishing to the market** — an explicit act, never implied by the two above. Only a Release that is actually going to the catalog has to drop the pre-release flag:

```bash
gh release edit <tag> --repo Nyasers/DSHana --prerelease=false --latest
```

Until that command runs, the tag stays a pre-release and the market cannot see it. That is the intended default: most releases are not published to the catalog, and the pre-release flag is the honest way to say so.

The market never picks the latest Release; it fetches the tag recorded in `approvals.json`. Shipping early and enrolling late therefore cannot cross versions — but an unenrolled version is simply not listed, and nothing will tell you it is missing.

The enrolled identity (`kind`, `id`, `repository`, `publisher`, upstream repo) lives in `market/enrollment.json` and is what the scripts below read; it is not duplicated here.

## Order of operations

Promotion is what makes the version visible to the market, so it comes **before** the enrollment PR, not after it. The order is fixed:

1. Bump PR merged as a merge commit (the `version` hook writes the commit; tagging is not its job).
2. Tag that merge commit and push the tag alone.
3. The Release workflow leaves a draft pre-release; `publish` un-drafts it and keeps the pre-release flag.
4. Install and verify on a real machine before the catalog can see the version: `pnpm run install:local -- --zip releases/<asset>` then `pnpm run smoke:packed` (what those two prove is in `dshana-dev-loop`).
5. Promote: `gh release edit <tag> --repo Nyasers/DSHana --prerelease=false --latest`.
6. Only now open or refresh the enrollment PR, and wait for its `validate-pr` to pass.

Step 4 uses the asset for the machine being tested (`-win32-x64.zip` on the author's box); the entry records the **universal** package from the same Release, and its `sha256` is copied from that package's entry, never recomputed from the platform asset.

## When to enroll

| Act | Trigger | Catalog files touched |
| --- | --- | --- |
| First enrollment | the extension enters the catalog for the first time | `registry.json` (add) + `approvals.json` (add) |
| Version update | a Release you have decided to publish is stable | `approvals.json` (`tag` + `sha256`) |
| Introduction only | the store blurb changes | `approvals.json` (`readme`), no Release needed |

One hard precondition, and it is act 3 above: the Release must be **neither draft nor prerelease**. The enrollment command refuses to run against a pre-release and prints the promote command, so the decision cannot be skipped by accident — it is made in a terminal, by someone, on purpose.

## Branch

```
version update    update/<kind>/<id>
first enrollment  enroll/<kind>/<id>
```

For this repo: `update/app/dshana`, `enroll/app/dshana`.

**No version in the branch name.** One extension should have at most one enrollment PR in flight. Raising the version again means another commit on the same branch and a normal push; the PR refreshes in place and its title/body are rewritten. A versioned branch name forces a new branch, a new PR and closing the previous one every time, which leaves the catalog with a trail of dead PRs and splits the review record. Never force-push: appended commits keep the "what changed since the last version" trail that reviewers rely on.

If a new version ships while a first-enrollment PR is still open, keep working on `enroll/<kind>/<id>`; do not open an `update/` branch on the side.

Branch from upstream `main`, one extension per PR.

## Title, body, branch name: derive, don't hand-write

```bash
pnpm run market:pr -- --out .tmp/market-pr
# .tmp/market-pr/title.txt / body.md / branch.txt
```

Facts come from places the reviewer can check:

- **Title** `chore: approve <kind>/<id> <previous tag> -> <new tag>`, no range on first enrollment. Both ends are full tags, `+dsh-…` segment included.
- **Baseline is always the version currently enrolled in the market**, read from upstream `approvals.json` — never the tag this PR carried before. When the PR in flight is raised to a newer version, re-run the script and overwrite the title and body; editing the left end by hand drops the intermediate versions and makes the enrollment chain disagree with the market.
- **Changelog section** spans the market's enrolled version to the repository Latest (the market rejects prereleases, so Latest is always the promoted version). The script merges every skipped version into one section.
- **Changes section** is written by hand (`--changes` / `--changes-file`). It carries judgement, not a fact list: permission surface deltas, `minAppVersion` jumps, bundled kernel or dependency changes.

Three sections the script cannot produce. Missing any of them means the submission is incomplete:

| Section | Content | When |
| --- | --- | --- |
| Icon and card face | embed the actual `icon.webp` / `face.webp`, raw links pinned to the **commit sha** the tag points at (a `+` in a tag must be escaped in URLs, a sha need not) | first enrollment; afterwards only when the assets changed |
| Author test report | Hana version, OS and version, the exact asset tested with its SHA-256, steps and results, untested parts | every time, updates included |
| Permissions and external services | declared capabilities, why they are needed, external services reached; write "no new permissions" when unchanged | every time |

The test report is the author's statement, not an independent verification. State untested platforms honestly.

## What to edit

Two lines in two upstream files; copy values, never compute them:

```jsonc
// registry.json — first enrollment, or when repository/publisher changes
{ "kind": "app", "id": "dshana", "repository": "Nyasers/DSHana", "publisher": "Nyasers" }

// approvals.json — every version update; readme is optional
{ "kind": "app", "id": "dshana", "tag": "v1.3.1+dsh-0.2.2-rc.1", "sha256": "71bfc25b…" }
```

`sha256` is copied from `archive.sha256` in the release asset `app-dshana-<version>.entry.json`. Size, identity and version are re-verified by the upstream synchronizer.

## Update rules

- **One version per PR, one enrollment per PR.** The market never discovers versions on its own and never updates users; until the PR merges, users keep seeing the enrolled version.
- **One PR in flight per extension.** Raise the version on the same branch and the same PR; do not close and reopen.
- **Never replace the archive of a published version.** Users install against the approved SHA-256, so a swapped asset simply fails to install. Ship a higher version instead.
- **Never edit `index.v2.json` or the upstream workflows.** The index is a product of their publish workflow; editing it fabricates market state.
- **The store blurb (`readme`) is decoupled from the package.** Changing it needs a PR but no Release. Without the field the store shows "no reviewed introduction" — it does not fall back to this repository's README, so a README change here does not propagate.

## When `validate-pr` fails

The failure seen in practice is the ordering mistake above:

```
app/dshana (Nyasers/DSHana): release v1.3.2+dsh-0.2.2-rc.1 is a prerelease
```

It means step 5 was skipped, or run after the PR was opened. Promote the Release first, then get a fresh run.

Getting that fresh run has one snag: the check executes on the upstream repository, so the author cannot rerun it — `gh run rerun` answers `Must have admin rights to Repository`. Close and reopen **the same PR** instead; that is a re-trigger, not the abandonment the Branch rules forbid, because the branch, the commits and the review record all stay put. `pull_request` defaults to the `opened`, `synchronize` and `reopened` activities, so reopening starts a new run and the branch stays free of noise commits. Do not push an empty commit to re-trigger.

## Pre-submit checklist

- [ ] Release is neither draft nor prerelease; its tag matches the new `approvals.json` value exactly
- [ ] `app-dshana-<version>.entry.json` and the ZIP it points at live in that same Release
- [ ] `sha256` copied from the entry's `archive.sha256`, not recomputed locally
- [ ] `publisher` matches `market/enrollment.json` (`Nyasers`)
- [ ] No version downgrade, no archive swap on a published version
- [ ] Icon links pinned to this tag's commit and actually load
