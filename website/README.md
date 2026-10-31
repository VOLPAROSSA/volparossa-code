# VOLPAROSSA Code — The Loom of Ideas

Static English product page for `/volparossa-code/`. The selected walnut/brass
loom, golden threads and burgundy fox tapestry are implemented as separate
responsive scenes around semantic HTML. No Code runtime, model, account or
network participation is started by this website.

## Build and preview

Python 3 is the only build dependency. All theme files and visitor assets are
local and pinned; the build works offline.

```sh
python3 website/scripts/build_site.py
python3 website/scripts/check_site.py
python3 -m http.server 8775 --bind 127.0.0.1 --directory website/preview
```

Open **http://127.0.0.1:8775/volparossa-code/**. The preview uses `noindex,nofollow`.
The workflow's `code-website-preview` artifact contains the same project route;
unzip it and serve its parent directory using the command above.

The explicit production build is separate from publication:

```sh
python3 website/scripts/build_site.py --production --output website/dist/volparossa-code
python3 website/scripts/check_site.py --production --output website/dist/volparossa-code
```

Use matching `--origin` and `--base-path` arguments on both commands to check an
alternative host, such as `--origin https://volparossa.github.io`. Local resources
remain relative to the repository project route. No CNAME or root robots policy
is copied. The production sitemap contains only the real product route.

## Maintenance

- `src/index.html`, `src/content.json`: page structure, copy, metadata and links.
- `assets/code.css`: Code-only composition, beside the unmodified shared styles.
- `vendor/volparossa-theme/`: exact source-only theme export, its renderer,
  original marks, fonts, notices and hash manifest. Do not edit it locally.
- `masters/`: clean generated scene masters and exact prompts, excluded from output.
- `scripts/export_images.py`: maintainer-only crops and AVIF/WebP/JPEG exports;
  requires Pillow 12.3.0. `--inventory-only` refreshes hashes after an asset change.
- `asset-manifest.json`: dimensions, crop boxes, file sizes and SHA-256 inventory.
- `docs/`: [content sources](docs/CONTENT-SOURCES.md), [assets](docs/ASSETS.md)
  and [verification](docs/VERIFICATION.md). `review/` contains review evidence,
  never visitor assets.

The existing `/docs/#applications` portal is the verified Code entrance. No
second documentation portal or central publication flag is added.

## Optional browser QA

The website's separate package and lockfile pin Playwright, axe and Lighthouse.
They do not change the application's package or ship to visitors.

```sh
cd website
npm ci
# With locally available browsers; otherwise provision Playwright browsers.
CHROME_PATH=/usr/bin/chromium npm run qa
```

`SITE_QA_URL` overrides the preview URL. The script checks Chromium and Firefox,
responsive layout, local assets, initial/full-page transfer, keyboard navigation,
native details, no JS, reduced motion, text enlargement and narrow reflow.

## Publication after review

This implementation prepares a preview and PR; it does not merge or deploy.
On 31 October 2026 the read-only Pages API reported `build_type=workflow`,
`cname=null` and `html_url=https://volparossa.org/volparossa-code/`.
This is configuration evidence, not a successful site deployment.

After the owner approves publication:

1. Merge the reviewed PR after required checks pass.
2. Run **Code website** manually on `main`. The workflow validates the preview,
   builds and checks production, uploads only `website/dist/volparossa-code/`,
   then publishes with the existing GitHub Pages configuration.
3. Verify the live HTML, asset bytes, canonical, links and actual mobile/desktop
   rendering at the intended URL.
4. Only after that live verification, make a separate homepage PR to set Code's
   `published` flag to true. The product stays **In development**.

PR and ordinary push jobs only build/check. Deployment is restricted to a manual
event on `main`, with Pages/OIDC rights scoped to the deployment job. No settings,
DNS, CNAME or root-site changes are part of this PR.
