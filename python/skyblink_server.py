"""
SKY BLINK live helper - "Search the sky" for ANY position (NASA Space Apps 2026, "Planet X and SPHEREx")
======================================================================================================
Run it from the skyblink folder:

    python skyblink_server.py

then open  http://localhost:8000  in your browser.

What it does when you search a position (RA/Dec or a name):
  1. NASA/IPAC IRSA lists every SPHEREx image of that spot (newest data release first,
     so the tool is always up to date with no extra work).
  2. It downloads small cutouts from ONE detector array (you choose which infrared colours),
     lines them up north-up on one grid, and ADDS together the images of each visit
     (stacking = cleaner picture), or shows every single image.
  3. It makes a difference image (last minus first visit), a deep stack of everything,
     looks for things that changed (moving or varying sources), and reads the FLAGS layer.
  4. Optional overlays: ESA Gaia DR3 stars (moved to the image date) and NASA WISE sources.
  5. "Spectrum" measures the target in up to 36 images across all 6 detectors = a spectrum
     on the fly from 0.75 to 5 microns.

Uses only Python's built-in web server plus the packages you already installed
(astroquery astropy reproject numpy matplotlib pillow).
Needs spherex_test.py and spherex_targets.py in the same folder.
"""

import json
import math
import os
import re
import shutil
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
import uuid
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

import numpy as np
import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.time import Time

import spherex_test as base
import spherex_targets as tg

warnings.simplefilter("ignore")
try:
    from astropy import log as astropy_log
    astropy_log.setLevel("WARNING")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, "web")
LIVE = os.path.join(WEB, "data", "live")
PORT = int(os.environ.get("SKYBLINK_PORT", "8000"))
os.chdir(HERE)  # the download cache lives in ./cache

# SPHEREx detector arrays and their wavelength ranges (microns)
DETECTORS = {1: (0.75, 1.09), 2: (1.10, 1.62), 3: (1.63, 2.41), 4: (2.42, 3.82), 5: (3.83, 4.41), 6: (4.42, 5.00)}

# The challenge's test targets (+ proper motion so the tool can predict where they are)
PRESETS = {
    "barnard's star": {"ra": 269.452083, "dec": 4.693391, "pmra": -801.55, "pmdec": 10362.39, "epoch": 2000.0, "det": 2},
    "barnard": "barnard's star",
    "epsilon indi b": {"ra": 331.0438, "dec": -56.7828, "pmra": 3982.0, "pmdec": -2470.0, "epoch": 2000.0, "det": 5},
    "eps ind b": "epsilon indi b",
    "wise 0855": {"ra": 133.795129, "dec": -7.245147, "pmra": -8123.7, "pmdec": 673.1, "epoch": 2010.3, "det": 6},
    "wise 0855-0714": "wise 0855",
    "wise j085510.83-071442.5": "wise 0855",
    "rw aurigae": {"ra": 76.956458, "dec": 30.401417, "pmra": 3.0, "pmdec": -25.0, "epoch": 2000.0, "det": 3},
    "rw aur": "rw aurigae",
    "r draconis": {"ra": 248.1675, "dec": 66.755, "pmra": -2.0, "pmdec": 15.0, "epoch": 2000.0, "det": 3},
    "r dra": "r draconis",
}

JOBS = {}
JOBS_LOCK = threading.Lock()


# ---------------------------------------------------------------------- helpers
def detector_of(row):
    m = re.search(r"D(\d)_spx", row["url"])
    if m:
        return int(m.group(1))
    if row.get("wmin") and row.get("wmax"):
        mid = (row["wmin"] + row["wmax"]) / 2
        for d, (a, b) in DETECTORS.items():
            if a - 0.02 <= mid <= b + 0.02:
                return d
    return None


def problem_pixels(flags):
    """SPHEREx FLAGS: some bits are set on many pixels (e.g. 'a source is here') and are harmless;
    rare bits mark real problems (hot pixels, cosmic-ray hits, non-working pixels...). Return a mask
    of pixels with any RARE flag bit set."""
    if flags is None:
        return None
    f = flags.astype(np.int64)
    common = 0
    for b in range(32):
        if np.mean((f >> b) & 1) > 0.05:
            common |= (1 << b)
    return (f & ~common) != 0


