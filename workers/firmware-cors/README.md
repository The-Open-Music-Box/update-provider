# firmware-cors Worker

**Stateless** Cloudflare Worker that serves the firmware binaries published as
GitHub Releases on this repo, **adding CORS headers**.

Public URL: `https://fw.theopenmusicbox.com/{tag}/{asset}`

## Why

The browser flasher on the site's `/build/flash` page
([web#193](https://github.com/The-Open-Music-Box/web/issues/193), ESP Web Tools
/ Web Serial) downloads the `.bin` files **in the browser** via `fetch()`.
GitHub Release assets (`objects.githubusercontent.com`) expose **no**
`Access-Control-Allow-Origin` header, so a cross-origin `fetch()` from
`theopenmusicbox.com` fails.

This Worker is the only fix needed: the Flutter app (OTA) and the ESP32
(`esp_https_ota`) download over plain HTTP with no CORS constraint.

## What it does / does not do

- **Proxies** `GET /{tag}/{asset}` to
  `https://github.com/The-Open-Music-Box/update-provider/releases/download/{tag}/{asset}`
  and returns the stream with `Access-Control-Allow-Origin: *`.
- **Stores nothing durable**: GitHub Releases stay the source of truth. Only
  the Cloudflare edge cache (Cache API) is populated on the fly — safe because
  a release tag is immutable (`Cache-Control: immutable`).
- **Strict allowlist** (no open proxy):
  - tag: `firmware-v*` (regex `firmware-vX.Y.Z[-(alpha|beta|stable).N]`)
  - asset: `firmware.bin`, `firmware.bin.sha256`, `bootloader.bin`,
    `partitions.bin`, `manifest.json`
- Methods: `GET`, `HEAD`, `OPTIONS` (preflight). Anything else → 405.

| Response | Meaning |
|---|---|
| `200` + `X-Cache: HIT/MISS` | binary served (from the edge or from GitHub) |
| `403 forbidden` | tag does not match or asset is not allowlisted |
| `404 not_found` | path is not `/{tag}/{asset}`, or the release/asset does not exist |
| `502 upstream_error` | GitHub answered something other than 2xx/404 |

## Development

```bash
npm ci
npm run check   # wrangler deploy --dry-run (validates config + bundle, no Cloudflare call)
npm run dev     # local wrangler dev server
```

## Deployment

### Automatic (CI)

`.github/workflows/deploy-worker.yml` deploys on every push to `develop` that
touches `workers/firmware-cors/**`, on the self-hosted `node` runners. It runs
the dry-run check first, then `wrangler deploy` (pinned to the lockfile's
wrangler version), then smoke-tests `https://fw.theopenmusicbox.com/` for a
`200` with `access-control-allow-origin: *`.

Prerequisites: repo secrets `CLOUDFLARE_API_TOKEN` (scoped **Edit Cloudflare
Workers** on the account + the `theopenmusicbox.com` zone) and
`CLOUDFLARE_ACCOUNT_ID`.

### Manual

```bash
cd workers/firmware-cors
npm ci
npx wrangler deploy   # requires `wrangler login` or CLOUDFLARE_API_TOKEN
```

## Cloudflare prerequisites (account owner)

- **DNS: nothing to do by hand.** `wrangler.toml` uses `custom_domain = true`,
  so wrangler creates the `fw` DNS record **and** the edge certificate
  automatically on the **first** deploy.
- **First deploy** (creates the custom domain): `wrangler login` (OAuth, full
  scopes) then `npx wrangler deploy`. Already done — the Worker is live.
- **Subsequent CI deploys** (script update only): repo secrets
  `CLOUDFLARE_API_TOKEN` (template *Edit Cloudflare Workers*, scoped to the
  account + the `theopenmusicbox.com` zone) + `CLOUDFLARE_ACCOUNT_ID`.

## Web side

The site's
[`web` `components/build/FirmwareFlasher.tsx`](https://github.com/The-Open-Music-Box/web)
points at the Worker:

```ts
const FIRMWARE_CORS_BASE = 'https://fw.theopenmusicbox.com'
```

The component then builds asset URLs as `${BASE}/{tag}/{asset}`.
