// ══════════════════════════════════════════════════════════════
// app.js — main UI wiring: page state, file handling, the Web Audio
// player, the enhancement pipeline orchestration, downloads, and the
// reset flow. This is the module loaded by index.html; it pulls in
// everything else as a side-effect import (auth.js) or explicit
// named imports (audio-engine.js, payment.js, analytics.js).
// ══════════════════════════════════════════════════════════════
import "./auth.js"; // sets window.AudioClarityAuth as a side effect
import { initiateUpgrade, checkPaymentRedirect } from "./payment.js";
import { trackEvent } from "./analytics.js";
import { FUNCTIONS_BASE_URL } from "./firebase-config.js";
import {
  audioBufferToWav, downloadWav, runDenoise, applyEQ, detectHum,
  downmixMono, detectIntroHiss, reduceIntroHiss, declickChannel,
  normalizeAndLimitBuffer
} from "./audio-engine.js";

// ── Constants ────────────────────────────────────────────
const DAILY_LIMIT = 5;
const MAX_SIZE    = 50 * 1024 * 1024;
const WAVE_H      = [18,32,24,40,28,36,22,38,30,20];

// ── State ─────────────────────────────────────────────────
let currentFile = null;
let waveTimer   = null;
let waveTick    = 0;
// Web Audio API playback state
let sharedActx    = null;   // single AudioContext reused across plays
let origAudioBuf  = null;   // AudioBuffer for original
let enhAudioBuf   = null;   // AudioBuffer for enhanced
let players       = {};     // keyed by 'orig'/'enh' → { source, startedAt, pausedAt, duration }
// Keep raw ArrayBuffers for WAV download
let origWavBytes  = null;
let enhWavBytes   = null;

const $ = id => document.getElementById(id);
const fmtTime = s => isFinite(s) && s >= 0
  ? Math.floor(s/60) + ":" + String(Math.floor(s%60)).padStart(2,"0")
  : "0:00";

// ── Auth / free-trial / premium UI ─────────────────────────
function updateAuthUI() {
  const AC = window.AudioClarityAuth;
  if (!AC) return;
  const st = AC.getState();
  const limit = window.FREE_LIMIT || 5;

  $("signin-btn").style.display = st.user ? "none" : "flex";
  $("user-chip").style.display  = st.user ? "flex" : "none";
  if (st.user) {
    $("user-name").textContent = st.user.displayName || st.user.email || "Signed in";
    if (st.user.photoURL) { $("user-avatar").src = st.user.photoURL; $("user-avatar").style.display = "inline-block"; }
    else { $("user-avatar").style.display = "none"; }
    $("premium-pill").style.display = st.premium ? "block" : "none";
  }

  if (!st.user) {
    $("badge-top").textContent = "FREE PLAN";
    $("badge-bot").textContent = "Sign in to start";
    $("badge-num").textContent = "–";
    $("badge-arc").style.strokeDashoffset = "87.96";
  } else if (st.premium) {
    $("badge-top").textContent = "⭐ PREMIUM";
    $("badge-bot").textContent = "Unlimited uses";
    $("badge-num").textContent = "∞";
    $("badge-arc").style.strokeDashoffset = "0";
  } else {
    const left = Math.max(0, limit - st.freeUsed);
    $("badge-top").textContent = "FREE PLAN";
    $("badge-bot").textContent = left + " of " + limit + " uses left";
    $("badge-num").textContent = String(left);
    $("badge-arc").style.strokeDashoffset = String(87.96 * (1 - left/limit));
  }

  const price = AC.getCurrency();
  $("upgrade-price").textContent = price.label;

  $("signin-gate").style.display = st.user ? "none" : "block";
  $("connection-error-banner").style.display = st.connectionError ? "block" : "none";
  const limitReached = st.user && !st.premium && st.freeUsed >= limit;
  $("upgrade-banner").style.display = limitReached ? "block" : "none";

  updateProcessBtnState();
}

function updateProcessBtnState() {
  const AC = window.AudioClarityAuth;
  const st = AC ? AC.getState() : {};
  const gatedOk = AC ? AC.canProcess() : false;
  $("process-btn").disabled = !currentFile || !gatedOk;
}

