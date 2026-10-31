# Website verification — 31 October 2026

Code base: `ce2524532f30fc74dff02d384424f4293ed457d5`.
Shared theme: 1.0.3 from homepage
`8cdbbf675dc83d14bb9490b5222b36c10c5670c2`.
Work is limited to the static website and its separate workflow; no model,
OpenCode runtime, editor extension, host network or live service was changed.

## Build, sources and routes

```sh
python3 website/scripts/build_site.py
python3 website/scripts/check_site.py
python3 -m http.server 8775 --bind 127.0.0.1 --directory website/preview
# http://127.0.0.1:8775/volparossa-code/
```

- Offline preview and explicit production build/check pass.
- Two preview builds have identical SHA-256 contents across all 111 output files.
- Production metadata passes for both `https://volparossa.org` and
  `https://volparossa.github.io`, under `/volparossa-code/`.
- Local assets, links, section anchors, notices, single H1, English language,
  canonical, preview indexing and production sitemap pass the artifact checker.
- Vendored theme files and original Lucide geometry match their pinned hashes.
- Masters, mockups, build briefs, source code, package tools and QA are excluded
  from public output. No CNAME, root robots policy or external runtime assets.
- Primary external destinations return HTTP 200. The central `/docs/#applications`
  anchor and its actual Code integration link were verified; both evidence
  section anchors match the reviewed OpenCode document headings.

[Build results](../review/build-results.json) ·
[External link observations](../review/external-links.json)

## Browser checks and visual review

`CHROME_PATH=/usr/bin/chromium node website/scripts/browser_check.mjs` passes
all 13 profiles using Chromium 154 and Playwright Firefox:

- Chromium: 320×740, 390×844, 768×1024, 1440×900, 1920×1080, 844×390 landscape.
- Firefox: 390×844, 1440×900 and 2560×1440.
- No JavaScript at 390px; 200% root text at 1440px; 400% reflow equivalent
  (a 1440×900 viewport reduced to 360×225 CSS pixels); raster images blocked.
- No horizontal page overflow, header overlap, missing visible images,
  console errors, failed requests or external subresource requests in normal runs.
- Keyboard skip link reaches main; native disclosure opens from the keyboard;
  menu works without JS, and Escape/outside click enhancements pass with JS.
- Reduced motion disables smooth scrolling. No custom or perpetual animation.
- Zero axe WCAG A/AA, 2.1 AA and 2.2 AA violations at 390 and 1440px.

Actual renders were inspected at the required desktop/mobile widths, with every
scene loaded before full-page capture. The hero preserves the woven fox and loom;
the full authentic TUI remains visible; mobile shows all four workflow fragments
in the same numbered DOM order. Architecture labels distinguish the local route
from the target using text. Evidence, limitations and CTA labels remain readable.
Focus treatment, image descriptions and semantic reading order were reviewed in
addition to the automated scan. This is not a certification or physical-device,
Safari or literal browser-UI zoom test.

The first visual pass exposed busy imagery behind the fourth workflow caption
and mobile letterboxing in cooperation. The registered workbench crop now keeps
captions above the object groups, and the mobile panorama retains its natural
aspect ratio. The cooperation heading overlaps its pale image space on wide
screens to follow the selected concept. The shared ghost-button style provides
the reference's bordered secondary CTA.

The complete proof/scope copy and real upstream TUI need more space than the
concept's abbreviated text and invented editor. Those deliberate differences
preserve the requested content, attribution and development boundaries.

[Desktop page](../review/firefox-1440-full.webp) ·
[Mobile page](../review/firefox-390-full.webp) ·
[Browser results](../review/browser-results.json)

## Performance

Lighthouse 13.6.0, Chromium 154 headless on Linux, Python loopback server,
default simulated mobile throttling. This is a local lab measurement, not
production user-experience data.

| Metric | Mobile result |
| --- | ---: |
| Performance | 95 |
| Accessibility | 100 |
| Best practices | 100 |
| First contentful paint | 1.2 s |
| Largest contentful paint | 2.9 s |
| Total blocking time | 0 ms |
| Cumulative layout shift | 0.000023 |
| Lighthouse measured transfer | 352 KiB |

Browser Resource Timing at 390px/DPR 1 records **232,938 bytes** initially,
including navigation HTML, fonts, CSS, JS, hero and any nearby lazy resources
requested by the browser. The Python server does not compress text. Local font
transfer is 47,140 bytes. Fully scrolled image transfer is **262,680 bytes** on
mobile and **607,684 bytes** at 1920px; these are actual selected derivatives,
not the sum of all exported variants. HTML/CSS/JS total **18,594 bytes gzip**.
Both the 1.5MB initial-mobile and 4MB/6MB image budgets are comfortably met.

[Lighthouse settings and metrics](../review/lighthouse-summary.json)

## Publication preparation

The Pages API was read only: it reports the existing GitHub Actions source,
no custom CNAME on this project, and the intended project URL. The new workflow
uses pinned actions, read-only PR validation and a separate manual main-only
deployment with job-scoped Pages/OIDC permissions, following
[GitHub's custom-workflow guidance](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

No deployment was dispatched, no PR merged and no central Code publication flag
enabled. The reviewed production build and publication steps are ready in
[README.md](../README.md). Hosted source/website check results and the downloadable
preview artifact are recorded in the pull request when available.
