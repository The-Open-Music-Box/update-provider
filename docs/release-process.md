# Release process

Authoritative reference for cutting an ESP32 firmware release in the
TheOpenMusicBox ecosystem. The actual build pipeline lives in
[`esp32-firmware/.github/workflows/ota-release.yml`](https://github.com/The-Open-Music-Box/esp32-firmware/blob/develop/.github/workflows/ota-release.yml);
this document describes the **policy** (who cuts what, in which
channel, with what retention) and the **operator quickstart**.

> Only the project owner (Jonathan Piette) cuts stable releases. Alpha
> releases are produced by CI automatically; beta releases require an
> explicit manual trigger.

## TL;DR

| I want to… | What happens |
|---|---|
| **Try develop right now** | Latest alpha is built automatically when something merges to `develop`. Pick "alpha" channel in the Flutter app → "Vérifier les mises à jour" → install the newest tag. |
| **Have testers preview a feature** | Push a beta tag manually: `firmware-vX.Y.Z-beta.N`. The workflow publishes it; testers on the beta channel see it on next check. |
| **Ship to production boxes** | Push to the `release` branch on `esp32-firmware`; the prod deploy workflow cuts a stable tag from that branch. |
| **Roll back to an older version** | Pick any older release on any channel in the app and install — no anti-rollback enforced (yet — see [esp32-firmware#887](https://github.com/The-Open-Music-Box/esp32-firmware/issues/887)). |

## Channels

There are three channels, and **the tag nomenclature is symmetric
across all three** — the channel suffix is always present:

| Channel | Trigger | Tag pattern | Published version | Retention | Who consumes it |
|---|---|---|---|---|---|
| **alpha** | Auto, every merge to `develop` on `esp32-firmware` | `firmware-vX.Y.Z-alpha.N` | `X.Y.Z-alpha.N` | Last **5** releases | Internal dogfooding, daily builds |
| **beta** | Manual tag push by maintainer | `firmware-vX.Y.Z-beta.N` | `X.Y.Z-beta.N` | Last **10** releases | External testers, pre-release validation |
| **stable** | Auto, push to `release` branch on `esp32-firmware` | `firmware-vX.Y.Z-stable.N` | `X.Y.Z` | **All** releases (no cleanup) | Production boxes |

A **bare `firmware-vX.Y.Z` tag is rejected**, and so is any other suffix.
The three channels never diverge in shape.

### Tag vs published version

The *tag* is symmetric; the *version* stays clean SemVer:

- **stable drops its suffix** — `firmware-v0.5.3-stable.1` publishes
  version `0.5.3`. That matters: in SemVer, `0.5.3-stable.1` sorts *below*
  `0.5.3`, and the device reports the bare `0.5.3` triplet as its
  `APP_VERSION`. Dropping the suffix keeps "is this release newer than what
  I am running?" correct.
- **alpha and beta keep theirs** — they are genuine SemVer pre-releases, and
  `0.6.0-beta.2` correctly sorts below `0.6.0`.

The `-stable.N` counter therefore only distinguishes *re-cuts of the same
content* (a retry, a fixed asset). Any change to the firmware itself needs
an `APP_VERSION` bump — two different binaries must never ship under the
same version.

### Alpha — auto on `develop`

Every merge to `develop` triggers an alpha tag bump. The workflow
parses the previous alpha number from the latest `firmware-vX.Y.Z-alpha.*`
tag, increments by 1, and publishes
`firmware-v{APP_VERSION}-alpha.{N+1}`.

If the latest alpha was `firmware-v0.5.0-alpha.7` and `APP_VERSION` in
`version.h` is still `0.5.0`, the next merge produces
`firmware-v0.5.0-alpha.8`. If a maintainer bumps `APP_VERSION` to
`0.6.0`, the next alpha is `firmware-v0.6.0-alpha.1` — the counter
resets per base version.

Retention is enforced after each publish: the workflow lists alpha
releases newest-first and deletes everything past index 5, including
the associated assets and tag. Devices that already downloaded an
expired alpha keep running it (no remote pull); they simply won't see
it in the "Vérifier les mises à jour" list anymore.

### Beta — manual

Beta releases gate features for external testers. They require a
deliberate decision: which alpha proved stable enough? The maintainer
tags it explicitly:

```bash
# From the commit you want to bless:
git tag -a firmware-v0.6.0-beta.1 -m "Firmware 0.6.0 beta 1"
git push origin firmware-v0.6.0-beta.1
```

The workflow accepts the tag, builds, publishes. Retention: last 10
beta releases across all base versions.

### Stable — deploy workflow

Stable releases ship to production boxes. They are produced when the
maintainer fast-forwards the `release` branch on `esp32-firmware` to
the commit they want to ship:

```bash
# Promote the current develop HEAD to release:
git checkout release
git pull
git merge --ff-only develop
git push origin release
```

A separate workflow watches the `release` branch, parses `APP_VERSION`, and
tags `firmware-v{APP_VERSION}-stable.{N}` — the suffix is mandatory, exactly
as on the other two channels. The published version drops it back to
`{APP_VERSION}`. The workflow runs the same build + publish steps as the
alpha path, only without retention cleanup — every stable build stays
forever.

Pre-condition: `APP_VERSION` on `release` must be strictly greater
than the last stable tag, otherwise the workflow rejects the push so
two stables never collide.

## Where the artifacts live

Each release publishes the same five assets to both repos
simultaneously:

| Asset | Purpose |
|---|---|
| `firmware.bin` | OTA payload — streamed by `esp_https_ota` into the inactive partition |
| `firmware.bin.sha256` | Companion integrity hint |
| `bootloader.bin` | Reference (full-image reflash via esptool) |
| `partitions.bin` | Reference |
| `manifest.json` | Machine-readable summary (`version`, `channel`, `sha256`, `build_hash`) |

**`update-provider` (public)** is the consumer-facing mirror. The
Flutter app and any other client read from
`https://api.github.com/repos/theopenmusicbox/update-provider/releases`
anonymously.

**`esp32-firmware` (private)** keeps the archival copy. Maintainers
have access for historical reference, debug, or worst-case manual
flash.

A delete on `esp32-firmware` propagates to `update-provider` —
cleanup workflows and manual deletes both call the same shared logic,
so the public mirror never holds an asset the source repo has
disavowed.

## Operator quickstart

For the maintainer cutting an explicit release (beta or stable). Alpha cuts
happen without intervention.

### Beta

```bash
# 1. You decide which alpha commit to bless. Browse:
gh release list --repo The-Open-Music-Box/update-provider --limit 10

# 2. Identify the alpha you want, find its SHA:
gh release view firmware-v0.5.0-alpha.7 --repo The-Open-Music-Box/update-provider \
    --json targetCommitish -q .targetCommitish

# 3. Tag that commit as beta on esp32-firmware:
cd ~/github/theopenmusicbox/esp32-firmware
git fetch origin
git tag -a firmware-v0.5.0-beta.1 <sha> -m "Firmware 0.5.0 beta 1 (from alpha.7)"
git push origin firmware-v0.5.0-beta.1

# 4. Watch the run:
gh run watch
```

3 minutes later the release lands on `update-provider`. Beta testers
on the beta channel see it on their next check.

### Stable

```bash
# 1. Bump APP_VERSION on develop:
sed -i '' 's/APP_VERSION "0.5.0"/APP_VERSION "0.5.1"/' include/version.h
git commit -am "chore(version): bump APP_VERSION to 0.5.1"
git push origin develop

# 2. Promote develop to release (fast-forward only — fails if release diverged):
git checkout release
git pull
git merge --ff-only develop
git push origin release
```

The stable workflow takes over from here. No manual tagging — the workflow
tags `firmware-v0.5.1-stable.1` from the `release` HEAD, and the release is
published as version `0.5.1`.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Workflow rejects the tag as non-conforming | Bare stable (`firmware-v0.5.1`), missing `.N`, or an unknown suffix (`-rc.1`, `-issue.42`) | Use the symmetric form `firmware-vX.Y.Z-{alpha\|beta\|stable}.N`. The three channels are the only ones that exist |
| Workflow rejects the tag prefix | Wrong prefix | Use `firmware-v…`, the `v…` namespace is reserved for the legacy contracts release flow |
| "APP_VERSION mismatch" build error | `version.h` not bumped to match the tag X.Y.Z | Bump `version.h`, recommit, retag |
| Release archived to esp32-firmware but not on update-provider | `UPDATE_PROVIDER_PUBLISH_TOKEN` missing/expired on the workflow run | Rotate the PAT, re-add as `esp32-firmware` repo secret, re-run the workflow job |
| Flutter app shows "Erreur inattendue" on check | update-provider unreachable or returns 404 | Verify the asset bundle was published; confirm anonymous `curl https://api.github.com/repos/.../update-provider/releases` returns ≥1 result for the channel |
| Anti-rollback would have caught this | Anti-rollback not enabled yet — see [esp32-firmware#887](https://github.com/The-Open-Music-Box/esp32-firmware/issues/887) | Manual rollback by picking an older tag in the app |

## Cross-repo references

- Workflow: [`esp32-firmware/.github/workflows/ota-release.yml`](https://github.com/The-Open-Music-Box/esp32-firmware/blob/develop/.github/workflows/ota-release.yml)
- Signing roadmap (Phase 2): [`esp32-firmware/docs/ota-signing.md`](https://github.com/The-Open-Music-Box/esp32-firmware/blob/develop/docs/ota-signing.md)
- Security hardening backlog: [esp32-firmware#887](https://github.com/The-Open-Music-Box/esp32-firmware/issues/887)
- Client integration: [`flutter-app/lib/features/firmware_update/data/github_releases_client.dart`](https://github.com/The-Open-Music-Box/flutter-app/blob/develop/lib/features/firmware_update/data/github_releases_client.dart)
- EPIC: [esp32-firmware#744](https://github.com/The-Open-Music-Box/esp32-firmware/issues/744)