def parse_coord(ra_s, dec_s):
    ra_s, dec_s = str(ra_s).strip(), str(dec_s).strip()
    sexa = any(ch in ra_s for ch in "hms: ")
    return SkyCoord(ra_s, dec_s, unit=(u.hourangle if sexa else u.deg, u.deg))


def resolve_name(name):
    """Name -> position. Challenge targets are built in; other names go to CDS Sesame."""
    key = name.strip().lower().replace("’", "'")
    p = PRESETS.get(key)
    if isinstance(p, str):
        p = PRESETS[p]
    if p:
        return dict(p, source="SKY BLINK built-in (with proper motion)")
    url = "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?" + urllib.parse.quote(name)
    with urllib.request.urlopen(url, timeout=20) as r:
        xml = r.read().decode("utf-8", "replace")
    ra = re.search(r"<jradeg>([-\d.eE+]+)</jradeg>", xml)
    dec = re.search(r"<jdedeg>([-\d.eE+]+)</jdedeg>", xml)
    if not (ra and dec):
        raise ValueError(f"'{name}' was not found. Try coordinates instead.")
    pmra = re.search(r"<pmRA>([-\d.eE+]+)</pmRA>", xml)
    pmde = re.search(r"<pmDE>([-\d.eE+]+)</pmDE>", xml)
    return {"ra": float(ra.group(1)), "dec": float(dec.group(1)),
            "pmra": float(pmra.group(1)) if pmra else 0.0, "pmdec": float(pmde.group(1)) if pmde else 0.0,
            "epoch": 2000.0, "source": "CDS Sesame / SIMBAD"}


def moved(ra, dec, pmra, pmdec, epoch, mjd):
    """Simple proper-motion shift (good to << 1 pixel over a few decades)."""
    dt = (Time(mjd, format="mjd").jyear - epoch)
    d_dec = pmdec * dt / 3.6e6
    d_ra = pmra * dt / 3.6e6 / max(1e-6, math.cos(math.radians(dec)))
    return ra + d_ra, dec + d_dec


class Job:
    def __init__(self, kind, params):
        self.id = uuid.uuid4().hex[:10]
        self.kind, self.params = kind, params
        self.status, self.progress, self.log, self.result, self.error = "running", 0.0, [], None, None
        self.t0 = time.time()

    def say(self, msg, progress=None):
        self.log.append(msg)
        if progress is not None:
            self.progress = float(progress)
        print(f"  [{self.id}] {msg}")

    def public(self):
        return {"id": self.id, "kind": self.kind, "status": self.status, "progress": round(self.progress, 3),
                "log": self.log[-12:], "result": self.result, "error": self.error,
                "seconds": round(time.time() - self.t0, 1)}


def start_job(kind, params, fn):
    job = Job(kind, params)
    with JOBS_LOCK:
        JOBS[job.id] = job

    def run():
        try:
            job.result = fn(job, params)
            job.status, job.progress = "done", 1.0
        except Exception as e:
            job.status, job.error = "error", str(e).splitlines()[0][:300] if str(e) else type(e).__name__
            traceback.print_exc()
    threading.Thread(target=run, daemon=True).start()
    return job


def cleanup_live(keep=25):
    if not os.path.isdir(LIVE):
        return
    dirs = sorted((os.path.join(LIVE, d) for d in os.listdir(LIVE)), key=os.path.getmtime)
    for d in dirs[:-keep]:
        shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------------- the search job
def target_from_params(p):
    if p.get("name"):
        t = resolve_name(p["name"])
    else:
        c = parse_coord(p["ra"], p["dec"])
        t = {"ra": c.ra.deg, "dec": c.dec.deg, "pmra": 0.0, "pmdec": 0.0, "epoch": 2000.0, "source": "your coordinates"}
    for k in ("pmra", "pmdec"):
        if p.get(k) not in (None, ""):
            t[k] = float(p[k])
    return t


