"""
SKY BLINK - challenge targets pipeline (NASA Space Apps 2026, "Planet X and SPHEREx")
====================================================================================
Makes website data for fixed-sky targets: fast-moving nearby stars, brown dwarfs
and stars that change brightness.

For each target:
  1. Gaia DR3 (or SIMBAD for stars too faint for Gaia) gives its position and
     how fast it moves (proper motion).
  2. NASA/IPAC IRSA lists every SPHEREx image that covers it.
  3. Images are grouped into "visits" (SPHEREx maps the whole sky every ~6 months).
  4. Small cutouts are downloaded, lined up north-up, and the target is measured
     at the exact infrared colour of each image.
  5. Output: web/data/targets/<id>/frame_XX.png, diff.png and web/data/targets.js

Setup (once):   python -m pip install astroquery astropy reproject numpy matplotlib pillow
Run:            python spherex_targets.py
Only some:      python spherex_targets.py --only barnard rwaur
More frames:    python spherex_targets.py --per-visit 12

Needs spherex_test.py in the same folder (it reuses its download + measuring code).
Downloads are cached in ./cache, so running again is fast.
"""

import argparse
import json
import os
import sys
import warnings

import numpy as np
import astropy.units as u
from astropy.coordinates import SkyCoord, Distance
from astropy.time import Time

import spherex_test as base  # download, cache, clean, wavelength, photometry helpers

warnings.simplefilter("ignore")

OUT = os.path.join("web", "data", "targets")
COLLECTIONS = ["spherex_dr1", "spherex_qr3"]  # newest first; stop at the first that has images

# fallback = (RA deg, Dec deg, pmRA mas/yr, pmDec mas/yr, parallax mas[, epoch year of the position])
# Used only if SIMBAD cannot be reached. Approximate values - SIMBAD is preferred.
TARGETS = [
    {"id": "barnard", "name": "Barnard's Star", "simbad": "Barnard's star", "kind": "moving",
     "type": "Nearby red dwarf star · about 6 light-years away", "ref_wl": 1.6,
     "desc": "The fastest-moving star across our sky. Over many years it slides past the background stars.",
     "fallback": (269.452083, 4.693391, -801.55, 10362.39, 546.98)},
    {"id": "epsindib", "name": "Epsilon Indi B", "simbad": "eps Ind B", "kind": "moving",
     "type": "A pair of brown dwarfs · about 12 light-years away", "ref_wl": 4.4,
     "desc": "Two brown dwarfs orbiting each other, travelling together with the star Epsilon Indi A.",
     "fallback": (331.0438, -56.7828, 3982.0, -2470.0, 274.8)},
    {"id": "rwaur", "name": "RW Aurigae", "simbad": "RW Aur", "kind": "variable",
     "type": "Young star with a dusty disc", "ref_wl": 2.2,
     "desc": "Clouds of dust from its disc sometimes block its light, so it dims and brightens.",
     "fallback": (76.956458, 30.401417, 3.0, -25.0, 6.4)},
]


# ----------------------------------------------------------------------
def simbad_coord(t):
    """Position at J2000 with proper motion, as a SkyCoord we can move in time."""
    ra = dec = pmra = pmdec = plx = None
    epoch = 2000.0
    try:
        from astroquery.simbad import Simbad
        s = Simbad()
        s.add_votable_fields("pmra", "pmdec", "plx_value")
        r = s.query_object(t["simbad"])
        if r is None or len(r) == 0:
            raise ValueError("not found")
        cols = {c.lower(): c for c in r.colnames}
        row = r[0]
        ra_v, dec_v = row[cols.get("ra")], row[cols.get("dec")]
        if isinstance(ra_v, str) or isinstance(ra_v, bytes):  # old sexagesimal format
            c = SkyCoord(str(ra_v), str(dec_v), unit=(u.hourangle, u.deg))
            ra, dec = c.ra.deg, c.dec.deg
        else:
            ra, dec = float(ra_v), float(dec_v)
        pmra = float(row[cols.get("pmra")])
        pmdec = float(row[cols.get("pmdec")])
        plx_key = cols.get("plx_value") or cols.get("plx_value".upper())
        plx = float(row[plx_key]) if plx_key and np.isfinite(row[plx_key]) else None
        src = "SIMBAD"
    except Exception as e:
        ra, dec, pmra, pmdec, plx = t["fallback"][:5]
        epoch = t["fallback"][5] if len(t["fallback"]) > 5 else 2000.0
        src = "built-in approximate values (SIMBAD unavailable: " + str(e).strip().splitlines()[0][:80] + ")"
    if not np.isfinite(pmra):
        pmra = 0.0
    if not np.isfinite(pmdec):
        pmdec = 0.0
    dist = Distance(parallax=plx * u.mas) if plx and plx > 0.1 else 1 * u.kpc
    c = SkyCoord(ra * u.deg, dec * u.deg, distance=dist,
                 pm_ra_cosdec=pmra * u.mas / u.yr, pm_dec=pmdec * u.mas / u.yr,
                 radial_velocity=0 * u.km / u.s, obstime=Time(epoch, format="jyear"), frame="icrs")
    print(f"  position from {src}; motion {np.hypot(pmra, pmdec) / 1000:.2f} arcsec/year")
    return c