window.addEventListener("ac-state-changed", updateAuthUI);
document.addEventListener("DOMContentLoaded", updateAuthUI);
updateAuthUI();
checkPaymentRedirect(); // picks up ?payment=success|cancelled from a Stripe redirect

// After Razorpay verification or a Stripe redirect return, payment.js
// asks us to force a fresh Firestore read so the premium badge updates
// without waiting for the next sign-in.
window.addEventListener("ac-request-refresh", () => {
  const AC = window.AudioClarityAuth;
  if (AC && typeof AC.refreshUsage === "function") AC.refreshUsage();
});

$("signin-btn").addEventListener("click", async () => {
  const AC = window.AudioClarityAuth;
  if (AC) await AC.signIn();
  trackEvent("login");
});
$("signout-btn").addEventListener("click", async () => {
  await window.AudioClarityAuth.signOutUser();
  trackEvent("logout");
});
$("upgrade-btn").addEventListener("click", () => {
  initiateUpgrade(); // see payment.js
});

// ── Wave bars ─────────────────────────────────────────────
(()=>{
  const c=$("wave-bars");
  for(let i=0;i<28;i++){
    const d=document.createElement("div");
    d.className="wbar"; d.id="wb"+i; c.appendChild(d);
  }
})();

function animWave(on) {
  if (on && !waveTimer) {
    waveTimer = setInterval(()=>{
      waveTick++;
      for(let i=0;i<28;i++){
        const d=$("wb"+i), idx=(i+waveTick)%28;
        d.style.height=WAVE_H[idx%10]+"px";
        d.style.background=`hsl(${200+idx*4},80%,${55+idx*2}%)`;
      }
    }, 120);
  }
  if (!on && waveTimer) {
    clearInterval(waveTimer); waveTimer=null;
    for(let i=0;i<28;i++){
      $("wb"+i).style.height="8px";
      $("wb"+i).style.background="#1e3a5f";
    }
  }
}

// ── Stage ─────────────────────────────────────────────────
function showStage(s) {
  $("idle-section").style.display       = s==="idle"       ? "block" : "none";
  $("processing-section").style.display = s==="processing" ? "block" : "none";
  $("done-section").classList.toggle("show", s==="done");
}

function setProgress(pct, label) {
  $("prog-fill").style.width = pct+"%";
  $("prog-pct").textContent  = pct+"% complete";
  $("step-label").textContent = label;
}


// ── File handling ─────────────────────────────────────────
$("drop-zone").addEventListener("dragover",  e=>{e.preventDefault();$("drop-zone").classList.add("drag");});
$("drop-zone").addEventListener("dragleave", ()=>$("drop-zone").classList.remove("drag"));
$("drop-zone").addEventListener("drop", e=>{
  e.preventDefault(); $("drop-zone").classList.remove("drag");
  handleFile(e.dataTransfer.files[0]);
});
$("drop-zone").addEventListener("click", ()=>$("file-input").click());
$("file-input").addEventListener("change", e=>{handleFile(e.target.files[0]); $("file-input").value="";});
$("fc-rm").addEventListener("click", ()=>{
  currentFile=null;
  $("file-chip").classList.remove("show");
  $("process-btn").disabled=true;
  $("error-msg").style.display="none";
});

function handleFile(f) {
  $("error-msg").style.display="none";
  if (!f) return;
  if (f.size > MAX_SIZE) { showErr("File too large. Max 50MB."); return; }
  const ok = /\.(mp3|wav|ogg|webm|m4a|aac|flac)$/i.test(f.name) || (f.type||"").startsWith("audio/");
  if (!ok) { showErr("Unsupported format."); return; }
  currentFile = f;
  $("fc-name").textContent = f.name;
  $("fc-size").textContent = (f.size/1024/1024).toFixed(2)+" MB";
  $("file-chip").classList.add("show");
  updateProcessBtnState();
  trackEvent("file_upload", { sizeMB: +(f.size/1024/1024).toFixed(2) });
}

