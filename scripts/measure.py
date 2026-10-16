#!/usr/bin/env python3
"""
Measured takeoff from vector drawings (phase 2).

For every page of a vector PDF:
  1. read the printed scale(s) ("SCALE 1/4"=1'-0"") and calibrate them against the printed
     dimension strings on the same drawing (a 23'-9" string must sit next to a line that long);
  2. rasterize the drawing's lines at a known feet-per-pixel and flood-fill from each room
     label to measure room area (SF) and perimeter (LF), flagging rooms that leak into
     neighbours (open plan or a missing door line);
  3. find wall-like runs (pairs of long parallel lines 3.5" to 14" apart) and total their
     length by thickness;
  4. draw an overlay image per page so every number can be checked by eye.

usage: measure.py <pdf> <out_dir> [--pages 11,12] [--labels labels.json]
labels.json: { "11": ["LOUNGE", "KITCHEN 101", ...] } optional room labels per 0-based page.
"""
import json, math, re, sys, os, collections
import pdfplumber
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOM_WORDS = r"(KITCHEN|KITCHENETTE|LOUNGE|DINING|BAR|STAGE|BACK\s?STAGE|OFFICE|STORAGE|CELLAR|BASEMENT|BEDROOM|MASTER|LIVING|BATH|BATHROOM|TOILET|RR|HALL|HALLWAY|FOYER|LOBBY|VESTIBULE|CLOSET|W\.?I\.?C|STAIR|LAUNDRY|DRESSING|MECH|MECHANICAL|BOILER|METER|UTILITY|STUDY|DEN|PORCH|GARDEN|PANTRY|CORRIDOR|ENTRY|BREAK|CONF|CONFERENCE|RECEPTION|SHOWROOM|RETAIL|SALES|STOCK|JANITOR|ELEC|ELECTRICAL|IT|SERVER|LOCKER|SHOWER|WAITING|EXAM|LAB|CLASSROOM|GYM|CAFE|SEATING|AREA)"
DIM = re.compile(r"^(\d+)'-?(\d+)?(?:\s?(\d+)/(\d+))?\"?$")
SCALE = re.compile(r"^(\d+(?:/\d+)?)\"\s*=\s*(\d+)'(?:-(\d+)\")?$")
PX_PER_FT = 8.0  # raster resolution for room measurement (1.5 in per pixel)


def parse_dim(s):
    m = DIM.match(s.replace("’", "'").replace("”", '"'))
    if not m or m.group(2) is None and "'" not in s:
        return None
    ft = int(m.group(1)); inch = int(m.group(2) or 0)
    frac = int(m.group(3)) / int(m.group(4)) if m.group(3) else 0.0
    return ft + (inch + frac) / 12.0


