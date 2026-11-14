"""
SKY BLINK - SPHEREx data pipeline (NASA Space Apps 2026)
=========================================================
Works on real NASA SPHEREx images of the interstellar comet 3I/ATLAS.

STEP 1  --scan   Look at EVERY SPHEREx image of the comet. For each one,
                 measure the exact infrared colour (wavelength) at the comet's
                 spot and how bright the comet is there.
                 -> skyblink_output/comet_fingerprint.csv
                 -> skyblink_output/fingerprint.png   (the comet's "fingerprint")

STEP 2  --blink  Pick frames where the comet is clearly visible, line them up
                 on the same patch of sky, and make the blink animation.
                 -> skyblink_output/frame_XX.png, blink.gif, frames.json

STEP 3  --web    Website data: clean frames, comet thumbnails, site_data.js
                 -> web/data/   then double-click web/index.html

Run everything (default): python spherex_test.py
Website only (fast):      python spherex_test.py --web
Only one step:          python spherex_test.py --scan
                        python spherex_test.py --blink
Hide the circle:        python spherex_test.py --blink --no-marker

Setup (once):  python -m pip install astropy reproject numpy matplotlib pillow

Downloads are saved in ./cache so running again is fast.
"""

import argparse
import csv
import hashlib
import json
import os
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.table import Table
from astropy.time import Time
from astropy.utils.data import conf
from astropy.wcs import WCS, FITSFixedWarning

warnings.simplefilter("ignore", FITSFixedWarning)
import logging
from astropy import log as astropy_log
astropy_log.setLevel("WARNING")  # hide the long "SIP distortion" INFO messages
conf.remote_timeout = 180

OBS_TABLE_URL = ("https://irsa.ipac.caltech.edu/data/SPHEREx/docs/"
                 "comet3iatlas/obscore_3I_Atlas.vot")
PIXEL_SCALE_ARCSEC = 6.15
OUT_DIR = "skyblink_output"
CACHE_DIR = "cache"
FINGERPRINT_CSV = os.path.join(OUT_DIR, "comet_fingerprint.csv")
WEB_DATA = os.path.join("web", "data")

# Gas glow lines worth pointing out to judges (microns)
FEATURES = {"Water (H2O)": 2.7, "Carbon dioxide (CO2)": 4.26, "Carbon monoxide (CO)": 4.67}


# ======================================================================
# Small helpers
# ======================================================================
def text(v):
    return v.decode() if isinstance(v, bytes) else str(v)


def find_col(table, *candidates):
    lower = {c.lower(): c for c in table.colnames}
    for cand in candidates:
        if cand.lower() in lower:
            return lower[cand.lower()]
    return None


