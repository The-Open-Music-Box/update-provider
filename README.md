# update-provider

Public distribution endpoint for client-facing artifacts of TheOpenMusicBox
ecosystem. Today: ESP32 OTA firmware binaries published as GitHub Releases.

This repo is intentionally a thin artifact mirror. Source code lives in the
private `esp32-firmware` repo; the **compiled** firmware binaries land here
so the Flutter / iOS / Android clients can read
`https://api.github.com/repos/theopenmusicbox/update-provider/releases`
**anonymously** (no PAT, no auth-provider token, no Cloudflare Worker — just
an HTTPS GET).

## What lives here

| Asset | Source | Trigger | Notes |
|---|---|---|---|
| `firmware.bin` | `esp32-firmware/.pio/build/production` | `firmware-vX.Y.Z[-channel.N]` tag on `esp32-firmware` | OTA payload, written to the inactive partition |
| `bootloader.bin` | same | same | Reference only, not used by `esp_https_ota` |
| `partitions.bin` | same | same | Reference only |
| `manifest.json` | generated in workflow | same | Version, channel, SHA-256, build hash |
| `firmware.bin.sha256` | generated in workflow | same | Companion integrity hint |

The release titles follow the `Firmware vX.Y.Z (channel)` pattern produced
by `esp32-firmware/.github/workflows/ota-release.yml`. Pre-releases
(`alpha` / `beta`) carry GitHub's "Pre-release" flag so anonymous clients
can filter on it.

## Who consumes this

- **Flutter app** (`flutter-app/lib/features/firmware_update/data/github_releases_client.dart`):
  reads the releases list, filters by channel parsed from the tag suffix,
  picks the newest, hands the `browser_download_url` to the device via
  `POST /api/system/firmware/update`.
- **ESP32 firmware** (`esp32-firmware/adapters/secondary/ota/EspHttpsOtaAdapter.hpp`):
  receives the URL and streams it through `esp_https_ota` against the
  GitHub CDN (`objects.githubusercontent.com`). The IDF CA bundle covers
  the cert chain — no per-host cert pinning needed.

End-to-end flow:

```
esp32-firmware tag push  ─►  ota-release.yml builds + signs (planned)
                                  │
                                  ▼
                          update-provider GitHub Release
                                  │   (this repo)
                                  ▼
                      Flutter app queries releases
                                  │
                                  ▼
                          User taps "Installer"
                                  │
                                  ▼
                       POST /api/system/firmware/update {url}
                                  │
                                  ▼
                       esp_https_ota stream → flash partition → reboot
```

## Why a separate repo?

- **Privacy boundary.** `esp32-firmware` stays private (source code) while
  the public-facing artifacts have their own surface — no risk of
  accidentally leaking source through repo visibility flips.
- **Anonymous reads.** GitHub Releases on a public repo are accessible
  without a PAT, so the mobile app doesn't need to ship a token or hit
  an auth provider just to check for an update.
- **Free CDN.** Asset downloads route through `objects.githubusercontent.com`
  which is a CDN — no bandwidth ops on our side.
- **Decoupling for the future.** Tomorrow we might host Telmi story
  bundles, RPi firmware images, or a static `index.json` here too. The
  repo name (`update-provider`, not `firmware-releases`) doesn't pin us
  to one product line.

## How releases get published

Triggered from `esp32-firmware` when a tag matching `firmware-v*` is
pushed. The workflow:

1. Builds `firmware.bin` against the tagged commit, verifies
   `APP_VERSION` in `include/version.h` matches the tag.
2. Computes SHA-256, packages with `bootloader.bin`, `partitions.bin`,
   and a generated `manifest.json`.
3. Publishes a GitHub Release **here** in `update-provider`, with the tag
   from `esp32-firmware` carried over verbatim (so the Flutter app can
   correlate a tag with a build hash).

See `esp32-firmware/docs/ota-release-process.md` for the human walkthrough
and `esp32-firmware/.github/workflows/ota-release.yml` for the source.

## What this repo does NOT do (yet)

- **No active service.** No Cloudflare Worker, no FastAPI, no scheduled
  job. Just artifacts attached to releases. If we later need
  release-history filtering, anti-rollback enforcement, or a custom
  channel index, the code can land in this same repo without renaming.
- **No image signing on the publish side.** Manifest carries SHA-256 only.
  ECDSA app-level signing is tracked as Phase 2 in
  `esp32-firmware/docs/ota-signing.md` and would be added at the
  `esp32-firmware/ota-release.yml` build stage, not here.
- **No firmware code review or testing.** Validation happens in
  `esp32-firmware` (`pio run -e production` + HIL CI). This repo only
  stores what was already validated upstream.

## Repository conventions

- Default branch: `develop`. PRs branch off `develop` and merge back into
  it. Tag-based releases are cut from `develop`.
- Branch naming: `feat(scope):` / `fix(scope):` / `chore(scope):` /
  `docs(scope):` / `test(scope):` — same convention as the rest of the
  ecosystem.
- All PRs link an open issue. Tag releases follow SemVer; pre-releases
  use the `-alpha.N` / `-beta.N` suffix.

## Cross-repo references

- EPIC: [`esp32-firmware#744`](https://github.com/The-Open-Music-Box/esp32-firmware/issues/744)
- Tag convention: [`esp32-firmware/docs/ota-release-process.md`](https://github.com/The-Open-Music-Box/esp32-firmware/blob/develop/docs/ota-release-process.md)
- Signing posture: [`esp32-firmware/docs/ota-signing.md`](https://github.com/The-Open-Music-Box/esp32-firmware/blob/develop/docs/ota-signing.md)
- Client integration: [`flutter-app/lib/features/firmware_update/data/github_releases_client.dart`](https://github.com/The-Open-Music-Box/flutter-app/blob/develop/lib/features/firmware_update/data/github_releases_client.dart)
