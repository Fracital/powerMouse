#!/usr/bin/env python3
"""
bench/charts.py - turn a results directory from run.mjs into SVG charts and an HTML report.

    python3 -I bench/charts.py bench/results/<run> [--png]

Reads <run>/results.json and writes <run>/charts/<name>.svg plus <name>-dark.svg (self-contained,
light and dark), <run>/report.html (both themes, hover tooltips, a table view under every chart)
and <run>/contact-sheet.html (every screenshot, site by row). --png also rasterises each SVG to
<name>.png and <name>-dark.png, and the contact sheet to charts/contact-sheet.png (or .jpg when a
PNG would be too large), with headless Chromium: $CHROME if set, else the first of chromium-browser,
google-chrome, google-chrome-stable, chromium or chrome on PATH.

Every part of results.json may be missing or partial: a chart without data is skipped, and a row
without a value is drawn as DNF (a stat whose median is null), n/a (not measured) or its verdict.
No dependencies beyond the standard library.
"""
import concurrent.futures
import html
import json
import math
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

# ------------------------------------------------------------------------------ palette (dataviz)
# holyWisp's palette and slot scheme (bench/charts.py there), so the two benchmarks read as siblings.
# The home project takes s1 blue as holyWisp does; the rivals take the next strongest slots,
# scramjet s2 orange and Ultraviolet s3 aqua; the STomp variants take s4 and s7 the way holyWisp's
# variant row does; the two older proxies take s8 red and s6 green, the pair the validator passes
# after aqua (s5 magenta next to aqua fails the dark CVD check). native is the muted grey reference.
# Checked with the dataviz validator in the canonical row order:
#   light "#2a78d6,#eda100,#6250d6,#eb6834,#1baf7a,#e34948,#008300"
#   dark  "#3987e5,#c98500,#9085e9,#d95926,#199e70,#e66767,#008300"
# no hard FAIL in either mode; CVD sits in the 6 to 8 warn band for aqua against red, and yellow and
# aqua are below 3:1 on the light surface. Bars are sorted best-first, so neighbours change from
# group to group: every bar therefore carries its row name, and every chart has a table view.
ROW_ORDER = ["native", "stomp-js", "stomp-wasm", "stomp-noadblock", "scramjet", "ultraviolet", "stompv1",
             "powermouse-v1"]
ROW_SLOT = {"native": "muted", "stomp-js": "s1", "stomp-wasm": "s4", "stomp-noadblock": "s7", "scramjet": "s2",
            "ultraviolet": "s3", "stompv1": "s8", "powermouse-v1": "s6"}
SPARE_SLOTS = ["s5"]  # rows outside the fixed list, then the muted grey
LIGHT = {"s1": "#2a78d6", "s2": "#eb6834", "s3": "#1baf7a", "s4": "#eda100", "s5": "#e87ba4", "s6": "#008300",
         "s7": "#6250d6", "s8": "#e34948",
         "surface": "#fcfcfb", "ink": "#0b0b0b", "ink2": "#52514e", "muted": "#898781", "grid": "#e1e0d9", "axis": "#c3c2b7"}
DARK = {"s1": "#3987e5", "s2": "#d95926", "s3": "#199e70", "s4": "#c98500", "s5": "#d55181", "s6": "#008300",
        "s7": "#9085e9", "s8": "#e66767",
        "surface": "#1a1a19", "ink": "#f0efec", "ink2": "#c3c2b7", "muted": "#898781", "grid": "#2c2c2a", "axis": "#383835"}
PAGE = {"light": {"page": "#f9f9f7", "border": "rgba(11,11,11,0.10)", "code": "#f0efec"},
        "dark": {"page": "#0d0d0d", "border": "rgba(255,255,255,0.10)", "code": "#262624"}}
THEMES = {"light": LIGHT, "dark": DARK}
# Verdicts are states, so they wear the fixed status scale, always with a glyph and a label.
# boot-fail (the proxy never came up) is a dark neutral and native-fail (the site is down without a
# proxy too, so it is left out of every count) a light one.
VERDICTS = [  # key, label, glyph
    ("pass", "pass", "✓"), ("partial", "partial", "~"), ("challenge", "bot challenge", "?"),
    ("fail", "fail", "✗"), ("boot-fail", "boot fail", "!"), ("native-fail", "fails natively", "-"),
]
VERDICT_COLORS = {
    "light": {"pass": "#0ca30c", "partial": "#fab219", "challenge": "#ec835a", "fail": "#d03b3b",
              "boot-fail": "#52514e", "native-fail": "#e1e0d9"},
    "dark": {"pass": "#0ca30c", "partial": "#fab219", "challenge": "#ec835a", "fail": "#d03b3b",
             "boot-fail": "#c3c2b7", "native-fail": "#383835"},
}
# sequential blue, steps 100 to 700; dark mode flips the anchor so low values recede into the surface
SEQ = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf",
       "#1c5cab", "#184f95", "#104281", "#0d366b"]
FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif'
W = 960
TABULAR = 'font-variant-numeric="tabular-nums"'
HALO = 'stroke="var(--surface)" stroke-width="4" stroke-linejoin="round" paint-order="stroke"'


def luminance(hex_):
    def lin(c):
        c = int(c, 16) / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    h = hex_.lstrip("#")
    return 0.2126 * lin(h[0:2]) + 0.7152 * lin(h[2:4]) + 0.0722 * lin(h[4:6])


def ink_on(hex_):
    """Label colour inside a fill: white, or near-black on light fills (yellow, warning)."""
    return "#0b0b0b" if luminance(hex_) > 0.4 else "#ffffff"


def css_id(row):
    return re.sub(r"[^a-z0-9-]", "-", str(row).lower())


def theme_tokens(mode, rows):
    t = {k: v for k, v in THEMES[mode].items() if not re.fullmatch(r"s\d", k)}
    t.update(PAGE[mode])
    spare = list(SPARE_SLOTS)
    for row in rows:
        slot = ROW_SLOT.get(row) or (spare.pop(0) if spare else "muted")
        c = THEMES[mode][slot]
        t[f"r-{css_id(row)}"] = c
        t[f"ri-{css_id(row)}"] = ink_on(c)
    for key, c in VERDICT_COLORS[mode].items():
        t[f"v-{key}"] = c
        t[f"vi-{key}"] = ink_on(c) if key != "native-fail" else t["ink2"]
    steps = SEQ if mode == "light" else SEQ[::-1]
    for i, c in enumerate(steps):
        t[f"q{i}"] = c
        t[f"qi{i}"] = ink_on(c)
    return t


def tokens_css(t):
    return "".join(f"--{k}:{v};" for k, v in t.items())


def row_fill(row):
    return f"var(--r-{css_id(row)})"


def row_ink(row):
    return f"var(--ri-{css_id(row)})"


def seq_step(v):
    """0..100 -> (fill, ink) of the sequential ramp."""
    i = max(0, min(len(SEQ) - 1, round(v / 100 * (len(SEQ) - 1))))
    return f"var(--q{i})", f"var(--qi{i})"


# ------------------------------------------------------------------------------ formatting
def esc(s):
    return html.escape(str(s), quote=True)


def num(v):
    if v is None:
        return "DNF"
    a = abs(v)
    if a >= 100 or float(v).is_integer():
        return f"{v:,.0f}"
    return f"{v:.1f}" if a >= 10 else f"{v:.2f}"


def nbytes(b):
    if b is None:
        return "n/a"
    if b >= 1024 * 1024:
        return f"{b / 1048576:.2f} MiB"
    return f"{b / 1024:,.0f} KiB" if b >= 10240 else f"{b / 1024:.1f} KiB"


def pct(v):
    return "n/a" if v is None else f"{v * 100:.0f}"


def text_w(s, size):
    return len(str(s)) * size * 0.56


def wrap(s, chars):
    out, line = [], ""
    for word in str(s).split():
        if line and len(line) + 1 + len(word) > chars:
            out.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    return out + ([line] if line else [])


def nice_ticks(vmax, n=5, integer=False):
    if not vmax or vmax <= 0:
        return [0, 1]
    raw = vmax / n
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        step = m * mag
        if vmax / step <= n:
            break
    if integer:
        step = max(1, round(step))
    ticks, t = [], 0
    while t <= vmax + 1e-9:
        ticks.append(round(t, 6))
        t += step
    if ticks[-1] < vmax:
        ticks.append(round(t, 6))
    return ticks


