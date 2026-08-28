# Publishing model

`update-provider` does not contain code that builds anything. Releases are
**pushed in** from upstream repos (today: `esp32-firmware`) and the
artifacts are stored as standard GitHub Release assets.

## Upstream contract

A release is considered well-formed when it carries **all** of:

| Asset | MIME | Purpose |
|---|---|---|
| `firmware.bin` | `application/octet-stream` | OTA payload streamed by `esp_https_ota` into the inactive partition |
| `firmware.bin.sha256` | `text/plain` | Companion integrity hint — same digest is mirrored inside `manifest.json` |
| `bootloader.bin` | `application/octet-stream` | Reference only (not used by OTA, kept for full-image reflash via esptool) |
| `partitions.bin` | `application/octet-stream` | Reference only |
| `manifest.json` | `application/json` | Machine-readable summary (`version`, `channel`, `sha256`, `signed`, `build_hash`) |

`manifest.json` schema is owned upstream — see
`esp32-firmware/docs/ota-release-process.md` and the build job in
`esp32-firmware/.github/workflows/ota-release.yml`.

## Tag convention

Tags are duplicated verbatim from `esp32-firmware`. The nomenclature is
symmetric across the three channels: the channel suffix is **always**
present, a bare `firmware-vX.Y.Z` is rejected (see
[`release-process.md`](release-process.md) for triggers, retention and the
tag-vs-version rule):

| Pattern | Channel | Published version | Example |
|---|---|---|---|
| `firmware-vX.Y.Z-alpha.N` | `alpha` | `X.Y.Z-alpha.N` | `firmware-v0.6.0-alpha.3` |
| `firmware-vX.Y.Z-beta.N` | `beta` | `X.Y.Z-beta.N` | `firmware-v0.6.0-beta.1` |
| `firmware-vX.Y.Z-stable.N` | `stable` | `X.Y.Z` | `firmware-v0.6.0-stable.1` |

The GitHub Release **must** carry the `prerelease=true` flag for any
non-stable tag so anonymous clients can filter on it without parsing the
suffix themselves.

## Anti-rollback / signing

Both are upstream concerns:

- **SHA-256** is computed at build time in `esp32-firmware`; this repo
  just hosts the digest.
- **ECDSA app-level signing** is Phase 2 (see
  `esp32-firmware/docs/ota-signing.md`). When it lands, `manifest.json`
  gains a `signature.alg` / `signature.value` block, the assets gain
  `firmware.bin.sig`, and the firmware bootloader verifies before flip.

This repo does **not** verify or filter incoming releases — whatever
upstream publishes is what clients see. The trust boundary is at the
build job in `esp32-firmware`.

## Manual publish (escape hatch)

For a hot-fix when the workflow path is broken:

```bash
gh release create firmware-v0.5.0 \
  --repo The-Open-Music-Box/update-provider \
  --title "Firmware 0.5.0 (stable)" \
  --notes "Manual republish — workflow run XXXX broken, see issue YYY." \
  firmware.bin firmware.bin.sha256 bootloader.bin partitions.bin manifest.json
```

The release name **must** match `esp32-firmware`'s naming convention
(`Firmware vX.Y.Z (channel)`) so the Flutter app's channel grouper picks
it up. Prefer fixing the workflow over manual republish.
