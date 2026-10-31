#!/usr/bin/env python3
"""Maintainer exports using Pillow 12.3.0; never required by the site build."""
import argparse
import hashlib
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets/code'
# All coordinates are in untouched master pixels. No generated letters or UI.
COMPOSITIONS = {
    'hero-loom': {'master': 'hero-loom', 'desktop': ((0, 0, 1774, 887), [960, 1440, 1774]), 'mobile': ((850, 0, 1774, 887), [480, 768])},
    'workflow-bench': {'master': 'workflow-bench', 'desktop': ((0, 170, 2172, 724), [960, 1600, 2172])},
    'cooperation-loom': {'master': 'cooperation-loom', 'desktop': ((0, 0, 2023, 777), [800, 1400, 2023])},
    'woven-fox-detail': {'master': 'woven-fox-detail', 'desktop': ((0, 0, 2172, 724), [800, 1400, 2172]), 'mobile': ((1030, 0, 2172, 724), [480, 800])},
    'step-1': {'master': 'workflow-bench', 'desktop': ((0, 200, 575, 675), [480, 575])},
    'step-2': {'master': 'workflow-bench', 'desktop': ((535, 190, 1130, 680), [480, 595])},
    'step-3': {'master': 'workflow-bench', 'desktop': ((1110, 210, 1665, 690), [480, 555])},
    'step-4': {'master': 'workflow-bench', 'desktop': ((1630, 185, 2172, 690), [480, 542])},
}


def inventory():
    manifest = {'compositions': COMPOSITIONS, 'social_crop': [84, 0, 1774, 887], 'files': {}}
    for directory in [ROOT / 'masters', ROOT / 'assets']:
        for p in sorted(directory.rglob('*')):
            if not p.is_file():
                continue
            record = {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
            if p.suffix in ['.png', '.jpg', '.webp', '.avif']:
                with Image.open(p) as im:
                    record['width'], record['height'] = im.size
            manifest['files'][p.relative_to(ROOT).as_posix()] = record
    (ROOT / 'asset-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


def export():
    OUT.mkdir(parents=True, exist_ok=True)
    variants = {}
    for name, plan in COMPOSITIONS.items():
        source = Image.open(ROOT / 'masters' / (plan['master'] + '.png')).convert('RGB')
        variants[name] = {}
        for kind in ['desktop', 'mobile']:
            if kind not in plan:
                continue
            box, widths = plan[kind]
            crop = source.crop(box)
            variants[name][kind] = []
            for width in widths:
                assert width <= crop.width, 'Do not enlarge source pixels'
                size = (width, round(width * crop.height / crop.width))
                image = crop.resize(size, Image.Resampling.LANCZOS)
                stem = f'{name}-{kind}-{width}'
                image.save(OUT / (stem + '.avif'), quality=57, speed=6)
                image.save(OUT / (stem + '.webp'), quality=83, method=6)
                image.save(OUT / (stem + '.jpg'), quality=84, optimize=True, progressive=True)
                variants[name][kind].append({'stem': stem, 'width': size[0], 'height': size[1]})
    hero = Image.open(ROOT / 'masters/hero-loom.png').convert('RGB').crop((84, 0, 1774, 887))
    hero.resize((1200, 630), Image.Resampling.LANCZOS).save(OUT / 'social.jpg', quality=85, optimize=True)
    (OUT / 'variants.json').write_text(json.dumps(variants, indent=2) + '\n')
    inventory()
    print('Exported responsive scenes and registered dimensions, crops and hashes.')


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--inventory-only', action='store_true')
    args = p.parse_args()
    inventory() if args.inventory_only else export()
