/* SI (AI) use: parts of this code were written with help from Claude, an AI assistant by Anthropic, then tested, checked and edited by Team Kepler 16. NASA Space Apps 2026. */
/* SKY BLINK — explore SPHEREx images of comet 3I/ATLAS by sight or by sound.
   Data comes from data/site_data.js, made by:  python spherex_test.py --web   */
(() => {
  "use strict";

  const DATA = window.SKYBLINK_DATA;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  if (!DATA || !DATA.blink || !DATA.blink.frames || DATA.blink.frames.length < 2) {
    $("noData").hidden = false;
    return;
  }

  const frames = DATA.blink.frames;
  const points = (DATA.fingerprint || []).filter((p) => p.snr !== null && p.wl);
  const maxFrameSnr = Math.max(...frames.map((f) => f.snr || 1));
  const hasAsteroids = frames.some((f) => Array.isArray(f.asteroids));
  const FEATURES = [
    { name: "Water (H₂O)", short: "Water", wl: 2.7 },
    { name: "Carbon dioxide (CO₂)", short: "CO₂", wl: 4.26 },
    { name: "Carbon monoxide (CO)", short: "CO", wl: 4.67 },
  ];

  /* ------------------------------------------------------------------ helpers */
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  const wlHue = (wl) => 260 - ((Math.min(Math.max(wl, 0.75), 5) - 0.75) / 4.25) * 260;
  const wlColour = (wl) => `hsl(${wlHue(wl)} 85% 58%)`;
  const wlPos = (wl) => (Math.min(Math.max(wl, 0.75), 5) - 0.75) / 4.25;
  const hoursBetween = (a, b) => ((b.mjd - a.mjd) * 24);

  function elapsed(mjd) {
    const mins = Math.round((mjd - frames[0].mjd) * 1440);
    if (mins === 0) return "start";
    const h = Math.floor(mins / 60), m = mins % 60;
    return `+${h ? h + " h " : ""}${m} min`;
  }
  function strengthWord(snr) {
    if (snr < 3) return "not detected";
    if (snr < 20) return "faint";
    if (snr < 100) return "clear";
    if (snr < 250) return "strong";
    return "very strong";
  }
  function whereWord(f) {
    const h = f.fx < 0.34 ? "left" : f.fx > 0.66 ? "right" : "centre";
    const v = f.fy < 0.34 ? "upper" : f.fy > 0.66 ? "lower" : "middle";
    if (h === "centre" && v === "middle") return "in the centre";
    if (v === "middle") return `on the ${h} side`;
    if (h === "centre") return `in the ${v} middle`;
    return `in the ${v} ${h}`;
  }
  function moveWord(prev, f) {
    if (!prev) return "";
    const dx = f.fx - prev.fx, dy = f.fy - prev.fy;
    if (Math.hypot(dx, dy) < 0.01) return "barely moving";
    const parts = [];
    if (Math.abs(dx) > 0.004) parts.push(dx > 0 ? "right" : "left");
    if (Math.abs(dy) > 0.004) parts.push(dy > 0 ? "down" : "up");
    return "moving " + parts.join(" and ");
  }
  const jplLink = (name) => `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${encodeURIComponent(name.replace(/\s*\(.*\)\s*$/, ""))}`;

  /* ------------------------------------------------------------------ sound engine */
  const Sound = (() => {
    let ctx = null, master = null, comp = null, hum = null;
    let volume = 0.8, muted = false;
    function ensure() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        comp = ctx.createDynamicsCompressor(); // keeps many notes from clipping
        master = ctx.createGain();
        master.gain.value = muted ? 0 : volume;
        master.connect(comp).connect(ctx.destination);
      }
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }
    function setVolume(v) { volume = v; if (master && !muted) master.gain.setTargetAtTime(v, ctx.currentTime, 0.02); }
    function setMuted(m) { muted = m; if (master) master.gain.setTargetAtTime(m ? 0 : volume, ctx.currentTime, 0.02); }
    // Bell-like note: main tone + quieter "ring" overtone
    function chime({ freq, pan = 0, vol = 0.35, dur = 1.3, type = "triangle", delay = 0 }) {
      if (!ensure()) return;
      const t = ctx.currentTime + delay;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.001), t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const o1 = ctx.createOscillator();
      o1.type = type; o1.frequency.value = freq;
      const o2 = ctx.createOscillator();
      o2.type = "sine"; o2.frequency.value = freq * 2.76;
      const g2 = ctx.createGain(); g2.gain.value = 0.2;
      o1.connect(g); o2.connect(g2).connect(g);
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, pan));
        g.connect(p).connect(master);
      } else g.connect(master);
      o1.start(t); o2.start(t);
      o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
    }
    function humStart() {
      if (!ensure() || hum) return;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 1.2);
      const oscs = [110, 164.8, 220].map((f, i) => {
        const o = ctx.createOscillator();
        o.type = "sine"; o.frequency.value = f;
        const og = ctx.createGain(); og.gain.value = [1, 0.55, 0.3][i];
        o.connect(og).connect(g); o.start();
        return o;
      });
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.25;
      const lg = ctx.createGain(); lg.gain.value = 0.012;
      lfo.connect(lg).connect(g.gain); lfo.start();
      g.connect(master);
      hum = { g, oscs: [...oscs, lfo] };
    }
    function humStop() {
      if (!hum || !ctx) return;
      const { g, oscs } = hum;
      g.gain.cancelScheduledValues(ctx.currentTime);
      g.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
      setTimeout(() => oscs.forEach((o) => { try { o.stop(); } catch (e) {} }), 1200);
      hum = null;
    }
    const success = () => [523, 659, 784, 1047].forEach((f, i) => chime({ freq: f, vol: 0.25, dur: 0.6, delay: i * 0.09 }));
    const miss = () => { chime({ freq: 196, vol: 0.25, dur: 0.5, type: "sine" }); chime({ freq: 185, vol: 0.2, dur: 0.6, type: "sine", delay: 0.15 }); };
    return { ensure, chime, humStart, humStop, success, miss, setVolume, setMuted, get muted() { return muted; } };
  })();

  // Comet position -> sound: left/right = stereo, higher = higher note, brighter = louder
  function playFrame(f, delay = 0) {
    Sound.chime({
      freq: 262 * Math.pow(2, 2 * (1 - f.fy)),
      pan: (f.fx * 2 - 1) * 0.95,
      vol: 0.12 + 0.45 * Math.min(1, (f.snr || 0) / maxFrameSnr),
      delay,
    });
  }
  // Infrared colour -> sound: short wavelength = high note, long = low note
  const maxPointSnr = Math.max(1, ...points.map((p) => p.snr));
  function playWavelength(wl, snr, dur = 0.5, delay = 0) {
    const freq = 1400 * Math.pow(140 / 1400, Math.log(wl / 0.75) / Math.log(5 / 0.75));
    Sound.chime({
      freq, dur, delay,
      vol: 0.04 + 0.5 * Math.max(0, Math.min(1, snr / maxPointSnr)),
      type: wl < 2.42 ? "sine" : "triangle", // SPHEREx's two detector types
    });
  }
  window.SKYBLINK = window.SKYBLINK || {};
  function speak(text, onEnd) {
    if (!("speechSynthesis" in window) || Sound.muted) { if (onEnd) onEnd(); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-GB"; u.rate = 1.05;
    if (onEnd) { let done = false; u.onend = u.onerror = () => { if (!done) { done = true; onEnd(); } }; }
    window.speechSynthesis.speak(u);
  }
  function stopSpeech() { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); }
  Object.assign(window.SKYBLINK, { Sound, speak, stopSpeech, wlColour: (wl) => wlColour(wl), strengthWord: (s) => strengthWord(s) });
  /* Wait until the sentence has been read out completely, then run next().
     A backup timer covers browsers that never fire "end". isOn() lets Stop cancel everything. */
  function sayThen(text, isOn, next, gapMs = 700) {
    let fired = false;
    const go = () => { if (fired || !isOn()) return; fired = true; clearTimeout(backup); setTimeout(() => isOn() && next(), gapMs); };
    const backup = setTimeout(go, 2500 + text.length * 90);
    speak(text, go);
    return backup;
  }

  function initSoundbox() {
    $("volume").oninput = (e) => { Sound.ensure(); Sound.setVolume(Number(e.target.value)); };
    $("muteBtn").onclick = () => {
      Sound.ensure();
      const m = !Sound.muted;
      Sound.setMuted(m);
      if (m && window.speechSynthesis) speechSynthesis.cancel();
      $("muteBtn").setAttribute("aria-pressed", String(m));
      $("muteBtn").textContent = m ? "🔇 Muted" : "🔊 Sound on";
    };
    $("testSound").onclick = () => {
      Sound.ensure();
      Sound.chime({ freq: 523, pan: -0.9, vol: 0.4, dur: 0.6 });
      Sound.chime({ freq: 784, pan: 0.9, vol: 0.4, dur: 0.6, delay: 0.45 });
    };
  }

  /* ------------------------------------------------------------------ hero */
  function initHero() {
    const a = frames[0], b = frames[frames.length - 1];
    $("heroA").src = a.web_file; $("heroB").src = b.web_file;
    [["heroMarkA", a], ["heroMarkB", b]].forEach(([id, f]) => { $(id).style.left = pct(f.fx); $(id).style.top = pct(f.fy); });
    $("heroCap").textContent = `Real SPHEREx images, ${a.date_utc.slice(0, 10)} — ${hoursBetween(a, b).toFixed(1)} hours apart. The comet moves; the stars stay still.`;
    const months = [...new Set(points.map((p) => p.month))];
    const nAst = (DATA.blink.asteroid_names || []).length;
    const nSaved = Object.keys(window.SKYBLINK_SAVED || {}).length;
    const stats = [
      ["Any RA/Dec", "search the whole sky"],
      ["5", "challenge targets tested"],
      ["0.75–5 µm", "spectra on the fly"],
      ["🎧", "every view can be heard"],
    ];
    $("heroStats").innerHTML = stats.map(([n, t]) => `<li><b>${n}</b>${t}</li>`).join("");
    $("aboutStats").textContent =
      `Our scan measured ${(DATA.fingerprint || []).length} SPHEREx images of 3I/ATLAS` +
      (months.length ? ` from ${months.join(" and ")}` : "") +
      `. The blink viewer shows ${frames.length} images taken between ${frames[0].date_utc} and ${b.date_utc} UTC.`;
  }

  /* ------------------------------------------------------------------ blink viewer */
  const viewer = { idx: 0, timer: null };

  function showFrame(i, opts = {}) {
    viewer.idx = (i + frames.length) % frames.length;
    const f = frames[viewer.idx];
    $("frameImg").src = f.web_file;
    $("frameSlider").value = viewer.idx;
    $("frameNum").textContent = viewer.idx + 1;
    $("rDate").textContent = f.date_utc;
    $("rElapsed").textContent = elapsed(f.mjd);
    $("rWl").textContent = `${f.wavelength_um.toFixed(2)} µm`;
    $("rChip").style.background = wlColour(f.wavelength_um);
    $("rSnr").textContent = `${Math.round(f.snr)} (${strengthWord(f.snr)})`;
    $("wlPin").style.left = pct(wlPos(f.wavelength_um));
    $("stageTag").textContent = `${f.date_utc} UTC · ${f.wavelength_um.toFixed(2)} µm`;
    const m = $("marker");
    m.style.left = pct(f.fx); m.style.top = pct(f.fy);
    m.hidden = !$("showMarker").checked;
    drawTrail();
    drawAsteroids();
    if (opts.sound ?? $("soundOn").checked) playFrame(f);
  }

  function drawTrail() {
    const svg = $("trail");
    if (!$("showTrail").checked) { svg.innerHTML = ""; return; }
    const upto = frames.slice(0, viewer.idx + 1);
    const pts = upto.map((f) => `${f.fx * 100},${f.fy * 100}`);
    const dots = upto.map((f) => `<circle cx="${f.fx * 100}" cy="${f.fy * 100}" r="0.7" fill="#ffb054"/>`).join("");
    svg.innerHTML = `<polyline points="${pts.join(" ")}" fill="none" stroke="#ffb054" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` + dots;
  }

  function drawAsteroids() {
    const layer = $("astLayer"), list = $("astList");
    const on = hasAsteroids && $("showAst").checked;
    layer.innerHTML = ""; list.hidden = !on;
    if (!on) return;
    const asts = frames[viewer.idx].asteroids || [];
    layer.innerHTML = asts.map((a) =>
      `<span class="ast" style="left:${pct(a.fx)};top:${pct(a.fy)}"></span>` +
      `<span class="ast-name" style="left:${pct(a.fx)};top:${pct(a.fy)}">${esc(a.name.replace(/\s*\(.*\)\s*$/, ""))}</span>`).join("");
    list.innerHTML = asts.length
      ? `<b>${asts.length} known asteroid${asts.length > 1 ? "s" : ""} in this image</b> (predicted by NASA JPL):<ul>` +
        asts.map((a) => `<li><a href="${jplLink(a.name)}" target="_blank" rel="noopener">${esc(a.name)}</a>${a.vmag ? ` · brightness V ${a.vmag.toFixed(1)}` : ""}</li>`).join("") + "</ul>"
      : "No known asteroids bright enough in this image.";
  }

  function setPlaying(on) {
    clearInterval(viewer.timer);
    viewer.timer = null;
    $("playBtn").textContent = on ? "❚❚ Pause" : "▶ Play";
    $("playBtn").setAttribute("aria-pressed", String(on));
    if (on) viewer.timer = setInterval(() => showFrame(viewer.idx + 1), Number($("speed").value));
  }

  function initViewer() {
    $("frameSlider").max = frames.length - 1;
    $("frameTotal").textContent = frames.length;
    const f0 = frames[0];
    const deg = DATA.blink.view_size_deg;
    $("frameCaption").textContent = `Image: NASA SPHEREx (QR2 data via NASA/IPAC IRSA), processed by SKY BLINK. North is up. Width ${deg.toFixed(2)}° ≈ ${(deg / 0.5).toFixed(1)}× the width of the full Moon.`;
    if (!hasAsteroids) { $("astToggleLabel").hidden = true; }
    $("prevBtn").onclick = () => { setPlaying(false); showFrame(viewer.idx - 1); };
    $("nextBtn").onclick = () => { setPlaying(false); showFrame(viewer.idx + 1); };
    $("playBtn").onclick = () => { if ($("soundOn").checked) Sound.ensure(); setPlaying(!viewer.timer); };
    $("frameSlider").oninput = (e) => { setPlaying(false); showFrame(Number(e.target.value)); };
    $("showMarker").onchange = () => showFrame(viewer.idx, { sound: false });
    $("showTrail").onchange = () => drawTrail();
    $("showAst").onchange = () => drawAsteroids();
    $("soundOn").onchange = (e) => { if (e.target.checked) { Sound.ensure(); playFrame(frames[viewer.idx]); } };
    $("speed").onchange = () => { if (viewer.timer) setPlaying(true); };

    document.addEventListener("keydown", (e) => {
      const tag = document.activeElement.tagName;
      if ((["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(tag) && document.activeElement.type !== "range") ||
          document.activeElement.id === "sonarStage" || document.activeElement.id === "gameStage") return;
      const r = $("blink").getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      if (e.key === "ArrowRight") { setPlaying(false); showFrame(viewer.idx + 1); e.preventDefault(); }
      if (e.key === "ArrowLeft") { setPlaying(false); showFrame(viewer.idx - 1); e.preventDefault(); }
      if (e.key === " ") { setPlaying(!viewer.timer); e.preventDefault(); }
    });

    frames.forEach((f) => { const im = new Image(); im.src = f.web_file; }); // preload
    showFrame(0, { sound: false });
  }

  /* ------------------------------------------------------------------ spot it game */
  const game = { round: 0, score: 0, a: 0, b: 1, timer: null, showA: true, done: false, hinted: false, finished: false };
  const ROUNDS = 5, HIT = 0.08;

  function newRound() {
    clearInterval(game.timer);
    const n = frames.length;
    const gap = Math.max(1, Math.ceil(n / 3));
    game.a = Math.floor(Math.random() * Math.max(1, n - gap));
    game.b = Math.min(n - 1, game.a + gap + Math.floor(Math.random() * Math.max(1, n - game.a - gap)));
    game.done = false; game.hinted = false;
    $("gameGuess").hidden = true; $("gameAnswer").hidden = true;
    $("gRound").textContent = game.round + 1;
    $("gScore").textContent = game.score;
    $("gBar").style.width = pct(game.round / ROUNDS);
    const msg = $("gMsg");
    msg.className = "gmsg";
    msg.textContent = "Watch the blinking images, then tap the object that moves.";
    $("gNext").textContent = "Skip round";
    game.showA = true;
    $("gameImg").src = frames[game.a].web_file;
    game.timer = setInterval(() => {
      game.showA = !game.showA;
      $("gameImg").src = frames[game.showA ? game.a : game.b].web_file;
    }, 550);
  }

  function guess(fx, fy) {
    if (game.done) return;
    game.done = true;
    const fa = frames[game.a], fb = frames[game.b];
    const d = Math.min(Math.hypot(fx - fa.fx, fy - fa.fy), Math.hypot(fx - fb.fx, fy - fb.fy));
    const hit = d <= HIT;
    const g = $("gameGuess");
    g.style.left = pct(fx); g.style.top = pct(fy); g.hidden = false;
    const shown = game.showA ? fa : fb;
    const ans = $("gameAnswer");
    ans.style.left = pct(shown.fx); ans.style.top = pct(shown.fy); ans.hidden = false;
    const msg = $("gMsg");
    if (hit) {
      game.score += game.hinted ? 0.5 : 1;
      msg.className = "gmsg good";
      msg.textContent = `Found it! That's interstellar comet 3I/ATLAS. It moved in ${hoursBetween(fa, fb).toFixed(1)} hours while the stars stayed still.`;
      Sound.ensure(); Sound.success();
    } else {
      msg.className = "gmsg bad";
      msg.textContent = "Not quite — the comet is in the green circle. Look for the fuzzy dot that jumps between the two images.";
      Sound.ensure(); Sound.miss();
    }
    $("gScore").textContent = game.score;
    game.round += 1;
    $("gBar").style.width = pct(game.round / ROUNDS);
    $("gNext").textContent = game.round >= ROUNDS ? "See final score" : "Next round";
  }

  function finishGame() {
    clearInterval(game.timer);
    game.finished = true; game.done = true;
    const msg = $("gMsg");
    msg.className = "gmsg good";
    msg.textContent = `Final score: ${game.score} / ${ROUNDS}. ` +
      (game.score >= 4 ? "Sharp eyes — real astronomer skills!" : "Try again — the comet is the fuzzy dot that jumps.");
    $("gNext").textContent = "Play again";
  }

  function initGame() {
    $("gameStage").addEventListener("click", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      guess((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    });
    $("gameStage").addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() === "h") { $("gHint").click(); e.preventDefault(); }
    });
    $("gHint").onclick = () => {
      if (game.done) return;
      game.hinted = true;
      $("gMsg").textContent = `Hint: look ${whereWord(frames[game.a])} of the image. (Hint answers score ½ point.)`;
    };
    $("gNext").onclick = () => {
      if (game.finished) { game.finished = false; game.round = 0; game.score = 0; newRound(); return; }
      if (!game.done) game.round += 1;
      if (game.round >= ROUNDS) { finishGame(); return; }
      newRound();
    };
    newRound();
  }

  /* ------------------------------------------------------------------ listening tour */
  const tour = { on: false, i: 0, timer: null };

  function stopTour(finalText) {
    tour.on = false;
    clearTimeout(tour.timer);
    Sound.humStop();
    $("listenBtn").textContent = "▶ Start listening tour";
    $("listenBtn").setAttribute("aria-pressed", "false");
    if (finalText) {
      $("listenLive").textContent = finalText;
      if ($("speakOn").checked) speak(finalText);
    }
  }

  function tourStep() {
    if (!tour.on) return;
    if (tour.i >= frames.length) {
      const f0 = frames[0], f1 = frames[frames.length - 1];
      stopTour(`Tour complete. In ${hoursBetween(f0, f1).toFixed(1)} hours the comet travelled from ${whereWord(f0)} to ${whereWord(f1)}, while the stars stayed still.`);
      return;
    }
    const f = frames[tour.i];
    const prev = tour.i ? frames[tour.i - 1] : null;
    showFrame(tour.i, { sound: false });
    tourPicture(f);
    playFrame(f);
    const text = `Image ${tour.i + 1} of ${frames.length}. Comet ${whereWord(f)}` +
      (prev ? `, ${moveWord(prev, f)}` : "") + `. Signal ${strengthWord(f.snr)}.`;
    $("listenLive").textContent = text;
    const talk = $("speakOn").checked;
    tour.i += 1;
    if (talk) tour.timer = setTimeout(() => { if (tour.on) tour.timer = sayThen(text, () => tour.on, tourStep); }, 450);
    else tour.timer = setTimeout(tourStep, 1700);
  }

  function tourPicture(f) {
    $("tourImg").src = f.web_file;
    const m = $("tourMarker"); m.hidden = false;
    m.style.left = pct(f.fx); m.style.top = pct(f.fy);
    m.classList.remove("hop"); void m.offsetWidth; m.classList.add("hop");
  }
  function soundKey(k) {
    Sound.ensure();
    const msg = {
      stars: "Stars: a steady soft hum. Stars are so far away they never move between images.",
      comet: "The comet: a bell-like chime, played once for every image.",
      left: "Comet on the LEFT of the picture: you hear it in your left ear.",
      right: "Comet on the RIGHT of the picture: you hear it in your right ear.",
      high: "Comet HIGH in the picture: a high note.",
      low: "Comet LOW in the picture: a low note.",
      bright: "A bright comet is loud; a faint comet is quiet.",
    }[k];
    if (k === "stars") { Sound.humStart(); setTimeout(() => { if (!tour.on) Sound.humStop(); }, 2500); }
    if (k === "comet") Sound.chime({ freq: 523, vol: 0.4 });
    if (k === "left") Sound.chime({ freq: 523, pan: -0.95, vol: 0.4 });
    if (k === "right") Sound.chime({ freq: 523, pan: 0.95, vol: 0.4 });
    if (k === "high") Sound.chime({ freq: 988, vol: 0.4 });
    if (k === "low") Sound.chime({ freq: 262, vol: 0.4 });
    if (k === "bright") { Sound.chime({ freq: 523, vol: 0.55 }); Sound.chime({ freq: 523, vol: 0.06, delay: 0.8 }); }
    $("listenLive").textContent = msg;
  }

  function initListen() {
    document.querySelectorAll(".soundkey .pchip").forEach((b) => { b.onclick = () => soundKey(b.dataset.key); });
    tourPicture(frames[0]); $("tourMarker").hidden = true;
    $("tourHide").onchange = (e) => { $("tourCover").hidden = !e.target.checked; };
    $("listenBtn").onclick = () => {
      if (tour.on) { stopSpeech(); stopTour(); $("listenLive").textContent = "Tour stopped."; return; }
      Sound.ensure();
      setPlaying(false);
      tour.on = true; tour.i = 0;
      $("listenBtn").textContent = "■ Stop tour";
      $("listenBtn").setAttribute("aria-pressed", "true");
      Sound.humStart();
      $("listenLive").textContent = "Listen: the soft hum is the stars. The chime is the comet.";
      if ($("speakOn").checked) speak("Listen. The soft hum is the stars. The chime is the comet.");
      tour.timer = setTimeout(tourStep, $("speakOn").checked ? 3800 : 1500);
    };
  }

  /* ------------------------------------------------------------------ sonar */
  const sonar = { on: false, x: 0.5, y: 0.5, frame: null, timer: null, found: false };
  const SONAR_HIT = 0.07;

  function sonarDist() { return Math.hypot(sonar.x - sonar.frame.fx, sonar.y - sonar.frame.fy); }

  function sonarPing() {
    if (!sonar.on) return;
    const d = sonarDist();
    const closeness = 1 - Math.min(d / 0.75, 1); // 0 far .. 1 on top
    Sound.chime({
      freq: 220 + closeness * 880,
      pan: (sonar.x * 2 - 1) * 0.9,
      vol: 0.18 + closeness * 0.25,
      dur: 0.14, type: "sine",
    });
    sonar.timer = setTimeout(sonarPing, 90 + (1 - closeness) * 750);
  }

  function sonarMove(x, y) {
    sonar.x = Math.max(0, Math.min(1, x)); sonar.y = Math.max(0, Math.min(1, y));
    const c = $("sonarCursor");
    c.hidden = false; c.style.left = pct(sonar.x); c.style.top = pct(sonar.y);
    if (!sonar.on) startSonar();
  }

  function startSonar() {
    Sound.ensure();
    sonar.frame = frames[Math.floor(Math.random() * frames.length)];
    $("sonarImg").src = sonar.frame.web_file;
    $("sonarAnswer").hidden = true;
    sonar.found = false;
    sonar.on = true;
    clearTimeout(sonar.timer);
    $("sonarStart").textContent = "■ Stop sonar";
    $("sonarLive").textContent = "Sonar on. Move around and listen: faster, higher beeps mean you are close.";
    sonarPing();
  }

  function stopSonar(text) {
    sonar.on = false;
    clearTimeout(sonar.timer);
    $("sonarStart").textContent = "▶ Start sonar";
    if (text) $("sonarLive").textContent = text;
  }

  function sonarCheck() {
    if (!sonar.frame) return;
    const d = sonarDist();
    if (d <= SONAR_HIT) {
      stopSonar("You found the comet by ear! Press Start to try another image.");
      Sound.success();
      speak("You found the comet!");
      const a = $("sonarAnswer");
      a.style.left = pct(sonar.frame.fx); a.style.top = pct(sonar.frame.fy); a.hidden = false;
    } else {
      const dir = [];
      if (Math.abs(sonar.frame.fy - sonar.y) > 0.05) dir.push(sonar.frame.fy < sonar.y ? "up" : "down");
      if (Math.abs(sonar.frame.fx - sonar.x) > 0.05) dir.push(sonar.frame.fx < sonar.x ? "left" : "right");
      const t = `Not yet. Try moving ${dir.join(" and ") || "a little"}.`;
      $("sonarLive").textContent = t;
      speak(t);
    }
  }

  function initSonar() {
    const st = $("sonarStage");
    $("sonarImg").src = frames[0].web_file;
    $("sonarCover").hidden = !$("sonarHide").checked;
    $("sonarHide").onchange = (e) => { $("sonarCover").hidden = !e.target.checked; };
    $("sonarStart").onclick = () => (sonar.on ? stopSonar("Sonar stopped.") : (sonarMove(0.5, 0.5), st.focus()));
    st.addEventListener("pointermove", (e) => {
      const r = st.getBoundingClientRect();
      sonarMove((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    });
    st.addEventListener("pointerleave", () => { if (sonar.on && !st.matches(":focus")) stopSonar("Sonar paused. Move back over the image to continue."); });
    st.addEventListener("click", (e) => {
      const r = st.getBoundingClientRect();
      sonarMove((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      sonarCheck();
    });
    st.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.01 : 0.04;
      const k = e.key;
      if (k === "ArrowLeft") sonarMove(sonar.x - step, sonar.y);
      else if (k === "ArrowRight") sonarMove(sonar.x + step, sonar.y);
      else if (k === "ArrowUp") sonarMove(sonar.x, sonar.y - step);
      else if (k === "ArrowDown") sonarMove(sonar.x, sonar.y + step);
      else if (k === "Enter" || k === " ") sonarCheck();
      else if (k === "Escape") stopSonar("Sonar stopped.");
      else return;
      e.preventDefault();
    });
  }

  /* ------------------------------------------------------------------ fingerprint */
  const fp = { month: "all", sel: null, playing: false };
  const MONTH_COLOUR = { "Aug 2025": "#6fa8ff", "Dec 2025": "#ffb054" };
  const colourFor = (m) => MONTH_COLOUR[m] || "#c9a7ff";
  const X0 = 0.7, X1 = 5.1;
  let layout = null;

  const visiblePoints = () => (fp.month === "all" ? points : points.filter((p) => p.month === fp.month));

  function niceStep(max) {
    const raw = max / 5, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }

  function drawChart() {
    const c = $("fpCanvas");
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const pad = { l: 46, r: 12, t: 30, b: 38 };
    const vis = visiblePoints();
    const yMax = Math.max(10, ...vis.map((p) => p.snr)) * 1.08;
    const X = (wl) => pad.l + ((wl - X0) / (X1 - X0)) * (w - pad.l - pad.r);
    const Y = (s) => h - pad.b - (Math.max(0, s) / yMax) * (h - pad.t - pad.b);
    layout = { X, Y };

    // background: the infrared "rainbow" as a faint band along the bottom
    const grad = g.createLinearGradient(X(0.75), 0, X(5), 0);
    [0, 0.2, 0.4, 0.6, 0.8, 1].forEach((s) => grad.addColorStop(s, `hsla(${260 - s * 260} 80% 55% / 0.35)`));
    g.fillStyle = grad;
    g.fillRect(X(0.75), h - pad.b - 4, X(5) - X(0.75), 4);

    g.font = "12px system-ui, sans-serif";
    const step = niceStep(yMax);
    g.strokeStyle = "#262d48"; g.fillStyle = "#a3abc6"; g.lineWidth = 1;
    g.textAlign = "right"; g.textBaseline = "middle";
    for (let v = 0; v <= yMax; v += step) {
      g.beginPath(); g.moveTo(pad.l, Y(v)); g.lineTo(w - pad.r, Y(v)); g.stroke();
      g.fillText(String(Math.round(v)), pad.l - 6, Y(v));
    }
    g.textAlign = "center"; g.textBaseline = "top";
    for (let v = 1; v <= 5; v += 1) g.fillText(`${v}`, X(v), h - pad.b + 6);
    g.fillText("Infrared wavelength (µm)", (pad.l + w - pad.r) / 2, h - 16);
    g.save();
    g.translate(12, (pad.t + h - pad.b) / 2); g.rotate(-Math.PI / 2);
    g.fillText("Comet signal", 0, -6);
    g.restore();
    FEATURES.forEach((f, i) => {
      g.strokeStyle = "#8a93b8"; g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(X(f.wl), pad.t); g.lineTo(X(f.wl), h - pad.b); g.stroke();
      g.setLineDash([]);
      g.fillStyle = "#cfd5ea"; g.textAlign = i === 2 ? "left" : "right"; g.textBaseline = "top";
      g.fillText(f.short, X(f.wl) + (i === 2 ? 4 : -4), pad.t - 22);
    });
    vis.forEach((p) => {
      g.fillStyle = colourFor(p.month);
      g.beginPath(); g.arc(X(p.wl), Y(p.snr), 3.4, 0, Math.PI * 2); g.fill();
    });
    if (fp.sel) {
      g.strokeStyle = "#ffffff"; g.lineWidth = 2;
      g.beginPath(); g.arc(X(fp.sel.wl), Y(fp.sel.snr), 8, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = "rgba(94,230,255,0.6)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(X(fp.sel.wl), pad.t); g.lineTo(X(fp.sel.wl), h - pad.b); g.stroke();
    }
  }

  function nearest(wl, pool) {
    const close = pool.filter((p) => Math.abs(p.wl - wl) <= 0.04);
    if (close.length) return close.reduce((a, b) => (b.snr > a.snr ? b : a));
    let best = null, bd = Infinity;
    pool.forEach((p) => { const d = Math.abs(p.wl - wl); if (d < bd) { bd = d; best = p; } });
    return best;
  }

  function selectWl(wl, { sound = true } = {}) {
    const pool = visiblePoints();
    $("wlVal").textContent = Number(wl).toFixed(2);
    if (!pool.length) return;
    const p = nearest(wl, pool);
    fp.sel = p;
    if (p.thumb) { $("fpThumb").src = p.thumb; $("fpThumb").hidden = false; } else { $("fpThumb").hidden = true; }
    $("fpInfo").textContent = `${p.month} · ${p.wl.toFixed(2)} µm · signal ${Math.round(p.snr)} (${strengthWord(p.snr)})`;
    const feat = FEATURES.find((f) => Math.abs(f.wl - p.wl) < 0.1);
    $("fpFeature").textContent = feat ? `${feat.name} glows near here` : "";
    drawChart();
    if (sound && $("fpSound").checked) playWavelength(p.wl, p.snr, 0.45);
  }

  function playSweep(pool, label, done) {
    const seq = [...pool].sort((a, b) => a.wl - b.wl);
    seq.forEach((p, i) => setTimeout(() => {
      $("wlSlider").value = p.wl;
      selectWl(p.wl, { sound: false });
      playWavelength(p.wl, p.snr, 0.3);
      if (i === seq.length - 1) setTimeout(done, 300);
    }, i * 110));
    if (!seq.length) done();
  }

  function setMonth(m) {
    fp.month = m;
    document.querySelectorAll(".fp-filter .btn").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.month === m)));
  }

  function initFingerprint() {
    if (!points.length) { $("fpInfo").textContent = "No fingerprint data yet. Run the scan step."; return; }
    const months = [...new Set(points.map((p) => p.month))];
    $("fpLegend").innerHTML = months.map((m) => `<span style="--c:${colourFor(m)}">${m}</span>`).join("") +
      `<span style="--c:transparent">Dashed lines: gas glow colours</span>`;

    document.querySelectorAll(".fp-filter .btn").forEach((b) => {
      b.onclick = () => { setMonth(b.dataset.month); selectWl(Number($("wlSlider").value), { sound: false }); };
    });
    let last = 0;
    $("wlSlider").oninput = (e) => {
      const now = performance.now();
      const doSound = now - last > 90;
      if (doSound) last = now;
      Sound.ensure();
      selectWl(Number(e.target.value), { sound: doSound });
    };
    document.querySelectorAll(".jumps .btn").forEach((b) => {
      b.onclick = () => { Sound.ensure(); $("wlSlider").value = b.dataset.wl; selectWl(Number(b.dataset.wl)); };
    });
    $("fpCanvas").addEventListener("click", (e) => {
      if (!layout) return;
      const r = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      let best = null, bd = Infinity;
      visiblePoints().forEach((p) => {
        const d = Math.hypot(layout.X(p.wl) - mx, layout.Y(p.snr) - my);
        if (d < bd) { bd = d; best = p; }
      });
      if (best && bd < 30) { Sound.ensure(); $("wlSlider").value = best.wl; selectWl(best.wl); }
    });
    $("fpPlay").onclick = () => {
      if (fp.playing) return;
      Sound.ensure();
      let pool = visiblePoints();
      if (fp.month === "all" && pool.some((p) => p.month === "Dec 2025")) pool = pool.filter((p) => p.month === "Dec 2025");
      fp.playing = true; $("fpPlay").textContent = "♫ Playing…";
      playSweep(pool, "", () => { fp.playing = false; $("fpPlay").textContent = "♫ Play the fingerprint"; });
    };
    $("fpCompare").onclick = () => {
      if (fp.playing || months.length < 2) return;
      Sound.ensure();
      fp.playing = true; $("fpCompare").textContent = "♫ August…";
      setMonth(months[0]);
      playSweep(points.filter((p) => p.month === months[0]), "", () => {
        $("fpCompare").textContent = "♫ December…";
        setMonth(months[1]);
        playSweep(points.filter((p) => p.month === months[1]), "", () => {
          fp.playing = false; $("fpCompare").textContent = "♫ August vs December";
        });
      });
    };
    window.addEventListener("resize", drawChart);
    selectWl(4.26, { sound: false });
  }

  /* ------------------------------------------------------------------ how it works */
  function initFlow() {
    const nScan = (DATA.fingerprint || []).length;
    const nAst = (DATA.blink.asteroid_names || []).length;
    const steps = [
      ["NASA archive", "SPHEREx images of", "3I/ATLAS at IRSA"],
      ["Download", `${nScan} images (small`, "cut-outs, not full files)"],
      ["Clean + align", "remove background glow,", "line up north-up"],
      ["Measure", "exact infrared colour +", "comet signal per image"],
      ["Explore", "see it, hear it,", nAst ? `+ ${nAst} JPL asteroids` : "learn from it"],
    ];
    const W = 1000, bw = 168, gap = (W - 5 * bw) / 4;
    const boxes = steps.map((s, i) => {
      const x = i * (bw + gap);
      const accent = i === 4;
      return `<g><rect x="${x}" y="20" width="${bw}" height="110" rx="14" fill="${accent ? "rgba(94,230,255,.12)" : "#0e1222"}" stroke="${accent ? "#5ee6ff" : "#3a4470"}" stroke-width="${accent ? 2 : 1.25}"/>
        <text x="${x + bw / 2}" y="58" text-anchor="middle" fill="#eef1fa" font-size="17" font-weight="700">${esc(s[0])}</text>
        <text x="${x + bw / 2}" y="86" text-anchor="middle" fill="#a3abc6" font-size="13">${esc(s[1])}</text>
        <text x="${x + bw / 2}" y="104" text-anchor="middle" fill="#a3abc6" font-size="13">${esc(s[2])}</text>
        <text x="${x + 16}" y="42" fill="#5ee6ff" font-size="12" font-weight="700">${i + 1}</text></g>` +
        (i < 4 ? `<path d="M${x + bw + 6} 75 H${x + bw + gap - 8}" stroke="#8a93b8" stroke-width="1.5" marker-end="url(#arr)"/>` : "");
    }).join("");
    $("flow").innerHTML = `<svg viewBox="0 0 ${W} 150" role="img" aria-label="Pipeline: NASA archive, download, clean and align, measure, explore">
      <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#8a93b8"/></marker></defs>${boxes}</svg>`;
  }

  /* ------------------------------------------------------------------ learn + classroom (EN / BM) */
  let lang = "en";
  const T = {
    en: { learnEyebrow: "Learn", learnTitle: "Space facts in one minute", classEyebrow: "Classroom mode", classTitle: "Test yourself",
      classIntro: () => `${ROUND_SIZE} random questions from a bank of ${QUIZ_BANK.length} — new questions every time you play. Teachers: a 40-minute lesson plan is below.`, teacherSummary: "👩‍🏫 Teacher guide: 40-minute lesson",
      wow: "Wow", correct: "Correct!", wrong: "Not quite.", score: (s, n) => `Your score: ${s} / ${n}`, retry: "Try again",
      qnum: (i, n) => `Question ${i} of ${n}`, next: "Next question →", finish: "See my score", again: "Play again (new questions)",
      perfect: "Perfect! You're a real space scientist.", good: "Great job! Play again to meet new questions.", keep: "Good try! Explore the website and play again." },
    ms: { learnEyebrow: "Belajar", learnTitle: "Fakta angkasa dalam satu minit", classEyebrow: "Mod bilik darjah", classTitle: "Uji diri anda",
      classIntro: () => `${ROUND_SIZE} soalan rawak daripada ${QUIZ_BANK.length} soalan — soalan baharu setiap kali bermain. Guru: rancangan pelajaran 40 minit di bawah.`, teacherSummary: "👩‍🏫 Panduan guru: pelajaran 40 minit",
      wow: "Wah", correct: "Betul!", wrong: "Belum tepat.", score: (s, n) => `Markah anda: ${s} / ${n}`, retry: "Cuba lagi",
      qnum: (i, n) => `Soalan ${i} daripada ${n}`, next: "Soalan seterusnya →", finish: "Lihat markah saya", again: "Main lagi (soalan baharu)",
      perfect: "Sempurna! Anda saintis angkasa sebenar.", good: "Syabas! Main lagi untuk soalan baharu.", keep: "Cubaan yang baik! Teroka laman web dan main lagi." },
  };
  const CARDS = [
    { en: ["What is SPHEREx?", "SPHEREx is a NASA space telescope launched in March 2025. Every six months it photographs the entire sky in 102 colours of infrared light.", "It is studying over a billion objects, from nearby comets to faraway galaxies."],
      ms: ["Apa itu SPHEREx?", "SPHEREx ialah teleskop angkasa NASA yang dilancarkan pada Mac 2025. Setiap enam bulan, ia merakam seluruh langit dalam 102 warna cahaya inframerah.", "Ia mengkaji lebih satu bilion objek, daripada komet berdekatan hingga galaksi yang jauh."] },
    { en: ["What is infrared light?", "Infrared is light our eyes cannot see, just beyond red in the rainbow. Warm things and certain gases glow in infrared, so it reveals what objects are made of.", "A TV remote talks to your TV using infrared light."],
      ms: ["Apa itu cahaya inframerah?", "Inframerah ialah cahaya yang tidak dapat dilihat oleh mata kita, terletak selepas warna merah dalam pelangi. Objek panas dan gas tertentu bercahaya dalam inframerah, jadi ia mendedahkan bahan sesuatu objek.", "Alat kawalan jauh TV berkomunikasi dengan TV menggunakan cahaya inframerah."] },
    { en: ["What is a comet?", "A comet is a ball of ice, dust and rock. Near the Sun its ice turns into gas and forms a glowing cloud called a coma.", "A comet's coma can be bigger than a planet."],
      ms: ["Apa itu komet?", "Komet ialah bola ais, debu dan batu. Apabila menghampiri Matahari, aisnya bertukar menjadi gas dan membentuk awan bercahaya yang dipanggil koma.", "Koma komet boleh menjadi lebih besar daripada sebuah planet."] },
    { en: ["Meet 3I/ATLAS", "3I/ATLAS was discovered on 1 July 2025. It is only the third object ever found that came from outside our Solar System.", "It formed around another star and will leave our Solar System forever."],
      ms: ["Kenali 3I/ATLAS", "3I/ATLAS ditemui pada 1 Julai 2025. Ia hanyalah objek ketiga yang pernah ditemui datang dari luar Sistem Suria kita.", "Ia terbentuk di sekeliling bintang lain dan akan meninggalkan Sistem Suria kita buat selama-lamanya."] },
    { en: ["What did SPHEREx find?", "SPHEREx found a huge cloud of carbon dioxide gas around 3I/ATLAS, plus signs of water. After passing the Sun, the comet became much more active.", "Our scan of real SPHEREx images found the same carbon dioxide and water signals."],
      ms: ["Apa yang ditemui SPHEREx?", "SPHEREx menemui awan gas karbon dioksida yang besar di sekeliling 3I/ATLAS, serta tanda-tanda air. Selepas melepasi Matahari, komet itu menjadi jauh lebih aktif.", "Imbasan kami terhadap imej SPHEREx sebenar menemui isyarat karbon dioksida dan air yang sama."] },
    { en: ["Why do stars stay still?", "Stars are so far away they barely move between photos taken hours apart. Comets and asteroids are much closer, so they visibly shift.", "This blink trick is how Pluto was discovered in 1930."],
      ms: ["Mengapa bintang kekal diam?", "Bintang sangat jauh sehingga hampir tidak bergerak antara gambar yang diambil beberapa jam berselang. Komet dan asteroid jauh lebih dekat, jadi ia kelihatan beralih.", "Teknik 'kelip' ini digunakan untuk menemui Pluto pada tahun 1930."] },
    { en: ["Why does the comet's brightness change?", "Each SPHEREx photo sees a different infrared colour at each part of its camera. The comet looks brightest where its gases glow.", "In some colours 3I/ATLAS almost disappears; in carbon dioxide light it shines."],
      ms: ["Mengapa kecerahan komet berubah?", "Setiap gambar SPHEREx melihat warna inframerah yang berbeza di setiap bahagian kameranya. Komet kelihatan paling terang di tempat gasnya bercahaya.", "Dalam sesetengah warna 3I/ATLAS hampir hilang; dalam cahaya karbon dioksida ia bersinar."] },
    { en: ["What is an asteroid?", "An asteroid is a rocky or metal object left over from when the planets formed. Most orbit the Sun between Mars and Jupiter.", "Over a million asteroids are known — turn on 'Known asteroids' in the blink viewer to meet some."],
      ms: ["Apa itu asteroid?", "Asteroid ialah objek berbatu atau logam yang tertinggal sejak planet-planet terbentuk. Kebanyakannya mengorbit Matahari di antara Marikh dan Musytari.", "Lebih sejuta asteroid telah dikenal pasti — hidupkan 'Known asteroids' dalam pemapar untuk melihatnya."] },
    { en: ["What is a brown dwarf?", "A brown dwarf is too big to be a planet but too small to shine like a star. It glows mostly in infrared, so SPHEREx can spot it.", "Some brown dwarfs are cooler than a cup of coffee."],
      ms: ["Apa itu kerdil perang?", "Kerdil perang terlalu besar untuk menjadi planet tetapi terlalu kecil untuk bersinar seperti bintang. Ia bercahaya kebanyakannya dalam inframerah, jadi SPHEREx dapat mengesannya.", "Sesetengah kerdil perang lebih sejuk daripada secawan kopi."] },
    { en: ["Carbon dioxide: the brightest glow", "Carbon dioxide (CO₂) is the gas we breathe out. In space it glows strongly at about 4.3 microns of infrared light.", "It is the comet's loudest note in our fingerprint sound."],
      ms: ["Karbon dioksida: cahaya paling terang", "Karbon dioksida (CO₂) ialah gas yang kita hembus. Di angkasa, ia bercahaya kuat pada kira-kira 4.3 mikron cahaya inframerah.", "Ia nada paling kuat komet ini dalam bunyi cap jari kami."] },
    { en: ["Water from another star", "Water gas glows near 2.7 microns. Finding it tells us 3I/ATLAS carried ice from its home star system.", "This ice may be billions of years old."],
      ms: ["Air dari bintang lain", "Gas air bercahaya berhampiran 2.7 mikron. Penemuannya memberitahu kita bahawa 3I/ATLAS membawa ais dari sistem bintang asalnya.", "Ais ini mungkin berusia berbilion tahun."] },
    { en: ["How to use listen mode", "Put on headphones and press play. The chime is the comet: it moves between your ears and changes pitch as it travels. The soft hum is the stars.", "You can follow a comet across the sky with your eyes closed."],
      ms: ["Cara menggunakan mod dengar", "Pakai fon kepala dan tekan main. Bunyi loceng ialah komet: ia bergerak antara telinga kiri dan kanan serta berubah nada semasa bergerak. Dengungan lembut ialah bintang.", "Anda boleh mengikuti komet merentasi langit dengan mata tertutup."] },
  ];
  // [question, [correct, wrong, wrong], explanation]  — correct answer is always first here;
  // options are shuffled every time they are shown.
  const QUIZ_BANK = [
    { en: ["Why do stars stay still in our images while the comet moves?", ["Stars are much farther away", "Stars are smaller", "The camera follows the stars"], "Stars are so far away that a few hours of motion is far too small to see. The comet is in our Solar System, so it moves visibly."],
      ms: ["Mengapa bintang kekal diam dalam imej kami sedangkan komet bergerak?", ["Bintang jauh lebih jauh", "Bintang lebih kecil", "Kamera mengikut bintang"], "Bintang terlalu jauh sehingga pergerakan beberapa jam tidak dapat dilihat. Komet berada dalam Sistem Suria kita, jadi ia kelihatan bergerak."] },
    { en: ["Where did comet 3I/ATLAS come from?", ["Outside our Solar System", "The asteroid belt", "The Moon"], "It is only the third object ever found coming from another star system."],
      ms: ["Dari manakah komet 3I/ATLAS datang?", ["Luar Sistem Suria kita", "Jalur asteroid", "Bulan"], "Ia hanyalah objek ketiga yang ditemui datang dari sistem bintang lain."] },
    { en: ["What does the '3I' in 3I/ATLAS mean?", ["The third interstellar object", "The third ice comet", "Three images"], "'I' stands for interstellar — it came from between the stars."],
      ms: ["Apakah maksud '3I' dalam 3I/ATLAS?", ["Objek antara bintang yang ketiga", "Komet ais yang ketiga", "Tiga imej"], "'I' bermaksud antara bintang (interstellar) — ia datang dari ruang antara bintang."] },
    { en: ["Which gas makes 3I/ATLAS glow brightest in SPHEREx data?", ["Carbon dioxide", "Oxygen", "Helium"], "Our fingerprint chart peaks at about 4.3 microns — the colour where carbon dioxide glows."],
      ms: ["Gas manakah yang membuat 3I/ATLAS bercahaya paling terang dalam data SPHEREx?", ["Karbon dioksida", "Oksigen", "Helium"], "Carta cap jari kami memuncak pada kira-kira 4.3 mikron — warna di mana karbon dioksida bercahaya."] },
    { en: ["Which gas glows near 2.7 microns in the comet's fingerprint?", ["Water", "Carbon dioxide", "Neon"], "Water gas glows near 2.7 microns. It shows the comet carried ice from its home star system."],
      ms: ["Gas manakah yang bercahaya berhampiran 2.7 mikron dalam cap jari komet?", ["Air", "Karbon dioksida", "Neon"], "Gas air bercahaya berhampiran 2.7 mikron. Ia menunjukkan komet membawa ais dari sistem bintang asalnya."] },
    { en: ["What kind of light does SPHEREx see?", ["Infrared", "X-rays", "Radio waves"], "SPHEREx sees near-infrared light from 0.75 to 5 microns."],
      ms: ["Jenis cahaya apakah yang dilihat oleh SPHEREx?", ["Inframerah", "Sinar-X", "Gelombang radio"], "SPHEREx melihat cahaya inframerah dekat dari 0.75 hingga 5 mikron."] },
    { en: ["How often does SPHEREx map the entire sky?", ["Every six months", "Every day", "Every ten years"], "Every six months it completes a full map of the sky, so we can compare maps to see what changed."],
      ms: ["Berapa kerap SPHEREx memetakan seluruh langit?", ["Setiap enam bulan", "Setiap hari", "Setiap sepuluh tahun"], "Setiap enam bulan ia melengkapkan peta seluruh langit, jadi kita boleh membandingkan peta untuk melihat perubahan."] },
    { en: ["How many colours (bands) of infrared light does SPHEREx use?", ["102", "3", "7"], "102 bands let scientists see which gases and ices objects are made of."],
      ms: ["Berapa banyak warna (jalur) cahaya inframerah yang digunakan SPHEREx?", ["102", "3", "7"], "102 jalur membolehkan saintis melihat gas dan ais yang membentuk sesuatu objek."] },
    { en: ["When was SPHEREx launched?", ["March 2025", "1990", "2015"], "SPHEREx launched in March 2025 and began mapping the sky soon after."],
      ms: ["Bilakah SPHEREx dilancarkan?", ["Mac 2025", "1990", "2015"], "SPHEREx dilancarkan pada Mac 2025 dan mula memetakan langit tidak lama kemudian."] },
    { en: ["Why was the comet brighter in December than in August?", ["It passed close to the Sun and released more gas", "It moved closer to the Moon", "The telescope was repaired"], "After its closest approach to the Sun in late October 2025, it warmed up and released much more gas and dust."],
      ms: ["Mengapa komet lebih terang pada Disember berbanding Ogos?", ["Ia melepasi berhampiran Matahari dan membebaskan lebih banyak gas", "Ia bergerak lebih dekat ke Bulan", "Teleskop telah dibaiki"], "Selepas paling hampir dengan Matahari pada akhir Oktober 2025, ia menjadi panas dan membebaskan lebih banyak gas dan debu."] },
    { en: ["What is the glowing cloud around a comet called?", ["Coma", "Crater", "Core"], "Near the Sun, a comet's ice turns into gas and dust, forming a glowing cloud called the coma."],
      ms: ["Apakah nama awan bercahaya di sekeliling komet?", ["Koma", "Kawah", "Teras"], "Berhampiran Matahari, ais komet bertukar menjadi gas dan debu, membentuk awan bercahaya yang dipanggil koma."] },
    { en: ["Why does a comet start to glow near the Sun?", ["Its ice turns into gas", "It catches fire", "Lightning hits it"], "Sunlight warms the ice, which turns straight into gas and carries dust with it."],
      ms: ["Mengapa komet mula bercahaya berhampiran Matahari?", ["Aisnya bertukar menjadi gas", "Ia terbakar", "Ia dipanah petir"], "Cahaya Matahari memanaskan ais, yang terus bertukar menjadi gas dan membawa debu bersamanya."] },
    { en: ["Where do most asteroids orbit the Sun?", ["Between Mars and Jupiter", "Between Earth and the Moon", "Inside the Sun"], "Most asteroids are in the main asteroid belt between Mars and Jupiter."],
      ms: ["Di manakah kebanyakan asteroid mengorbit Matahari?", ["Di antara Marikh dan Musytari", "Di antara Bumi dan Bulan", "Di dalam Matahari"], "Kebanyakan asteroid berada dalam jalur asteroid utama di antara Marikh dan Musytari."] },
    { en: ["What is a brown dwarf?", ["Too big to be a planet, too small to shine like a star", "A dead star", "A type of comet"], "Brown dwarfs sit between planets and stars. They never become hot enough to shine like the Sun."],
      ms: ["Apakah itu kerdil perang?", ["Terlalu besar untuk menjadi planet, terlalu kecil untuk bersinar seperti bintang", "Bintang yang mati", "Sejenis komet"], "Kerdil perang berada di antara planet dan bintang. Ia tidak pernah cukup panas untuk bersinar seperti Matahari."] },
    { en: ["Why is infrared good for finding brown dwarfs?", ["They glow mostly in infrared", "They are very hot", "They reflect sunlight"], "Brown dwarfs are cool, so most of their light is infrared — perfect for SPHEREx."],
      ms: ["Mengapa inframerah sesuai untuk mencari kerdil perang?", ["Ia bercahaya kebanyakannya dalam inframerah", "Ia sangat panas", "Ia memantulkan cahaya Matahari"], "Kerdil perang sejuk, jadi kebanyakan cahayanya ialah inframerah — sesuai untuk SPHEREx."] },
    { en: ["Which dwarf planet was found in 1930 by blinking two photos?", ["Pluto", "Ceres", "Eris"], "Clyde Tombaugh found Pluto by flipping between photos and spotting the dot that moved."],
      ms: ["Planet kerdil manakah yang ditemui pada 1930 dengan mengelipkan dua gambar?", ["Pluto", "Ceres", "Eris"], "Clyde Tombaugh menemui Pluto dengan menukar-nukar gambar dan mengesan titik yang bergerak."] },
    { en: ["What does a light-year measure?", ["Distance", "Time", "Brightness"], "A light-year is how far light travels in one year — about 9.5 trillion kilometres."],
      ms: ["Apakah yang diukur oleh tahun cahaya?", ["Jarak", "Masa", "Kecerahan"], "Tahun cahaya ialah jarak yang dilalui cahaya dalam setahun — kira-kira 9.5 trilion kilometer."] },
    { en: ["What is a variable star?", ["A star whose brightness changes", "A star that changes shape", "A star that is moving fast"], "Variable stars brighten and dim — because they pulse, or because dust blocks their light."],
      ms: ["Apakah itu bintang boleh ubah?", ["Bintang yang kecerahannya berubah", "Bintang yang berubah bentuk", "Bintang yang bergerak laju"], "Bintang boleh ubah menjadi terang dan malap — kerana ia berdenyut, atau debu menghalang cahayanya."] },
    { en: ["Why would a distant Planet X seem to jump between sky maps taken six months apart?", ["Earth moved around the Sun, changing our view", "Planet X moves very fast", "The telescope was moved by mistake"], "This shift is called parallax. Nearby objects jump against far-away stars when our viewpoint changes."],
      ms: ["Mengapa Planet X yang jauh kelihatan melompat antara peta langit yang diambil enam bulan berselang?", ["Bumi bergerak mengelilingi Matahari, mengubah pandangan kita", "Planet X bergerak sangat laju", "Teleskop teralih secara tidak sengaja"], "Anjakan ini dipanggil paralaks. Objek berdekatan kelihatan melompat berbanding bintang jauh apabila sudut pandangan kita berubah."] },
    { en: ["Barnard's Star is famous for…", ["Moving fastest across our sky of all stars", "Being the brightest star", "Being the biggest star"], "It is only about 6 light-years away, so its motion through space is easier to notice over the years."],
      ms: ["Bintang Barnard terkenal kerana…", ["Bergerak paling laju merentasi langit kita berbanding bintang lain", "Bintang paling terang", "Bintang paling besar"], "Ia hanya kira-kira 6 tahun cahaya dari kita, jadi pergerakannya lebih mudah dilihat selepas beberapa tahun."] },
    { en: ["Why do astronomers compare images taken at different times?", ["To find things that move or change", "To make the images more colourful", "To fix the camera"], "Anything that moves or changes brightness stands out when you compare images."],
      ms: ["Mengapa ahli astronomi membandingkan imej yang diambil pada masa berbeza?", ["Untuk mencari objek yang bergerak atau berubah", "Untuk menjadikan imej lebih berwarna", "Untuk membaiki kamera"], "Apa-apa yang bergerak atau berubah kecerahan akan menonjol apabila imej dibandingkan."] },
    { en: ["What unit do we use for infrared wavelengths in SKY BLINK?", ["Micrometre (micron)", "Kilometre", "Kilogram"], "One micron is one millionth of a metre. SPHEREx sees 0.75 to 5 microns."],
      ms: ["Unit apakah yang digunakan untuk panjang gelombang inframerah dalam SKY BLINK?", ["Mikrometer (mikron)", "Kilometer", "Kilogram"], "Satu mikron ialah satu per sejuta meter. SPHEREx melihat 0.75 hingga 5 mikron."] },
    { en: ["In SKY BLINK's listen mode, what does a higher note mean?", ["The comet is higher in the image", "The comet is bigger", "The comet is farther away"], "Our sound rule: up in the image = higher note; left and right = left and right ear."],
      ms: ["Dalam mod dengar SKY BLINK, apakah maksud nada yang lebih tinggi?", ["Komet berada lebih tinggi dalam imej", "Komet lebih besar", "Komet lebih jauh"], "Peraturan bunyi kami: lebih tinggi dalam imej = nada lebih tinggi; kiri dan kanan = telinga kiri dan kanan."] },
    { en: ["How can sound help science?", ["People who cannot see can explore data by listening", "Sound makes telescopes faster", "Sound replaces all images"], "Turning data into sound (sonification) lets blind and visually impaired people do science too — and helps everyone notice patterns."],
      ms: ["Bagaimanakah bunyi boleh membantu sains?", ["Orang yang tidak dapat melihat boleh meneroka data dengan mendengar", "Bunyi menjadikan teleskop lebih laju", "Bunyi menggantikan semua imej"], "Menukar data kepada bunyi (sonifikasi) membolehkan golongan cacat penglihatan turut menjalankan sains — dan membantu semua orang mengesan corak."] },
  ];
  const ROUND_SIZE = 8;
  const TEACHER = {
    en: `<p><b>Goals:</b> students can explain why nearby objects move against the stars, describe infrared light, and identify gases from a spectrum.</p>
      <ol>
        <li><b>Hook (5 min):</b> lights off. Play the <a href="#listen">listening tour</a> with eyes closed. Ask: "What moved? Which way?"</li>
        <li><b>See it (10 min):</b> in pairs, use the <a href="#blink">blink viewer</a> and play <a href="#spot">Spot it</a>. Discuss why stars stay still (distance).</li>
        <li><b>Discover (10 min):</b> on the <a href="#fingerprint">fingerprint</a>, find water and carbon dioxide. Explain: each gas glows at its own infrared colour.</li>
        <li><b>Check (10 min):</b> everyone answers the quiz above.</li>
        <li><b>Discuss (5 min):</b> How can sound help blind scientists? What else could SPHEREx discover?</li>
      </ol>
      <p><b>You need:</b> a projector or devices with a browser, and headphones if possible. Works offline once downloaded.</p>`,
    ms: `<p><b>Objektif:</b> murid dapat menerangkan mengapa objek berdekatan bergerak berbanding bintang, menghuraikan cahaya inframerah, dan mengenal pasti gas daripada spektrum.</p>
      <ol>
        <li><b>Set induksi (5 minit):</b> padamkan lampu. Mainkan <a href="#listen">lawatan dengar</a> dengan mata tertutup. Tanya: "Apa yang bergerak? Ke arah mana?"</li>
        <li><b>Lihat (10 minit):</b> secara berpasangan, guna <a href="#blink">pemapar kelip</a> dan main <a href="#spot">Spot it</a>. Bincangkan mengapa bintang kekal diam (jarak).</li>
        <li><b>Teroka (10 minit):</b> pada <a href="#fingerprint">cap jari</a>, cari air dan karbon dioksida. Terangkan: setiap gas bercahaya pada warna inframerahnya sendiri.</li>
        <li><b>Semak (10 minit):</b> semua murid menjawab kuiz di atas.</li>
        <li><b>Bincang (5 minit):</b> Bagaimanakah bunyi boleh membantu saintis buta? Apa lagi yang boleh ditemui SPHEREx?</li>
      </ol>
      <p><b>Keperluan:</b> projektor atau peranti dengan pelayar web, dan fon kepala jika ada. Boleh digunakan tanpa internet selepas dimuat turun.</p>`,
  };

  const quiz = { order: [], i: 0, score: 0, answered: null, opts: [], lastSet: [] };

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function newQuizRound() {
    // prefer questions not used in the last round
    const all = QUIZ_BANK.map((_, i) => i);
    const fresh = shuffle(all.filter((i) => !quiz.lastSet.includes(i)));
    const pick = fresh.concat(shuffle(quiz.lastSet)).slice(0, ROUND_SIZE);
    quiz.order = pick; quiz.lastSet = pick;
    quiz.i = 0; quiz.score = 0;
    startQuestion();
  }
  function startQuestion() {
    quiz.answered = null;
    quiz.opts = shuffle([0, 1, 2]); // option 0 is the correct one in the bank
    renderQuiz();
  }
  function renderLearn() {
    const t = T[lang];
    document.querySelectorAll("[data-i18n]").forEach((el) => { const v = t[el.dataset.i18n]; el.textContent = typeof v === "function" ? v() : v; });
    document.querySelectorAll(".lang .btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === lang)));
    $("cards").innerHTML = CARDS.map((c) => {
      const [h, p, w] = c[lang];
      return `<article class="card" lang="${lang}"><h3>${h}</h3><p>${p}</p><p class="wow"><b>${t.wow}:</b> ${w}</p></article>`;
    }).join("");
    renderQuiz();
    $("teacherBody").innerHTML = TEACHER[lang];
  }

  function renderQuiz() {
    const t = T[lang];
    const box = $("quiz");
    if (quiz.i >= quiz.order.length) {
      const n = quiz.order.length, sc = quiz.score;
      const stars = sc === n ? "🌟🌟🌟" : sc >= n * 0.6 ? "🌟🌟" : "🌟";
      box.innerHTML = `<div class="q done" role="status"><p class="big-stars">${stars}</p>
        <h3>${t.score(sc, n)}</h3><p class="why">${sc === n ? t.perfect : sc >= n * 0.6 ? t.good : t.keep}</p>
        <button class="btn primary" id="quizAgain">${t.again}</button></div>`;
      $("quizAgain").onclick = () => newQuizRound();
      return;
    }
    const q = QUIZ_BANK[quiz.order[quiz.i]];
    const [question, opts, why] = q[lang];
    const ans = quiz.answered;
    box.innerHTML = `<div class="q" lang="${lang}">
        <div class="qhead"><span>${t.qnum(quiz.i + 1, quiz.order.length)}</span><span>⭐ ${quiz.score}</span></div>
        <div class="progress"><span style="width:${pct(quiz.i / quiz.order.length)}"></span></div>
        <h3>${question}</h3><div class="opts">` +
      quiz.opts.map((oi) => {
        let cls = "btn opt";
        if (ans !== null) { if (oi === 0) cls += " right"; else if (oi === ans) cls += " wrong"; }
        return `<button class="${cls}" data-o="${oi}" ${ans !== null ? "disabled" : ""}>${opts[oi]}</button>`;
      }).join("") + `</div>` +
      (ans !== null ? `<p class="why" role="status"><b>${ans === 0 ? t.correct : t.wrong}</b> ${why}</p>
        <button class="btn primary" id="quizNext">${quiz.i + 1 < quiz.order.length ? t.next : t.finish}</button>` : "") + `</div>`;
    box.querySelectorAll(".opt").forEach((b) => {
      b.onclick = () => {
        const oi = Number(b.dataset.o);
        quiz.answered = oi;
        if (oi === 0) quiz.score += 1;
        Sound.ensure();
        if (oi === 0) Sound.success(); else Sound.miss();
        renderQuiz();
        const nx = $("quizNext"); if (nx) nx.focus();
      };
    });
    const nx = $("quizNext");
    if (nx) nx.onclick = () => { quiz.i += 1; quiz.answered = null; quiz.opts = shuffle([0, 1, 2]); renderQuiz(); };
  }

  function initLearn() {
    document.querySelectorAll(".lang .btn").forEach((b) => { b.onclick = () => { lang = b.dataset.lang; renderLearn(); }; });
    quiz.order = []; // filled below
    newQuizRound();
    renderLearn();
  }

  /* ------------------------------------------------------------------ sky explorer (challenge targets) */
  const TARGETS = [...(Array.isArray(window.SKYBLINK_PLANETX) ? window.SKYBLINK_PLANETX : []),
    ...(Array.isArray(window.SKYBLINK_TARGETS) ? window.SKYBLINK_TARGETS : [])].filter((t) => t.frames && t.frames.length);
  const isPX = (t) => t && t.kind === "planetx";
  const kindLabel = (t) => isPX(t) ? "Planet X practice" : t.kind === "moving" ? "Moves" : "Changes brightness";
  const ex = { t: null, i: 0, timer: null, tour: null };

  function exShow(i, { sound = false } = {}) {
    const t = ex.t; if (!t) return;
    ex.i = (i + t.frames.length) % t.frames.length;
    const f = t.frames[ex.i];
    $("exImg").src = f.file;
    const m = $("exMarker");
    m.style.left = pct(f.fx); m.style.top = pct(f.fy); m.hidden = !$("exShowMarker").checked;
    m.classList.remove("hop"); void m.offsetWidth; m.classList.add("hop");
    drawTrail();
    $("exTag").textContent = isPX(t)
      ? `Image ${ex.i + 1}/${t.frames.length} · ${f.date_utc} · ${f.wl.toFixed(2)} µm`
      : `Visit ${f.visit + 1} · ${f.date_utc.slice(0, 10)} · ${f.wl.toFixed(2)} µm`;
    $("exDate").textContent = f.date_utc;
    $("exWl").textContent = `${f.wl.toFixed(2)} µm`;
    $("exSnr").textContent = f.snr === null ? "–" : `${Math.round(f.snr)} (${strengthWord(f.snr)})`;
    drawLc();
    if (sound) exPlayFrame(f);
  }

  /* glowing path showing where the target has been so far */
  function drawTrail() {
    const t = ex.t, svg = $("exTrail");
    if (!t || t.kind === "variable" || !$("exShowMarker").checked) { svg.innerHTML = ""; return; }
    const pts = t.frames.slice(0, ex.i + 1);
    const line = pts.map((f) => `${(f.fx * 100).toFixed(2)},${(f.fy * 100).toFixed(2)}`).join(" ");
    svg.innerHTML = (pts.length > 1 ? `<polyline points="${line}" class="trail-line"/>` : "") +
      pts.map((f, k) => `<circle cx="${f.fx * 100}" cy="${f.fy * 100}" r="${k === pts.length - 1 ? 1.1 : 0.7}" class="trail-dot" style="opacity:${0.35 + 0.65 * (k + 1) / pts.length}"/>`).join("");
  }

  function exPlayFrame(f) {
    const maxF = Math.max(1e-9, ...ex.t.frames.map((q) => Math.abs(q.flux || 0)));
    Sound.chime({
      freq: 262 * Math.pow(2, 2 * (1 - f.fy)),
      pan: (f.fx * 2 - 1) * 0.95,
      vol: 0.08 + 0.5 * Math.min(1, Math.abs(f.flux || 0) / maxF),
      type: ex.t.kind === "variable" ? "sine" : "triangle",
    });
  }

  function exMoveText(t) {
    const days = (t.frames[t.frames.length - 1].mjd - t.frames[0].mjd);
    if (isPX(t)) return `${(t.shift_arcsec / 60).toFixed(1)}′ in ${days.toFixed(1)} days ≈ ${Math.round(t.shift_px)} SPHEREx pixels`;
    if (t.kind !== "moving") return "Stays in place (brightness changes instead)";
    return `${t.shift_arcsec.toFixed(1)}″ in ${Math.round(days)} days ≈ ${t.shift_px.toFixed(1)} SPHEREx pixels`;
  }

  function selectTarget(id) {
    ex.t = TARGETS.find((t) => t.id === id);
    exStop();
    document.querySelectorAll(".tbtn").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.id === id)));
    const t = ex.t;
    $("exName").textContent = t.name;
    $("exType").textContent = t.type;
    $("exDesc").textContent = t.desc;
    $("exMove").textContent = exMoveText(t);
    $("exCaption").textContent = isPX(t)
      ? `Image: NASA SPHEREx via NASA/IPAC IRSA, processed by SKY BLINK. North up, ${(t.size_deg * 60).toFixed(0)} arcminutes wide. ` +
        `${t.frames.length} images from one SPHEREx visit, ${(t.frames[t.frames.length - 1].mjd - t.frames[0].mjd).toFixed(1)} days apart in total, near ${t.ref_wl} µm. ` +
        `The circle marks where NASA JPL Horizons predicts ${t.name} in each image.`
      : `Image: NASA SPHEREx via NASA/IPAC IRSA, processed by SKY BLINK. North up, ${(t.size_deg * 60).toFixed(0)} arcminutes wide. ` +
      `${t.frames.length} visits shown, chosen near ${t.ref_wl} µm. Shared brightness scale, so brightness changes are real. ` +
      `The circle marks where ${t.position_source || "SIMBAD"} predicts the target at each visit.`;
    $("exDiff").hidden = true; $("exShowDiff").checked = false;
    $("exShowDiff").disabled = !t.diff;
    if (t.diff) $("exDiff").src = t.diff;
    t.frames.forEach((f) => { const im = new Image(); im.src = f.file; });
    exShow(0);
    $("pxCalc").hidden = !isPX(t);
    $("pxExplain").hidden = !isPX(t);
    if (isPX(t)) requestAnimationFrame(drawOrbit);
    $("exLive").textContent = isPX(t)
      ? `Press Blink: every star stays still, but ${t.name} walks across the picture. That is how a hidden Planet X would give itself away.`
      : t.kind === "moving"
      ? "Press Blink and watch the circle: the target creeps against the still background stars."
      : "Press Blink or Listen: this star changes brightness between visits.";
  }

  function exStop() {
    if (ex.tour) stopSpeech();
    clearInterval(ex.timer); ex.timer = null;
    clearTimeout(ex.tour); ex.tour = null;
    $("exPlay").textContent = "▶ Blink"; $("exPlay").setAttribute("aria-pressed", "false");
    $("exStage").classList.remove("scanning");
    $("exListen").textContent = "🎧 Listen";
  }

  function exListen() {
    if (ex.tour) { exStop(); return; }
    Sound.ensure();
    exStop();
    $("exListen").textContent = "■ Stop";
    $("exStage").classList.add("scanning");
    const t = ex.t; let i = 0;
    const talk = $("speakOn") && $("speakOn").checked;
    const step = () => {
      if (i >= t.frames.length) {
        const a = t.frames[0], b = t.frames[t.frames.length - 1];
        const ch = a.flux && b.flux ? Math.round((b.flux / a.flux - 1) * 100) : null;
        const end = isPX(t)
          ? `${t.name} moved ${(t.shift_arcsec / 60).toFixed(1)} arcminutes in ${(b.mjd - a.mjd).toFixed(1)} days, while the stars stayed still.`
          : t.kind === "moving"
          ? `${t.name} moved ${t.shift_arcsec.toFixed(1)} arcseconds between the first and last visit.`
          : (ch !== null ? `${t.name} was ${Math.abs(ch)} percent ${ch >= 0 ? "brighter" : "dimmer"} at the last visit than the first.` : "Done.");
        exStop();
        $("exLive").textContent = end; if (talk) speak(end);
        return;
      }
      const f = t.frames[i], prev = i ? t.frames[i - 1] : null;
      exShow(i); exPlayFrame(f);
      let txt = isPX(t)
        ? `Image ${i + 1} of ${t.frames.length}, ${f.date_utc.slice(0, 10)}. ${t.name} is ${f.fx < 0.34 ? "on the left" : f.fx > 0.66 ? "on the right" : "in the middle"}${f.fy < 0.34 ? ", near the top" : f.fy > 0.66 ? ", near the bottom" : ""}.`
        : `Visit ${i + 1} of ${t.frames.length}, ${f.date_utc.slice(0, 10)}.`;
      if (!isPX(t) && prev && prev.flux && f.flux) {
        const c = Math.round((f.flux / prev.flux - 1) * 100);
        txt += Math.abs(c) < 5 ? " About the same brightness." : ` ${Math.abs(c)} percent ${c > 0 ? "brighter" : "dimmer"}.`;
      }
      $("exLive").textContent = txt;
      i += 1;
      if (talk) ex.tour = setTimeout(() => { if (ex.tour) ex.tour = sayThen(txt, () => !!ex.tour, step); }, 400);
      else ex.tour = setTimeout(step, 1500);
    };
    ex.tour = setTimeout(step, 50);
  }

  function drawLc() {
    const t = ex.t, c = $("exLc");
    if (!t || !t.points || !t.points.length) { $("exLcWrap").hidden = true; return; }
    $("exLcWrap").hidden = false;
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (!w) return;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const pts = t.points.filter((p) => p.snr !== null);
    const pad = { l: 48, r: 14, t: 14, b: 34 };
    const x0 = Math.min(...pts.map((p) => p.mjd)), x1 = Math.max(...pts.map((p) => p.mjd));
    const ys = pts.map((p) => p.snr), y1 = Math.max(10, ...ys) * 1.1;
    const X = (m) => pad.l + (x1 > x0 ? (m - x0) / (x1 - x0) : 0.5) * (w - pad.l - pad.r);
    const Y = (v) => h - pad.b - (Math.max(0, v) / y1) * (h - pad.t - pad.b);
    g.font = "12px system-ui, sans-serif"; g.strokeStyle = "#262d48"; g.fillStyle = "#a3abc6";
    const step = niceStep(y1);
    g.textAlign = "right"; g.textBaseline = "middle";
    for (let v = 0; v <= y1; v += step) { g.beginPath(); g.moveTo(pad.l, Y(v)); g.lineTo(w - pad.r, Y(v)); g.stroke(); g.fillText(String(Math.round(v)), pad.l - 6, Y(v)); }
    g.textAlign = "center"; g.textBaseline = "top";
    const visits = [...new Set(pts.map((p) => p.visit))];
    visits.forEach((v) => {
      const vp = pts.filter((p) => p.visit === v);
      const mx = vp.reduce((s, p) => s + p.mjd, 0) / vp.length;
      const lx = Math.min(Math.max(X(mx), pad.l + 60), w - pad.r - 60);
      g.fillText(`Visit ${v + 1} · ${vp[0].date_utc.slice(0, 7)}`, lx, h - pad.b + 8);
    });
    pts.forEach((p) => { g.fillStyle = wlColour(p.wl); g.beginPath(); g.arc(X(p.mjd), Y(p.snr), 4, 0, Math.PI * 2); g.fill(); });
    const f = t.frames[ex.i];
    if (f && f.snr !== null) { g.strokeStyle = "#fff"; g.lineWidth = 2; g.beginPath(); g.arc(X(f.mjd), Y(f.snr), 8, 0, Math.PI * 2); g.stroke(); }
  }

  /* Planet X Hunter calculator: apparent drift caused by Earth's own motion.
     Earth moves 29.8 km/s ≈ 2.575 million km a day; seen from d AU that is about 3550/d arcseconds a day. */
  function pxNumbers(d) {
    const arcsecDay = 3550 / d, pxDay = arcsecDay / 6.15;
    // reflected sunlight falls as size² / distance⁴; compare with Pluto (1188 km, ~35 AU), for a world 5× Earth's width
    const fainter = 1 / (Math.pow(5 * 6371 / 1188, 2) * Math.pow(35 / d, 4));
    return { arcsecDay, pxDay, week: pxDay * 7, fainter };
  }
  function pxRender() {
    const d = +$("pxDist").value, n = pxNumbers(d);
    $("pxDistOut").textContent = d;
    const f = n.fainter < 1 ? `${Math.round(1 / n.fainter)}× brighter` : `about ${n.fainter < 10 ? n.fainter.toFixed(1) : Math.round(n.fainter).toLocaleString("en")}× fainter`;
    $("pxOut").innerHTML = `Drifts about <b>${n.arcsecDay.toFixed(0)}″ a day</b> = <b>${n.pxDay.toFixed(1)} SPHEREx pixels a day</b>, ` +
      `so <b>${n.week.toFixed(0)} pixels</b> during one week-long SPHEREx visit. ` +
      (n.week >= 2 ? "A blink like the one above would catch it moving. " : "Too slow to see in one visit: you would compare visits six months apart. ") +
      `If it were 5× Earth's width, it would look ${f} than Pluto.`;
  }
  /* Orbit animation: Earth circles the Sun; the line of sight from Earth through the far planet
     hits the distant stars at a point that slides back and forth. Farther planet = smaller slide. */
  const orbit = { a: 0, raf: 0, visible: false };
  function drawOrbit() {
    const c = $("pxOrbit"); if (!c) return;
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (!w) return;
    if (c.width !== Math.round(w * dpr)) { c.width = w * dpr; c.height = h * dpr; }
    const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const d = +$("pxDist").value;
    const sunX = w * 0.5, sunY = h * 0.8, rE = Math.min(w * 0.12, 46);
    // the planet sits straight "up"; its drawn distance grows slowly with real distance
    const py = sunY - rE - (h * 0.42) * (Math.log(d / 20) / Math.log(1000 / 20));
    const starY = 26;
    // background stars
    for (let k = 0; k < 70; k++) {
      const r1 = Math.abs(Math.sin(k * 12.9898) * 43758.5453) % 1, r2 = Math.abs(Math.sin(k * 78.233) * 12345.678) % 1;
      const x = r1 * w, y = 6 + r2 * 34;
      g.fillStyle = `rgba(220,230,255,${0.25 + (k % 5) / 8})`; g.fillRect(x, y, 1.6, 1.6);
    }
    g.fillStyle = "#a3abc6"; g.font = "12px system-ui, sans-serif"; g.textAlign = "left";
    g.fillText("far-away stars", 8, starY + 22);
    // Earth's orbit + Sun
    g.strokeStyle = "rgba(110,168,255,.35)"; g.lineWidth = 1; g.setLineDash([3, 4]);
    g.beginPath(); g.arc(sunX, sunY, rE, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    const sg = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, 16);
    sg.addColorStop(0, "#fff6c8"); sg.addColorStop(1, "rgba(255,190,80,0)");
    g.fillStyle = sg; g.beginPath(); g.arc(sunX, sunY, 16, 0, Math.PI * 2); g.fill();
    const ex_ = sunX + rE * Math.cos(orbit.a), ey = sunY + rE * Math.sin(orbit.a) * 0.55;
    // planet
    g.fillStyle = "#ff7ad9"; g.beginPath(); g.arc(sunX, py, 5, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#ffd3f2"; g.textAlign = "center"; g.fillText(`Planet X · ${d} AU`, sunX, py + 18);
    // line of sight from Earth through planet up to the star layer
    const t = (starY - ey) / (py - ey), hitX = ex_ + (sunX - ex_) * t;
    g.strokeStyle = "rgba(255,122,217,.55)"; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(ex_, ey); g.lineTo(hitX, starY); g.stroke();
    // where the planet appears against the stars
    g.fillStyle = "#ff7ad9"; g.beginPath(); g.arc(hitX, starY, 4, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "rgba(255,122,217,.5)"; g.beginPath(); g.arc(hitX, starY, 8, 0, Math.PI * 2); g.stroke();
    // Earth
    g.fillStyle = "#6ea8ff"; g.beginPath(); g.arc(ex_, ey, 6, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#cfe0ff"; g.fillText("Earth", ex_, ey + 20);
    g.fillStyle = "#fff6c8"; g.fillText("Sun", sunX, sunY + 30);
  }
  function orbitLoop() {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce && orbit.visible && !$("pxCalc").hidden) orbit.a += 0.012;
    drawOrbit();
    orbit.raf = reduce ? 0 : requestAnimationFrame(orbitLoop);
  }

  function initPxCalc() {
    if (!$("pxDist")) return;
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((es) => es.forEach((e) => { orbit.visible = e.isIntersecting; }), { threshold: 0.05 }).observe($("pxCalc"));
    } else orbit.visible = true;
    orbitLoop();
    $("pxDist").addEventListener("input", drawOrbit);
    $("pxDist").oninput = pxRender;
    $("pxHear").onclick = () => {
      Sound.ensure();
      const n = pxNumbers(+$("pxDist").value), span = Math.min(0.95, n.week / 40); // wide sweep = fast drift
      for (let k = 0; k < 8; k++) {
        Sound.chime({ freq: 440, pan: -span + (2 * span * k) / 7, vol: 0.25, dur: 0.35, delay: k * 0.28 });
      }
      $("exLive").textContent = `Listen: the sound moves ${span > 0.5 ? "far" : span > 0.1 ? "a little" : "hardly at all"} from left to right, like the planet's drift in one week.`;
    };
    pxRender();
  }

  function initExplorer() {
    if (!TARGETS.length) { $("exEmpty").hidden = false; return; }
    $("targetList").innerHTML = TARGETS.map((t) =>
      `<button class="tbtn" role="tab" data-id="${t.id}" aria-selected="false"><span class="tag ${t.kind}">${kindLabel(t)}</span><b>${esc(t.name)}</b><small>${esc(t.type.split("·")[0])}</small></button>`).join("") +
      `<a class="tbtn" href="#blink"><span class="tag">Showcase</span><b>3I/ATLAS</b><small>Interstellar comet</small></a>`;
    document.querySelectorAll(".tbtn[data-id]").forEach((b) => { b.onclick = () => selectTarget(b.dataset.id); });
    $("exViewer").hidden = false;
    $("exPrev").onclick = () => { exStop(); exShow(ex.i - 1, { sound: true }); };
    $("exNext").onclick = () => { exStop(); exShow(ex.i + 1, { sound: true }); };
    $("exPlay").onclick = () => {
      if (ex.timer) { exStop(); return; }
      exStop();
      $("exPlay").textContent = "❚❚ Stop"; $("exPlay").setAttribute("aria-pressed", "true");
      $("exStage").classList.add("scanning");
      ex.timer = setInterval(() => exShow(ex.i + 1), 700);
    };
    $("exListen").onclick = exListen;
    $("exShowMarker").onchange = () => exShow(ex.i);
    $("exShowDiff").onchange = (e) => { $("exDiff").hidden = !e.target.checked; };
    window.addEventListener("resize", drawLc);
    initPxCalc();
    selectTarget(TARGETS[0].id);
  }

  /* ------------------------------------------------------------------ animations */
  function initIntro() {
    const intro = $("intro");
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let seen = false;
    try { seen = sessionStorage.getItem("skyblinkIntro") === "1"; } catch (e) {}
    if (reduce || seen || location.hash) return;
    intro.hidden = false;
    const close = () => {
      intro.classList.add("out");
      try { sessionStorage.setItem("skyblinkIntro", "1"); } catch (e) {}
      setTimeout(() => { intro.hidden = true; }, 800);
      document.removeEventListener("keydown", close);
    };
    $("introSkip").onclick = close;
    intro.addEventListener("click", close);
    document.addEventListener("keydown", close);
    setTimeout(close, 3600);
  }
  /* highlight the menu item of the section on screen */
  function initNavSpy() {
    const links = [...document.querySelectorAll(".topbar nav a")];
    const map = { fingerprint: "blink" }; // fingerprint is part 2 of the comet case study
    if (!("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const id = map[e.target.id] || e.target.id;
        links.forEach((l) => l.classList.toggle("active", l.getAttribute("href") === "#" + id));
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    document.querySelectorAll("main section[id]").forEach((s) => io.observe(s));
  }

  function initReveal() {
    const els = document.querySelectorAll(".panel-head, .target-list, .viewer, .game, .listen-grid, .rules, .fp, .flow, .limits, .cards, .quiz, .teacher, .about-grid");
    if (!("IntersectionObserver" in window)) return;
    els.forEach((el) => el.classList.add("reveal"));
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { threshold: 0.08 });
    els.forEach((el) => io.observe(el));
  }

  /* ------------------------------------------------------------------ start */
  initIntro();
  initReveal();
  initNavSpy();
  initSoundbox();
  initHero();
  initExplorer();
  initViewer();
  initGame();
  initListen();
  initSonar();
  initFingerprint();
  initFlow();
  initLearn();
})();