def fetch_all(job, rows, ra, dec, size, p0, p1):
    """Download cutouts in parallel. Returns {url: (img, wcs, var, flags, wl_at_center)}."""
    out = {}

    def one(r):
        with base.get_cutout(r["url"], ra, dec, size) as h:
            img, wcs = base.clean_image(h)
            raw = img
            var = h["VARIANCE"].data.astype(float) if "VARIANCE" in h else None
            flags = h["FLAGS"].data.astype(np.int64) if "FLAGS" in h else None
            bad = problem_pixels(flags)
            if bad is not None and bad.shape == img.shape:
                img = img.copy(); img[bad] = np.nan
                flags = bad.astype(np.int64)  # from now on "flags" = real problem pixels only
            x, y = wcs.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg))
            wl = base.wavelength_at(h, float(x), float(y))
            return img, wcs, var, flags, wl, float(x), float(y), raw

    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(one, r): r for r in rows}
        for i, f in enumerate(as_completed(futs)):
            r = futs[f]
            try:
                out[r["url"]] = f.result()
            except Exception as e:
                job.say(f"skipped one image ({str(e).splitlines()[0][:60]})")
            job.progress = p0 + (p1 - p0) * (i + 1) / len(rows)
            if (i + 1) % 4 == 0 or i + 1 == len(rows):
                job.say(f"downloaded {i + 1} of {len(rows)} images", job.progress)
    return out


def png01(stack_list, lo=None, hi=None):
    allv = np.concatenate([s[np.isfinite(s)] for s in stack_list]) if lo is None else None
    if lo is None:
        # set black just under the sky background and white well above the noise, so faint stars show
        med = np.median(allv); sig = np.median(np.abs(allv - med)) * 1.4826 + 1e-12
        lo = med - 1.0 * sig
        hi = min(np.percentile(allv, 99.8), med + 80 * sig)
        if hi <= lo + 5 * sig:
            hi = lo + 30 * sig
    outs = []
    for s in stack_list:
        x = np.clip((s - lo) / (hi - lo + 1e-12), 0, 1)
        outs.append(tg.fill_saturated(np.arcsinh(10 * x) / np.arcsinh(10)))
    return outs, lo, hi


def find_changes(diff, noise_map=None, max_n=6, bad=None, bright=None):
    """Peaks in the difference image: + = new light, - = light that left. A +/- pair close together = mover."""
    from scipy.ndimage import uniform_filter, maximum_filter
    d = np.nan_to_num(diff)
    sm = uniform_filter(d, 3)
    med = np.median(sm); mad = np.median(np.abs(sm - med)) * 1.4826 + 1e-12
    if bright is not None:
        # a star seen at a slightly different infrared colour changes brightness a little:
        # only count changes bigger than ~25% of what was already there
        b = uniform_filter(np.nan_to_num(np.clip(bright, 0, None)), 3)
        z = (sm - med) / np.sqrt(mad ** 2 + (0.25 * b) ** 2)
    else:
        z = (sm - med) / mad
    n = d.shape[0]
    found = []
    for sign in (1, -1):
        zz = sign * z
        peaks = (zz == maximum_filter(zz, size=9)) & (zz > 8)
        if bad is not None:
            peaks &= ~bad
        ys, xs = np.nonzero(peaks)
        for x, y in zip(xs, ys):
            if 3 <= x < n - 3 and 3 <= y < n - 3:
                found.append({"x": int(x), "y": int(y), "sig": float(zz[y, x]), "sign": sign})
    found.sort(key=lambda f: -f["sig"])
    found = found[:max_n * 2]
    # pair + and - peaks close together -> "possible mover"
    for f in found:
        f["pair"] = any(g["sign"] != f["sign"] and math.hypot(g["x"] - f["x"], g["y"] - f["y"]) <= 6 for g in found)
    found = found[:max_n]
    return found, float(mad)


def gaia_overlay(job, ra, dec, radius_deg, mjd, out_wcs, n):
    try:
        from astroquery.gaia import Gaia
        Gaia.ROW_LIMIT = 600
        q = f"""SELECT TOP 80 source_id, ra, dec, pmra, pmdec, phot_g_mean_mag
            FROM gaiadr3.gaia_source
            WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_deg}))
            AND phot_g_mean_mag < 18.5 ORDER BY phot_g_mean_mag"""
        r = Gaia.launch_job(q).get_results()
        cols = {k.lower(): k for k in r.colnames}
        out = []
        for row in r:
            g = lambda k: float(row[cols[k]]) if np.isfinite(row[cols[k]]) else 0.0
            pr, pd = g("pmra"), g("pmdec")
            a, b = moved(g("ra"), g("dec"), pr, pd, 2016.0, mjd)
            x, y = out_wcs.world_to_pixel(SkyCoord(a * u.deg, b * u.deg))
            if -2 <= x <= n + 1 and -2 <= y <= n + 1:
                out.append({"fx": (float(x) + 0.5) / n, "fy": (n - float(y) - 0.5) / n, "g": round(g("phot_g_mean_mag"), 2),
                            "pm": round(math.hypot(pr, pd), 1), "id": str(row[cols["source_id"]])})
        job.say(f"Gaia DR3: {len(out)} stars in the view")
        return out
    except Exception as e:
        job.say(f"Gaia overlay unavailable ({str(e).splitlines()[0][:60]})")
        return []