def tick_label(v, ticks):
    if max(ticks) >= 10000:
        return f"{v / 1000:g}K" if v else "0"
    return f"{v:,.0f}" if float(v).is_integer() else f"{v:g}"


def med(st):
    return st.get("median") if isinstance(st, dict) else None


# ------------------------------------------------------------------------------ SVG builder
class SVG:
    """Tiny SVG builder. Marks get data-tip attributes; the report's JS turns them into tooltips,
    and a <title> child gives standalone files a native hover text. The theme is a style
    attribute of CSS custom properties on the root, filled in per variant at write time."""

    def __init__(self, title, w=W):
        self.w, self.title, self.parts = w, title, []

    def add(self, s):
        self.parts.append(s)

    def text(self, x, y, s, size=12, fill="var(--ink2)", anchor="start", weight="normal", extra=""):
        self.add(f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{fill}" text-anchor="{anchor}" '
                 f'font-weight="{weight}" {extra}>{esc(s)}</text>')

    def line(self, x1, y1, x2, y2, stroke="var(--grid)", width=1, extra=""):
        self.add(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{stroke}" '
                 f'stroke-width="{width}" {extra}/>')

    def bar_h(self, x, y, w, h, fill, tip, rounded=True):
        # 4px rounded data end, square at the baseline; interior stack segments stay square.
        if w <= 0:
            return
        r = min(4, w / 2, h / 2) if rounded else 0
        d = (f"M{x:.1f},{y:.1f} H{x + w - r:.1f} Q{x + w:.1f},{y:.1f} {x + w:.1f},{y + r:.1f} "
             f"V{y + h - r:.1f} Q{x + w:.1f},{y + h:.1f} {x + w - r:.1f},{y + h:.1f} H{x:.1f} Z")
        self.add(f'<path class="mark" d="{d}" fill="{fill}" data-tip="{esc(tip)}"><title>{esc(tip)}</title></path>')

    def cell(self, x, y, w, h, fill, tip, rx=3):
        self.add(f'<rect class="mark" x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx}" '
                 f'fill="{fill}" data-tip="{esc(tip)}"><title>{esc(tip)}</title></rect>')

    def header(self, title, subtitle):
        self.text(24, 30, title, 17, "var(--ink)", weight="600")
        y = 50
        for ln in wrap(subtitle, 135):
            self.text(24, y, ln, 12, "var(--muted)")
            y += 16
        return y + 14

    def legend(self, y, items):
        """items: [(fill, label, shape)] with shape rect, line or ramp (fill is then a list of colours
        drawn as one strip, label a (low, high) pair); wraps; returns the bottom y."""
        cx = 24
        for fill, label, shape in items:
            if shape == "ramp":
                lo, hi = label
                self.text(cx, y, lo, 12)
                cx += text_w(lo, 12) * 0.95 + 8
                for c in fill:
                    self.add(f'<rect x="{cx:.1f}" y="{y - 9}" width="14" height="10" fill="{c}"/>')
                    cx += 14
                self.text(cx + 8, y, hi, 12)
                cx += 8 + text_w(hi, 12) + 18
                continue
            iw = 15 + text_w(label, 12) * 0.95 + 16
            if cx + iw > self.w - 24 and cx > 24:
                cx, y = 24, y + 20
            if shape == "line":
                self.line(cx, y - 4, cx + 10, y - 4, fill, 2, 'stroke-linecap="round"')
            else:
                self.add(f'<rect x="{cx}" y="{y - 9}" width="10" height="10" rx="2" fill="{fill}"/>')
            self.text(cx + 15, y, label, 12)
            cx += iw
        return y + 14

    def done(self, h):
        h = math.ceil(h)
        head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {h}" width="{self.w}" height="{h}" '
                f'role="img" aria-label="{esc(self.title)}" font-family=\'{FONT}\' style="__THEME__">'
                f'<rect width="{self.w}" height="{h}" fill="var(--surface)"/>')
        return "\n".join([head] + self.parts + ["</svg>"])


def best_first(rows, value_of, higher_better=False):
    """native first as the reference, then rows with a value best-first, then DNF, then not measured."""
    rest = [r for r in rows if r != "native"]
    have = sorted([r for r in rest if value_of(r) is not None], key=value_of, reverse=higher_better)
    return [r for r in rows if r == "native"] + have + [r for r in rest if value_of(r) is None]


def row_legend(rows, labels):
    rows = sorted(rows, key=lambda r: ROW_ORDER.index(r) if r in ROW_ORDER else len(ROW_ORDER))
    return [(row_fill(r), labels[r] + (" (reference)" if r == "native" else ""), "rect") for r in rows]


# ------------------------------------------------------------------------------ chart forms
def stat_bars(title, subtitle, groups, rows, labels, higher_better=False, shared=False):
    """Grouped horizontal bars with whiskers. groups: [{key, label, unit, rows: {row: STAT}}].
    One axis for all groups when they share a unit and a range (or shared=True and one unit),
    otherwise each group gets its own axis (small multiples). Within a group the bars run best-first
    under native's grey reference bar, which is also drawn as a hairline across the group, and the
    best proxy is labelled. DNF and not-measured rows come last."""
    rows = [r for r in rows if any(r in g["rows"] for g in groups)]
    if not rows or not groups:
        return None
    bar, gap, left, right = 14, 2, 200, 120

    def gmax(g):
        vals = [x for st in g["rows"].values() if isinstance(st, dict)
                for x in (st.get("median"), st.get("max")) if x is not None]
        return max(vals) if vals else 0

    maxes = [gmax(g) for g in groups]
    units = {g.get("unit", "") for g in groups}
    pos = [m for m in maxes if m > 0]
    per_group = len(units) > 1 or (not shared and pos and max(pos) / min(pos) > 4)
    svg = SVG(title)
    y = svg.header(title, subtitle)
    x0, x1 = left, W - right
    shared_ticks = nice_ticks(max(maxes) if maxes else 1)
    block_h = len(rows) * (bar + gap)
    for gi, g in enumerate(groups):
        unit = g.get("unit", "")
        ticks = nice_ticks(maxes[gi]) if per_group else shared_ticks
        scale = (x1 - x0) / ticks[-1]
        svg.text(24, y + 12, g["label"], 12, "var(--ink)", weight="600")
        by = y + 22
        for t in ticks:
            svg.line(x0 + t * scale, by - 2, x0 + t * scale, by + block_h, "var(--grid)")
        if per_group:
            for i, t in enumerate(ticks):
                lab = tick_label(t, ticks) + (f" {unit}" if i == len(ticks) - 1 else "")
                svg.text(x0 + t * scale, by + block_h + 13, lab, 10, "var(--muted)",
                         "end" if i == len(ticks) - 1 else "middle", extra=TABULAR)
        svg.line(x0, by - 2, x0, by + block_h, "var(--axis)")
        stats = {r: g["rows"].get(r) for r in rows}
        nat = med(stats.get("native"))
        if nat is not None and len(rows) > 1:
            svg.line(x0 + nat * scale, by - 4, x0 + nat * scale, by + block_h + 2, "var(--muted)", 1)
        ok = [med(st) for r, st in stats.items() if r != "native" and med(st) is not None]
        best = (max(ok) if higher_better else min(ok)) if ok else None
        order = best_first(rows, lambda r: med(stats.get(r)), higher_better)
        order.sort(key=lambda r: stats.get(r) is None and r != "native")  # DNF before not measured
        for ri, r in enumerate(order):
            ry = by + ri * (bar + gap)
            svg.text(x0 - 10, ry + bar - 3, labels[r], 11, "var(--ink2)", "end")
            st = stats.get(r)
            v = med(st)
            if st is None:
                svg.text(x0 + 6, ry + bar - 2, "n/a", 10, "var(--muted)", extra=HALO)
                continue
            if v is None:
                why = f"DNF ({st.get('dnf')} of {st.get('dnf')} runs failed)" if st.get("dnf") else "DNF"
                svg.text(x0 + 6, ry + bar - 2, why, 10, "var(--muted)", extra=HALO)
                continue
            lo, hi = st.get("min"), st.get("max")
            tip = f"{labels[r]}, {g['label']}\nmedian {num(v)} {unit}"
            if lo is not None and hi is not None:
                tip += f", runs {num(lo)} to {num(hi)}"
            tip += f" (n={st.get('n', '?')})"
            if st.get("dnf"):
                tip += f", {st['dnf']} failed"
            svg.bar_h(x0, ry, v * scale, bar, row_fill(r), tip)
            end = v
            if lo is not None and hi is not None and hi > lo:
                cy = ry + bar / 2
                svg.line(x0 + lo * scale, cy, x0 + hi * scale, cy, "var(--ink2)", 1)
                svg.line(x0 + lo * scale, cy - 3, x0 + lo * scale, cy + 3, "var(--ink2)", 1)
                svg.line(x0 + hi * scale, cy - 3, x0 + hi * scale, cy + 3, "var(--ink2)", 1)
                end = max(v, hi)
            lx = x0 + end * scale + 7
            if r != "native" and v == best:
                lab = f"{num(v)} {unit}"
                svg.text(lx, ry + bar - 2, lab, 11, "var(--ink)", weight="600", extra=f"{TABULAR} {HALO}")
                lx += text_w(lab, 11) + 8
            if st.get("dnf"):
                svg.text(lx, ry + bar - 2, f"{st['dnf']} of {st['dnf'] + st.get('n', 0)} failed", 10, "var(--muted)",
                         extra=HALO)
        y = by + block_h + (24 if per_group else 14)
    if not per_group:
        scale = (x1 - x0) / shared_ticks[-1]
        for t in shared_ticks:
            svg.text(x0 + t * scale, y + 4, tick_label(t, shared_ticks), 11, "var(--muted)", "middle", extra=TABULAR)
        svg.text(x1, y + 22, groups[0].get("unit", ""), 11, "var(--muted)", "end")
        y += 22
    items = row_legend(rows, labels)
    if "native" in rows:
        items.append(("var(--muted)", "native median", "line"))
    y = svg.legend(y + 26, items)
    return svg.done(y + 6)


