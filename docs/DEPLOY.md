# Deploying Phloem on Cloudflare

Phloem is a static site (`npm run build` writes `dist/`). It is hosted on **Cloudflare** (Workers static assets), from the public repository
**https://github.com/thcp/phloem**. Served at **https://phloem.thales.sh** (the only deployment). **https://phloem.stemdeck.app** is a permanent redirect to it.

## 1. Deploy (Workers static assets)

Cloudflare now hosts static sites as a Worker with static assets (what "Pages" became). `wrangler.jsonc` in the repo root carries the config:
the Worker `phloem`, assets from `dist/`, and the custom domain `phloem.thales.sh`. `public/_headers` (copied into `dist/`) sets the security headers and cache rules.

```
npm run build        # also fails if the test hook or a placeholder URL ships (scripts/check-dist.mjs)
npx wrangler deploy
```

`wrangler login` first (or set `CLOUDFLARE_API_TOKEN`). Do **not** set `VITE_EXPOSE_TEST_HOOKS` for a production build.
`SITE_URL` (canonical, `og:url`, `og:image`) and `VITE_SOURCE_URL` default to https://phloem.thales.sh/ and https://github.com/thcp/phloem; set them at build time to override.
A stale `.wrangler/deploy/config.json` (git-ignored) can redirect `wrangler deploy` to `dist/wrangler.json` and ignore `wrangler.jsonc`: delete both if the routes do not apply.

## 2. Domains

* `phloem.thales.sh`: live, attached as a custom domain by `wrangler.jsonc` (DNS record and certificate are created automatically because thales.sh is on the same Cloudflare account).
* `phloem.stemdeck.app`: not served by the Worker. In the stemdeck.app zone it has a proxied placeholder record (`AAAA phloem 100::`, needed so Cloudflare applies rules to the name) and a Single Redirect rule
  (Rules > Redirect Rules) "phloem.stemdeck.app -> phloem.thales.sh": 301 to `https://phloem.thales.sh` + the same path, query string preserved.

`canonical` and the share previews point at `SITE_URL` (https://phloem.thales.sh/).

## 3. Music

The tracks load from `https://audio.stemdeck.app` (the EU-jurisdiction R2 bucket `phloem`, custom domain `audio.stemdeck.app`). Two things restrict who may load them, and both list **both** sites:

* R2 CORS on the bucket: allowed origins `https://phloem.thales.sh` and the old `https://phloem.stemdeck.app` (GET, HEAD, `range`; the old one can be dropped, nothing serves from it any more).
* A zone firewall rule on stemdeck.app, "audio: only the Phloem site may load the music": blocks `audio.stemdeck.app` unless the Referer starts with one of those two origins.

Check: `curl -s -o /dev/null -w "%{http_code}\n" -H "Referer: https://phloem.thales.sh/" -H "Range: bytes=0-99" https://audio.stemdeck.app/audio/heartbeat-drip.mp3` gives 206; a foreign Referer gives 403.
To add another site, add it to both.

## 4. After it is live

* The page loads, console clean, no CSP messages; Featured cards open instantly (no request to api.github.com in the Network tab).
* The test hook is absent: type `window.__phloem` in the console, it must be `undefined`.
* Headers and caching:

  ```
  curl -sI https://phloem.thales.sh/ | grep -i -E 'content-security-policy|x-content-type|cache-control'
  curl -sI https://phloem.thales.sh/featured/index.json | grep -i cache-control
  ```

  Expect the CSP, `nosniff`, `max-age=0, must-revalidate` on `/`, `max-age=3600` on `/featured/*`, and `max-age=31536000, immutable` on `/assets/*`.
* Share preview: paste the URL into a social/Slack unfurl tester; the image is `/og.png` (1200x630).
* Deploys are manual (`npx wrangler deploy`); there is no Git integration yet.

## Notes

* **AGPL-3.0 section 13:** if you (or anyone) host a *modified* version, the page must offer its users the corresponding source. The footer and viewer link do that via `VITE_SOURCE_URL`; a fork must set it to its own source URL.
* `public/_headers` has no overlapping `Cache-Control` rules on purpose: Pages merges matching rules, which would join conflicting values for one URL.
* No redirects or rewrites are configured on purpose: the site is one `index.html` with query parameters.
* Rollback: Workers & Pages > `phloem` > Deployments > pick an earlier version > roll back.
* Data saved by the app under its former name (`gitmold`) in a visitor's browser is moved to the Phloem names once, automatically (`src/web/migrate.ts`). For a new public site there is nothing to migrate.
