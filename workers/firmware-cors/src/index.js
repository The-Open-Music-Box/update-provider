/**
 * firmware-cors — Cloudflare Worker (stateless proxy)
 *
 * Serves the firmware binaries published as GitHub Releases on this repo
 * (`update-provider`) with CORS headers added, so the browser flasher
 * (ESP Web Tools / Web Serial) on the site's `/build/flash` page can
 * `fetch()` them client-side.
 *
 * GitHub Release assets (`objects.githubusercontent.com`) expose NO CORS
 * header: a cross-origin `fetch()` from theopenmusicbox.com fails without
 * this proxy. The Flutter app (OTA) and the ESP32 (`esp_https_ota`) download
 * over plain HTTP and are not affected.
 *
 * The Worker stores nothing durable: GitHub Releases stay the source of
 * truth. The only "storage" is the Cloudflare edge cache, populated on the
 * fly and safe because a release tag is immutable.
 *
 * Public URL: https://fw.theopenmusicbox.com/{tag}/{asset}
 *   e.g. https://fw.theopenmusicbox.com/firmware-v0.5.3-alpha.1/firmware.bin
 */

const REPO = 'The-Open-Music-Box/update-provider'

// Strict allowlist: only the expected release assets are proxied, never an
// arbitrary path (no open proxy).
const ALLOWED_ASSETS = new Set([
  'firmware.bin',
  'firmware.bin.sha256',
  'bootloader.bin',
  'partitions.bin',
  'manifest.json',
])

// Valid release tags (see update-provider/docs/publishing.md).
const TAG_RE = /^firmware-v\d+\.\d+\.\d+(?:-(?:alpha|beta|stable)\.\d+)?$/

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

function contentType(asset) {
  if (asset.endsWith('.json')) return 'application/json'
  if (asset.endsWith('.sha256')) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse(405, { error: 'method_not_allowed' })
    }

    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)

    // Root: small info / health endpoint.
    if (parts.length === 0) {
      return jsonResponse(200, {
        service: 'firmware-cors',
        repo: REPO,
        usage: '/{tag}/{asset}',
        assets: [...ALLOWED_ASSETS],
      })
    }

    if (parts.length !== 2) {
      return jsonResponse(404, { error: 'not_found', hint: 'expected /{tag}/{asset}' })
    }

    const [tag, asset] = parts
    if (!TAG_RE.test(tag) || !ALLOWED_ASSETS.has(asset)) {
      return jsonResponse(403, {
        error: 'forbidden',
        hint: 'tag must match firmware-v* and asset must be allowlisted',
      })
    }

    // Edge cache: key normalised to GET (HEAD shares the same entry).
    const cache = caches.default
    const cacheKey = new Request(`${url.origin}/${tag}/${asset}`, { method: 'GET' })

    const cached = await cache.match(cacheKey)
    if (cached) {
      const body = request.method === 'HEAD' ? null : cached.body
      const hit = new Response(body, cached)
      hit.headers.set('X-Cache', 'HIT')
      return hit
    }

    const upstream = `https://github.com/${REPO}/releases/download/${tag}/${asset}`
    let originResp
    try {
      originResp = await fetch(upstream, {
        headers: { 'User-Agent': 'firmware-cors-worker' },
      })
    } catch (err) {
      // Network error towards GitHub: answer a structured error WITH CORS
      // (without the try/catch the throw would yield an opaque 500 with no
      // CORS header).
      console.error(JSON.stringify({ event: 'upstream_unreachable', tag, asset, message: String(err) }))
      return jsonResponse(502, { error: 'upstream_unreachable', tag, asset })
    }

    if (!originResp.ok) {
      console.error(JSON.stringify({ event: 'upstream_error', status: originResp.status, tag, asset }))
      return jsonResponse(originResp.status === 404 ? 404 : 502, {
        error: 'upstream_error',
        status: originResp.status,
        tag,
        asset,
      })
    }

    const resp = new Response(originResp.body, originResp)
    for (const [k, v] of Object.entries(CORS_HEADERS)) resp.headers.set(k, v)
    resp.headers.set('Content-Type', contentType(asset))
    // A release tag is immutable -> long, aggressive cache.
    resp.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    resp.headers.set('X-Cache', 'MISS')
    resp.headers.delete('Set-Cookie')

    // Populate the edge cache in the background (does not block the response).
    ctx.waitUntil(
      cache
        .put(cacheKey, resp.clone())
        .catch((err) =>
          console.error(JSON.stringify({ event: 'cache_put_failed', tag, asset, message: String(err) }))
        )
    )

    if (request.method === 'HEAD') {
      return new Response(null, { status: resp.status, headers: resp.headers })
    }
    return resp
  },
}