def row_bars(title, subtitle, rows, labels, items, unit, axis_max=None, ref=None, ref_label="", higher_better=False):
    """One bar per row, best-first, every bar labelled at its tip. items[row] = {value, text, tip} or None."""
    rows = best_first([r for r in rows if r in items], lambda r: (items[r] or {}).get("value"), higher_better)
    if not rows:
        return None
    bar, gap, left, right = 16, 6, 200, 190
    svg = SVG(title)
    y = svg.header(title, subtitle)
    x0, x1 = left, W - right
    vals = [it["value"] for it in items.values() if it and it.get("value") is not None]
    ticks = nice_ticks(max([axis_max or 0, ref or 0] + vals) or 1)
    scale = (x1 - x0) / ticks[-1]
    h = len(rows) * (bar + gap)
    for t in ticks:
        svg.line(x0 + t * scale, y, x0 + t * scale, y + h, "var(--grid)")
        svg.text(x0 + t * scale, y + h + 16, tick_label(t, ticks), 11, "var(--muted)", "middle", extra=TABULAR)
    svg.text(x1, y + h + 34, unit, 11, "var(--muted)", "end")
    svg.line(x0, y, x0, y + h, "var(--axis)")
    if ref is not None:
        svg.line(x0 + ref * scale, y - 6, x0 + ref * scale, y + h, "var(--muted)", 1)
        svg.text(x0 + ref * scale, y - 9, ref_label, 10, "var(--muted)", "middle")
    for i, r in enumerate(rows):
        ry = y + i * (bar + gap)
        svg.text(x0 - 10, ry + bar - 3, labels[r], 12, "var(--ink2)", "end")
        it = items[r]
        if not it or it.get("value") is None:
            svg.text(x0 + 6, ry + bar - 3, (it or {}).get("text") or "DNF", 11, "var(--muted)", extra=HALO)
            continue
        v = it["value"]
        svg.bar_h(x0, ry, v * scale, bar, row_fill(r), it.get("tip") or f"{labels[r]}: {num(v)} {unit}")
        svg.text(x0 + v * scale + 7, ry + bar - 3, it.get("text") or num(v), 11, "var(--ink)", extra=f"{TABULAR} {HALO}")
    y = svg.legend(y + h + 60, row_legend(rows, labels))
    return svg.done(y + 6)


def stacked_panel(svg, x0, x1, y, rows, labels, segs, data, ends, unit, axis_max, show_labels=True, title=None, div=1):
    """One panel of stacked horizontal bars. segs: [(key, label, fill, ink)] where fill/ink may be
    callables of the row; data[row] = {key: value} or None; ends[row] = text at the bar end. Values
    are divided by div to land on the axis (bytes on a KiB axis)."""
    bar, gap = 20, 8
    if title:
        svg.text(x0, y - 8, title, 12, "var(--ink)", weight="600")
    ticks = nice_ticks(axis_max or 1, 5 if x1 - x0 > 400 else 3, integer=unit == "sites")
    scale = (x1 - x0) / ticks[-1]
    h = len(rows) * (bar + gap)
    for t in ticks:
        svg.line(x0 + t * scale, y, x0 + t * scale, y + h, "var(--grid)")
        svg.text(x0 + t * scale, y + h + 14, tick_label(t, ticks), 10, "var(--muted)", "middle", extra=TABULAR)
    svg.text(x1, y + h + 30, unit, 10, "var(--muted)", "end")
    svg.line(x0, y, x0, y + h, "var(--axis)")
    for i, r in enumerate(rows):
        ry = y + i * (bar + gap)
        if show_labels:
            svg.text(x0 - 10, ry + bar - 6, labels[r], 12, "var(--ink2)", "end")
        d = data.get(r)
        if not d:
            svg.text(x0 + 6, ry + bar - 6, ends.get(r) or "DNF", 11, "var(--muted)")
            continue
        parts = [(k, lab, f, ink, d.get(k) or 0) for k, lab, f, ink in segs if (d.get(k) or 0) > 0]
        total = sum(p[4] for p in parts)
        x = x0
        for j, (k, lab, f, ink, v) in enumerate(parts):
            f = f(r) if callable(f) else f
            ink = ink(r) if callable(ink) else ink
            w = v / div * scale
            last = j == len(parts) - 1
            draw_w = w if last else max(w - 2, 0.5)  # 2px surface gap between segments
            share = f" ({v / total * 100:.0f}%)" if total else ""
            tip = f"{labels[r]}\n{lab}: {d.get('_fmt', {}).get(k) or num(v)}{share}"
            svg.bar_h(x, ry, draw_w, bar, f, tip, rounded=last)
            txt = d.get("_inner", {}).get(k, num(v))
            if text_w(txt, 10) + 8 <= draw_w:
                svg.text(x + 5, ry + bar - 6, txt, 10, ink, extra=TABULAR)
            x += w
        if ends.get(r):
            svg.text(x + 7, ry + bar - 6, ends[r], 11, "var(--ink)", weight="600", extra=f"{TABULAR} {HALO}")
    return y + h + 30


def heat_grid(title, subtitle, row_items, col_items, cells, legend_items, cw=64, ch=22, left=200, gap_before=None):
    """row_items: [(key, label)] where key None is a group heading; col_items: [(key, label)];
    cells[(row_key, col_key)] = (fill, ink, text, tip) or None (drawn as an empty, muted cell)."""
    svg = SVG(title)
    y = svg.header(title, subtitle)
    longest = max([text_w(lab, 11) for _, lab in col_items] + [0])
    rotate = longest > cw - 6
    head_h = (longest * 0.64 + 14) if rotate else 20
    xs, x = [], left
    for ck, _ in col_items:
        if gap_before and ck == gap_before:
            x += 12
        xs.append(x)
        x += cw
    for (ck, lab), cx in zip(col_items, xs):
        if rotate:
            tx, ty = cx + cw / 2 + 4, y + head_h - 6
            svg.text(tx, ty, lab, 11, "var(--ink2)", "start", extra=f'transform="rotate(-40 {tx:.1f} {ty:.1f})"')
        else:
            svg.text(cx + cw / 2, y + head_h - 6, lab, 11, "var(--ink2)", "middle")
    y += head_h + 4
    for rk, rlab in row_items:
        if rk is None:
            y += 6
            svg.text(24, y + 13, rlab, 12, "var(--ink)", weight="600")
            svg.line(24 + text_w(rlab, 12) + 10, y + 9, xs[-1] + cw - 2, y + 9, "var(--grid)")
            y += 20
            continue
        svg.text(left - 10, y + ch / 2 + 4, rlab, 11, "var(--ink2)", "end")
        for (ck, clab), cx in zip(col_items, xs):
            c = cells.get((rk, ck))
            if not c:
                svg.add(f'<rect x="{cx:.1f}" y="{y:.1f}" width="{cw - 2}" height="{ch - 2}" rx="3" fill="none" '
                        f'stroke="var(--grid)"/>')
                svg.text(cx + (cw - 2) / 2, y + ch / 2 + 3, "n/a", 10, "var(--muted)", "middle")
                continue
            fill, ink, txt, tip = c
            svg.cell(cx, y, cw - 2, ch - 2, fill, tip)
            if txt and text_w(txt, 10.5) + 6 <= cw - 2:
                svg.text(cx + (cw - 2) / 2, y + ch / 2 + 3, txt, 10.5, ink, "middle", extra=TABULAR)
        y += ch
    y = svg.legend(y + 30, legend_items)
    return svg.done(y + 6)