def wise_overlay(job, ra, dec, radius_deg, out_wcs, n):
    try:
        from astroquery.ipac.irsa import Irsa
        r = Irsa.query_region(SkyCoord(ra * u.deg, dec * u.deg), catalog="allwise_p3as_psd",
                              spatial="Cone", radius=radius_deg * u.deg, columns="ra,dec,w1mpro,w2mpro")
        out = []
        for row in r[:600]:
            x, y = out_wcs.world_to_pixel(SkyCoord(float(row["ra"]) * u.deg, float(row["dec"]) * u.deg))
            if -2 <= x <= n + 1 and -2 <= y <= n + 1:
                w1 = float(row["w1mpro"]) if np.isfinite(row["w1mpro"]) else None
                w2 = float(row["w2mpro"]) if np.isfinite(row["w2mpro"]) else None
                out.append({"fx": (float(x) + 0.5) / n, "fy": (n - float(y) - 0.5) / n, "w1": w1, "w2": w2})
        job.say(f"AllWISE: {len(out)} sources in the view")
        return out
    except Exception as e:
        job.say(f"WISE overlay unavailable ({str(e).splitlines()[0][:60]})")
        return []


SAVED = os.path.join(WEB, "data", "saved")


def save_result(q):
    """Copy a finished search (and its spectrum) into web/data/saved/ so the public website can show it
    without this helper. Writes web/data/saved.js."""
    job = JOBS.get(q.get("id", ""))
    if not job or job.status != "done" or job.kind != "search":
        raise ValueError("Search again first, then save.")
    name = (q.get("name") or "search").strip()[:60]
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or job.id
    src, dst = os.path.join(LIVE, job.id), os.path.join(SAVED, slug)
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(src, dst)
    res = json.loads(json.dumps(job.result).replace(f"data/live/{job.id}/", f"data/saved/{slug}/"))
    spec = JOBS.get(q.get("spec", ""))
    if spec and spec.status == "done":
        res["spectrum"] = spec.result
    res["saved_utc"] = Time.now().iso[:16]
    index_path = os.path.join(WEB, "data", "saved.js")
    allres = {}
    if os.path.exists(index_path):
        try:
            allres = json.loads(open(index_path, encoding="utf-8").read().split("=", 1)[1].strip().rstrip(";"))
        except Exception:
            allres = {}
    allres[slug] = {"name": name, "result": res}
    with open(index_path, "w", encoding="utf-8") as f:
        f.write("window.SKYBLINK_SAVED = " + json.dumps(allres) + ";\n")
    return {"ok": True, "slug": slug, "count": len(allres)}