def to_mjd(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return Time(text(value)).mjd


def detector_number(value):
    digits = "".join(ch for ch in text(value) if ch.isdigit())
    return int(digits) if digits else None


# ======================================================================
# Downloading
# ======================================================================
def load_observations():
    os.makedirs(CACHE_DIR, exist_ok=True)
    local = os.path.join(CACHE_DIR, "obscore_3I_Atlas.vot")
    if not os.path.exists(local):
        print("Downloading the 3I/ATLAS observation table from NASA/IPAC...")
        from astropy.utils.data import download_file
        import shutil
        for attempt in range(1, 6):
            try:
                tmp = download_file(OBS_TABLE_URL, cache=False)
                shutil.copy(tmp, local)
                break
            except Exception as e:
                print(f"  table download failed (try {attempt}/5): {e}")
                if attempt == 5:
                    sys.exit("Could not reach NASA/IPAC. Check internet and run again.")
                time.sleep(3 * attempt)
    t = Table.read(local, format="votable")
    c = {
        "url": find_col(t, "access_url"),
        "ra": find_col(t, "comet_ra"),
        "dec": find_col(t, "comet_dec"),
        "t": find_col(t, "t_min"),
        "wmin": find_col(t, "em_min"),
        "wmax": find_col(t, "em_max"),
        "det": find_col(t, "spherex_detector"),
        "obs": find_col(t, "obs_id"),
    }
    missing = [k for k in ("url", "ra", "dec", "t") if c[k] is None]
    if missing:
        sys.exit(f"Missing columns {missing}. Columns are: {t.colnames}")

    rows = []
    for r in t:
        url = text(r[c["url"]]).strip()
        if not url.startswith("http"):
            continue
        rows.append({
            "url": url,
            "ra": float(r[c["ra"]]),
            "dec": float(r[c["dec"]]),
            "mjd": to_mjd(r[c["t"]]),
            "det": detector_number(r[c["det"]]) if c["det"] else None,
            "obs_id": text(r[c["obs"]]) if c["obs"] else "",
            "det_wl": (float(r[c["wmin"]]) + float(r[c["wmax"]])) / 2 * 1e6
                      if c["wmin"] and c["wmax"] else None,
        })
    rows.sort(key=lambda r: r["mjd"])
    print(f"  Found {len(rows)} SPHEREx images of 3I/ATLAS")
    return rows


def resolve_fits_url(url):
    """NASA's table links to a 'DataLink' list; find the real FITS image in it."""
    if "datalink" not in url.lower():
        return url
    links = Table.read(url, format="votable", use_names_over_ids=True)
    url_col, sem_col = find_col(links, "access_url"), find_col(links, "semantics")
    if url_col and sem_col:
        for row in links:
            if text(row[sem_col]).strip() == "#this":
                link = text(row[url_col]).strip()
                if link.startswith("http"):
                    return link
    for row in links:
        for col in links.colnames:
            cell = text(row[col]).strip()
            if cell.startswith("http") and cell.lower().split("?")[0].endswith(".fits"):
                return cell
    raise ValueError(f"No FITS link in DataLink. Columns: {links.colnames}")


def get_cutout(url, ra, dec, size_deg, retries=4):
    """Download (or load from cache) a small cutout. Returns an HDUList."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    key = hashlib.md5(f"{url}|{ra:.5f}|{dec:.5f}|{size_deg:.4f}".encode()).hexdigest()
    path = os.path.join(CACHE_DIR, key + ".fits")
    if os.path.exists(path):
        try:
            return fits.open(path)
        except Exception:
            os.remove(path)
    last = None
    for attempt in range(1, retries + 1):
        try:
            fits_url = resolve_fits_url(url)
            sep = "&" if "?" in fits_url else "?"
            cut_url = f"{fits_url}{sep}center={ra:.6f},{dec:.6f}&size={size_deg:.4f}"
            with fits.open(cut_url, cache=False) as h:
                h.writeto(path, overwrite=True)
            return fits.open(path)
        except Exception as e:
            last = e
            time.sleep(2 * attempt)
    raise RuntimeError(f"download failed after {retries} tries: {last}")


# ======================================================================
# Measuring
# ======================================================================
def clean_image(hdul):
    img = hdul["IMAGE"].data.astype(float)
    if "ZODI" in hdul:
        img = img - hdul["ZODI"].data.astype(float)
    return img, WCS(hdul["IMAGE"].header)


def wavelength_at(hdul, x, y):
    """Exact wavelength (microns) at a pixel, using SPHEREx's spectral WCS ('W')."""
    try:
        sw = WCS(hdul["IMAGE"].header, fobj=hdul, key="W")
        out = sw.pixel_to_world(x, y)
        wl = out[0] if isinstance(out, (list, tuple)) else out
        wl = u.Quantity(wl)
        return float(wl.to(u.micron).value) if wl.unit != u.one else float(wl.value)
    except Exception:
        try:  # manual fallback: pixel_to_world_values gives raw numbers
            sw = WCS(hdul["IMAGE"].header, fobj=hdul, key="W")
            val = float(np.ravel(sw.pixel_to_world_values(x, y))[0])
            return val * 1e6 if val < 1e-3 else val  # metres -> microns if needed
        except Exception:
            return None


def measure_comet(img, x, y, var=None, r_ap=3.0, r_in=7.0, r_out=12.0):
    """Brightness inside a small circle on the comet minus local background.
    Returns (flux, snr) in relative units."""
    ny, nx = img.shape
    yy, xx = np.mgrid[:ny, :nx]
    d = np.hypot(xx - x, yy - y)
    ap = (d <= r_ap) & np.isfinite(img)
    ann = (d >= r_in) & (d <= r_out) & np.isfinite(img)
    if ap.sum() < 10 or ann.sum() < 20:
        return None, None
    bg_vals = img[ann]
    med = np.median(bg_vals)
    mad = np.median(np.abs(bg_vals - med)) * 1.4826 + 1e-12
    bg = np.median(bg_vals[np.abs(bg_vals - med) < 3 * mad])
    flux = float(np.sum(img[ap] - bg))
    if var is not None and np.isfinite(var[ap]).all():
        noise = float(np.sqrt(np.sum(var[ap])))
    else:
        noise = float(mad * np.sqrt(ap.sum()))
    return flux, (flux / noise if noise > 0 else None)


# ======================================================================
# STEP 1: scan every image -> fingerprint
# ======================================================================
def scan_one(r):
    size = 0.06  # degrees, ~35 pixels around the comet: small and fast
    with get_cutout(r["url"], r["ra"], r["dec"], size) as h:
        img, wcs = clean_image(h)
        var = h["VARIANCE"].data.astype(float) if "VARIANCE" in h else None
        x, y = wcs.world_to_pixel(SkyCoord(r["ra"] * u.deg, r["dec"] * u.deg))
        x, y = float(x), float(y)
        wl = wavelength_at(h, x, y)
        flux, snr = measure_comet(img, x, y, var)
    return {**r, "wl_um": wl, "flux": flux, "snr": snr, "wl_exact": wl is not None}


def run_scan(rows, workers):
    print(f"\nSTEP 1: scanning all {len(rows)} images (first time ~5-15 min)...")
    results, failed = [], 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(scan_one, r): r for r in rows}
        for i, f in enumerate(as_completed(futs), 1):
            try:
                results.append(f.result())
            except Exception as e:
                failed += 1
                print(f"  ! skipped one image: {e}")
            if i % 10 == 0 or i == len(rows):
                print(f"  {i}/{len(rows)} done")
    results.sort(key=lambda r: r["mjd"])

    exact = sum(r["wl_exact"] for r in results)
    if exact < len(results):
        print(f"  Note: exact wavelength read for {exact}/{len(results)} images; "
              "others use the detector's average colour.")
        for r in results:
            if r["wl_um"] is None:
                r["wl_um"] = r["det_wl"]

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(FINGERPRINT_CSV, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date_utc", "mjd", "detector", "wavelength_um", "wavelength_exact",
                    "brightness", "snr", "comet_ra", "comet_dec", "url"])
        for r in results:
            w.writerow([Time(r["mjd"], format="mjd").iso[:16], f"{r['mjd']:.6f}", r["det"],
                        f"{r['wl_um']:.4f}" if r["wl_um"] else "", r["wl_exact"],
                        f"{r['flux']:.4g}" if r["flux"] is not None else "",
                        f"{r['snr']:.2f}" if r["snr"] is not None else "",
                        f"{r['ra']:.6f}", f"{r['dec']:.6f}", r["url"]])
    print(f"  Saved {FINGERPRINT_CSV} ({len(results)} rows, {failed} skipped)")
    plot_fingerprint(results)
    return results