def seq_legend(lo_label="0", hi_label="100"):
    return [([f"var(--q{i})" for i in range(len(SEQ))], (lo_label, hi_label), "ramp")]


def verdict_legend(keys):
    return [(f"var(--v-{k})", f"{g} {lab}", "rect") for k, lab, g in VERDICTS if k in keys]


# ------------------------------------------------------------------------------ tables (report)
def table(head, body, first_is_th=True):
    th = "".join(f"<th>{esc(h)}</th>" for h in head)
    rows = []
    for row in body:
        cells = []
        for i, c in enumerate(row):
            if i == 0 and first_is_th:
                cells.append(f"<th>{esc(c)}</th>")
            elif isinstance(c, (int, float)) or c in ("DNF", "n/a") or re.match(r"^[\d,.]+( |$)", str(c)):
                cls = "num dnf" if c in ("DNF", "n/a") else "num"
                cells.append(f'<td class="{cls}">{esc(c)}</td>')
            else:
                cells.append(f"<td>{esc(c)}</td>")
        rows.append("<tr>" + "".join(cells) + "</tr>")
    return f'<div class="tablewrap"><table><thead><tr>{th}</tr></thead><tbody>{"".join(rows)}</tbody></table></div>'


def stat_cell(st):
    if st is None:
        return "n/a"
    v = med(st)
    if v is None:
        return "DNF"
    s = num(v)
    if st.get("min") is not None and st.get("max") is not None:
        s += f" ({num(st['min'])} to {num(st['max'])})"
    if st.get("dnf"):
        s += f", {st['dnf']} DNF"
    return s


def stat_table(groups, rows, labels):
    rows = [r for r in rows if any(r in g["rows"] for g in groups)]
    head = [""] + [f"{g['label']} ({g.get('unit', '')})" for g in groups]
    return table(head, [[labels[r]] + [stat_cell(g["rows"].get(r)) for g in groups] for r in rows])


# ------------------------------------------------------------------------------ the charts
PREFERRED_ORDER = {"first_visit": ["cold", "boot", "warm"], "rewrite": ["in_browser", "offline", "offline_all"],
                   "memory": ["pss_blank_mb", "pss_frames_mb", "heap_blank_mb", "heap_frames_mb", "per_frame_kb"]}


def groups_of(block, prefer=None):
    """A speed block {scenario: {label, unit, lower_better, rows}} -> groups for stat_bars, the
    preferred keys first and the rest in file order."""
    if not isinstance(block, dict):
        return []
    out = []
    keys = [k for k in prefer or [] if k in block] + [k for k in block if k not in (prefer or [])]
    for k in keys:
        g = block.get(k)
        if isinstance(g, dict) and isinstance(g.get("rows"), dict) and g["rows"]:
            out.append({"key": k, "label": g.get("label") or k, "unit": g.get("unit", ""),
                        "lower_better": g.get("lower_better", True), "rows": g["rows"]})
    return out


def verdict_of(res):
    v = (res or {}).get("verdict")
    return v if v in dict((k, 1) for k, _, _ in VERDICTS) else ("fail" if res else None)


def site_charts(data, rows, labels, out):
    ss = data.get("site_support") or {}
    sites = ss.get("sites") or []
    results = ss.get("results") or {}
    summary = ss.get("summary") or {}
    if not sites and results:
        sites = [{"id": k, "category": "other"} for k in results]
    if not sites and not summary:
        return
    site_rows = [r for r in rows if r in summary or any(r in (results.get(s["id"]) or {}) for s in sites)]
    native_down = [s["id"] for s in sites if any(verdict_of(v) == "native-fail"
                                                for v in (results.get(s["id"]) or {}).values())]

    # 1 site-support
    counts, ends, scores = {}, {}, {}
    for r in site_rows:
        sm = summary.get(r) or {}
        c = {"pass": sm.get("pass"), "partial": sm.get("partial"), "challenge": sm.get("challenge"),
             "fail": sm.get("fail"), "boot-fail": sm.get("boot_fail")}
        if all(v is None for v in c.values()):
            c = {k: 0 for k in c}
            for s in sites:
                v = verdict_of((results.get(s["id"]) or {}).get(r))
                if v in c:
                    c[v] += 1
        score = sm.get("score")
        if score is None:
            sc = [(results.get(s["id"]) or {}).get(r, {}).get("score") for s in sites
                  if verdict_of((results.get(s["id"]) or {}).get(r)) not in (None, "native-fail")]
            score = sum(x or 0 for x in sc) / len(sc) if sc else None
        scores[r] = score
        counts[r] = c if sum(v or 0 for v in c.values()) else None
        ends[r] = f"score {pct(score)}" if score is not None else ("no result" if not counts[r] else "")
    if any(counts.values()):
        segs = [(k, lab, f"var(--v-{k})", f"var(--vi-{k})") for k, lab, _ in VERDICTS if k != "native-fail"]
        for r, c in counts.items():
            if c:
                c["_fmt"] = {k: f"{c[k]} sites" for k in c if not k.startswith("_")}
        total = max(sum(v or 0 for k, v in c.items() if not k.startswith("_")) for c in counts.values() if c)
        title = "Site support"
        sub = (f"How many of {total} real sites each proxy loads, by verdict; the number at the end is the mean "
               "score (0 to 100) over the same sites")
        if native_down:
            sub += f". {len(native_down)} sites that fail without a proxy too are left out"
        svg = SVG(title)
        y = svg.header(title, sub)
        ranked = best_first(site_rows, lambda r: scores.get(r), higher_better=True)
        y = stacked_panel(svg, 200, W - 110, y, ranked, labels, segs, counts, ends, "sites", total)
        y = svg.legend(y + 26, verdict_legend([k for k, *_ in segs]))
        tbl = table(["", "pass", "partial", "challenge", "fail", "boot fail", "score", "extra JS errors (median)",
                     "load time vs native (median)"],
                    [[labels[r]] + [(counts[r] or {}).get(k, "n/a") if counts[r] else "n/a"
                                    for k in ("pass", "partial", "challenge", "fail", "boot-fail")]
                     + [pct(scores[r]), num((summary.get(r) or {}).get("extra_js_errors_median"))
                        if (summary.get(r) or {}).get("extra_js_errors_median") is not None else "n/a",
                        f"{(summary.get(r) or {}).get('ttl_ratio_median')}x"
                        if (summary.get(r) or {}).get("ttl_ratio_median") is not None else "n/a"]
                     for r in site_rows])
        out.append(("site-support", "sites", title, svg.done(y + 6), tbl))

    # 2 site-categories
    cats = []
    for s in sites:
        if s.get("category") and s["category"] not in cats:
            cats.append(s["category"])
    for sm in summary.values():
        for c in (sm or {}).get("by_category") or {}:
            if c not in cats:
                cats.append(c)
    n_in = {c: sum(1 for s in sites if s.get("category") == c) for c in cats}
    cat_score = {}
    for r in site_rows:
        bc = (summary.get(r) or {}).get("by_category")
        for c in cats:
            v = bc.get(c) if isinstance(bc, dict) else None
            if v is None and not isinstance(bc, dict):
                sc = [(results.get(s["id"]) or {}).get(r, {}).get("score") for s in sites if s.get("category") == c
                      and verdict_of((results.get(s["id"]) or {}).get(r)) not in (None, "native-fail")]
                v = sum(x or 0 for x in sc) / len(sc) if sc else None
            cat_score[(r, c)] = v
    if cats and any(v is not None for v in cat_score.values()):
        cells = {}
        for (r, c), v in cat_score.items():
            if v is not None:
                f, ink = seq_step(v * 100)
                cells[(r, c)] = (f, ink, pct(v), f"{labels[r]}, {c} ({n_in.get(c, '?')} sites)\nscore {pct(v)}")
        for r in site_rows:
            if scores.get(r) is not None:
                f, ink = seq_step(scores[r] * 100)
                cells[(r, "__all")] = (f, ink, pct(scores[r]), f"{labels[r]}, all sites\nscore {pct(scores[r])}")
        cols = [(c, c) for c in cats] + [("__all", "all sites")]
        cw = max(48, min(76, (W - 224) / (len(cols) + 0.3)))
        svg = heat_grid("Site support by category",
                        "Mean score (0 to 100) of each proxy over the sites of a category, and over all sites at "
                        "the right", [(r, labels[r]) for r in site_rows], cols, cells,
                        seq_legend("score 0", "100"), cw=cw, ch=26, gap_before="__all")
        tbl = table([""] + [f"{c} ({n_in.get(c, 0)})" for c in cats] + ["all"],
                    [[labels[r]] + [pct(cat_score.get((r, c))) for c in cats] + [pct(scores.get(r))]
                     for r in site_rows])
        out.append(("site-categories", "sites", "Site support by category", svg, tbl))

    # 3 site-matrix
    if results and sites:
        row_items, cells, seen = [], {}, set()
        glyph = {k: g for k, _, g in VERDICTS}
        for c in cats + [None]:
            members = [s for s in sites if s.get("category") == c or (c is None and s.get("category") not in cats)]
            if not members:
                continue
            row_items.append((None, c or "other"))
            for s in members:
                row_items.append((s["id"], s["id"]))
                for r in site_rows:
                    res = (results.get(s["id"]) or {}).get(r)
                    v = verdict_of(res)
                    if not v:
                        continue
                    seen.add(v)
                    score = res.get("score")
                    txt = glyph[v] + (f" {pct(score)}" if score is not None and v not in ("boot-fail", "native-fail") else "")
                    cells[(s["id"], r)] = (f"var(--v-{v})", f"var(--vi-{v})", txt, site_tip(s, r, labels, res, v))
        svg = heat_grid("Every site, every proxy",
                        "Verdict per site and proxy, with the score (0 to 100); hover a cell for similarity to "
                        "native, text overlap, errors and timings", row_items,
                        [(r, labels[r]) for r in site_rows], cells, verdict_legend(seen), cw=86, ch=20, left=170)
        body = []
        for rk, rlab in row_items:
            if rk is None:
                continue
            body.append([rlab] + [(lambda res: f"{verdict_of(res)} {pct(res.get('score'))}" if res else "n/a")(
                (results.get(rk) or {}).get(r)) for r in site_rows])
        out.append(("site-matrix", "sites", "Every site, every proxy", svg,
                    table(["site"] + [labels[r] for r in site_rows], body)))


