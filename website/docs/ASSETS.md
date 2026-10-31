# Code assets — The Loom of Ideas

The selected loom concept controls composition and materials. The original
VOLPAROSSA emblem, library, harbour and crystal references were viewed for brand
continuity; their environments were not reused. The extra loom inspiration is a
reference only, with no publication-rights claim. No full mockup section or
generated interface is shipped as page content.

## New scenes

Four original clean images were generated on 31 October 2026 using OpenAI image
generation. Exact prompts, reference identities and output filenames are in
[generation.json](../masters/generation.json). Masters are kept unchanged under
`website/masters/` and excluded from public output. The later scenes use the new
hero as a reference to retain its fox profile, cloth, wood and brass character.

| Master | Native dimensions | Composition and treatment |
| --- | --- | --- |
| hero-loom.png | 1774×887 | Dark left copy space; walnut/brass mechanism and woven fox head on the right. Desktop retains the full master. Mobile crop `(850,0)–(1774,887)` retains the machine and fox together. |
| workflow-bench.png | 2172×724 | Four equally spaced object groups. Desktop crop `(0,170)–(2172,724)` removes excess background so HTML captions stay above the scene. Four registered mobile fragments follow the same ordered list. |
| cooperation-loom.png | 2023×777 | Three stations and one shared loom, bright ivory workshop, elevated viewpoint. Full image; HTML roles and architecture carry the actual meaning. |
| woven-fox-detail.png | 2172×724 | The same woven fox in amber light, dark left space. Mobile crop `(1030,0)–(2172,724)` retains the full fox head and shuttle. |

No letters, numbers, UI, buttons or labels were generated into these assets.
The workflow sketchbook contains non-letter geometric drawings. Wax seals and
decorative stars have no status or verification meaning. Real proof labels and
all explanation, numbering and controls are HTML; exact icon geometry is SVG.

[export_images.py](../scripts/export_images.py) records every crop in source
pixels, resamples without enlarging masters and emits AVIF, WebP and JPEG.
Widths and heights travel with each picture source to prevent aspect-ratio
layout shifts. Desktop/mobile focal positions and overlap rules live in the
Code stylesheet. The 1200×630 social JPEG crops only the clean new hero, with
no generated text or browser chrome.

[asset-manifest.json](../asset-manifest.json) records sizes, dimensions, crop
boxes and SHA-256 digests for every asset and master. The small local paper SVG
is reused from the Cloud website at `a87a55635d59fe853ba39240931022d4d44cd20a`;
it is a decorative procedural grain, not source artwork from the reference.

## Shared and upstream assets

The exact source-only theme comes from homepage
`8cdbbf675dc83d14bb9490b5222b36c10c5670c2`, version 1.0.3. Its full original
file inventory, source templates, renderer, fonts and notices are preserved in
[theme-version.json](../vendor/volparossa-theme/theme-version.json). The builder
refuses altered vendor files. The original emblem shape and upstream mark
proportions/colours remain unchanged.

No verified integration screenshot exists in the inspected repository. The
permitted fallback is the actual upstream OpenCode TUI, copied byte-for-byte
from that same reviewed homepage commit as `assets/upstream/code-screen.webp`
(800×557). It retains the full relevant terminal content and is explicitly
captioned “OpenCode interface example. The VOLPAROSSA integration is in
development.” It is not a representation of a completed VOLPAROSSA integration.

The original screenshot source is `anomalyco/opencode`,
`packages/web/src/assets/lander/screenshot.png`, Git blob
`b9d8bf4df1319cb4d378b7bda73002e4fc621860`, original SHA-256
`14b01372a2589a120ab0d6a0510868e71bceadcbd1f1278fb099d700a03912cb`.
The homepage's existing treatment crops outer window padding and resizes;
this page performs no further screenshot alteration. The original OpenCode
mark is separately vendored from the shared export. Its MIT notice remains
`assets/upstream/OPENCODE-LICENSE.txt`; no endorsement is implied.

Lucide icons are original SVGs from fixed commit
`a630cec77eac6568b989e87e4947a8bfe45caacd`; Git blob identities are verified
in [source.json](../assets/icons/lucide/source.json) and the ISC license is
retained. Only decorative root attributes are added when embedding them.
The GitHub mark retains its Primer Octicons MIT notice. Cormorant Garamond and
Inter are served locally with their SIL Open Font License notices.

Original project code retains GPL-3.0-only. Third-party fonts, icons, brands and
screenshots keep their own notices and terms. The CTA links a concise public
[credits file](../assets/CREDITS.txt); the shared footer remains intact. There
are no image-service hotlinks, trackers, external fonts or visitor-time AI calls.