def gaia_refine(c, t):
    """Replace position + motion with Gaia DR3 values when Gaia has the star
    (the challenge recommends Gaia DR3). Brown dwarfs too faint for Gaia keep SIMBAD."""
    try:
        from astroquery.gaia import Gaia
        p16 = c.apply_space_motion(new_obstime=Time("J2016"))
        q = f"""SELECT TOP 5 source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag,
            DISTANCE(POINT('ICRS', ra, dec), POINT('ICRS', {p16.ra.deg}, {p16.dec.deg})) AS sep
            FROM gaiadr3.gaia_source
            WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {p16.ra.deg}, {p16.dec.deg}, {6 / 3600}))
            AND pmra IS NOT NULL ORDER BY sep"""
        r = Gaia.launch_job(q).get_results()
        if len(r) == 0:
            print("  Gaia DR3: no match (too faint for Gaia) - using SIMBAD")
            return c, None
        cols = {k.lower(): k for k in r.colnames}
        exp_pm = np.hypot(c.pm_ra_cosdec.to_value(u.mas / u.yr), c.pm_dec.to_value(u.mas / u.yr))
        row = None
        for cand in r:  # the match must move like the target, or it is a different star
            gpm = np.hypot(float(cand[cols["pmra"]]), float(cand[cols["pmdec"]]))
            if exp_pm < 200 or abs(gpm - exp_pm) / exp_pm < 0.2:
                row = cand
                break
        if row is None:
            print("  Gaia DR3: no star with matching motion (too faint for Gaia) - using SIMBAD/built-in values")
            return c, None
        g = lambda k: float(row[cols[k]])
        plx = g("parallax")
        dist = Distance(parallax=plx * u.mas) if plx > 0.1 else 1 * u.kpc
        cg = SkyCoord(g("ra") * u.deg, g("dec") * u.deg, distance=dist,
                      pm_ra_cosdec=g("pmra") * u.mas / u.yr, pm_dec=g("pmdec") * u.mas / u.yr,
                      radial_velocity=0 * u.km / u.s, obstime=Time("J2016"), frame="icrs")
        sid = str(row[cols["source_id"]])
        print(f"  Gaia DR3 {sid}: motion {np.hypot(g('pmra'), g('pmdec')) / 1000:.2f} arcsec/year")
        return cg, f"Gaia DR3 {sid}"
    except Exception as e:
        print("  Gaia DR3 unavailable (" + str(e).strip().splitlines()[0][:80] + ") - using SIMBAD")
        return c, None


def at_time(c, mjd):
    moved = c.apply_space_motion(new_obstime=Time(mjd, format="mjd"))
    return SkyCoord(moved.ra, moved.dec)


