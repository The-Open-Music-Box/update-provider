# firmware-cors Worker

Cloudflare Worker **stateless** qui sert les binaires de firmware publiés en
GitHub Releases sur ce repo, **en ajoutant les en-têtes CORS**.

URL publique : `https://fw.theopenmusicbox.com/{tag}/{asset}`

## Pourquoi

Le flasheur navigateur de la page `/build/flash` du site
([web#193](https://github.com/The-Open-Music-Box/web/issues/193), ESP Web Tools
/ Web Serial) télécharge les `.bin` **côté navigateur** via `fetch()`. Or les
assets de GitHub Releases (`objects.githubusercontent.com`) n'exposent **aucun**
en-tête `Access-Control-Allow-Origin` : le `fetch()` cross-origin depuis
`theopenmusicbox.com` échoue.

Ce Worker est le seul correctif nécessaire : l'app Flutter (OTA) et l'ESP32
(`esp_https_ota`) tirent en HTTP natif, sans contrainte CORS.

## Ce qu'il fait / ne fait pas

- **Proxie** `GET /{tag}/{asset}` vers
  `https://github.com/The-Open-Music-Box/update-provider/releases/download/{tag}/{asset}`
  et renvoie le flux avec `Access-Control-Allow-Origin: *`.
- **Ne stocke rien de durable** : la source de vérité reste les GitHub
  Releases. Seul un cache edge Cloudflare (Cache API) est peuplé à la volée —
  sûr car un tag de release est immuable (`Cache-Control: immutable`).
- **Allowlist stricte** (pas d'open-proxy) :
  - tag : `firmware-v*` (regex `firmware-vX.Y.Z[-(alpha|beta|stable).N]`)
  - asset : `firmware.bin`, `firmware.bin.sha256`, `bootloader.bin`,
    `partitions.bin`, `manifest.json`
- Méthodes : `GET`, `HEAD`, `OPTIONS` (préflight). Tout le reste → 405.

| Réponse | Sens |
|---|---|
| `200` + `X-Cache: HIT/MISS` | binaire servi (depuis edge ou GitHub) |
| `403 forbidden` | tag non conforme ou asset hors allowlist |
| `404 not_found` | chemin ≠ `/{tag}/{asset}` ou release/asset inexistant |
| `502 upstream_error` | GitHub a répondu autre chose que 2xx/404 |

## Développement

```bash
npm install
npm run check   # wrangler deploy --dry-run (valide la config + le bundle, sans CF)
npm run dev     # serveur local wrangler
```

## Déploiement

### Automatique (CI)

`.github/workflows/deploy-worker.yml` déploie au push sur `develop` qui touche
`workers/firmware-cors/**`. Prérequis : secrets repo `CLOUDFLARE_API_TOKEN`
(scopé **Edit Cloudflare Workers** sur la zone `theopenmusicbox.com`) et
`CLOUDFLARE_ACCOUNT_ID`.

### Manuel

```bash
cd workers/firmware-cors
npm install
npx wrangler deploy   # nécessite `wrangler login` ou CLOUDFLARE_API_TOKEN
```

## Prérequis Cloudflare (côté Jonathan)

- **DNS : rien à faire à la main.** `wrangler.toml` utilise
  `custom_domain = true` → wrangler crée l'enregistrement DNS `fw` **et** le
  certificat edge automatiquement au **premier** déploiement.
- **Premier déploiement** (crée le domaine) : `wrangler login` (OAuth, scopes
  complets) puis `npx wrangler deploy`.
- **Déploiements CI suivants** (mise à jour du script seulement) : secrets repo
  `CLOUDFLARE_API_TOKEN` (template *Edit Cloudflare Workers*, scopé compte +
  zone `theopenmusicbox.com`) + `CLOUDFLARE_ACCOUNT_ID`.

## Côté web

Une fois le Worker en ligne, renseigner dans
[`web` `components/build/FirmwareFlasher.tsx`](https://github.com/The-Open-Music-Box/web) :

```ts
const FIRMWARE_CORS_BASE = 'https://fw.theopenmusicbox.com'
```

Le composant construit alors les URLs d'asset au format `${BASE}/{tag}/{asset}`.