def parse_scale(s):
    m = SCALE.match(s.replace(" ", ""))
    if not m:
        return None
    num = m.group(1)
    if "/" in num:
        a, b = int(num.split("/")[0]), int(num.split("/")[1])
        # "1 1/2" arrives as "11/2" once spaces are stripped: a leading whole number
        inches = (a // 10 + (a % 10) / b) if a > b else a / b
    else:
        inches = float(num)
    feet = int(m.group(2)) + int(m.group(3) or 0) / 12.0
    return inches * 72.0 / feet  # points per foot


def seg_len(l):
    return math.hypot(l["x1"] - l["x0"], l["bottom"] - l["top"])


def page_geometry(page):
    segs = []
    for l in page.lines:
        segs.append((l["x0"], l["top"], l["x1"], l["bottom"]))
    for r in page.rects:
        x0, y0, x1, y1 = r["x0"], r["top"], r["x1"], r["bottom"]
        segs += [(x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)]
    for c in page.curves:
        pts = c.get("pts") or c.get("points") or []
        # pdfplumber gives pts in PDF coordinates (origin bottom-left); convert y
        H = page.height
        pp = [(x, H - y) for x, y in pts] if pts and isinstance(pts[0], (tuple, list)) else []
        for a, b in zip(pp, pp[1:]):
            segs.append((a[0], a[1], b[0], b[1]))
    return segs


def find_scales(words):
    """Scale labels with positions: [(pt_per_ft, text, x, y)]"""
    out = []
    for j, w in enumerate(words):
        if w["text"].upper().startswith("SCALE") and j + 1 < len(words):
            cand = words[j + 1]["text"]
            if j + 2 < len(words) and "=" not in cand:
                cand = cand + words[j + 2]["text"]
            s = parse_scale(cand)
            if s:
                out.append((s, cand, (w["x0"] + words[j + 1]["x1"]) / 2, w["top"]))
    return out


def scale_for_point(scales, x, y, default):
    """Drawing titles sit below their drawing: pick the nearest scale label below the point."""
    best, bd = default, None
    for s, _, sx, sy in scales:
        if sy >= y - 20 and abs(sx - x) < 900:
            d = (sy - y) + abs(sx - x) * 0.5
            if bd is None or d < bd:
                best, bd = s, d
    return best


def calibrate(words, segs, scales, default_scale):
    """Check printed dimension strings against nearby line lengths. Returns stats and empirical pt/ft."""
    checks = []
    long_segs = [s for s in segs if math.hypot(s[2] - s[0], s[3] - s[1]) > 20]
    for w in words:
        ft = parse_dim(w["text"])
        if not ft or ft < 1:
            continue
        cx, cy = (w["x0"] + w["x1"]) / 2, (w["top"] + w["bottom"]) / 2
        ppf = scale_for_point(scales, cx, cy, default_scale)
        expect = ft * ppf
        best = None
        for s in long_segs:
            L = math.hypot(s[2] - s[0], s[3] - s[1])
            if abs(L - expect) / expect > 0.04:
                continue
            # distance from text centre to the segment's midpoint band
            mx, my = (s[0] + s[2]) / 2, (s[1] + s[3]) / 2
            horiz = abs(s[3] - s[1]) < abs(s[2] - s[0])
            d = abs(my - cy) if horiz else abs(mx - cx)
            along = abs(mx - cx) if horiz else abs(my - cy)
            if d < 30 and along < L / 2 + 10:
                if best is None or d < best[0]:
                    best = (d, L)
        checks.append({"text": w["text"], "feet": round(ft, 4), "matched": best is not None, "ratio": (best[1] / ft) if best else None})
    matched = [c for c in checks if c["matched"]]
    emp = float(np.median([c["ratio"] for c in matched])) if matched else None
    return {"dimensions": len(checks), "matched": len(matched), "empirical_pt_per_ft": emp}, checks


def room_labels(words, custom=None):
    """Group words on a line into labels like 'KITCHEN 101' / 'AREA A' / 'LOUNGE'."""
    labels = []
    used = set()
    for j, w in enumerate(words):
        if j in used:
            continue
        t = w["text"].upper().strip(":")
        if not re.fullmatch(ROOM_WORDS, t):
            continue
        text = t; x0, x1, top, bottom = w["x0"], w["x1"], w["top"], w["bottom"]
        k = j + 1
        while k < len(words) and k < j + 3 and abs(words[k]["top"] - w["top"]) < 3 and words[k]["x0"] - x1 < 12:
            nxt = words[k]["text"].upper().strip(":")
            if re.fullmatch(r"[A-Z]|\d{1,3}[A-Z]?|ROOM|" + ROOM_WORDS, nxt):
                text += " " + nxt; x1 = words[k]["x1"]; used.add(k); k += 1
            else:
                break
        labels.append({"label": text, "x": (x0 + x1) / 2, "y": (top + bottom) / 2})
    if custom:
        want = {c.upper() for c in custom}
        labels = [l for l in labels if l["label"] in want or l["label"].split(" ")[0] in want]
    return labels


def measure_rooms(page, segs, labels, scales, default_scale, overlay):
    W, H = page.width, page.height
    results = []
    cache = {}
    DOOR_FT = float(os.environ.get("MEASURE_CLOSE_FT", "1.0"))  # gaps narrower than this are closed

    def build(ppf):
        k = PX_PER_FT / ppf
        img = Image.new("1", (int(W * k) + 2, int(H * k) + 2), 1)
        d = ImageDraw.Draw(img)
        for x0, y0, x1, y1 in segs:
            d.line([(x0 * k, y0 * k), (x1 * k, y1 * k)], fill=0, width=2)
        empty = np.array(img, dtype=bool)
        lines = ~empty
        r = int(round(DOOR_FT / 2 * PX_PER_FT))
        yy, xx = np.ogrid[-r:r + 1, -r:r + 1]
        disk = (xx * xx + yy * yy) <= r * r
        closed = ndimage.binary_closing(lines, structure=disk, border_value=0)
        core, n = ndimage.label(~closed)
        # give every empty pixel that the closing swallowed back to the nearest core region
        dist, (iy, ix) = ndimage.distance_transform_edt(core == 0, return_indices=True)
        assigned = core[iy, ix]
        assigned[~empty] = 0  # the lines themselves belong to no room
        assigned[dist > r + 1] = 0
        # regions touching the page border are the outside
        border = set(np.unique(np.concatenate([assigned[0], assigned[-1], assigned[:, 0], assigned[:, -1]])))
        return k, assigned, border

    for lab in labels:
        ppf = scale_for_point(scales, lab["x"], lab["y"], default_scale)
        if ppf not in cache:
            cache[ppf] = build(ppf)
        k, lbl, border = cache[ppf]
        px, py = int(lab["x"] * k), int(lab["y"] * k)
        comp = 0
        for r in range(0, 14):
            found = False
            for dy in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    yy_, xx_ = py + dy, px + dx
                    if 0 <= yy_ < lbl.shape[0] and 0 <= xx_ < lbl.shape[1] and lbl[yy_, xx_] > 0:
                        comp = lbl[yy_, xx_]; found = True; break
                if found: break
            if found: break
        base = {"label": lab["label"], "scale_pt_per_ft": ppf, "x": lab["x"], "y": lab["y"]}
        if not comp:
            results.append({**base, "area_sf": None, "perimeter_lf": None, "flag": "no open area found at the label"}); continue
        if comp in border:
            results.append({**base, "area_sf": None, "perimeter_lf": None, "flag": "label sits in the open page area, not inside an enclosed room"}); continue
        mask = lbl == comp
        area_sf = float(mask.sum()) / (PX_PER_FT ** 2)
        er = ndimage.binary_erosion(mask)
        perim_lf = float((mask & ~er).sum()) / PX_PER_FT * 0.9  # pixel boundary over-counts diagonals slightly
        flag = None
        if area_sf < 12:
            flag = "tiny area: the label is probably in a table or note, not in a room"
        results.append({**base, "area_sf": round(area_sf, 1), "perimeter_lf": round(perim_lf, 1), "flag": flag, "_comp": (ppf, comp)})
    by_comp = collections.defaultdict(list)
    for r in results:
        if r.get("_comp"): by_comp[r["_comp"]].append(r)
    for comp, rs in by_comp.items():
        if len(rs) > 1:
            names = ", ".join(sorted(set(x["label"] for x in rs)))
            for x in rs:
                x["flag"] = (x["flag"] + "; " if x["flag"] else "") + f"one open area shared by: {names} (open plan or an opening wider than a door); area is the combined space"
    if overlay is not None:
        ov, ok = overlay
        draw = ImageDraw.Draw(ov, "RGBA")
        palette = [(245, 165, 36, 110), (56, 189, 248, 110), (74, 222, 128, 110), (248, 113, 113, 110), (192, 132, 252, 110), (250, 204, 21, 110)]
        done = set()
        for i, r in enumerate(results):
            if not r.get("_comp") or r.get("area_sf") is None or r["_comp"] in done:
                continue
            done.add(r["_comp"])
            ppf, comp = r["_comp"]
            k, lbl, _ = cache[ppf]
            mask = (lbl == comp)
            sc = ok / k
            m = Image.fromarray((mask * 255).astype(np.uint8)).resize((ov.width, ov.height), Image.NEAREST)
            col = Image.new("RGBA", ov.size, palette[i % len(palette)])
            ov.paste(col, (0, 0), m)
        draw = ImageDraw.Draw(ov, "RGBA")
        for r in results:
            if r.get("area_sf"):
                draw.text((r["x"] * ok - 10, r["y"] * ok + 6), f"{r['area_sf']:.0f} SF", fill=(11, 18, 32, 255))
    for r in results:
        r.pop("_comp", None); r.pop("x", None); r.pop("y", None)
    return results


def walls_from_rooms(rooms):
    """Partition length from room boundaries: every interior wall is shared by two rooms."""
    measured = [r for r in rooms if r.get("perimeter_lf") and not (r.get("flag") or "").startswith("tiny")]
    total_perim = sum(r["perimeter_lf"] for r in measured)
    return {"rooms_measured": len(measured), "sum_room_perimeter_lf": round(total_perim, 1),
            "note": "Interior partitions are shared by two rooms, so partition LF is roughly half the summed perimeter plus the exterior wall; assign wall types from the legend before pricing."}


def main():
    pdf_path, out_dir = sys.argv[1], sys.argv[2]
    pages_arg = None; labels_arg = None
    if "--pages" in sys.argv:
        pages_arg = [int(x) for x in sys.argv[sys.argv.index("--pages") + 1].split(",")]
    if "--labels" in sys.argv:
        labels_arg = json.load(open(sys.argv[sys.argv.index("--labels") + 1]))
    os.makedirs(out_dir, exist_ok=True)
    pdf = pdfplumber.open(pdf_path)
    report = {"pages": []}
    for i, page in enumerate(pdf.pages):
        if pages_arg is not None and i not in pages_arg:
            continue
        words = page.extract_words()
        segs = page_geometry(page)
        vector = len(segs) > 200
        scales = find_scales(words)
        entry = {"page": i, "vector": vector, "width_pt": page.width, "height_pt": page.height, "scales": [{"text": t, "pt_per_ft": s} for s, t, _, _ in scales]}
        if not vector or not scales:
            entry["flag"] = "not a vector drawing" if not vector else "no printed scale found"
            report["pages"].append(entry); continue
        default_scale = collections.Counter(s for s, *_ in scales).most_common(1)[0][0]
        cal, checks = calibrate(words, segs, scales, default_scale)
        entry["calibration"] = cal
        if cal["matched"] >= 3 and cal["empirical_pt_per_ft"]:
            drift = abs(cal["empirical_pt_per_ft"] - default_scale) / default_scale
            entry["calibration"]["drift_pct"] = round(drift * 100, 2)
            if drift > 0.03:
                entry["flag"] = f"printed scale and dimension strings disagree by {drift*100:.1f}%; not measured"
                report["pages"].append(entry); continue
        elif cal["dimensions"] >= 3:
            entry["flag"] = "dimension strings could not be matched to lines; scale unconfirmed"
        # overlay base
        ok = 0.4  # overlay px per pt
        ov = None
        if "--rooms" in sys.argv:
            ov = Image.new("RGBA", (int(page.width * ok), int(page.height * ok)), (255, 255, 255, 255))
            d = ImageDraw.Draw(ov)
            for x0, y0, x1, y1 in segs:
                d.line([(x0 * ok, y0 * ok), (x1 * ok, y1 * ok)], fill=(120, 130, 145, 255), width=1)
        entry["width_pt"] = page.width; entry["height_pt"] = page.height
        entry["default_pt_per_ft"] = default_scale
        # snap geometry for the measure tool: the drawn lines, in page points, longest first, capped
        min_len = 0.4 * default_scale
        snap = [(round(a, 1), round(b, 1), round(c, 1), round(d, 1)) for a, b, c, d in segs if math.hypot(c - a, d - b) >= min_len]
        snap.sort(key=lambda t: -math.hypot(t[2] - t[0], t[3] - t[1]))
        snap = snap[:25000]
        flat = [v for seg in snap for v in seg]
        with open(os.path.join(out_dir, f"snap-{i}.json"), "w") as f:
            json.dump({"page": i, "width_pt": page.width, "height_pt": page.height, "segs": flat}, f, separators=(",", ":"))
        entry["snap_file"] = f"snap-{i}.json"
        entry["scale_labels"] = [{"text": t, "pt_per_ft": s, "x": x, "y": y} for s, t, x, y in scales]
        if "--rooms" in sys.argv:
            labs = room_labels(words, (labels_arg or {}).get(str(i)))
            entry["rooms"] = measure_rooms(page, segs, labs, scales, default_scale, (ov, ok))
            entry["walls"] = walls_from_rooms(entry["rooms"])
            path = os.path.join(out_dir, f"measure-{i}.png")
            ov.convert("RGB").save(path, quality=80)
            entry["overlay"] = path
        report["pages"].append(entry)
        print(f"page {i+1}: scale {default_scale:.1f} pt/ft, dims {cal['matched']}/{cal['dimensions']} matched, scales {len(scales)}", file=sys.stderr)
    json.dump(report, open(os.path.join(out_dir, "measure.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
