"""
SI (AI) use: parts of this code were written with help from Claude, an AI assistant by Anthropic, then tested, checked and edited by Team Kepler 16. NASA Space Apps 2026.
SKY BLINK - "Planet X Hunter" pipeline (NASA Space Apps 2026, "Planet X and SPHEREx")
=====================================================================================
How would astronomers find an unknown Planet X? It belongs to our Solar System,
so it slowly MOVES against the background stars, which stay still.

We practise on real, known distant worlds:
  1. NASA JPL Horizons gives the world's exact position for every day of the mission.
  2. NASA/IPAC IRSA lists the SPHEREx images that cover it in each month.
  3. One SPHEREx "visit" lasts several days. We take cutouts across that visit,
     line them up north-up on one fixed patch of sky, and measure the world
     exactly where Horizons says it is in each image.
  4. Output: web/data/planetx/<id>/frame_XX.png, diff.png and web/data/planetx.js
     (same format as targets.js, so the Sky Explorer can blink and sonify it).

Setup (once):   python -m pip install astroquery astropy reproject numpy matplotlib pillow
Run:            python spherex_planetx.py
Only one:       python spherex_planetx.py --only pluto
More frames:    python spherex_planetx.py --frames 12

Needs spherex_test.py and spherex_targets.py in the same folder.
Downloads are cached in ./cache, so running again is fast.
"""

import argparse
import json
import os
import warnings

import numpy as np
import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.time import Time

import spherex_test as base
import spherex_targets as tg

warnings.simplefilter("ignore")

OUT = os.path.join("web", "data", "planetx")
MISSION_START, MISSION_END = "2025-04-01", "2026-08-01"

WORLDS = [
    {"id": "pluto", "name": "Pluto", "horizons": "999", "id_type": None, "kind": "planetx",
     "type": "Dwarf planet · about 35 times farther from the Sun than Earth",
     "desc": "Our practice 'Planet X'. Because it is part of our Solar System, it drifts across the "
             "still background stars within just a few days. A real Planet X would move the same way, only slower.",
     "max_wl": 1.65},
    {"id": "makemake", "name": "Makemake", "horizons": "136472", "id_type": "smallbody", "kind": "planetx",
     "type": "Dwarf planet · about 53 times farther from the Sun than Earth",
     "desc": "A distant icy dwarf planet beyond Neptune, much fainter than Pluto. It is a harder test, "
             "closer to how difficult a real Planet X search would be.",
     "max_wl": 1.65},
]


# ----------------------------------------------------------------------
def ephemeris(w):
    """Daily positions from NASA JPL Horizons, as an interpolating function of MJD."""
    from astroquery.jplhorizons import Horizons
    kw = {"id": w["horizons"], "location": "500",
          "epochs": {"start": MISSION_START, "stop": MISSION_END, "step": "1d"}}
    if w["id_type"]:
        kw["id_type"] = w["id_type"]
    eph = Horizons(**kw).ephemerides()
    mjd = np.array(eph["datetime_jd"], float) - 2400000.5
    ra = np.unwrap(np.radians(np.array(eph["RA"], float)))
    dec = np.array(eph["DEC"], float)
    vmag = float(np.nanmedian(np.array(eph["V"], float))) if "V" in eph.colnames else None
    dist = float(np.nanmedian(np.array(eph["delta"], float))) if "delta" in eph.colnames else None

    def pos(m):
        r = np.degrees(np.interp(m, mjd, ra)) % 360
        return SkyCoord(r * u.deg, np.interp(m, mjd, dec) * u.deg)

    print(f"  NASA JPL Horizons: {len(mjd)} daily positions"
          + (f", brightness about V={vmag:.1f}" if vmag else "")
          + (f", {dist:.1f} AU from Earth" if dist else ""))
    return pos, mjd[0], mjd[-1], vmag, dist


def find_world_images(pos, m0, m1, max_wl):
    """SPHEREx images that should contain the moving world. The world moves, so we
    ask IRSA month by month at the position it had that month."""
    rows, seen = [], set()
    for mid in np.arange(m0 + 15, m1, 30):
        found = tg.find_images(pos(mid))
        for r in found:
            if abs(r["mjd"] - mid) > 15.5 or r["url"] in seen:
                continue
            if r["wmin"] and r["wmin"] > max_wl:
                continue  # keep the short colours, where sunlight reflected by ices is brightest
            seen.add(r["url"])
            rows.append(r)
    rows.sort(key=lambda r: r["mjd"])
    return rows