def yn(v):
    return "n/a" if v is None else ("yes" if v else "no")


def site_tip(site, r, labels, res, v):
    lines = [f"{site['id']} ({site.get('category', '?')}), {labels[r]}",
             f"{dict((k, lab) for k, lab, _ in VERDICTS)[v]}, score {pct(res.get('score'))}"]
    if res.get("ssim") is not None or res.get("text_overlap") is not None:
        lines.append(f"SSIM {res.get('ssim', 'n/a')} (vs native {res.get('ssim_rel', 'n/a')}), "
                     f"text overlap {res.get('text_overlap', 'n/a')} (vs native {res.get('text_rel', 'n/a')})")
    if res.get("js_errors") is not None:
        lines.append(f"JS errors {res['js_errors']} (native {res.get('js_errors_native', 'n/a')}), failed requests "
                     f"{res.get('failed_requests', 'n/a')} of {res.get('requests', 'n/a')}, leaks {res.get('leaks', 'n/a')}")
    it = res.get("interaction")
    if isinstance(it, dict):
        lines.append(f"scroll {yn(it.get('scroll'))}, link {yn(it.get('link'))}, search {yn(it.get('search'))}")
    if res.get("ttl_ms") is not None:
        lines.append(f"load {num(res['ttl_ms'])} ms, FCP {num(res.get('fcp_ms'))} ms, LCP {num(res.get('lcp_ms'))} ms")
    if res.get("error"):
        lines.append(f"error: {str(res['error'])[:160]}")
    return "\n".join(lines)


def speed_charts(data, rows, labels, out, repeats):
    sp = data.get("speed") or {}
    rep = f"median of {repeats} runs" if repeats else "median of the runs"
    specs = [
        ("load-fixtures", "fixtures", "Page loads on local fixture pages",
         f"Time until the page has loaded, through each proxy; {rep}, whiskers span min to max; lower is better"),
        ("paint", "paint", "First and largest paint",
         f"First contentful paint and largest contentful paint on the fixture pages; {rep}; lower is better"),
        ("load-real", "real", "Page loads on real sites",
         f"Time until the page has loaded; {rep}, whiskers span min to max; lower is better"),
        ("load-real-lcp", "real_lcp", "Largest paint on real sites",
         f"Largest contentful paint; {rep}, whiskers span min to max; lower is better"),
        ("transfer-real", "real_transfer", "Bytes transferred on real sites",
         f"Bytes over the wire per page load, proxy machinery included; {rep}; lower is better"),
        ("first-visit", "first_visit", "First visit",
         f"Cold: empty cache, the proxy installs its service worker; boot: the proxy's own start-up; warm: the "
         f"second visit; {rep}, whiskers span min to max; lower is better"),
        ("spa", "spa", "Navigation inside a single-page app",
         f"Time per in-app navigation; {rep}; lower is better"),
        ("rewrite", "rewrite", "Rewriter throughput",
         f"Megabytes of page code rewritten per second, in the browser and offline; {rep}; higher is better"),
        ("memory", "memory", "Memory", f"Memory with a blank page and with frames open; {rep}; lower is better"),
        ("cpu", "cpu", "CPU time", f"CPU time spent per page load; {rep}; lower is better"),
        ("transfer", "transfer", "Bytes transferred",
         f"Bytes over the wire per page load, proxy machinery included; {rep}; lower is better"),
    ]
    for name, key, title, sub in specs:
        groups = groups_of(sp.get(key), PREFERRED_ORDER.get(key))
        if not groups:
            continue
        higher = not groups[0].get("lower_better", True)
        if higher:
            sub = sub.replace("lower is better", "higher is better")
        svg = stat_bars(title, sub, groups, rows, labels, higher_better=higher, shared=key == "first_visit")
        if svg:
            out.append((name, "speed", title, svg, stat_table(groups, rows, labels)))
        if key == "real":
            ratio_chart(data, rows, labels, out)
    if not any(n == "load-ratio" for n, *_ in out):
        ratio_chart(data, rows, labels, out)


def ratio_chart(data, rows, labels, out):
    summary = (data.get("site_support") or {}).get("summary") or {}
    items = {}
    for r in rows:
        if r == "native" or r not in summary:
            continue
        v = (summary.get(r) or {}).get("ttl_ratio_median")
        items[r] = {"value": v, "text": f"{v:.2f}x native" if v is not None else "DNF",
                    "tip": f"{labels[r]}: median load time {v:.2f}x native" if v is not None else ""}
    if not any(it["value"] is not None for it in items.values()):
        return
    title = "Load time against native, real sites"
    svg = row_bars(title, "Median over the sites of each proxy's load time divided by native Chrome's on the "
                          "same site; 1 is native speed, lower is better", rows, labels, items, "times native",
                   ref=1, ref_label="native")
    tbl = table(["", "median load time / native"], [[labels[r], items[r]["text"]] for r in rows if r in items])
    out.append(("load-ratio", "speed", title, svg, tbl))