def search_job(job, p):
    t = target_from_params(p)
    fov = float(np.clip(float(p.get("fov", 0.1)), 0.03, 0.5))
    mode = p.get("mode", "stack")
    per_visit = int(np.clip(int(p.get("per_visit", 4)), 1, 10))
    max_frames = int(np.clip(int(p.get("max_frames", 12)), 2, 24))
    job.say(f"Target {t['ra']:.5f}, {t['dec']:+.5f} ({t['source']})", 0.02)

    now = moved(t["ra"], t["dec"], t["pmra"], t["pmdec"], t["epoch"], Time("2025-10-01").mjd)
    rows = tg.find_images(SkyCoord(now[0] * u.deg, now[1] * u.deg))
    if not rows:
        raise ValueError("SPHEREx has no images of this position yet.")
    for r in rows:
        r["det"] = detector_of(r)
    by_det = {}
    for r in rows:
        by_det.setdefault(r["det"], []).append(r)
    det = p.get("det", "auto")
    det = int(det) if str(det).isdigit() else (t.get("det") or max(by_det, key=lambda d: len(by_det[d])))
    if det not in by_det:
        det = max(by_det, key=lambda d: len(by_det[d]))
    sel = by_det[det]
    visits = tg.group_visits(sel, gap_days=30)
    job.say(f"{len(rows)} SPHEREx images here ({rows[0]['coll']}); detector {det} "
            f"({DETECTORS[det][0]}-{DETECTORS[det][1]} µm): {len(sel)} images in {len(visits)} visit(s)", 0.08)

    # choose which images to download
    if mode == "all":
        pool = sorted(sel, key=lambda r: r["mjd"])
        idx = np.unique(np.linspace(0, len(pool) - 1, min(len(pool), max_frames)).round().astype(int))
        groups = [[pool[i]] for i in idx]
    else:
        groups = []
        for v in visits[:max_frames]:
            step = max(1, len(v) // per_visit)
            groups.append(v[::step][:per_visit])
    todo = [r for g in groups for r in g]

    mid_mjd = np.mean([g[0]["mjd"] for g in groups])
    cra, cdec = moved(t["ra"], t["dec"], t["pmra"], t["pmdec"], t["epoch"], mid_mjd)
    out_wcs, shape = base.target_wcs(cra, cdec, fov)
    n = shape[0]
    data = fetch_all(job, todo, cra, cdec, fov * 1.5, 0.1, 0.8)
    if not data:
        raise ValueError("No images could be downloaded. Please try again in a minute.")

    from reproject import reproject_interp
    frames, stacks = [], []
    for gi, g in enumerate(groups):
        imgs, wls, fl_center, fl_all, names, mjds, fluxes = [], [], [], [], [], [], []
        for r in g:
            if r["url"] not in data:
                continue
            img, wcs, var, flags, wl, x, y, raw = data[r["url"]]
            a, b = moved(t["ra"], t["dec"], t["pmra"], t["pmdec"], t["epoch"], r["mjd"])
            tx, ty = wcs.world_to_pixel(SkyCoord(a * u.deg, b * u.deg))
            # brightness from the original pixels (bright stars have flagged, overloaded centres)
            flux, snr = base.measure_comet(raw, float(tx), float(ty), var, r_ap=2.5, r_in=6, r_out=10)
            fluxes.append((flux, snr))
            al, _ = reproject_interp((img, wcs), out_wcs, shape_out=shape)
            imgs.append(al); wls.append(wl); mjds.append(r["mjd"])
            names.append(r["url"].split("/")[-1].split("?")[0])
            if flags is not None:
                ix, iy = int(round(float(tx))), int(round(float(ty)))
                box = flags[max(0, iy - 2):iy + 3, max(0, ix - 2):ix + 3]
                fl_center.append(int(np.count_nonzero(box)))
                fl_all.append(float(np.count_nonzero(flags)) / flags.size)
        if not imgs:
            continue
        # median: a cosmic ray or hot pixel in ONE image does not survive
        st = np.nanmedian(np.stack(imgs), axis=0) if len(imgs) > 2 else (np.nanmean(np.stack(imgs), axis=0) if len(imgs) == 2 else imgs[0])
        mjd = float(np.mean(mjds))
        a, b = moved(t["ra"], t["dec"], t["pmra"], t["pmdec"], t["epoch"], mjd)
        tx, ty = out_wcs.world_to_pixel(SkyCoord(a * u.deg, b * u.deg))
        good = [f for f in fluxes if f[0] is not None]
        flux = float(np.mean([f[0] for f in good])) if good else None
        snr = float(np.sqrt(np.sum([max(0, f[1]) ** 2 for f in good]))) if good else None
        stacks.append(st)
        frames.append({"mjd": mjd, "date_utc": Time(mjd, format="mjd").iso[:16], "n_stacked": len(imgs),
                       "wl": float(np.nanmean([w for w in wls if w])) if any(wls) else float(np.mean(DETECTORS[det])),
                       "wl_min": float(np.nanmin([w for w in wls if w])) if any(wls) else None,
                       "wl_max": float(np.nanmax([w for w in wls if w])) if any(wls) else None,
                       "flux": flux, "snr": snr,
                       "flag_center": int(max(fl_center)) if fl_center else None,
                       "flag_frac": round(float(np.mean(fl_all)), 4) if fl_all else None,
                       "images": names,
                       "fx": (float(tx) + 0.5) / n, "fy": (n - float(ty) - 0.5) / n})
        job.say(f"frame {len(frames)}: {frames[-1]['date_utc'][:10]}, {len(imgs)} image(s) added together", 0.8 + 0.1 * gi / len(groups))
    if len(frames) < 1:
        raise ValueError("No usable images.")

    jdir = os.path.join(LIVE, job.id)
    os.makedirs(jdir, exist_ok=True)
    x01s, lo, hi = png01(stacks)
    for i, (f, x) in enumerate(zip(frames, x01s)):
        name = f"frame_{i:02d}.png"
        base.save_clean_png(x, os.path.join(jdir, name))
        f["file"] = f"data/live/{job.id}/{name}"
    deep = np.nanmedian(np.stack(stacks), axis=0) if len(stacks) > 2 else np.nanmean(np.stack(stacks), axis=0)
    (deep01,), _, _ = png01([deep])
    base.save_clean_png(deep01, os.path.join(jdir, "deep.png"))
    changes, diff_file = [], None
    if len(stacks) >= 2:
        diff = stacks[-1] - stacks[0]
        tg.save_diff(x01s[0], x01s[-1], os.path.join(jdir, "diff.png"))
        diff_file = f"data/live/{job.id}/diff.png"
        from scipy.ndimage import binary_dilation
        bad = binary_dilation(~np.isfinite(stacks[0]) | ~np.isfinite(stacks[-1]), iterations=3)
        # very bright stars change a lot between colours: ignore their cores
        both = np.nan_to_num(np.minimum(stacks[0], stacks[-1]))
        bad |= binary_dilation(both > np.nanpercentile(both, 99.7), iterations=2)
        bg = np.nanmedian(np.r_[stacks[0][np.isfinite(stacks[0])], stacks[-1][np.isfinite(stacks[-1])]])
        found, _ = find_changes(diff, bad=bad, bright=np.fmin(stacks[0], stacks[-1]) - bg)
        for f in found:
            changes.append({"fx": (f["x"] + 0.5) / n, "fy": (n - f["y"] - 0.5) / n, "sig": round(f["sig"], 1),
                            "sign": f["sign"], "pair": f["pair"]})
        job.say(f"change finder: {len(changes)} spot(s) changed between first and last frame")
    radius = fov / 2 * 1.45
    gaia = gaia_overlay(job, cra, cdec, radius, mid_mjd, out_wcs, n) if p.get("gaia", "1") == "1" else []
    wise = wise_overlay(job, cra, cdec, radius, out_wcs, n) if p.get("wise", "0") == "1" else []
    a0, b0 = moved(t["ra"], t["dec"], t["pmra"], t["pmdec"], t["epoch"], frames[0]["mjd"])
    a1, b1 = moved(t["ra"], t["dec"], t["pmra"], t["pmdec"], t["epoch"], frames[-1]["mjd"])
    shift = SkyCoord(a0 * u.deg, b0 * u.deg).separation(SkyCoord(a1 * u.deg, b1 * u.deg)).arcsec
    res = {"ra": t["ra"], "dec": t["dec"], "center_ra": cra, "center_dec": cdec, "source": t["source"],
           "pm": round(math.hypot(t["pmra"], t["pmdec"]), 1), "shift_arcsec": shift,
           "fov": fov, "npx": n, "det": det, "det_range": DETECTORS[det], "mode": mode,
           "collection": rows[0]["coll"], "n_total": len(rows),
           "det_counts": {str(k): len(v) for k, v in by_det.items() if k},
           "frames": frames, "diff": diff_file, "deep": f"data/live/{job.id}/deep.png",
           "changes": changes, "gaia": gaia, "wise": wise,
           "aladin": f"https://aladin.cds.unistra.fr/AladinLite/?target={cra:.5f}%20{cdec:+.5f}&fov={fov:.3f}&survey=CDS%2FP%2F2MASS%2Fcolor"}
    with open(os.path.join(jdir, "result.json"), "w") as fh:
        json.dump(res, fh)
    cleanup_live()
    job.say(f"done in {time.time() - job.t0:.0f} s", 1.0)
    return res


def spectrum_job(job, p):
    """Measure the target in images from all 6 detectors of one visit -> spectrum 0.75-5 µm."""
    t = target_from_params(p)
    now = moved(t["ra"], t["dec"], t["pmra"], t["pmdec"], t["epoch"], Time("2025-10-01").mjd)
    rows = tg.find_images(SkyCoord(now[0] * u.deg, now[1] * u.deg))
    if not rows:
        raise ValueError("SPHEREx has no images of this position yet.")
    for r in rows:
        r["det"] = detector_of(r)
    visits = tg.group_visits(rows, gap_days=30)
    pick = p.get("visit")
    if pick not in (None, "", "best"):
        v = visits[int(pick) % len(visits)]
    else:
        v = max(visits, key=lambda v: len({r["det"] for r in v}) * 100 + len(v))
    per_det = int(np.clip(int(p.get("per_det", 6)), 2, 12))
    todo = []
    for d in sorted({r["det"] for r in v if r["det"]}):
        rr = sorted([r for r in v if r["det"] == d], key=lambda r: (r["wmin"] or 0))
        idx = np.unique(np.linspace(0, len(rr) - 1, min(len(rr), per_det)).round().astype(int))
        todo += [rr[i] for i in idx]
    job.say(f"visit of {Time(v[0]['mjd'], format='mjd').iso[:10]}: measuring {len(todo)} images across "
            f"{len({r['det'] for r in todo})} detectors", 0.05)
    pts = []

    def one(r):
        a, b = moved(t["ra"], t["dec"], t["pmra"], t["pmdec"], t["epoch"], r["mjd"])
        with base.get_cutout(r["url"], a, b, 0.04) as h:
            img, wcs = base.clean_image(h)
            var = h["VARIANCE"].data.astype(float) if "VARIANCE" in h else None
            x, y = wcs.world_to_pixel(SkyCoord(a * u.deg, b * u.deg))
            wl = base.wavelength_at(h, float(x), float(y))
            flux, snr = base.measure_comet(img, float(x), float(y), var, r_ap=2.5, r_in=6, r_out=10)
            return wl, flux, snr

    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(one, r): r for r in todo}
        for i, f in enumerate(as_completed(futs)):
            r = futs[f]
            try:
                wl, flux, snr = f.result()
                if wl and flux is not None:
                    pts.append({"wl": wl, "flux": flux, "err": abs(flux / snr) if snr else None, "snr": snr, "det": r["det"]})
            except Exception as e:
                job.say(f"skipped one image ({str(e).splitlines()[0][:50]})")
            job.progress = 0.05 + 0.9 * (i + 1) / len(todo)
            if (i + 1) % 6 == 0:
                job.say(f"measured {i + 1} of {len(todo)}", job.progress)
    pts.sort(key=lambda q: q["wl"])
    job.say(f"spectrum: {len(pts)} points from {pts[0]['wl']:.2f} to {pts[-1]['wl']:.2f} µm" if pts else "no points", 1.0)
    return {"points": pts, "date": Time(v[0]["mjd"], format="mjd").iso[:10], "ra": t["ra"], "dec": t["dec"],
            "units": "SPHEREx surface brightness summed in a 2.5-pixel circle (MJy/sr x pixels)"}