def plot_fingerprint(results):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    good = [r for r in results if r["snr"] is not None and r["wl_um"]]
    if not good:
        print("  No measurements to plot.")
        return
    fig, ax = plt.subplots(figsize=(9, 4.8), dpi=130)
    groups = {}
    for r in good:
        month = Time(r["mjd"], format="mjd").datetime.strftime("%b %Y")
        groups.setdefault(month, []).append(r)
    for month, rs in groups.items():
        ax.scatter([r["wl_um"] for r in rs], [r["snr"] for r in rs], s=18, label=month)
    for name, wl in FEATURES.items():
        ax.axvline(wl, color="grey", ls="--", lw=0.8)
        ax.text(wl, ax.get_ylim()[1] * 0.95, " " + name, rotation=90, va="top",
                fontsize=8, color="grey")
    ax.axhline(3, color="lightgrey", lw=0.8)
    ax.set_xlabel("Infrared wavelength (microns)")
    ax.set_ylabel("Comet signal strength (signal-to-noise)")
    ax.set_title("3I/ATLAS fingerprint from NASA SPHEREx: where the comet glows")
    ax.legend()
    fig.tight_layout()
    path = os.path.join(OUT_DIR, "fingerprint.png")
    fig.savefig(path)
    plt.close(fig)
    print(f"  Saved {path}")