def fidelity_charts(data, rows, labels, out):
    fid = data.get("fidelity") or {}
    checks = fid.get("checks") or []
    results = fid.get("results") or {}
    summary = fid.get("summary") or {}
    title_of = {c.get("id"): c.get("title") or c.get("id") for c in checks}
    group_of = {c.get("id"): c.get("group") or "other" for c in checks}
    groups = []
    for c in checks:
        if group_of[c.get("id")] not in groups:
            groups.append(group_of[c.get("id")])
    for sm in summary.values():
        for g in (sm or {}).get("by_group") or {}:
            if g not in groups:
                groups.append(g)
    frows = [r for r in rows if r in summary or r in results]
    if frows and groups:
        cells, overall = {}, {}
        for r in frows:
            by = dict((summary.get(r) or {}).get("by_group") or {})
            res = results.get(r) or {}
            if not by and res:
                for cid, v in res.items():
                    p = by.setdefault(group_of.get(cid, "other"), [0, 0])
                    p[0] += bool((v or {}).get("pass"))
                    p[1] += 1
            for g in groups:
                pt = by.get(g)
                if not pt or not pt[1]:
                    continue
                failed = [f"{title_of.get(cid, cid)}" + (f": {v.get('note')}" if v.get("note") else "")
                          for cid, v in res.items() if group_of.get(cid) == g and not (v or {}).get("pass")]
                tip = f"{labels[r]}, {g}\n{pt[0]} of {pt[1]} checks pass"
                if failed:
                    tip += "\nfails: " + "; ".join(failed[:8]) + (f"; and {len(failed) - 8} more" if len(failed) > 8 else "")
                f, ink = seq_step(pt[0] / pt[1] * 100)
                cells[(r, g)] = (f, ink, f"{pt[0]}/{pt[1]}", tip)
            sm = summary.get(r) or {}
            p, t = sm.get("passed"), sm.get("total")
            if p is None and by:
                p, t = sum(v[0] for v in by.values()), sum(v[1] for v in by.values())
            overall[r] = (p, t)
            if t:
                f, ink = seq_step(p / t * 100)
                cells[(r, "__all")] = (f, ink, f"{p}/{t}", f"{labels[r]}, all checks\n{p} of {t} pass ({p / t * 100:.0f}%)")
        cols = [(g, g) for g in groups] + [("__all", "all checks")]
        cw = max(52, min(76, (W - 224) / (len(cols) + 0.3)))
        title = "Fidelity"
        svg = heat_grid(title, "Checks that pass, per area: whether a page behind the proxy sees what it would see "
                               "natively (location, cookies, storage, messaging, workers and more)", [(r, labels[r]) for r in frows], cols, cells,
                        seq_legend("0% pass", "100%"), cw=cw, ch=26, gap_before="__all")
        if checks and results:
            body = [[f"{c.get('group', '')}: {title_of[c['id']]}"] +
                    [("pass" if (results.get(r) or {}).get(c["id"], {}).get("pass") else
                      ("fail" + (f" ({results[r][c['id']].get('note')})" if results[r][c["id"]].get("note") else "")))
                     if c["id"] in (results.get(r) or {}) else "n/a" for r in frows] for c in checks]
            tbl = table(["check"] + [labels[r] for r in frows], body)
        else:
            tbl = table([""] + groups + ["all"], [[labels[r]] + [cells.get((r, g), (0, 0, "n/a"))[2] for g in groups]
                                                  + [cells.get((r, "__all"), (0, 0, "n/a"))[2]] for r in frows])
        out.append(("fidelity", "fidelity", title, svg, tbl))

    leaks = fid.get("leaks") or {}
    vectors = leaks.get("vectors") or []
    lres = leaks.get("results") or {}
    lsum = leaks.get("summary") or {}
    vtitle = {v.get("id"): v.get("title") or v.get("id") for v in vectors}
    lrows = [r for r in rows if r in lsum or r in lres]
    if lrows:
        items = {}
        for r in lrows:
            sm = lsum.get(r) or {}
            res = lres.get(r) or {}
            n = sm.get("vectors_leaked")
            if n is None and res:
                n = sum(1 for x in res.values() if x)
            total = sm.get("vectors") or len(vectors) or len(res)
            reqs = sm.get("requests")
            if reqs is None and res:
                reqs = sum(x or 0 for x in res.values())
            leaked = [f"{vtitle.get(k, k)}: {x} request{'s' if x != 1 else ''}" for k, x in res.items() if x]
            tip = f"{labels[r]}: {n} of {total} vectors leak, {reqs} requests past the proxy"
            if leaked:
                tip += "\n" + "\n".join(leaked)
            items[r] = {"value": n, "tip": tip,
                        "text": "DNF" if n is None else f"{n} of {total}, {reqs} request{'s' if reqs != 1 else ''}"}
        title = "Requests that bypass the proxy"
        svg = row_bars(title, "Leak vectors (out of the number tested) for which the page reached the network "
                              "without going through the proxy; lower is better, 0 is the goal", rows, labels, items,
                       "vectors that leak", axis_max=max([len(vectors)] + [(lsum.get(r) or {}).get("vectors") or 0
                                                                            for r in lrows]))
        if vectors:
            tbl = table(["vector"] + [labels[r] for r in lrows],
                        [[v.get("title") or v.get("id")] + [(lres.get(r) or {}).get(v.get("id"), "n/a") for r in lrows]
                         for v in vectors])
        else:
            tbl = table(["", "vectors that leak"], [[labels[r], items[r]["text"]] for r in lrows])
        out.append(("leaks", "fidelity", title, svg, tbl))


def size_chart(data, rows, labels, out):
    size = data.get("size") or {}
    srows = [r for r in rows if isinstance(size.get(r), dict)]
    if not srows:
        return
    roles = ["sw", "client", "transport", "rewriter", "other"]
    role_label = {"sw": "service worker", "client": "client", "transport": "transport", "rewriter": "rewriter",
                  "other": "other"}
    panels = {}
    for kind in ("raw", "br"):
        d, ends = {}, {}
        for r in srows:
            files = size[r].get("files") or []
            by = {}
            for f in files:
                role = f.get("role") if f.get("role") in roles else "other"
                by[role] = by.get(role, 0) + (f.get(kind) or 0)
            total = size[r].get(f"{kind}_total")
            if total is None:
                total = sum(by.values()) if files else None
            if not by and total:
                by = {"other": total}
            if by:
                by["_fmt"] = {k: nbytes(v) for k, v in by.items()}
                by["_inner"] = {k: role_label[k] for k in roles}
                d[r] = by
            ends[r] = nbytes(total) if total else "n/a"
        panels[kind] = (d, ends)
    if not any(p[0] for p in panels.values()):
        return
    srows = best_first(srows, lambda r: sum(v for k, v in (panels["br"][0].get(r) or {}).items()
                                            if not k.startswith("_")) or None)
    title = "What the browser downloads for the proxy itself"
    svg = SVG(title)
    y = svg.header(title, "Service worker, client, transport, rewriter and other files the host page loads, raw "
                          "and brotli-compressed; segments are the parts, the figure at the end is the total")
    segs = [(k, role_label[k], row_fill, row_ink) for k in roles]
    half = (W - 200 - 24) / 2
    yb = y
    for i, (kind, ptitle) in enumerate([("raw", "raw"), ("br", "brotli")]):
        d, ends = panels[kind]
        mx = max([sum(v for k, v in x.items() if not k.startswith("_")) for x in d.values()] + [1])
        div = 2 ** 20 if mx > 2 ** 20 else 1024
        x0 = 200 + i * half
        yb = stacked_panel(svg, x0, x0 + half - 90, y + 18, srows, labels, segs, d, ends, "MiB" if div > 1024 else "KiB",
                           mx / div, show_labels=i == 0, title=ptitle, div=div)
    y = svg.legend(yb + 26, row_legend(srows, labels))
    body = []
    for r in srows:
        files = size[r].get("files") or []
        per = {k: [0, 0] for k in roles}
        for f in files:
            p = per[f.get("role") if f.get("role") in roles else "other"]
            p[0] += f.get("raw") or 0
            p[1] += f.get("br") or 0
        body.append([labels[r], nbytes(size[r].get("raw_total") or sum(p[0] for p in per.values())),
                     nbytes(size[r].get("br_total") or sum(p[1] for p in per.values()))]
                    + [f"{nbytes(per[k][0])} / {nbytes(per[k][1])}" if per[k][0] else "n/a" for k in roles])
    tbl = table(["", "raw", "brotli"] + [f"{role_label[k]} (raw / br)" for k in roles], body)
    out.append(("size", "size", title, svg.done(y + 6), tbl))


# ------------------------------------------------------------------------------ build
def load_rows(data):
    meta = data.get("meta") or {}
    rows = list(data.get("rows") or [])
    for mr in meta.get("rows") or []:
        if mr.get("row") and mr["row"] not in rows:
            rows.append(mr["row"])
    if not rows:
        found = set()
        ss = data.get("site_support") or {}
        found.update(ss.get("summary") or {})
        for v in (ss.get("results") or {}).values():
            found.update(v or {})
        for block in (data.get("speed") or {}).values():
            for g in (block or {}).values():
                found.update((g or {}).get("rows") or {})
        found.update((data.get("fidelity") or {}).get("summary") or {})
        found.update(data.get("size") or {})
        rows = [r for r in ROW_ORDER if r in found] + sorted(found - set(ROW_ORDER))
    labels = {mr.get("row"): mr.get("label") for mr in meta.get("rows") or [] if mr.get("label")}
    labels.update({k: v for k, v in (data.get("labels") or {}).items() if v})
    return rows, {r: labels.get(r) or r for r in rows}