# ---------------------------------------------------------------------- web server
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=WEB, **k)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            return
        super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u_ = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u_.query).items()}
        try:
            if u_.path == "/api/ping":
                return self.send_json({"ok": True, "detectors": DETECTORS, "version": 1})
            if u_.path == "/api/resolve":
                return self.send_json(resolve_name(q.get("name", "")))
            if u_.path == "/api/search":
                if not (q.get("name") or (q.get("ra") and q.get("dec"))):
                    return self.send_json({"error": "Give a name, or RA and Dec."}, 400)
                return self.send_json(start_job("search", q, search_job).public())
            if u_.path == "/api/save":
                return self.send_json(save_result(q))
            if u_.path == "/api/spectrum":
                return self.send_json(start_job("spectrum", q, spectrum_job).public())
            if u_.path.startswith("/api/job/"):
                job = JOBS.get(u_.path.rsplit("/", 1)[-1])
                return self.send_json(job.public() if job else {"error": "unknown job"}, 200 if job else 404)
        except Exception as e:
            return self.send_json({"error": str(e).splitlines()[0][:300]}, 400)
        return super().do_GET()


def main():
    os.makedirs(LIVE, exist_ok=True)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"\nSKY BLINK helper running.  Open  http://localhost:{PORT}  in your browser.")
    print("Keep this window open while you use 'Search the sky'. Press Ctrl+C to stop.\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__":
    main()
