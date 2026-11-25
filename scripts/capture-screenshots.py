#!/usr/bin/env python3
"""
Capture the eight deck screenshots straight out of the running prototype.

Every shot is cropped to the exact aspect ratio of the frame it occupies in
docs/Vistara-TVSCredit-Round2.pptx, so python-pptx never letterboxes or
stretches it, and every crop is centred on the page's own content container so
nothing is clipped off the right edge.

    npm run build && PORT=3210 npm run start
    .venv/bin/python scripts/capture-screenshots.py

Uses playwright driving the installed Google Chrome (channel="chrome"), so no
separate browser download is required.
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import Error as PWError
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3210"
OUT_DIR = Path(__file__).resolve().parent.parent / "docs" / "screenshots"

# ── Frame aspect ratios. MUST stay in sync with FRAMES in generate-ppt.py ────
A_MOSAIC = 3.27 / 1.95    # 1.677 — the six tiles on slide 7
A_HERO = 12.09 / 4.367    # 2.769 — full-bleed scorecard across slide 8
A_STRIP = 5.55 / 4.52     # 1.228 — all five event strips on slide 9

# The content container every page uses (Tailwind `mx-auto max-w-6xl`).
CONTAINER = ".max-w-6xl"

# Document-relative rect of an element, optionally snapped to the nearest
# card ancestor so a crop lands on the card's own edges rather than on the
# heading text inside it.
RECT_JS = """
([sel]) => {
  let el = window.__vistaraEl;
  if (sel) { const up = el.closest(sel); if (up) el = up; }
  const r = el.getBoundingClientRect();
  return { x: r.x + window.scrollX, y: r.y + window.scrollY,
           width: r.width, height: r.height };
}
"""

SHOTS = [
    {
        "name": "01-landing.png",
        "url": "/",
        "frame": None,            # full-bleed: the hero is edge-to-edge
        "anchor": None,
        "aspect": A_MOSAIC,
        "mode": "width",
        "note": "landing hero",
    },
    {
        "name": "02-apply-form.png",
        "url": "/apply",
        "anchor": "text=Who is applying",
        "closest": ".rounded-card",
        "aspect": A_MOSAIC,
        "mode": "width",
        "pad_top": 0,
        "note": "step 1 — identity, no documents asked",
    },
    {
        "name": "03-consent.png",
        "url": "/apply",
        # /apply is a real three-step wizard: the consent step does not exist
        # in the DOM until step 1 validates, so fill it in as the hero.
        "actions": [
            ("fill", "input[placeholder='Lakshmi Narayanan']", "Karthik R."),
            ("fill", "input[placeholder='34']", "32"),
            ("select", "select", "small_merchant"),
            ("fill", "input[placeholder='28,000']", "38000"),
            ("click", "text=Continue to consent"),
        ],
        "anchor": "text=Step 2",
        "closest": ".rounded-card",
        "aspect": A_MOSAIC,
        "mode": "width",
        "pad_top": 0,
        "note": "step 2 — AA consent, five signals",
    },
    {
        "name": "04-score-hero.png",
        "url": "/score",
        "anchor": "text=Vistara score",
        "closest": ".rounded-card",
        "aspect": A_HERO,
        "mode": "height",         # fit the whole card, derive width from it
        "note": "708 · Near Prime · bureau No hit",
    },
    {
        "name": "05-score-strips.png",
        "url": "/score",
        "anchor": "text=Vehicle Service Rhythm",
        "aspect": A_STRIP,
        "mode": "width",
        "pad_top": 16,
        "note": "all five 18-month event strips",
    },
    {
        "name": "06-score-factors.png",
        "url": "/score",
        "anchor": "text=Consistency index by domain",
        "closest": ".rounded-card",
        "aspect": A_MOSAIC,
        "mode": "width",
        "pad_top": 0,
        "note": "consistency index + band and weight per signal",
    },
    {
        "name": "07-path-to-prime.png",
        "url": "/score",
        "anchor": "text=Path to prime",
        "aspect": A_MOSAIC,
        "mode": "width",
        "pad_top": 22,
        "note": "the 42 points to Prime",
    },
    {
        "name": "08-method.png",
        "url": "/method",
        "anchor": "text=Cross-domain coherence",
        "closest": ".rounded-card",
        "aspect": A_MOSAIC,
        "mode": "width",
        "pad_top": 0,
        "note": "coherence — the geometric-mean argument",
    },
]

PAD_X = 22       # breathing room either side of the container
PAD_EDGE = 12    # breathing room above/below a snapped card


def rect_of(page, selector: str, closest: str | None):
    """Document-relative rect of the first match, optionally snapped upward."""
    loc = page.locator(selector).first
    loc.wait_for(state="attached", timeout=8000)
    loc.scroll_into_view_if_needed(timeout=8000)
    loc.evaluate("el => { window.__vistaraEl = el; }")
    return page.evaluate(RECT_JS, [closest])


def capture() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = 0

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome")
        page = browser.new_page(
            viewport={"width": 1440, "height": 1100},
            device_scale_factor=3,
            color_scheme="dark",
        )

        for shot in SHOTS:
            name = shot["name"]
            url = BASE + shot["url"]
            try:
                page.goto(url, wait_until="networkidle", timeout=30000)
            except PWError as exc:
                print(f"  ✗ {name}: cannot load {url} — {exc}")
                continue

            # Let webfonts settle; a first-paint capture can use fallback
            # metrics and land the crop a few pixels off.
            try:
                page.evaluate("document.fonts && document.fonts.ready")
            except PWError:
                pass
            page.wait_for_timeout(450)

            # Drive any interaction the shot needs (wizard steps, toggles).
            failed = False
            for action in shot.get("actions", []):
                kind, selector = action[0], action[1]
                value = action[2] if len(action) > 2 else None
                try:
                    target = page.locator(selector).first
                    if kind == "fill":
                        target.fill(value, timeout=8000)
                    elif kind == "select":
                        target.select_option(value, timeout=8000)
                    elif kind == "click":
                        target.click(timeout=8000)
                    page.wait_for_timeout(320)
                except PWError as exc:
                    print(f"  ✗ {name}: {kind} on {selector!r} failed — {exc}")
                    failed = True
                    break
            if failed:
                continue
            page.wait_for_timeout(350)

            page_w = float(page.evaluate("document.documentElement.scrollWidth"))
            page_h = float(page.evaluate("document.documentElement.scrollHeight"))

            # Horizontal extent comes from the content container, so every
            # crop has even left/right margins and clips nothing.
            frame_sel = shot.get("frame", CONTAINER)
            if frame_sel is None:
                fx, fw = 0.0, page_w
            else:
                try:
                    fr = rect_of(page, frame_sel, None)
                except PWError as exc:
                    print(f"  ✗ {name}: container {frame_sel!r} missing — {exc}")
                    continue
                fx, fw = fr["x"], fr["width"]

            # Vertical anchor.
            if shot["anchor"] is None:
                ar = {"x": fx, "y": 0.0, "width": fw, "height": 0.0}
            else:
                try:
                    ar = rect_of(page, shot["anchor"], shot.get("closest"))
                except PWError as exc:
                    print(f"  ✗ {name}: anchor {shot['anchor']!r} not found — {exc}")
                    continue

            aspect = float(shot["aspect"])
            if shot["mode"] == "height":
                # Fit the anchored element in full, then derive the width.
                ch = ar["height"] + 2 * PAD_EDGE
                cw = ch * aspect
                cy = ar["y"] - PAD_EDGE
                cx = ar["x"] + ar["width"] / 2.0 - cw / 2.0
            else:
                cw = min(fw + 2 * PAD_X, page_w)
                ch = cw / aspect
                cx = fx - PAD_X
                cy = ar["y"] - float(shot.get("pad_top", 0))

            # Clamp inside the document on both axes.
            cx = max(0.0, min(cx, page_w - cw))
            cy = max(0.0, min(cy, max(0.0, page_h - ch)))
            if ch > page_h:
                print(f"  ! {name}: page shorter than crop, capturing what exists")
                ch = page_h

            path = OUT_DIR / name
            page.screenshot(
                path=str(path),
                full_page=True,
                clip={"x": cx, "y": cy, "width": cw, "height": ch},
                animations="disabled",
            )
            got = shot["aspect"]
            kb = path.stat().st_size / 1024
            print(
                f"  ✓ {name:<22} {int(cw)}×{int(ch)} css · a/r {got:.3f} "
                f"· {kb:5.0f} KB · {shot['note']}"
            )
            written += 1

        browser.close()

    print(f"\nCaptured {written} / {len(SHOTS)} screenshots into docs/screenshots/")
    return 0 if written == len(SHOTS) else 1


if __name__ == "__main__":
    try:
        sys.exit(capture())
    except KeyboardInterrupt:
        sys.exit(130)