def build(run_dir, png=False):
    run_dir = pathlib.Path(run_dir)
    data = json.loads((run_dir / "results.json").read_text())
    meta = data.get("meta") or {}
    rows, labels = load_rows(data)
    themes = {m: theme_tokens(m, rows) for m in ("light", "dark")}
    charts = []  # (name, section, title, svg, table_html)
    site_charts(data, rows, labels, charts)
    speed_charts(data, rows, labels, charts, meta.get("repeats"))
    fidelity_charts(data, rows, labels, charts)
    size_chart(data, rows, labels, charts)

    out = run_dir / "charts"
    out.mkdir(exist_ok=True)
    for name, _, _, svg, _ in charts:
        (out / f"{name}.svg").write_text(svg.replace("__THEME__", tokens_css(themes["light"]), 1))
        (out / f"{name}-dark.svg").write_text(svg.replace("__THEME__", tokens_css(themes["dark"]), 1))
    sheet = contact_sheet(data, rows, labels, themes)
    if sheet:
        (run_dir / "contact-sheet.html").write_text(sheet)
    (run_dir / "report.html").write_text(report_html(data, meta, rows, labels, themes, charts, bool(sheet)))
    print(f"wrote {len(charts)} charts (light and dark) to {out}, {run_dir / 'report.html'}"
          + (f" and {run_dir / 'contact-sheet.html'}" if sheet else ""))
    if png:
        chrome = find_chrome()
        if not chrome:
            print("no Chromium found: set CHROME=<binary> for --png", file=sys.stderr)
            return
        jobs = [(out / f"{n}{v}.svg", out / f"{n}{v}.png") for n, *_ in charts for v in ("", "-dark")]
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda j: rasterise(chrome, *j), jobs))
        if sheet:
            contact_sheet_image(chrome, data, rows, labels, themes, run_dir, out)
        print(f"rasterised {len(jobs)} charts with {chrome}")


def find_chrome():
    env = os.environ.get("CHROME")
    if env:
        return env
    for exe in ("chromium-browser", "google-chrome", "google-chrome-stable", "chromium", "chrome"):
        path = shutil.which(exe)
        if path:
            return path
    return None


def screenshot(chrome, url, path, w, h, scale=1):
    profile = tempfile.mkdtemp(prefix="charts-chrome-")
    try:
        subprocess.run([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                        "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
                        "--disable-sync", "--mute-audio", f"--user-data-dir={profile}", f"--window-size={w},{h}",
                        f"--force-device-scale-factor={scale}", f"--screenshot={path}", url],
                       check=True, capture_output=True, timeout=120)
        return True
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        print(f"could not rasterise {url}: {e}", file=sys.stderr)
        return False
    finally:
        shutil.rmtree(profile, ignore_errors=True)


def rasterise(chrome, svg_path, png_path, scale=2):
    m = re.search(r'width="(\d+)" height="(\d+)"', svg_path.read_text())
    screenshot(chrome, svg_path.resolve().as_uri(), png_path, int(m.group(1)), int(m.group(2)), scale)


# ------------------------------------------------------------------------------ contact sheet
SHEET_CSS = """
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 24px max(16px, env(safe-area-inset-left, 0px)) 48px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; }
p.lede { margin: 0 0 18px; color: var(--ink2); }
p.lede a { color: inherit; }
.sheet { display: grid; grid-template-columns: var(--label-w) repeat(var(--cols), var(--thumb-w)); gap: 8px 10px; align-items: start; }
.colhead { position: sticky; top: 0; background: var(--page); padding: 6px 0; font-weight: 600; z-index: 2; align-self: stretch; }
.cat { grid-column: 1 / -1; font-weight: 600; font-size: 14px; border-bottom: 1px solid var(--border); padding: 14px 0 4px; height: var(--cat-h); }
.site { padding-top: 4px; overflow-wrap: anywhere; height: var(--row-h); }
.site small { display: block; color: var(--muted); }
.site a { color: inherit; text-decoration: none; }
figure { margin: 0; height: var(--row-h); }
figure .shot { display: block; width: var(--thumb-w); height: var(--thumb-h); border-radius: 4px; overflow: hidden;
  background: var(--surface); border: 3px solid var(--vc); }
figure img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top; }
figure .none { display: grid; place-items: center; width: 100%; height: 100%; color: var(--muted); font-size: 12px; }
figcaption { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--ink2); margin-top: 3px;
  white-space: nowrap; overflow: hidden; }
figcaption i { flex: none; width: 10px; height: 10px; border-radius: 2px; background: var(--vc); }
figcaption b { font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
"""


def contact_sheet(data, rows, labels, themes, thumb_w=160, thumb_h=100, lazy=True, base=""):
    ss = data.get("site_support") or {}
    sites = ss.get("sites") or []
    results = ss.get("results") or {}
    if not sites or not results:
        return None
    cols = [r for r in rows if any(r in (results.get(s["id"]) or {}) for s in sites)]
    vlabel = {k: (lab, g) for k, lab, g in VERDICTS}
    cats = []
    for s in sites:
        if s.get("category", "other") not in cats:
            cats.append(s.get("category", "other"))
    parts = ['<div class="colhead"></div>'] + [f'<div class="colhead">{esc(labels[r])}</div>' for r in cols]
    for c in cats:
        parts.append(f'<div class="cat">{esc(c)}</div>')
        for s in [s for s in sites if s.get("category", "other") == c]:
            url = s.get("url") or ""
            link = f'<a href="{esc(url)}">{esc(s["id"])}</a>' if url else esc(s["id"])
            parts.append(f'<div class="site">{link}<small>{esc(c)}</small></div>')
            for r in cols:
                res = (results.get(s["id"]) or {}).get(r)
                v = verdict_of(res)
                if not v:
                    parts.append('<figure></figure>')
                    continue
                lab, g = vlabel[v]
                score = res.get("score")
                shot = res.get("shot")
                tip = site_tip(s, r, labels, res, v)
                if shot:
                    src = esc(base + shot)
                    img = (f'<a class="shot" href="{src}"><img src="{src}" alt="{esc(s["id"])} through {esc(labels[r])}"'
                           f'{" loading=lazy" if lazy else ""} width="{thumb_w}" height="{thumb_h}"></a>')
                else:
                    img = f'<span class="shot"><span class="none">no screenshot</span></span>'
                sc = f" <b>{pct(score)}</b>" if score is not None and v not in ("boot-fail", "native-fail") else ""
                parts.append(f'<figure style="--vc:var(--v-{v})" title="{esc(tip)}">{img}'
                             f'<figcaption><i></i>{esc(g)} {esc(lab)}{sc}</figcaption></figure>')
    light, dark = tokens_css(themes["light"]), tokens_css(themes["dark"])
    meta = data.get("meta") or {}
    dims = (f"--label-w:150px;--thumb-w:{thumb_w}px;--thumb-h:{thumb_h}px;--row-h:{thumb_h + 26}px;"
            f"--cat-h:40px;--cols:{len(cols)};")
    return f"""<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proxy contact sheet</title>
<style>
:root {{ {light} {dims} }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ {dark} color-scheme: dark; }} }}
:root[data-theme="dark"] {{ {dark} color-scheme: dark; }}
{SHEET_CSS}
</style>
<h1>Proxy contact sheet</h1>
<p class="lede">Every site through every proxy, {esc(meta.get('date', ''))}. The border and caption give the verdict and
score; click a screenshot for full size. <a href="{esc(base)}report.html">Back to the report</a>.</p>
<div class="sheet">
{chr(10).join(parts)}
</div>
</html>
"""