def process(w, n_frames):
    print(f"\n=== {w['name']} ===")
    pos, m0, m1, vmag, dist = ephemeris(w)
    rows = find_world_images(pos, m0, m1, w["max_wl"])
    visits = tg.group_visits(rows, gap_days=20)
    print(f"  {len(rows)} short-colour images in {len(visits)} visit(s)")
    if not visits:
        return None

    from reproject import reproject_interp
    best = None
    # try the visits with the most images first; keep the first that gives a clear detection
    for vi in sorted(range(len(visits)), key=lambda i: -len(visits[i]))[:3]:
        v = visits[vi]
        if v[-1]["mjd"] - v[0]["mjd"] < 0.5:
            continue  # need some time for it to move
        track = [pos(r["mjd"]) for r in v]
        mid = pos((v[0]["mjd"] + v[-1]["mjd"]) / 2)
        extent = max(mid.separation(p).deg for p in track) * 2
        size = float(np.clip(extent + 0.06, 0.12, 0.45))
        out_wcs, shape = base.target_wcs(mid.ra.deg, mid.dec.deg, size)
        n = shape[0]
        pick = sorted(set(np.linspace(0, len(v) - 1, min(len(v), n_frames * 2)).round().astype(int)))
        pts = []
        for i in pick:
            r = v[i]
            p = pos(r["mjd"])
            try:
                with base.get_cutout(r["url"], mid.ra.deg, mid.dec.deg, size * 1.3) as h:
                    img, wcs = base.clean_image(h)
                    var = h["VARIANCE"].data.astype(float) if "VARIANCE" in h else None
                    x, y = wcs.world_to_pixel(p)
                    if not (5 < x < img.shape[1] - 5 and 5 < y < img.shape[0] - 5):
                        continue  # the world is outside this image
                    wl = base.wavelength_at(h, float(x), float(y))
                    flux, snr = base.measure_comet(img, float(x), float(y), var, r_ap=2.5, r_in=6, r_out=10)
            except Exception as e:
                print(f"  ! skipped one image: {str(e).splitlines()[0][:90]}")
                continue
            aligned, _ = reproject_interp((img, wcs), out_wcs, shape_out=shape)
            tx, ty = out_wcs.world_to_pixel(p)
            pts.append({"visit": vi, "mjd": r["mjd"], "date_utc": Time(r["mjd"], format="mjd").iso[:16],
                        "wl": wl if wl else (r["wmin"] + r["wmax"]) / 2, "flux": flux, "snr": snr,
                        "fx": (float(tx) + 0.5) / n, "fy": (n - float(ty) - 0.5) / n, "_img": aligned})
        good = [q for q in pts if q["snr"] is not None and q["snr"] >= 3]
        print(f"  visit {vi + 1} ({Time(v[0]['mjd'], format='mjd').iso[:10]}): measured {len(pts)}, "
              f"clearly detected in {len(good)}")
        score = len(good) + 0.1 * len(pts)
        if best is None or score > best["score"]:
            best = {"score": score, "pts": pts, "good": good, "size": size, "mid": mid, "vi": vi}
        if len(good) >= 4:
            break

    if not best or len(best["pts"]) < 2:
        print("  ! not enough images to blink")
        return None
    pts = best["pts"]
    use = best["good"] if len(best["good"]) >= 3 else pts
    use = sorted(use, key=lambda q: q["mjd"])
    keep = sorted(set(np.linspace(0, len(use) - 1, min(len(use), n_frames)).round().astype(int)))
    frames = [use[i] for i in keep]

    os.makedirs(os.path.join(OUT, w["id"]), exist_ok=True)
    stack = np.concatenate([f["_img"][np.isfinite(f["_img"])] for f in frames])
    lo, hi = np.percentile(stack, [5, 99.7])
    out_frames = []
    for i, f in enumerate(frames):
        x01 = np.clip((f["_img"] - lo) / (hi - lo + 1e-12), 0, 1)
        x01 = tg.fill_saturated(np.arcsinh(10 * x01) / np.arcsinh(10))
        f["_x01"] = x01
        name = f"frame_{i:02d}.png"
        base.save_clean_png(x01, os.path.join(OUT, w["id"], name))
        out_frames.append({k: f[k] for k in ("visit", "mjd", "date_utc", "wl", "flux", "snr", "fx", "fy")} |
                          {"file": f"data/planetx/{w['id']}/{name}"})
    tg.save_diff(frames[0]["_x01"], frames[-1]["_x01"], os.path.join(OUT, w["id"], "diff.png"))

    a, b = pos(frames[0]["mjd"]), pos(frames[-1]["mjd"])
    shift = a.separation(b).arcsec
    days = frames[-1]["mjd"] - frames[0]["mjd"]
    print(f"  moved {shift / 60:.1f} arcminutes in {days:.1f} days "
          f"({shift / base.PIXEL_SCALE_ARCSEC:.0f} SPHEREx pixels) - stars stay still")
    return {
        "id": w["id"], "name": w["name"], "kind": "planetx", "type": w["type"], "desc": w["desc"],
        "ref_wl": round(float(np.median([f["wl"] for f in frames])), 2), "size_deg": best["size"],
        "position_source": "NASA JPL Horizons",
        "center_ra": best["mid"].ra.deg, "center_dec": best["mid"].dec.deg,
        "shift_arcsec": shift, "shift_px": shift / base.PIXEL_SCALE_ARCSEC,
        "vmag": vmag, "dist_au": dist,
        "frames": out_frames, "diff": f"data/planetx/{w['id']}/diff.png",
        "points": [{k: q[k] for k in ("visit", "mjd", "date_utc", "wl", "flux", "snr")} for q in pts],
    }


def main():
    ap = argparse.ArgumentParser(description="SKY BLINK Planet X Hunter")
    ap.add_argument("--only", nargs="*", help="world ids, e.g. pluto")
    ap.add_argument("--frames", type=int, default=8, help="frames in the blink")
    args = ap.parse_args()
    todo = [w for w in WORLDS if not args.only or w["id"] in args.only]
    path = os.path.join("web", "data", "planetx.js")
    results = {}
    if os.path.exists(path):
        try:
            old = json.loads(open(path).read().split("=", 1)[1].strip().rstrip(";"))
            results = {r["id"]: r for r in old}
        except Exception:
            pass
    os.makedirs(OUT, exist_ok=True)
    for w in todo:
        try:
            r = process(w, args.frames)
        except Exception as e:
            print(f"  ! {w['name']} failed: {str(e).splitlines()[0][:120]}")
            r = None
        if r:
            results[w["id"]] = r
            ordered = [results[x["id"]] for x in WORLDS if x["id"] in results]
            with open(path, "w") as f:
                f.write("window.SKYBLINK_PLANETX = ")
                json.dump(ordered, f, separators=(",", ":"))
                f.write(";\n")
    print(f"\nDONE: {len(results)} world(s) saved in {path}. Reload web/index.html.")


if __name__ == "__main__":
    main()