def find_images(pos):
    """All SPHEREx images covering this sky position, from every collection we know."""
    from astroquery.ipac.irsa import Irsa
    rows, seen = [], set()
    for coll in COLLECTIONS:
        try:
            tab = Irsa.query_sia(pos=(pos, 1 * u.arcsec), collection=coll)
        except Exception as e:
            print(f"  ({coll}: {e})")
            continue
        if tab is None or len(tab) == 0:
            continue
        cols = {c.lower(): c for c in tab.colnames}
        for r in tab:
            url = base.text(r[cols["access_url"]]).strip()
            if not url.startswith("http") or url in seen:
                continue
            seen.add(url)
            rows.append({
                "url": url,
                "mjd": base.to_mjd(r[cols["t_min"]]),
                "wmin": float(r[cols["em_min"]]) * 1e6 if "em_min" in cols else None,
                "wmax": float(r[cols["em_max"]]) * 1e6 if "em_max" in cols else None,
                "coll": coll,
            })
        print(f"  {coll}: {len(tab)} images")
        if rows:
            break  # same exposures appear in older releases; use the newest only
    if not rows:
        try:
            print("  No images found. SPHEREx collections IRSA offers:")
            print(Irsa.list_collections(servicetype="SIA", filter="spherex"))
        except Exception:
            pass
    rows.sort(key=lambda r: r["mjd"])
    return rows


def group_visits(rows, gap_days=30):
    visits = []
    for r in rows:
        if not visits or r["mjd"] - visits[-1][-1]["mjd"] > gap_days:
            visits.append([])
        visits[-1].append(r)
    return visits


def fill_saturated(x01):
    """Very bright stars have empty (saturated) centres. Paint them white, not black."""
    from scipy.ndimage import maximum_filter
    x = x01.copy()
    for _ in range(4):
        holes = ~np.isfinite(x)
        if not holes.any():
            break
        bright = maximum_filter(np.nan_to_num(x, nan=0.0), size=3) > 0.6
        x[holes & bright] = 1.0
    return np.nan_to_num(x, nan=0.0)