def load_scan():
    if not os.path.exists(FINGERPRINT_CSV):
        sys.exit("No scan found. Run:  python spherex_test.py --scan")
    out = []
    with open(FINGERPRINT_CSV) as f:
        for r in csv.DictReader(f):
            out.append({"url": r["url"], "ra": float(r["comet_ra"]), "dec": float(r["comet_dec"]),
                        "mjd": float(r["mjd"]), "det": r["detector"],
                        "wl_um": float(r["wavelength_um"]) if r["wavelength_um"] else None,
                        "snr": float(r["snr"]) if r["snr"] else None})
    return out


# ======================================================================
# STEP 2: blink animation from frames where the comet is visible
# ======================================================================
def choose_blink_frames(scan, n_frames, min_snr, max_span_deg):
    vis = [r for r in scan if r["snr"] is not None and r["snr"] >= min_snr]
    print(f"\nSTEP 2: {len(vis)} images where the comet is clearly visible (SNR >= {min_snr})")
    if len(vis) < 2:
        sys.exit("Too few bright frames. Try:  python spherex_test.py --blink --min-snr 3")
    vis.sort(key=lambda r: r["mjd"])
    # one frame per moment (keep the brightest of simultaneous detectors)
    moments = []
    for r in vis:
        if moments and (r["mjd"] - moments[-1]["mjd"]) * 1440 < 1.0:
            if r["snr"] > moments[-1]["snr"]:
                moments[-1] = r
        else:
            moments.append(r)
    # the longest stretch of visible frames that fits in one view
    best = []
    for i in range(len(moments)):
        c0 = SkyCoord(moments[i]["ra"] * u.deg, moments[i]["dec"] * u.deg)
        run = [moments[i]]
        for r in moments[i + 1:]:
            if c0.separation(SkyCoord(r["ra"] * u.deg, r["dec"] * u.deg)).deg > max_span_deg:
                break
            run.append(r)
        if len(run) > len(best):
            best = run
    if len(best) > n_frames:  # spread evenly through the stretch
        idx = np.linspace(0, len(best) - 1, n_frames).round().astype(int)
        best = [best[i] for i in sorted(set(idx))]
    return best


def target_wcs(ra, dec, size_deg):
    npix = int(round(size_deg * 3600 / PIXEL_SCALE_ARCSEC))
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [npix / 2 + 0.5, npix / 2 + 0.5]
    w.wcs.cdelt = [-PIXEL_SCALE_ARCSEC / 3600, PIXEL_SCALE_ARCSEC / 3600]
    return w, (npix, npix)


def stretch(img):
    good = img[np.isfinite(img)]
    if good.size == 0:
        return np.zeros_like(img)
    lo, hi = np.percentile(good, [5, 99.7])
    x = np.clip((img - lo) / (hi - lo + 1e-12), 0, 1)
    x = np.arcsinh(10 * x) / np.arcsinh(10)
    fill = float(np.median(x[np.isfinite(x)])) if np.isfinite(x).any() else 0.0
    return np.nan_to_num(x, nan=fill)