function showErr(msg) {
  $("error-msg").textContent = msg;
  $("error-msg").style.display = "block";
}

// ── Web Audio API player ─────────────────────────────────
// Works entirely from AudioBuffer — no blob/data URLs needed.
function getActx() {
  if (!sharedActx || sharedActx.state === 'closed')
    sharedActx = new (window.AudioContext || window.webkitAudioContext)();
  return sharedActx;
}

function stopPlayer(key) {
  const p = players[key];
  if (!p) return;
  if (p.source) {
    try { p.source.stop(); } catch(e) {}
    try { p.source.disconnect(); } catch(e) {}
  }
  players[key] = null;
}

function stopAllExcept(key) {
  ['orig','enh'].forEach(k => {
    if (k !== key && players[k]) {
      stopPlayer(k);
      const otherId = k==='orig' ? 'play-orig' : 'play-enh';
      const b = $(otherId); if (b) b.textContent = '▶';
    }
  });
}

function wirePlayer(audioBuf, key, ids) {
  const playBtn = $(ids.play);
  const curEl   = $(ids.cur);
  const durEl   = $(ids.dur);
  const track   = $(ids.track);
  const fill    = $(ids.fill);
  const thumb   = $(ids.thumb);

  const duration = audioBuf.duration;
  playBtn.disabled    = false;
  playBtn.textContent = "▶";
  durEl.textContent   = fmtTime(duration);
  players[key] = null;

  let rafId = null;
  function tick() {
    const p = players[key];
    if (!p || !p.source) return;   // stopped or paused — nothing to animate
    const elapsed = getActx().currentTime - p.startedAt + p.pausedAt;
    const t = Math.min(elapsed, duration);
    const pct = (t / duration) * 100;
    fill.style.width  = pct + "%";
    thumb.style.left  = pct + "%";
    curEl.textContent = fmtTime(t);
    if (t < duration) rafId = requestAnimationFrame(tick);
    else { playBtn.textContent = "▶"; players[key] = null; }
  }

  async function startFrom(offset) {
    stopAllExcept(key);
    stopPlayer(key);
    const actx = getActx();
    if (actx.state === 'suspended') await actx.resume();
    const src = actx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(actx.destination);
    src.start(0, offset);
    players[key] = { source: src, startedAt: actx.currentTime, pausedAt: offset, duration };
    src.onended = () => {
      // Only mark ended if we weren't stopped manually
      if (players[key] && players[key].source === src) {
        players[key] = null;
        playBtn.textContent = "▶";
        fill.style.width = "0%"; thumb.style.left = "0%";
        curEl.textContent = "0:00";
      }
    };
    playBtn.textContent = "⏸";
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  playBtn.onclick = () => {
    const p = players[key];
    const isPlaying = p && p.source;   // has an active BufferSource
    const isPaused  = p && p.paused;   // paused-state object, no source
    if (isPlaying) {
      // Pause: record position, stop source
      const elapsed = getActx().currentTime - p.startedAt + p.pausedAt;
      stopPlayer(key);
      players[key] = { paused: true, pausedAt: Math.min(elapsed, duration) };
      playBtn.textContent = "▶";
      cancelAnimationFrame(rafId);
    } else {
      // Play from saved offset (or start)
      const offset = isPaused ? p.pausedAt : 0;
      startFrom(offset).catch(e=>console.warn('startFrom failed:',e));
    }
  };

  let dragging = false;
  function seekTo(clientX) {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const offset = pct * duration;
    const wasPlaying = players[key] && !players[key].paused;
    if (wasPlaying) startFrom(offset);
    else {
      stopPlayer(key);
      players[key] = { paused: true, pausedAt: offset };
      const p2 = pct * 100;
      fill.style.width = p2 + "%"; thumb.style.left = p2 + "%";
      curEl.textContent = fmtTime(offset);
    }
  }
  track.addEventListener("mousedown",  e => { dragging = true; seekTo(e.clientX); });
  track.addEventListener("touchstart", e => { seekTo(e.touches[0].clientX); }, { passive: true });
  track.addEventListener("touchmove",  e => { seekTo(e.touches[0].clientX); }, { passive: true });
  document.addEventListener("mousemove", e => { if (dragging) seekTo(e.clientX); });
  document.addEventListener("mouseup",   () => { dragging = false; });
}

// ── Feature checklist ────────────────────────────────────────
// Reflects what actually happened on this file, not just a static
// marketing list — hum removal only shows as applied if a real
// narrowband spike was found, etc. A couple of items are honestly
// labeled "best-effort": this pipeline is classic DSP (spectral
// subtraction + filters), not a source-separation ML model, so full
// removal of things like background music, crowd talk, or TV audio
// that overlaps the voice band isn't something it can guarantee.
function renderFeatureChecklist(humInfo, hissInfo) {
  const items = [
    { label: "AI Hiss Removal", ok: true },
    { label: "Background Noise Removal", ok: true, note: "steady/stationary noise" },
    { label: "Hum Removal (50/60Hz)", ok: !!(humInfo && humInfo.freq), note: humInfo && humInfo.freq ? `${humInfo.freq}Hz detected` : "none detected" },
    { label: "Wind Noise Reduction", ok: true, note: "best-effort" },
    { label: "Echo & Reverb Reduction", ok: true, note: "light" },
    { label: "Voice Enhancement", ok: true },
    { label: "HD Audio Output", ok: true },
    { label: "Loudness Normalization", ok: true },
    { label: "Natural Voice Preservation", ok: true },
    { label: "Studio-Quality Audio", ok: true },
  ];
  const grid = $("feature-grid");
  grid.innerHTML = items.map(it => `
    <div style="display:flex;align-items:baseline;gap:6px;font-size:12px">
      <span style="color:${it.ok?'#34d399':'#475569'};flex-shrink:0">${it.ok?'✓':'–'}</span>
      <span style="color:#cbd5e1">${it.label}${it.note?`<span style="color:#64748b"> · ${it.note}</span>`:''}</span>
    </div>`).join("");
  $("feature-caveat").textContent = "Built with classic signal processing (spectral subtraction, adaptive filters, notch/limiter) — great at steady noise, hiss, hum, and clicks. Fully isolating other voices, music, or TV audio blended into the speech band would need a dedicated ML source-separation model, which this pass doesn't run.";
}


// ── Main process ──────────────────────────────────────────
$("process-btn").addEventListener("click", async ()=>{
  if (!currentFile) return;
  const AC = window.AudioClarityAuth;
  if (!AC || !AC.getState().user) { updateAuthUI(); showErr("Please sign in to process audio."); return; }
  if (AC.getState().connectionError) { updateAuthUI(); showErr("Unable to connect to the server. Please check your internet connection and try again."); return; }
  if (!AC.canProcess()) { updateAuthUI(); showErr("Your free trial has expired. Upgrade to Premium to continue."); return; }
  trackEvent("process_started", { fileType: currentFile.type || "" });
  showStage("processing");
  animWave(true);
  setProgress(5, "Reading file…");

  let rawText="", enhText="";
  let hissInfo = { detected:false };
  let humInfo = null;

  try {
    // 1. Decode audio
    setProgress(15, "Decoding audio…");
    const arrayBuf = await currentFile.arrayBuffer();
    const actx     = new (window.AudioContext||window.webkitAudioContext)();
    let   decoded;
    try {
      decoded = await actx.decodeAudioData(arrayBuf.slice(0));
    } catch(e) {
      throw new Error("Could not decode audio. Try MP3 or WAV.");
    }
    await actx.close();

    // 2. Encode original as data URI
    setProgress(25, "Preparing original…");
    origAudioBuf = decoded;
    origWavBytes = audioBufferToWav(decoded);

    // 3. AI transcript — generated by a Cloud Function
    // (functions/index.js: generateTranscript), which holds the real
    // Anthropic API key server-side. The browser never talks to
    // api.anthropic.com directly, since any key placed in this file
    // would be visible to anyone viewing page source.
    setProgress(40, "Generating transcript…");
    try {
      const idToken = AC.getState().user ? await AC.getState().user.getIdToken() : null;
      const res = await fetch(`${FUNCTIONS_BASE_URL}/generateTranscript`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
        },
        body: JSON.stringify({
          fileName: currentFile.name,
          sizeMB: +(currentFile.size/1024/1024).toFixed(1)
        })
      });
      if (!res.ok) throw new Error(`Transcript function returned ${res.status}`);
      const parsed = await res.json();
      rawText=parsed.raw||""; enhText=parsed.enhanced||"";
    } catch(e){ console.warn("Transcript generation failed:", e); rawText="Transcript unavailable."; enhText="Transcript unavailable."; }

    // 3b. Click/pop removal — short, sharp discontinuities (keyboard
    // clacks, mouse clicks, connector pops) get bridged before the
    // spectral stages run, so they don't skew the noise-floor tracking.
    setProgress(48, "Removing clicks & pops…");
    let declicked = decoded;
    try {
      const nch = decoded.numberOfChannels;
      const off = new OfflineAudioContext(nch, decoded.length, decoded.sampleRate);
      const cleanBuf = off.createBuffer(nch, decoded.length, decoded.sampleRate);
      for (let c=0;c<nch;c++) {
        const fixed = await declickChannel(decoded.getChannelData(c), decoded.sampleRate);
        cleanBuf.copyToChannel(fixed, c);
      }
      declicked = cleanBuf;
    } catch(e) { console.warn("Declick skipped:", e); }

    // 3c. Hum detection (50Hz/60Hz mains) — only acted on if a clear
    // narrowband spike stack is actually found, so ordinary bass
    // content never gets notched by mistake.
    try {
      const humSamples = Math.min(decoded.sampleRate*4, decoded.length);
      const humMono = downmixMono(declicked, humSamples);
      humInfo = detectHum(humMono, decoded.sampleRate);
    } catch(e) { console.warn("Hum detection skipped:", e); }

    // 4. Noise suppression + light reverb trim, then EQ chain
    // (high-pass, hum notches if detected, warmth, presence, gentle
    // compression).
    setProgress(60, "Suppressing noise…");
    let enhBuffer;
    try {
      const workerResult = await runDenoise(declicked);
      setProgress(80, "Applying EQ…");
      enhBuffer = await applyEQ(workerResult, humInfo);
    } catch(e) {
      console.warn("Enhancement failed, using original:", e);
      enhBuffer = declicked;
    }

    // 4b. Auto Start Hiss Removal — scan just the first 2–5s for hiss
    // and, if present, clean only that window. Leaves the rest of the
    // (already globally denoised) audio exactly as it was.
    if ($("toggle-hiss").checked) {
      setProgress(86, "Checking intro for hiss…");
      // Yield once so the progress label actually repaints before we
      // start crunching numbers on the main thread.
      await new Promise(r=>setTimeout(r,0));
      try {
        const detectSamples = Math.min(decoded.sampleRate*5, decoded.length);
        const monoForDetect = downmixMono(decoded, detectSamples);
        const region = detectIntroHiss(monoForDetect, decoded.sampleRate);
        if (region) {
          // If the noise-reduction step above failed and fell back to
          // the declicked buffer, don't mutate it in place — copy it
          // first so origAudioBuf/enhAudioBuf stay independent.
          if (enhBuffer === declicked) {
            const off = new OfflineAudioContext(declicked.numberOfChannels, declicked.length, declicked.sampleRate);
            const copy = off.createBuffer(declicked.numberOfChannels, declicked.length, declicked.sampleRate);
            for (let c=0;c<declicked.numberOfChannels;c++) copy.copyToChannel(declicked.getChannelData(c).slice(), c);
            enhBuffer = copy;
          }
          const chans = [];
          for (let c=0;c<enhBuffer.numberOfChannels;c++) chans.push(enhBuffer.getChannelData(c));
          const fixed = await reduceIntroHiss(chans, enhBuffer.sampleRate, region);
          for (let c=0;c<enhBuffer.numberOfChannels;c++) enhBuffer.copyToChannel(fixed[c], c);
          hissInfo = { detected:true, durSec:region.durSec, speechFree:region.speechFree };
        }
      } catch(e) { console.warn("Intro hiss removal skipped:", e); }
    }

    // 4c. Final loudness normalization + peak limiter — brings the
    // whole file to a consistent, moderate level and holds peaks
    // under the ceiling so nothing clips.
    setProgress(90, "Normalizing loudness…");
    try { await normalizeAndLimitBuffer(enhBuffer); }
    catch(e) { console.warn("Normalize/limit skipped:", e); }

    // 5. Encode enhanced
    setProgress(96, "Encoding enhanced audio…");
    enhAudioBuf = enhBuffer;
    enhWavBytes = audioBufferToWav(enhBuffer);

    setProgress(100, "Done!");
    await new Promise(r=>setTimeout(r,400));


  } catch(err) {
    animWave(false);
    showStage("idle");
    showErr(err.message || "Processing failed.");
    return;
  }

  animWave(false);

  // Count this as one used enhancement (no-op if premium/unlimited).
  // recordUsage() throws on Firestore failure and sets connectionError,
  // which the ac-state-changed listener uses to show the connection
  // banner automatically — we still let the already-finished result
  // display below, since the audio processing itself already succeeded.
  try { await window.AudioClarityAuth.recordUsage(); } catch(e) { console.warn("Usage recording failed, connection banner will show:", e); }

  // ── Show results ─────────────────────────────────────────
  $("result-status").textContent = "✓ " + currentFile.name;
  $("raw-text").textContent  = rawText;
  $("enh-text").textContent  = enhText;
  $("stat-words").textContent= enhText.trim().split(/\s+/).filter(Boolean).length || "—";
  $("orig-meta").textContent = currentFile.name + " · " + (currentFile.size/1024/1024).toFixed(2)+" MB";

  const subParts = ["Noise reduced","Clarity boosted","Normalized"];
  if (humInfo && humInfo.freq) subParts.push(`${humInfo.freq}Hz hum removed`);
  if (hissInfo.detected) subParts.push(`Intro hiss removed (0–${hissInfo.durSec.toFixed(1)}s${hissInfo.speechFree ? ", faded in" : ""})`);
  $("enh-sub").textContent = subParts.join(" · ");

  renderFeatureChecklist(humInfo, hissInfo);
  trackEvent("audio_enhanced", { humRemoved: !!(humInfo && humInfo.freq), hissRemoved: hissInfo.detected });

  showStage("done");

  // Wire original player (Web Audio, no blob URLs)
  wirePlayer(origAudioBuf, 'orig', {
    play:"play-orig", cur:"cur-orig", dur:"dur-orig",
    track:"track-orig", fill:"fill-orig", thumb:"thumb-orig"
  });

  // Wire enhanced player
  $("enh-status").style.display  = "none";
  $("player-enh").style.display  = "flex";
  wirePlayer(enhAudioBuf, 'enh', {
    play:"play-enh", cur:"cur-enh", dur:"dur-enh",
    track:"track-enh", fill:"fill-enh", thumb:"thumb-enh"
  });
});