def save_diff(a01, b01, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    d = np.nan_to_num(b01 - a01)
    lim = max(np.percentile(np.abs(d), 99.5), 1e-6)
    plt.imsave(path, np.flipud(d), cmap="RdBu_r", vmin=-lim, vmax=lim)


# ----------------------------------------------------------------------
def process(t, per_visit, size_deg):
    print(f"\n=== {t['name']} ===")
    c = simbad_coord(t)
    c, gaia_id = gaia_refine(c, t)
    now_pos = at_time(c, Time("2025-10-01").mjd)
    rows = find_images(now_pos)
    if not rows:
        print("  ! no SPHEREx images - skipped")
        return None
    # keep images whose detector covers the reference colour (fewer downloads)
    sel = [r for r in rows if r["wmin"] and r["wmax"] and r["wmin"] <= t["ref_wl"] <= r["wmax"]] or rows
    visits = group_visits(sel)
    print(f"  {len(rows)} images in total, {len(sel)} on the detector covering {t['ref_wl']} µm, "
          f"{len(visits)} visit(s)")

    mid_mjd = np.mean([v[len(v) // 2]["mjd"] for v in visits])
    center = at_time(c, mid_mjd)
    out_wcs, shape = base.target_wcs(center.ra.deg, center.dec.deg, size_deg)
    n = shape[0]
    os.makedirs(os.path.join(OUT, t["id"]), exist_ok=True)

    points = []
    for vi, v in enumerate(visits):
        step = max(1, len(v) // per_visit)
        for r in v[::step][:per_visit]:
            p = at_time(c, r["mjd"])
            try:
                with base.get_cutout(r["url"], center.ra.deg, center.dec.deg, size_deg * 1.5) as h:
                    img, wcs = base.clean_image(h)
                    var = h["VARIANCE"].data.astype(float) if "VARIANCE" in h else None
                    x, y = wcs.world_to_pixel(p)
                    wl = base.wavelength_at(h, float(x), float(y))
                    flux, snr = base.measure_comet(img, float(x), float(y), var, r_ap=2.5, r_in=6, r_out=10)
            except Exception as e:
                print(f"  ! skipped one image: {e}")
                continue
            from reproject import reproject_interp
            aligned, _ = reproject_interp((img, wcs), out_wcs, shape_out=shape)
            tx, ty = out_wcs.world_to_pixel(p)
            points.append({"visit": vi, "mjd": r["mjd"], "date_utc": Time(r["mjd"], format="mjd").iso[:16],
                           "wl": wl if wl else (r["wmin"] + r["wmax"]) / 2, "flux": flux, "snr": snr,
                           "fx": (float(tx) + 0.5) / n, "fy": (n - float(ty) - 0.5) / n, "_img": aligned})
        print(f"  visit {vi + 1}: {Time(v[0]['mjd'], format='mjd').iso[:10]} · measured {sum(1 for q in points if q['visit'] == vi)}")

    if not points:
        return None
    # blink frames: per visit, the image closest to the reference colour
    frames = []
    for vi in range(len(visits)):
        vp = [q for q in points if q["visit"] == vi and q["snr"] is not None]
        if not vp:
            continue
        best = min(vp, key=lambda q: abs(q["wl"] - t["ref_wl"]))
        frames.append(best)
    if len(frames) < 2:  # only one visit: blink within the visit instead
        frames = sorted([q for q in points if q["snr"] is not None], key=lambda q: q["mjd"])[:6]

    # one shared brightness stretch so brightness changes are visible frame to frame
    stack = np.concatenate([f["_img"][np.isfinite(f["_img"])] for f in frames])
    lo, hi = np.percentile(stack, [5, 99.7])
    out_frames = []
    for i, f in enumerate(frames):
        x01 = np.clip((f["_img"] - lo) / (hi - lo + 1e-12), 0, 1)
        x01 = fill_saturated(np.arcsinh(10 * x01) / np.arcsinh(10))
        f["_x01"] = x01
        name = f"frame_{i:02d}.png"
        base.save_clean_png(x01, os.path.join(OUT, t["id"], name))
        out_frames.append({k: f[k] for k in ("visit", "mjd", "date_utc", "wl", "flux", "snr", "fx", "fy")} |
                          {"file": f"data/targets/{t['id']}/{name}"})
    diff = None
    if len(frames) >= 2:
        save_diff(frames[0]["_x01"], frames[-1]["_x01"], os.path.join(OUT, t["id"], "diff.png"))
        diff = f"data/targets/{t['id']}/diff.png"

    a, b = at_time(c, frames[0]["mjd"]), at_time(c, frames[-1]["mjd"])
    shift = a.separation(b).arcsec
    print(f"  predicted motion between first and last frame: {shift:.1f} arcsec "
          f"({shift / base.PIXEL_SCALE_ARCSEC:.1f} SPHEREx pixels)")
    return {
        "id": t["id"], "name": t["name"], "kind": t["kind"], "type": t["type"], "desc": t["desc"],
        "ref_wl": t["ref_wl"], "size_deg": size_deg,
        "position_source": gaia_id or "SIMBAD",
        "center_ra": center.ra.deg, "center_dec": center.dec.deg,
        "shift_arcsec": shift, "shift_px": shift / base.PIXEL_SCALE_ARCSEC,
        "frames": out_frames, "diff": diff,
        "points": [{k: q[k] for k in ("visit", "mjd", "date_utc", "wl", "flux", "snr")} for q in points],
    }


def main():
    ap = argparse.ArgumentParser(description="SKY BLINK challenge targets")
    ap.add_argument("--only", nargs="*", help="target ids, e.g. barnard rwaur")
    ap.add_argument("--per-visit", type=int, default=8, help="images measured per visit")
    ap.add_argument("--size", type=float, default=0.1, help="cutout width in degrees")
    args = ap.parse_args()

    todo = [t for t in TARGETS if not args.only or t["id"] in args.only]
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join("web", "data", "targets.js")
    results = {}
    if os.path.exists(path):  # keep targets done in earlier runs
        try:
            old = json.loads(open(path).read().split("=", 1)[1].strip().rstrip(";"))
            results = {r["id"]: r for r in old}
        except Exception:
            pass
    for t in todo:
        r = process(t, args.per_visit, args.size)
        if r:
            results[t["id"]] = r
            ordered = [results[x["id"]] for x in TARGETS if x["id"] in results]
            with open(path, "w") as f:
                f.write("window.SKYBLINK_TARGETS = ")
                json.dump(ordered, f)
                f.write(";\n")
    print(f"\nDONE: {len(results)} targets saved in {path}. Reload web/index.html.")


if __name__ == "__main__":
    main()