def save_png(img01, path, label, marker=None):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig = plt.figure(figsize=(5, 5), dpi=120)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.imshow(img01, origin="lower", cmap="inferno", vmin=0, vmax=1)
    if marker is not None:
        ax.add_patch(plt.Circle(marker, radius=img01.shape[0] * 0.05,
                                fill=False, color="cyan", lw=1.2))
    ax.text(0.02, 0.97, label, color="white", fontsize=9, va="top", transform=ax.transAxes,
            bbox=dict(facecolor="black", alpha=0.5, lw=0))
    ax.set_axis_off()
    fig.savefig(path)
    plt.close(fig)


def save_clean_png(img01, path):
    """Plain image for the website: no labels, no circle, north up."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.imsave(path, np.flipud(img01), cmap="inferno", vmin=0, vmax=1)


def run_blink(scan, args):
    from reproject import reproject_interp
    from PIL import Image

    frames = choose_blink_frames(scan, args.frames, args.min_snr, args.max_span)
    ras = np.array([r["ra"] for r in frames])
    decs = np.array([r["dec"] for r in frames])
    mid = SkyCoord(np.median(ras) * u.deg, np.median(decs) * u.deg)
    span = max(SkyCoord(a * u.deg, b * u.deg).separation(mid).deg for a, b in zip(ras, decs))
    view = min(max(0.12, 2 * span + 0.08), 1.0)
    first, last = (Time(frames[i]["mjd"], format="mjd").iso[:16] for i in (0, -1))
    print(f"  Using {len(frames)} frames from {first} to {last} UTC, view {view:.2f} deg")

    for name in os.listdir(OUT_DIR):  # clear old frames
        if name.startswith("frame_") and name.endswith(".png"):
            os.remove(os.path.join(OUT_DIR, name))

    out_wcs, shape = target_wcs(mid.ra.deg, mid.dec.deg, view)
    web_frames = os.path.join(WEB_DATA, "frames")
    os.makedirs(web_frames, exist_ok=True)
    for name in os.listdir(web_frames):
        os.remove(os.path.join(web_frames, name))
    pngs, meta = [], []
    for i, r in enumerate(frames):
        date = Time(r["mjd"], format="mjd").iso[:16]
        print(f"  [{i + 1}/{len(frames)}] {date} UTC  {r['wl_um']:.2f} um  SNR {r['snr']:.1f}")
        try:
            with get_cutout(r["url"], mid.ra.deg, mid.dec.deg, view * 1.5) as h:
                img, wcs = clean_image(h)
        except Exception as e:
            print(f"    skipped: {e}")
            continue
        aligned, _ = reproject_interp((img, wcs), out_wcs, shape_out=shape)
        x, y = out_wcs.world_to_pixel(SkyCoord(r["ra"] * u.deg, r["dec"] * u.deg))
        path = os.path.join(OUT_DIR, f"frame_{i:02d}.png")
        img01 = stretch(aligned)
        save_png(img01, path, f"SPHEREx  {date} UTC  {r['wl_um']:.2f} µm",
                 None if args.no_marker else (float(x), float(y)))
        save_clean_png(img01, os.path.join(web_frames, f"frame_{i:02d}.png"))
        n = shape[0]
        pngs.append(path)
        meta.append({"file": os.path.basename(path), "date_utc": date, "mjd": r["mjd"],
                     "wavelength_um": r["wl_um"], "snr": r["snr"],
                     "comet_ra": r["ra"], "comet_dec": r["dec"],
                     "comet_px": [float(x), float(y)], "size_px": n,
                     # position as a fraction of the web image (0,0 = top-left)
                     "web_file": f"data/frames/frame_{i:02d}.png",
                     "fx": (float(x) + 0.5) / n, "fy": (n - float(y) - 0.5) / n})

    if len(pngs) < 2:
        sys.exit("FAIL: fewer than 2 frames made.")
    imgs = [Image.open(p).convert("P", palette=Image.ADAPTIVE) for p in pngs]
    imgs[0].save(os.path.join(OUT_DIR, "blink.gif"), save_all=True,
                 append_images=imgs[1:], duration=600, loop=0)
    blink = {"target": "3I/ATLAS", "view_size_deg": view,
             "center_ra": mid.ra.deg, "center_dec": mid.dec.deg, "frames": meta}
    with open(os.path.join(OUT_DIR, "frames.json"), "w") as f:
        json.dump(blink, f, indent=2)
    print(f"\nPASS: {len(pngs)} frames + blink.gif + frames.json in {OUT_DIR}/")
    return blink


# ======================================================================
# Known asteroids from NASA JPL (Small-Body Identification API)
# ======================================================================
JPL_SBIDENT = "https://ssd-api.jpl.nasa.gov/sb_ident.api"


def _jpl_ra(deg):
    return SkyCoord(deg * u.deg, 0 * u.deg).ra.to_string(u.hour, sep="-", precision=1, pad=True)


def _jpl_dec(deg):
    s = SkyCoord(0 * u.deg, deg * u.deg).dec.to_string(sep="-", precision=1, alwayssign=True, pad=True)
    return s.replace("-", "M", 1) if s.startswith("-") else s.lstrip("+")


def _parse_radec(ra_s, dec_s):
    ra_s = ra_s.strip()
    dec_s = dec_s.strip().replace("'", " ").replace('"', " ")
    return SkyCoord(ra_s.replace(":", " "), dec_s, unit=(u.hourangle, u.deg))


def find_asteroids(blink, vmag_lim=19.5):
    """Ask NASA JPL which known asteroids were inside our view at each frame's time.
    SPHEREx orbits Earth, so we use an observer on Earth's equator: positions are
    accurate to about one or two SPHEREx pixels for main-belt asteroids."""
    import urllib.request, urllib.parse
    out_wcs, shape = target_wcs(blink["center_ra"], blink["center_dec"], blink["view_size_deg"])
    n = shape[0]
    half = blink["view_size_deg"] / 2
    print(f"\nAsking NASA JPL for known asteroids in the view (V < {vmag_lim})...")
    total = set()
    for f in blink["frames"]:
        t = Time(f["mjd"], format="mjd").datetime.strftime("%Y-%m-%d_%H:%M:%S")
        params = {"sb-kind": "a", "lat": "0", "lon": "0", "alt": "0", "obs-time": t,
                  "mag-required": "true", "two-pass": "true", "suppress-first-pass": "true",
                  "vmag-lim": str(vmag_lim),
                  "fov-ra-center": _jpl_ra(blink["center_ra"]),
                  "fov-dec-center": _jpl_dec(blink["center_dec"]),
                  "fov-ra-hwidth": f"{half:.4f}", "fov-dec-hwidth": f"{half:.4f}"}
        url = JPL_SBIDENT + "?" + urllib.parse.urlencode(params, safe=":-")
        f["asteroids"] = []
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "SKYBLINK-student-project"})
            with urllib.request.urlopen(req, timeout=90) as r:
                js = json.loads(r.read().decode())
        except Exception as e:
            print(f"  ! {f['date_utc']}: JPL lookup failed ({e})")
            continue
        fields = js.get("fields_second") or js.get("fields_first") or []
        rows = js.get("data_second_pass") or js.get("data_first_pass") or []
        def col(word):
            for i, name in enumerate(fields):
                if word.lower() in name.lower():
                    return i
            return None
        i_name, i_ra, i_dec, i_v = col("Object name"), col("Astrometric RA"), col("Astrometric Dec"), col("Visual magnitude")
        if None in (i_name, i_ra, i_dec):
            print(f"  ! {f['date_utc']}: unexpected JPL format: {fields}")
            continue
        for row in rows:
            try:
                c = _parse_radec(row[i_ra], row[i_dec])
            except Exception:
                continue
            x, y = out_wcs.world_to_pixel(c)
            fx, fy = (float(x) + 0.5) / n, (n - float(y) - 0.5) / n
            if 0.01 < fx < 0.99 and 0.01 < fy < 0.99:
                name = str(row[i_name]).strip()
                v = None
                try:
                    v = float(row[i_v]) if i_v is not None else None
                except (TypeError, ValueError):
                    pass
                f["asteroids"].append({"name": name, "fx": fx, "fy": fy, "vmag": v})
                total.add(name)
        print(f"  {f['date_utc']}: {len(f['asteroids'])} known asteroids")
    blink["asteroid_names"] = sorted(total)
    print(f"  {len(total)} different known asteroids in our view")
    return blink


# ======================================================================
# STEP 3: data for the SKY BLINK website
# ======================================================================
def run_web_export(scan, blink, asteroids=True):
    """Small comet thumbnails for every scanned image + one data file the
    website loads (works by double-clicking index.html, no server needed)."""
    from reproject import reproject_interp
    thumbs = os.path.join(WEB_DATA, "thumbs")
    os.makedirs(thumbs, exist_ok=True)
    print(f"\nSTEP 3: website data ({len(scan)} comet thumbnails, uses cache)...")
    points = []
    for i, r in enumerate(scan):
        if r["wl_um"] is None:
            continue
        thumb = f"data/thumbs/t_{i:03d}.png"
        try:
            with get_cutout(r["url"], r["ra"], r["dec"], 0.06) as h:
                img, wcs = clean_image(h)
            tw, tshape = target_wcs(r["ra"], r["dec"], 0.05)
            aligned, _ = reproject_interp((img, wcs), tw, shape_out=tshape)
            save_clean_png(stretch(aligned), os.path.join(WEB_DATA, thumb.replace("data/", "")))
        except Exception as e:
            print(f"  ! no thumbnail for image {i}: {e}")
            thumb = None
        t = Time(r["mjd"], format="mjd")
        points.append({"date_utc": t.iso[:16], "month": t.datetime.strftime("%b %Y"),
                       "wl": round(r["wl_um"], 4), "snr": None if r["snr"] is None else round(r["snr"], 2),
                       "det": r["det"], "thumb": thumb})
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(scan)}")
    if asteroids:
        blink = find_asteroids(blink)
    data = {"generated": Time.now().iso[:16], "blink": blink, "fingerprint": points}
    path = os.path.join(WEB_DATA, "site_data.js")
    with open(path, "w") as f:
        f.write("window.SKYBLINK_DATA = ")
        json.dump(data, f)
        f.write(";\n")
    print(f"  Saved {path}")
    print("\nDONE: open web/index.html in your browser (double-click it).")


# ======================================================================
def main():
    ap = argparse.ArgumentParser(description="SKY BLINK SPHEREx pipeline")
    ap.add_argument("--scan", action="store_true", help="only step 1 (fingerprint)")
    ap.add_argument("--blink", action="store_true", help="only step 2 (animation)")
    ap.add_argument("--frames", type=int, default=10, help="max frames in the GIF")
    ap.add_argument("--min-snr", type=float, default=5.0,
                    help="how clearly the comet must show to use a frame")
    ap.add_argument("--max-span", type=float, default=0.4,
                    help="max comet movement within the GIF, degrees")
    ap.add_argument("--workers", type=int, default=2, help="parallel downloads")
    ap.add_argument("--web", action="store_true",
                    help="only steps 2+3: blink frames + website data (needs a scan)")
    ap.add_argument("--no-marker", action="store_true", help="hide the cyan circle")
    ap.add_argument("--no-asteroids", action="store_true", help="skip the NASA JPL asteroid lookup")
    args = ap.parse_args()
    only = args.scan or args.blink or args.web
    do_scan = args.scan or not only
    do_blink = args.blink or args.web or not only
    do_web = args.web or not only

    os.makedirs(OUT_DIR, exist_ok=True)
    if do_scan:
        run_scan(load_observations(), args.workers)
    if do_blink:
        scan = load_scan()
        blink = run_blink(scan, args)
        if do_web:
            run_web_export(scan, blink, asteroids=not args.no_asteroids)


if __name__ == "__main__":
    main()
