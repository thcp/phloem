// SPDX-License-Identifier: AGPL-3.0-only
/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';

/**
 * Deployment knobs (all optional environment variables, read at build time):
 *   PHLOEM_BASE   public path. Default './' (relative URLs: works on a root domain and under a sub-path alike).
 *                 Set an absolute path (e.g. '/phloem/') only if you need absolute asset URLs.
 *   SITE_URL      canonical origin + path of the deployed site. Default https://phloem.thales.sh/ . Used for og:url / og:image,
 *                 which social crawlers require to be absolute. Set it to the empty string to omit canonical / og:url and use
 *                 relative og:image (e.g. a preview deployment on another origin).
 *   VITE_SOURCE_URL  where the corresponding source code is offered (AGPL-3.0 section 13); target of the "Source code (AGPL-3.0)" links.
 *                 Default https://github.com/thcp/phloem (src/web/source.ts).
 *   VITE_EXPOSE_TEST_HOOKS=1 or `--mode e2e`  expose the window.__phloem test hook (src/main.ts). Never in a normal production build.
 * See docs/WEB.md and docs/DEPLOY.md.
 */
export const DEFAULT_SITE_URL = 'https://phloem.thales.sh/';
const siteUrl = (process.env.SITE_URL ?? DEFAULT_SITE_URL).replace(/\/?$/, '/').replace(/^\/$/, '');

// The CSP is in a <meta> tag so it also applies on hosts that cannot set headers. public/_headers carries the same
// policy plus the headers a meta tag cannot express (frame-ancestors, ...). Only at build: the dev server needs inline HMR scripts.
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "media-src 'self' https://audio.stemdeck.app",
  "connect-src 'self' https://api.github.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function htmlPlugin(): Plugin {
  return {
    name: 'phloem-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        let out = html.replaceAll('%SITE_URL%', siteUrl);
        // without SITE_URL there is no absolute address to declare: an empty canonical / og:url would be wrong, so leave the tags out
        if (!siteUrl) out = out.replace(/^\s*<link rel="canonical" href="" \/>\n/m, '').replace(/^\s*<meta property="og:url" content="" \/>\n/m, '');
        if (ctx.server === undefined) out = out.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
        else out = out.replace('<!--CSP-->', '');
        return out;
      },
    },
  };
}

export default defineConfig({
  base: process.env.PHLOEM_BASE || './', // static, deployable under any path
  plugins: [htmlPlugin()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, assetsInlineLimit: 0 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 60_000 },
});