def contact_sheet_image(chrome, data, rows, labels, themes, run_dir, out):
    """Full-page image of the contact sheet: PNG, or JPEG when the PNG would pass ~8 MB."""
    sites = (data.get("site_support") or {}).get("sites") or []
    results = (data.get("site_support") or {}).get("results") or {}
    cols = [r for r in rows if any(r in (results.get(s["id"]) or {}) for s in sites)]
    cats = {s.get("category", "other") for s in sites}
    # thumbnails shrink so the page stays under Chromium's 16384 px screenshot limit
    th = max(40, min(90, int((15000 - 200 - len(cats) * 48) / max(1, len(sites)) - 34)))
    tw = th * 16 // 10
    html_ = contact_sheet(data, rows, labels, themes, tw, th, lazy=False, base=run_dir.resolve().as_uri() + "/")
    html_ = html_.replace("@media (prefers-color-scheme: dark)", "@media not all")
    tmp = out / ".contact-sheet-print.html"
    tmp.write_text(html_)
    width = 24 * 2 + 150 + len(cols) * (tw + 10) + 16
    height = 24 + 34 + 30 + 40 + len(cats) * (40 + 8) + len(sites) * (th + 26 + 8) + 60
    png, jpg = out / "contact-sheet.png", out / "contact-sheet.jpg"
    for p in (png, jpg):
        p.unlink(missing_ok=True)
    if screenshot(chrome, tmp.resolve().as_uri(), png, width, height) and png.stat().st_size > 8_000_000:
        png.unlink()
        screenshot(chrome, tmp.resolve().as_uri(), jpg, width, height)
    tmp.unlink(missing_ok=True)


# ------------------------------------------------------------------------------ report
REPORT_CSS = """
body { background: var(--page); color: var(--ink); font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px; line-height: 1.5; margin: 0; padding-block: 32px 64px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
main { max-width: 1000px; margin: 0 auto; display: grid; gap: 36px; }
header h1 { font-size: 2rem; margin: 0 0 6px; letter-spacing: -0.01em; }
header p { margin: 0 0 14px; color: var(--ink2); max-width: 70ch; }
nav { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 14px; }
a { color: var(--ink); }
h2 { font-size: 1.35rem; margin: 0; }
h3 { font-size: 1rem; margin: 10px 0 0; }
section { display: grid; gap: 14px; min-width: 0; }
figure { margin: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px; overflow-x: auto; }
figure svg { display: block; width: 100%; height: auto; min-width: 640px; }
details.tv summary { cursor: pointer; color: var(--ink2); font-size: 14px; }
details.tv[open] summary { margin-bottom: 8px; }
.tablewrap { overflow-x: auto; max-height: 640px; overflow-y: auto; }
table { border-collapse: collapse; font-size: 13px; width: 100%; }
th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
thead th { color: var(--ink2); font-weight: 500; position: sticky; top: 0; background: var(--page); }
tbody th { font-weight: 500; white-space: nowrap; }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.dnf { color: var(--muted); }
dl.setup { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; margin: 0; font-size: 14px; }
dl.setup dt { color: var(--ink2); font-weight: 500; }
dl.setup dd { margin: 0; min-width: 0; }
code { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; background: var(--code); padding: 1px 5px;
  border-radius: 4px; overflow-wrap: anywhere; }
#tip { position: fixed; pointer-events: none; background: var(--ink); color: var(--surface); font-size: 12px; padding: 6px 9px;
  border-radius: 6px; max-width: 420px; z-index: 20; white-space: pre-line; transform: translate(-50%, calc(-100% - 12px)); }
.mark:hover { opacity: .8; }
@media (prefers-reduced-motion: no-preference) { .mark { transition: opacity .12s; } }
@media (max-width: 640px) { dl.setup { grid-template-columns: 1fr; } header h1 { font-size: 1.5rem; } }
"""

TIP_JS = """
(function () {
  var tip = document.getElementById('tip');
  function show(m, x, y) { tip.textContent = m.getAttribute('data-tip'); tip.hidden = false;
    tip.style.left = x + 'px'; tip.style.top = y + 'px'; }
  document.addEventListener('mousemove', function (e) {
    var m = e.target.closest ? e.target.closest('.mark') : null;
    if (!m || !m.getAttribute('data-tip')) { tip.hidden = true; return; }
    show(m, e.clientX, e.clientY);
  });
  document.addEventListener('focusin', function (e) {
    var m = e.target.closest ? e.target.closest('.mark') : null;
    if (!m) return; var r = m.getBoundingClientRect(); show(m, r.left + r.width / 2, r.top);
  });
  document.addEventListener('focusout', function () { tip.hidden = true; });
  document.addEventListener('mouseleave', function () { tip.hidden = true; });
  document.querySelectorAll('.mark').forEach(function (m) {
    var t = m.querySelector('title'); if (t) t.remove(); m.setAttribute('tabindex', '0');
  });
})();
"""


THEME_ATTR = ' style="__THEME__"'  # the report's page tokens theme its inline SVGs instead


def short_sha(s):
    return re.sub(r"\b([0-9a-f]{12})[0-9a-f]{28}\b", r"\1", str(s))


def report_html(data, meta, rows, labels, themes, charts, has_sheet):
    host = meta.get("host") or {}
    hw = meta.get("holywisp") or {}
    load = meta.get("load") or {}

    def la(v):
        return " ".join(f"{x:.2f}" for x in v) if isinstance(v, list) else "n/a"

    host_s = ", ".join(x for x in [host.get("cpu"), f"{host['cores']} cores" if host.get("cores") else None,
                                   f"{host['mem_gb']} GB" if host.get("mem_gb") else None, host.get("os"),
                                   f"Linux {host['kernel']}" if host.get("kernel") else None] if x)
    setup = [("Date", meta.get("date")), ("Host", host_s), ("Chrome", meta.get("chrome")), ("Node", meta.get("node")),
             ("holyWisp", " ".join(x for x in [hw.get("version"), f"({short_sha(hw['sha'])})" if hw.get("sha") else None] if x)),
             ("Load average", f"{la(load.get('before'))} before, {la(load.get('after'))} after" if load else None),
             ("Repeats", meta.get("repeats")), ("Command", meta.get("command"))]
    dl = "".join(f"<dt>{esc(k)}</dt><dd>{'<code>' + esc(v) + '</code>' if k == 'Command' else esc(v)}</dd>"
                 for k, v in setup if v not in (None, ""))
    contenders = ""
    if meta.get("rows"):
        body = []
        for mr in meta["rows"]:
            d = mr.get("describe") or {}
            ver = " ".join(short_sha(x) for x in [d.get("repo"), d.get("ref"), d.get("sha")] if x)
            pk = ", ".join(f"{k} {v}" for k, v in (d.get("packages") or {}).items())
            cfg = "; ".join(d.get("config") or [])
            body.append([mr.get("label") or labels.get(mr.get("row")) or mr.get("row"), ver or "n/a", pk, d.get("transport") or "",
                         cfg])
        contenders = "<h3>Contenders</h3>" + table(["", "source", "packages", "transport", "configuration"], body)

    sections = [("sites", "Site support"), ("speed", "Speed"), ("fidelity", "Fidelity and security"), ("size", "Size")]
    body = []
    for key, title in sections:
        mine = [c for c in charts if c[1] == key]
        extra = ""
        if key == "sites" and has_sheet:
            extra = '<p><a href="contact-sheet.html">Contact sheet: every screenshot, site by proxy</a></p>'
        if not mine and not extra:
            continue
        figs = "".join(f'<figure id="{esc(name)}">{svg.replace(THEME_ATTR, "", 1)}</figure>'
                       f'<details class="tv"><summary>Table: {esc(t)}</summary>{tbl}</details>'
                       for name, _, t, svg, tbl in mine)
        body.append(f'<section id="{key}"><h2>{esc(title)}</h2>{extra}{figs}</section>')
    nav = "".join(f'<a href="#{k}">{esc(t)}</a>' for k, t in sections if any(c[1] == k for c in charts))
    if has_sheet:
        nav += '<a href="contact-sheet.html">Contact sheet</a>'
    light, dark = tokens_css(themes["light"]), tokens_css(themes["dark"])
    names = ", ".join(labels[r] for r in rows)
    return f"""<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proxy benchmark</title>
<style>
:root {{ {light} }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ {dark} color-scheme: dark; }} }}
:root[data-theme="dark"] {{ {dark} color-scheme: dark; }}
{REPORT_CSS}
</style>
<main>
<header>
<h1>Proxy benchmark</h1>
<p>{esc(names)}: the same real sites, fixture pages and checks, one browser, one holyWisp for every proxy that speaks
Wisp. Hover a mark for its numbers; every chart has a table under it.</p>
<nav>{nav}</nav>
</header>
<section id="setup"><h2>Setup</h2><dl class="setup">{dl}</dl>{contenders}</section>
{"".join(body)}
</main>
<div id="tip" hidden></div>
<script>{TIP_JS}</script>
</html>
"""


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit("usage: python3 -I bench/charts.py bench/results/<run> [--png]")
    build(args[0], png="--png" in sys.argv)
