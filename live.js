/* SKY BLINK - "Search the sky": live SPHEREx search for any RA/Dec, via the local helper (skyblink_server.py). */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  const SB = () => window.SKYBLINK || {};
  const params = new URLSearchParams(location.search);
  // API: same server by default; ?api=https://... lets a hosted helper be used from any website
  const API = (params.get("api") || (location.protocol.startsWith("http") ? "" : "http://localhost:8000")).replace(/\/$/, "");
  const S = { res: null, i: 0, timer: null, tour: null, spec: null, online: false, base: "", jobId: null, specId: null };
  const SAVED = window.SKYBLINK_SAVED || {};
  const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  function wlColour(wl) { return SB().wlColour ? SB().wlColour(wl) : "#5eeaff"; }

  async function ping() {
    try {
      const r = await fetch(`${API}/api/ping`, { cache: "no-store" });
      S.online = r.ok;
    } catch (e) { S.online = false; }
    $("sOffline").hidden = S.online;
    $("sSavedNote").hidden = !Object.keys(SAVED).length;
    $("sSave").hidden = !S.online;
    S.base = S.online && API ? API + "/" : "";
    return S.online;
  }

  function query() {
    const q = new URLSearchParams();
    const name = $("sName").value.trim();
    if (name) q.set("name", name);
    else { q.set("ra", $("sRa").value.trim()); q.set("dec", $("sDec").value.trim()); }
    q.set("fov", $("sFov").value); q.set("det", $("sDet").value); q.set("mode", $("sMode").value);
    q.set("gaia", $("sGaia").checked ? "1" : "0"); q.set("wise", $("sWise").checked ? "1" : "0");
    return q;
  }

  function shareLink() {
    const q = query(); q.delete("gaia"); q.delete("wise");
    const u = new URL(location.href); u.search = q.toString(); u.hash = "search";
    return u.toString();
  }

  async function poll(id, onDone) {
    const r = await fetch(`${API}/api/job/${id}`, { cache: "no-store" });
    const j = await r.json();
    $("sBar").style.width = pct(j.progress || 0);
    $("sStatus").textContent = (j.log && j.log.length ? j.log[j.log.length - 1] : "Working…") + `  (${Math.round(j.seconds || 0)} s)`;
    if (j.status === "running") return setTimeout(() => poll(id, onDone), 900);
    if (j.status === "error") { $("sStatus").textContent = "⚠ " + j.error; $("sGo").disabled = false; return; }
    onDone(j.result);
  }

  function showSaved(name) {
    const sv = SAVED[slugOf(name)];
    if (!sv) return false;
    stop(); S.base = ""; $("sProgress").hidden = false; $("sBar").style.width = "100%";
    $("sStatus").textContent = `Saved search from ${sv.result.saved_utc || "earlier"} UTC (live SPHEREx data). Run the helper to search any other position.`;
    show(sv.result);
    if (sv.result.spectrum) { S.spec = sv.result.spectrum; $("sSpecWrap").hidden = false; $("sSpecDate").textContent = `· visit of ${S.spec.date} · ${S.spec.points.length} images`; drawSpec(); }
    return true;
  }

  async function run(e) {
    if (e) e.preventDefault();
    if (!(await ping())) {
      if ($("sName").value.trim() && showSaved($("sName").value.trim())) return;
      $("sOffline").scrollIntoView({ behavior: "smooth", block: "center" }); return;
    }
    if (!$("sName").value.trim() && !($("sRa").value.trim() && $("sDec").value.trim())) {
      $("sStatus").textContent = "Type a name, or both RA and Dec."; $("sProgress").hidden = false; return;
    }
    stop();
    $("sGo").disabled = true; $("sProgress").hidden = false; $("sBar").style.width = "2%";
    $("sStatus").textContent = "Asking NASA/IPAC IRSA for SPHEREx images…";
    history.replaceState(null, "", shareLink());
    try {
      const r = await fetch(`${API}/api/search?${query()}`);
      const j = await r.json();
      if (j.error) throw new Error(j.error);
      S.jobId = j.id; S.specId = null;
      poll(j.id, (res) => { $("sGo").disabled = false; show(res); });
    } catch (err) { $("sStatus").textContent = "⚠ " + err.message; $("sGo").disabled = false; }
  }

  /* ---------------------------------------------------------- viewer */
  function show(res) {
    S.res = res; S.i = 0;
    $("sResult").hidden = false; $("sSpecWrap").hidden = true;
    const name = $("sName").value.trim();
    $("sTitle").textContent = name || `RA ${res.ra.toFixed(4)}°, Dec ${res.dec >= 0 ? "+" : ""}${res.dec.toFixed(4)}°`;
    const n = res.frames.length;
    $("sSub").textContent = `${n} frame${n > 1 ? "s" : ""} · detector ${res.det} (${res.det_range[0]}–${res.det_range[1]} µm) · ` +
      `${res.n_total} SPHEREx images exist here (${res.collection})` + (res.pm > 50 ? ` · moves ${(res.pm / 1000).toFixed(2)}″/yr` : "");
    $("sCaption").textContent = `Images: NASA SPHEREx via NASA/IPAC IRSA (${res.collection}), processed live by SKY BLINK. North up, ` +
      `${(res.fov * 60).toFixed(1)} arcminutes wide, ${res.mode === "stack" ? "images of each visit added together" : "every single image"}. ` +
      `Circles: ESA Gaia DR3 stars moved to the image date${res.wise.length ? "; squares: NASA AllWISE" : ""}. Found via ${res.source}.`;
    $("sAladin").href = res.aladin;
    $("sDiff").hidden = true; $("sShowDiff").checked = false; $("sShowDiff").disabled = !res.diff;
    if (res.diff) $("sDiff").src = S.base + res.diff;
    $("sDeep").src = S.base + res.deep; $("sDeep").hidden = true; $("sShowDeep").checked = false;
    res.frames.forEach((f) => { const im = new Image(); im.src = S.base + f.file; });
    renderChanges(); renderMeta();
    frame(0);
    $("sLive").textContent = n > 1 ? "Press Blink to play the frames like a video, or Listen to hear them." : "Only one visit so far: SPHEREx will come back here in about six months.";
    $("sResult").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function frame(i, sound = false) {
    const res = S.res; if (!res) return;
    S.i = (i + res.frames.length) % res.frames.length;
    const f = res.frames[S.i];
    $("sImg").src = S.base + f.file;
    const m = $("sMarker");
    m.style.left = pct(f.fx); m.style.top = pct(f.fy); m.hidden = !$("sShowMarker").checked;
    m.classList.remove("hop"); void m.offsetWidth; m.classList.add("hop");
    $("sTag").textContent = `${S.i + 1}/${res.frames.length} · ${f.date_utc}`;
    $("sDate").textContent = f.date_utc;
    $("sWl").textContent = f.wl_min && f.wl_max && f.wl_max - f.wl_min > 0.01 ? `${f.wl_min.toFixed(2)}–${f.wl_max.toFixed(2)} µm` : `${f.wl.toFixed(2)} µm`;
    $("sWl").style.color = wlColour(f.wl);
    $("sN").textContent = String(f.n_stacked);
    $("sSnr").textContent = f.snr == null ? "–" : `${Math.round(f.snr)} (${SB().strengthWord ? SB().strengthWord(f.snr) : ""})`;
    $("sFlag").textContent = f.flag_center == null ? "–" : (f.flag_center ? `⚠ ${f.flag_center} flagged px at target` : "✓ clean at target");
    drawOverlay();
    if (sound) play(f);
  }

  function play(f) {
    const s = SB().Sound; if (!s) return;
    const fr = S.res.frames, maxF = Math.max(1e-9, ...fr.map((q) => Math.abs(q.flux || 0)));
    s.chime({ freq: 262 * Math.pow(2, 2 * (1 - f.fy)), pan: (f.fx * 2 - 1) * 0.95,
      vol: 0.08 + 0.5 * Math.min(1, Math.abs(f.flux || 0) / maxF), type: "triangle" });
  }

  function drawOverlay() {
    const c = $("sOverlay"), res = S.res; if (!res) return;
    const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w) return;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const r0 = Math.max(5, w / res.npx * 2.2);
    if ($("sShowGaia").checked) {
      res.gaia.forEach((s) => {
        g.strokeStyle = s.pm > 100 ? "rgba(255,196,110,.95)" : "rgba(110,231,168,.35)"; g.lineWidth = s.pm > 100 ? 2 : 1;
        const r = r0 * Math.max(0.6, Math.min(1.6, (20 - s.g) / 6));
        g.beginPath(); g.arc(s.fx * w, s.fy * h, r, 0, Math.PI * 2); g.stroke();
      });
    }
    if ($("sShowWise").checked) {
      g.strokeStyle = "rgba(180,140,255,.7)"; g.lineWidth = 1;
      res.wise.forEach((s) => { const r = r0 * 0.9; g.strokeRect(s.fx * w - r, s.fy * h - r, 2 * r, 2 * r); });
    }
    if ($("sShowChanges").checked) {
      res.changes.forEach((s, k) => {
        g.strokeStyle = s.sign > 0 ? "#ff5a7a" : "#5aa8ff"; g.lineWidth = 2.5;
        const x = s.fx * w, y = s.fy * h, r = r0 * 1.5;
        g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); g.stroke();
        g.fillStyle = "#fff"; g.font = "bold 12px system-ui"; g.fillText(String(k + 1), x + r + 2, y - r);
      });
    }
  }

  function renderChanges() {
    const res = S.res, ul = $("sChanges");
    if (!res.changes.length) {
      ul.innerHTML = `<li>${res.frames.length < 2 ? "Need at least two visits to compare." : "Nothing changed strongly between the first and last frame."}</li>`; return;
    }
    ul.innerHTML = res.changes.map((c, k) => {
      const near = res.gaia.filter((s) => Math.hypot(s.fx - c.fx, s.fy - c.fy) * res.npx < 2.5);
      const fast = near.find((s) => s.pm > 100);
      const kind = c.pair ? "<b>possible mover</b> (red/blue pair)" : c.sign > 0 ? "got brighter / new light" : "got dimmer / light left";
      const who = fast ? `Gaia star moving ${(fast.pm / 1000).toFixed(2)}″/yr` : near.length ? `Gaia star G=${near[0].g}` : "<b>no Gaia star here</b>";
      return `<li><button class="pchip" data-k="${k}">#${k + 1}</button> ${kind} · strength ${c.sig}σ · ${who}</li>`;
    }).join("");
    ul.querySelectorAll("button[data-k]").forEach((b) => {
      b.onclick = () => {
        const c = res.changes[+b.dataset.k], s = SB().Sound;
        if (s) s.chime({ freq: 262 * Math.pow(2, 2 * (1 - c.fy)), pan: c.fx * 2 - 1, vol: 0.4, type: c.sign > 0 ? "triangle" : "sine" });
        $("sLive").textContent = `Change #${+b.dataset.k + 1} is ${c.fx < .34 ? "on the left" : c.fx > .66 ? "on the right" : "in the middle"}, ${c.fy < .34 ? "near the top" : c.fy > .66 ? "near the bottom" : "halfway down"}.`;
      };
    });
  }

  function renderMeta() {
    const irsa = "https://irsa.ipac.caltech.edu/Missions/spherex.html";
    $("sMetaBody").innerHTML = S.res.frames.map((f, k) => `<tr><td>${k + 1}</td><td>${f.date_utc}</td><td>${f.wl.toFixed(2)}</td><td>${f.n_stacked}</td>` +
      `<td>${f.snr == null ? "–" : Math.round(f.snr)}</td><td>${f.flag_center == null ? "–" : f.flag_center + " / 25"}</td>` +
      `<td>${f.flag_frac == null ? "–" : (f.flag_frac * 100).toFixed(1) + "%"}</td>` +
      `<td class="files">${f.images.map((n) => `<a href="${irsa}" target="_blank" rel="noopener" title="${n}">${n.replace(/^level2_/, "").slice(0, 22)}…</a>`).join("<br>")}</td></tr>`).join("");
  }

  function stop() {
    clearInterval(S.timer); S.timer = null; clearTimeout(S.tour); S.tour = null;
    if (SB().stopSpeech) SB().stopSpeech();
    $("sPlay").textContent = "▶ Blink"; $("sPlay").setAttribute("aria-pressed", "false");
    $("sListen").textContent = "🎧 Listen"; $("sStage").classList.remove("scanning");
  }

  function listen() {
    if (S.tour) { stop(); return; }
    stop(); if (SB().Sound) SB().Sound.ensure();
    $("sListen").textContent = "■ Stop"; $("sStage").classList.add("scanning");
    const fr = S.res.frames; let i = 0;
    const talk = $("speakOn") && $("speakOn").checked;
    const step = () => {
      if (!S.tour) return;
      if (i >= fr.length) {
        stop();
        const a = fr[0], b = fr[fr.length - 1];
        const ch = a.flux && b.flux ? Math.round((b.flux / a.flux - 1) * 100) : null;
        const txt = `Done. ${fr.length} frames.` + (ch !== null ? ` The target was ${Math.abs(ch)} percent ${ch >= 0 ? "brighter" : "dimmer"} in the last frame.` : "") +
          (S.res.changes.length ? ` The change finder marked ${S.res.changes.length} spots.` : "");
        $("sLive").textContent = txt; if (talk && SB().speak) SB().speak(txt);
        return;
      }
      const f = fr[i]; frame(i); play(f);
      const txt = `Frame ${i + 1} of ${fr.length}, ${f.date_utc.slice(0, 10)}. Signal ${f.snr == null ? "unknown" : SB().strengthWord(f.snr)}.`;
      $("sLive").textContent = txt; i += 1;
      if (talk && SB().speak) SB().speak(txt, () => { if (S.tour) S.tour = setTimeout(step, 600); });
      else S.tour = setTimeout(step, 1300);
      if (talk) S.tour = S.tour || 1;
    };
    S.tour = setTimeout(step, 50);
  }

  /* ---------------------------------------------------------- spectrum */
  async function spectrum() {
    if (!(await ping())) { $("sLive").textContent = "Spectrum needs the helper (this saved search has no spectrum)."; return; }
    const q = query(); q.delete("mode"); q.delete("gaia"); q.delete("wise"); q.delete("det");
    $("sSpecBtn").disabled = true; $("sProgress").hidden = false; $("sBar").style.width = "2%";
    $("sStatus").textContent = "Measuring the target in all six detectors…";
    const r = await fetch(`${API}/api/spectrum?${q}`); const j = await r.json();
    if (j.error) { $("sStatus").textContent = "⚠ " + j.error; $("sSpecBtn").disabled = false; return; }
    S.specId = j.id;
    poll(j.id, (res) => {
      $("sSpecBtn").disabled = false; S.spec = res; $("sSpecWrap").hidden = false;
      $("sSpecDate").textContent = `· visit of ${res.date} · ${res.points.length} images`;
      drawSpec(); $("sSpecWrap").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
  function drawSpec(hi = -1) {
    const c = $("sSpec"), sp = S.spec; if (!sp) return;
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight; if (!w) return;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const pad = { l: 56, r: 14, t: 26, b: 34 };
    const pts = sp.points; if (!pts.length) return;
    const y1 = Math.max(...pts.map((p) => p.flux + (p.err || 0))) * 1.1, y0 = Math.min(0, ...pts.map((p) => p.flux - (p.err || 0)));
    const X = (wl) => pad.l + (wl - 0.7) / (5.05 - 0.7) * (w - pad.l - pad.r);
    const Y = (v) => h - pad.b - (v - y0) / (y1 - y0 || 1) * (h - pad.t - pad.b);
    g.font = "12px system-ui"; g.fillStyle = "#a3abc6"; g.strokeStyle = "#262d48"; g.textAlign = "center";
    for (let wl = 1; wl <= 5; wl++) { g.beginPath(); g.moveTo(X(wl), pad.t); g.lineTo(X(wl), h - pad.b); g.stroke(); g.fillText(`${wl} µm`, X(wl), h - pad.b + 16); }
    g.beginPath(); g.moveTo(pad.l, Y(0)); g.lineTo(w - pad.r, Y(0)); g.stroke();
    [[1.4, "H₂O", true], [3.3, "CH₄ · methane", true], [4.26, "CO₂", false], [4.67, "CO", false]].forEach(([wl, lab, main]) => {
      g.setLineDash([5, 5]); g.strokeStyle = main ? "rgba(255,122,217,.8)" : "rgba(255,255,255,.22)"; g.lineWidth = main ? 2 : 1;
      g.beginPath(); g.moveTo(X(wl), pad.t); g.lineTo(X(wl), h - pad.b); g.stroke(); g.setLineDash([]); g.lineWidth = 1;
      g.font = main ? "bold 13px system-ui" : "12px system-ui"; g.fillStyle = main ? "#ff7ad9" : "#a3abc6"; g.fillText(lab, X(wl), pad.t - 4);
    });
    g.font = "12px system-ui";
    // glowing line joining the points (like the video)
    if ($("sSpecLine") && $("sSpecLine").checked) {
    g.save(); g.strokeStyle = "#ff9a46"; g.lineWidth = 3; g.lineJoin = "round"; g.shadowColor = "#ff9a46"; g.shadowBlur = 12;
    g.beginPath(); pts.forEach((p, k) => { const x = X(p.wl), y = Y(p.flux); k ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); g.restore();
    }
    g.save(); g.translate(14, h / 2); g.rotate(-Math.PI / 2); g.fillText("brightness", 0, 0); g.restore();
    pts.forEach((p, k) => {
      if (p.err) { g.strokeStyle = "rgba(255,255,255,.35)"; g.beginPath(); g.moveTo(X(p.wl), Y(p.flux - p.err)); g.lineTo(X(p.wl), Y(p.flux + p.err)); g.stroke(); }
      g.fillStyle = wlColour(p.wl); g.beginPath(); g.arc(X(p.wl), Y(p.flux), k === hi ? 8 : 5, 0, Math.PI * 2); g.fill();
    });
  }
  function playSpec() {
    const sp = S.spec, s = SB().Sound; if (!sp || !s) return;
    s.ensure();
    const maxF = Math.max(1e-9, ...sp.points.map((p) => Math.abs(p.flux)));
    sp.points.forEach((p, k) => {
      // high notes = short wavelengths, louder = brighter (same rule as the comet fingerprint)
      s.chime({ freq: 880 * Math.pow(2, -(p.wl - 0.75) / 1.6), vol: 0.05 + 0.45 * Math.max(0, p.flux) / maxF, dur: 0.5, type: "sine", delay: k * 0.12 });
      setTimeout(() => drawSpec(k), k * 120);
    });
    setTimeout(() => drawSpec(), sp.points.length * 120 + 300);
  }

  /* ---------------------------------------------------------- wiring */
  function init() {
    if (!$("sForm")) return;
    $("sFov").oninput = () => { $("sFovOut").textContent = (+$("sFov").value * 60).toFixed(1); };
    $("sFovOut").textContent = (+$("sFov").value * 60).toFixed(1);
    $("sForm").onsubmit = run;
    $("sName").addEventListener("input", () => { if ($("sName").value.trim()) { $("sRa").value = ""; $("sDec").value = ""; } });
    ["sRa", "sDec"].forEach((id) => $(id).addEventListener("input", () => { if ($(id).value.trim()) $("sName").value = ""; }));
    document.querySelectorAll(".presets .pchip").forEach((b) => {
      b.onclick = () => { $("sName").value = b.dataset.name; $("sRa").value = ""; $("sDec").value = ""; $("sDet").value = "auto"; run(); };
    });
    $("sPrev").onclick = () => { stop(); frame(S.i - 1, true); };
    $("sNext").onclick = () => { stop(); frame(S.i + 1, true); };
    $("sPlay").onclick = () => {
      if (S.timer) { stop(); return; }
      stop(); $("sPlay").textContent = "❚❚ Stop"; $("sPlay").setAttribute("aria-pressed", "true"); $("sStage").classList.add("scanning");
      S.timer = setInterval(() => frame(S.i + 1), +$("sSpeed").value);
    };
    $("sSpeed").oninput = () => { if (S.timer) { clearInterval(S.timer); S.timer = setInterval(() => frame(S.i + 1), +$("sSpeed").value); } };
    $("sListen").onclick = listen;
    ["sShowGaia", "sShowWise", "sShowChanges"].forEach((id) => { $(id).onchange = drawOverlay; });
    $("sShowMarker").onchange = () => frame(S.i);
    $("sShowDiff").onchange = (e) => { $("sDiff").hidden = !e.target.checked; if (e.target.checked) { $("sShowDeep").checked = false; $("sDeep").hidden = true; } };
    $("sShowDeep").onchange = (e) => { $("sDeep").hidden = !e.target.checked; if (e.target.checked) { $("sShowDiff").checked = false; $("sDiff").hidden = true; } };
    $("sSpecBtn").onclick = spectrum; $("sSpecPlay").onclick = playSpec;
    $("sSpecLine").onchange = () => drawSpec();
    $("sSave").onclick = async () => {
      if (!S.jobId) { $("sLive").textContent = "Search first, then save."; return; }
      const name = $("sName").value.trim() || $("sTitle").textContent;
      try {
        const r = await fetch(`${API}/api/save?id=${S.jobId}&name=${encodeURIComponent(name)}${S.specId ? "&spec=" + S.specId : ""}`);
        const j = await r.json(); if (j.error) throw new Error(j.error);
        $("sLive").textContent = `Saved "${name}"${S.specId ? " with its spectrum" : ""} for the website (${j.count} saved). Tip: make the spectrum first, then save.`;
      } catch (err) { $("sLive").textContent = "⚠ " + err.message; }
    };
    $("sCopy").onclick = async () => {
      const link = shareLink();
      try { await navigator.clipboard.writeText(link); $("sLive").textContent = "Link copied. Anyone with the helper running can open this exact view."; }
      catch (e) { $("sLive").textContent = link; }
    };
    window.addEventListener("resize", () => { drawOverlay(); drawSpec(); });
    // coordinates in the URL: index.html?ra=133.79&dec=-7.24&fov=0.1  or  ?name=WISE%200855
    const has = params.get("name") || (params.get("ra") && params.get("dec"));
    if (params.get("name")) $("sName").value = params.get("name");
    if (params.get("ra")) $("sRa").value = params.get("ra");
    if (params.get("dec")) $("sDec").value = params.get("dec");
    if (params.get("fov")) { $("sFov").value = params.get("fov"); $("sFov").oninput(); }
    if (params.get("det")) $("sDet").value = params.get("det");
    if (params.get("mode")) $("sMode").value = params.get("mode");
    ping().then((ok) => { if (ok && has) { $("search").scrollIntoView(); run(); } });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
