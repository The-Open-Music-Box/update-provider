/**
 * firmware-cors — Cloudflare Worker (stateless proxy)
 *
 * Sert les binaires de firmware publiés en GitHub Releases sur ce repo
 * (`update-provider`) en y ajoutant les en-têtes CORS, pour que le flasheur
 * navigateur (ESP Web Tools / Web Serial) de la page `/build/flash` du site
 * puisse les `fetch()` côté client.
 *
 * Les assets de release GitHub (`objects.githubusercontent.com`) n'exposent
 * AUCUN en-tête CORS : un `fetch()` cross-origin depuis theopenmusicbox.com
 * échoue donc sans ce proxy. L'app Flutter (OTA) et l'ESP32 (`esp_https_ota`)
 * tirent en HTTP natif et ne sont pas concernés.
 *
 * Le Worker ne stocke rien de durable : la source de vérité reste les
 * GitHub Releases. Le seul "stockage" est le cache edge Cloudflare, peuplé
 * à la volée et sûr car un tag de release est immuable.
 *
 * URL publique : https://fw.theopenmusicbox.com/{tag}/{asset}
 *   ex. https://fw.theopenmusicbox.com/firmware-v0.5.3-alpha.1/firmware.bin
 */

const REPO = 'The-Open-Music-Box/update-provider'

// Allowlist stricte : on ne proxie QUE les assets de release attendus,
// jamais un chemin arbitraire (pas d'open-proxy).
const ALLOWED_ASSETS = new Set([
  'firmware.bin',
  'firmware.bin.sha256',
  'bootloader.bin',
  'partitions.bin',
  'manifest.json',
])

// Tags de release valides (cf. update-provider/docs/publishing.md).
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

    // Racine : petit endpoint d'information / health.
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

    // Cache edge : clé normalisée en GET (HEAD partage la même entrée).
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
      // Erreur réseau vers GitHub : on répond une erreur structurée AVEC CORS
      // (sans try/catch, le throw donnerait un 500 opaque sans en-tête CORS).
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
    // Un tag de release est immuable -> cache long et agressif.
    resp.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    resp.headers.set('X-Cache', 'MISS')
    resp.headers.delete('Set-Cookie')

    // Peuple le cache edge en tâche de fond (ne bloque pas la réponse).
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