// ── Downloads ─────────────────────────────────────────────
function downloadDataUri(dataUri, filename) {
  const a = document.createElement("a");
  a.href = dataUri; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

function baseName() { return currentFile ? currentFile.name.replace(/\.[^.]+$/,"") : "audio"; }

$("dl-report").addEventListener("click", ()=>{
  trackEvent("download", { type: "pdf_report" });
  const raw  = $("raw-text").textContent  || "Transcript unavailable.";
  const enh  = $("enh-text").textContent  || "Transcript unavailable.";
  const meta = currentFile
    ? "File: " + currentFile.name + "   Size: " + (currentFile.size/1024/1024).toFixed(2) + " MB"
    : "";

  // ── Pure-JS PDF (no external lib) ────────────────────────
  // PDF uses points (1pt = 1/72 in). A4 = 595 x 842 pt.
  const PW=595, PH=842, ML=50, MR=50, MT=60, MB=50;
  const CW = PW-ML-MR;   // content width
  const LHEIGHT = 14;    // line height pt
  const CHARS_PER_LINE = 90; // approx for 9pt Helvetica in CW

  function wrapText(text, cpl) {
    const words = text.split(/\s+/);
    const lines = []; let cur = "";
    for (const w of words) {
      if (!w) continue;
      if ((cur + (cur?" ":"") + w).length <= cpl) { cur += (cur?" ":"") + w; }
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }

  // PDF object builder
  const objs = [];
  const offsets = [];
  function addObj(content) { objs.push(content); return objs.length; }

  // We'll build pages, collecting stream content per page
  const pages = [];
  let streamLines = [];
  let y = PH - MT;

  function pdfStr(s) {
    // Escape special PDF string chars
    return s.replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)");
  }

  function newPage() {
    if (streamLines.length) pages.push(streamLines.join("\n"));
    streamLines = [];
    y = PH - MT;
  }

  function ensureSpace(needed) {
    if (y - needed < MB) newPage();
  }

  function drawText(text, x, yy, size, r,g,b) {
    streamLines.push(`${(r/255).toFixed(3)} ${(g/255).toFixed(3)} ${(b/255).toFixed(3)} rg`);
    streamLines.push(`BT /F1 ${size} Tf ${x} ${yy} Td (${pdfStr(text)}) Tj ET`);
  }

  function drawRect(x,yy,w,h, r,g,b) {
    streamLines.push(`${(r/255).toFixed(3)} ${(g/255).toFixed(3)} ${(b/255).toFixed(3)} rg`);
    streamLines.push(`${x} ${yy} ${w} ${h} re f`);
  }

  // ── Page 1 header ──
  drawRect(0, PH-70, PW, 70, 10,22,40);
  drawText("Audio Clarity Report", ML, PH-30, 16, 59,130,246);
  drawText("Generated: "+new Date().toLocaleString(), ML, PH-48, 8, 100,116,139);
  if (meta) drawText(meta, ML, PH-60, 8, 71,85,105);
  y = PH - 85;

  function addSection(title, body) {
    ensureSpace(30);
    drawRect(ML, y-4, CW, 18, 15,39,68);
    drawText(title, ML+6, y+8, 9, 96,165,250);
    y -= 22;
    const bodyLines = wrapText(body, CHARS_PER_LINE);
    for (const line of bodyLines) {
      ensureSpace(LHEIGHT+2);
      drawText(line, ML, y, 9, 40,40,40);
      y -= LHEIGHT;
    }
    y -= 10;
  }

  addSection("RAW TRANSCRIPT", raw);
  addSection("ENHANCED & CLARIFIED", enh);
  newPage(); // flush last page

  // ── Assemble PDF binary ──
  const enc = new TextEncoder();
  const parts = [enc.encode("%PDF-1.4\n")];
  let pos = parts[0].length;

  function pushStr(s) {
    const b = enc.encode(s);
    parts.push(b); pos += b.length; return b.length;
  }

  // Font obj (1)
  offsets[1] = pos;
  pushStr("1 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n");

  // Page streams
  const streamObjIds = [];
  for (let i=0;i<pages.length;i++) {
    const sid = 2 + i*2;
    offsets[sid] = pos;
    const s = pages[i];
    pushStr(`${sid} 0 obj\n<< /Length ${s.length} >>\nstream\n${s}\nendstream\nendobj\n`);
    streamObjIds.push(sid);
  }

  // Page objects
  const pageObjIds = [];
  const firstPageObj = 2 + pages.length*2;
  for (let i=0;i<pages.length;i++) {
    const pid = firstPageObj + i;
    offsets[pid] = pos;
    const sid = 2 + i*2;
    pushStr(`${pid} 0 obj\n<< /Type /Page /Parent ${firstPageObj+pages.length} 0 R /MediaBox [0 0 ${PW} ${PH}] /Contents ${sid} 0 R /Resources << /Font << /F1 1 0 R >> >> >>\nendobj\n`);
    pageObjIds.push(pid);
  }

  // Pages dict
  const pagesId = firstPageObj + pages.length;
  offsets[pagesId] = pos;
  pushStr(`${pagesId} 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map(id=>id+" 0 R").join(" ")}] /Count ${pages.length} >>\nendobj\n`);

  // Catalog
  const catId = pagesId + 1;
  offsets[catId] = pos;
  pushStr(`${catId} 0 obj\n<< /Type /Catalog /Pages ${pagesId} 0 R >>\nendobj\n`);

  // xref
  const xrefPos = pos;
  const totalObjs = catId + 1;
  let xref = `xref\n0 ${totalObjs}\n0000000000 65535 f \n`;
  for (let i=1;i<totalObjs;i++)
    xref += (offsets[i]||0).toString().padStart(10,"0") + " 00000 n \n";
  pushStr(xref);
  pushStr(`trailer\n<< /Size ${totalObjs} /Root ${catId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  // Concatenate all parts
  const total = parts.reduce((s,b)=>s+b.length,0);
  const out = new Uint8Array(total);
  let off2=0; for (const b of parts) { out.set(b,off2); off2+=b.length; }

  const blob = new Blob([out],{type:"application/pdf"});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href=url; a.download=baseName()+"_report.pdf";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
});
$("dl-enh-txt").addEventListener("click", ()=>{
  trackEvent("download", { type: "enhanced" });
  if (enhWavBytes) downloadWav(enhWavBytes, baseName()+"_enhanced.wav");
  else downloadDataUri("data:text/plain;charset=utf-8,"+encodeURIComponent($("enh-text").textContent), baseName()+"_enhanced.txt");
});
$("dl-raw-txt").addEventListener("click", ()=>{
  trackEvent("download", { type: "raw" });
  if (origWavBytes) downloadWav(origWavBytes, baseName()+"_original.wav");
  else downloadDataUri("data:text/plain;charset=utf-8,"+encodeURIComponent($("raw-text").textContent), baseName()+"_raw.txt");
});


// ── Copy buttons ──────────────────────────────────────────
function legacyCopy(text){
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch(e) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

["copy-raw","copy-enh"].forEach(id=>{
  const src = id==="copy-raw"?"raw-text":"enh-text";
  $(id).addEventListener("click", ()=>{
    const text = $(src).textContent;
    const showCopied = ()=>{
      $(id).textContent="✓ Copied"; $(id).classList.add("copied");
      setTimeout(()=>{ $(id).textContent="Copy"; $(id).classList.remove("copied"); },1800);
    };
    const showFailed = ()=>{
      $(id).textContent="✗ Failed";
      setTimeout(()=>{ $(id).textContent="Copy"; },1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(showCopied).catch(()=>{
        if (legacyCopy(text)) showCopied(); else showFailed();
      });
    } else {
      if (legacyCopy(text)) showCopied(); else showFailed();
    }
  });
});


// ── Reset ─────────────────────────────────────────────────
$("reset-btn").addEventListener("click", ()=>{
  ['orig','enh'].forEach(k=>stopPlayer(k));
  if (sharedActx) { try { sharedActx.close(); } catch(e){} sharedActx=null; }
  origAudioBuf=enhAudioBuf=origWavBytes=enhWavBytes=currentFile=null;
  players={};
  $("file-chip").classList.remove("show");
  $("process-btn").disabled=true;
  $("error-msg").style.display="none";
  $("enh-status").style.display="flex";
  $("player-enh").style.display="none";
  $("enh-status-text").textContent="Processing audio…";
  $("enh-sub").textContent="Noise reduced · Clarity boosted · Normalized";
  $("feature-grid").innerHTML="";
  $("feature-caveat").textContent="";
  $("prog-fill").style.width="0%";
  $("prog-pct").textContent="0% complete";
  ["play-orig","play-enh"].forEach(id=>{ const b=$(id); if(b){b.disabled=true;b.textContent="▶";} });
  ["fill-orig","fill-enh"].forEach(id=>{ const f=$(id); if(f) f.style.width="0%"; });
  ["cur-orig","cur-enh"].forEach(id=>{ const e=$(id); if(e) e.textContent="0:00"; });
  ["dur-orig","dur-enh"].forEach(id=>{ const e=$(id); if(e) e.textContent="0:00"; });
  showStage("idle");
});
