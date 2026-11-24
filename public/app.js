"use strict";

const $ = (id) => document.getElementById(id);

const els = {
  boot: $("boot"),
  bootLog: $("bootLog"),
  btnInit: $("btnInit"),
  conn: $("conn"),
  connLabel: $("connLabel"),
  btnVoice: $("btnVoice"),
  btnWake: $("btnWake"),
  modelSelect: $("modelSelect"),
  hostVal: $("hostVal"),
  uptimeVal: $("uptimeVal"),
  cpuVal: $("cpuVal"),
  cpuFill: $("cpuFill"),
  memVal: $("memVal"),
  memFill: $("memFill"),
  diskVal: $("diskVal"),
  diskFill: $("diskFill"),
  battVal: $("battVal"),
  battFill: $("battFill"),
  reactorWrap: $("reactorWrap"),
  canvas: $("viz"),
  status: $("status"),
  substatus: $("substatus"),
  transcript: $("transcript"),
  composer: $("composer"),
  input: $("input"),
  log: $("log"),
  modal: $("modal"),
  modalTool: $("modalTool"),
  modalSummary: $("modalSummary"),
  btnAuthorize: $("btnAuthorize"),
  btnDeny: $("btnDeny"),
};

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  started: false,
  busy: false,
  speaking: false,
  voiceOn: true,
  wakeMode: true,
  voice: null,
  model: localStorage.getItem("jarvis.model") || "",
  messages: [],
  pendingToken: null,
  recog: null,
  recogActive: false,
  speechSeq: 0,
  speechCooldownUntil: 0,
  pttBypass: false,
  pttTimer: null,
  audioCtx: null,
  analyser: null,
  freq: null,
  vizRunning: false,
  ctx: null,
};

const STATE_ATTR = {
  STANDBY: "standby",
  "STANDING BY": "standby",
  LISTENING: "listening",
  PROCESSING: "processing",
  SPEAKING: "speaking",
  "AWAITING AUTHORIZATION": "awaiting",
  "CORE OFFLINE": "awaiting",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function truncate(text, max) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ---------------- status + transcript ---------------- */

function setStatus(text) {
  els.status.textContent = text;
  els.reactorWrap.dataset.state = STATE_ATTR[text] || "standby";
  if (text === "AWAITING AUTHORIZATION") {
    els.status.style.color = "var(--gold)";
    els.status.style.textShadow = "0 0 20px rgba(255,199,107,.55)";
  } else if (text === "CORE OFFLINE") {
    els.status.style.color = "var(--red)";
    els.status.style.textShadow = "0 0 20px rgba(255,95,109,.55)";
  } else {
    els.status.style.color = "";
    els.status.style.textShadow = "";
  }
}

function setSub(text) {
  els.substatus.textContent = text || "";
}

function updateIdleStatus() {
  if (state.busy) {
    setStatus("PROCESSING");
    return;
  }
  if (state.pendingToken) {
    setStatus("AWAITING AUTHORIZATION");
    setSub("say “authorize” or “deny”");
    return;
  }
  if (state.speaking || !state.started) return;
  if (state.wakeMode) {
    setStatus(state.recogActive ? "LISTENING" : "STANDING BY");
    setSub(
      state.recogActive
        ? "listening for “jarvis” · hold space to talk"
        : "reconnecting microphone…"
    );
  } else {
    setStatus("STANDBY");
    setSub("hold space to talk, or type below");
  }
}

function addBubble(kind, text) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${kind}`;
  bubble.textContent = text;
  els.transcript.appendChild(bubble);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  while (els.transcript.children.length > 40) els.transcript.firstChild.remove();
}

/* ---------------- speech synthesis ---------------- */

function pickVoice() {
  if (!("speechSynthesis" in window)) return;
  const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  const score = (v) => {
    let s = 0;
    if (/daniel/i.test(v.name)) s += 100;
    if (/google uk english male/i.test(v.name)) s += 90;
    if (/oliver|arthur|alex/i.test(v.name)) s += 70;
    if (/en-GB/i.test(v.lang)) s += 40;
    if (/male/i.test(v.name)) s += 20;
    if (v.localService) s += 5;
    return s;
  };
  voices.sort((a, b) => score(b) - score(a));
  state.voice = voices[0] || null;
}

function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

function chunkText(text, max = 180) {
  const parts = String(text).replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*/g) || [String(text)];
  const chunks = [];
  let current = "";
  for (const part of parts) {
    if ((current + part).length > max && current) {
      chunks.push(current.trim());
      current = part;
    } else {
      current += part;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.slice(0, 8);
}

function stopSpeechEngine() {
  try {
    speechSynthesis.cancel();
  } catch {}
}

function speak(text, done) {
  const seq = ++state.speechSeq;
  if (!state.voiceOn || !text || !("speechSynthesis" in window)) {
    if (done) done();
    return;
  }
  stopSpeechEngine();
  state.speaking = true;
  setStatus("SPEAKING");
  const chunks = chunkText(text);
  let index = 0;

  const speakNext = () => {
    if (seq !== state.speechSeq) return;
    if (index >= chunks.length) {
      state.speaking = false;
      state.speechCooldownUntil = Date.now() + 650;
      if (done) done();
      else updateIdleStatus();
      return;
    }
    const chunk = chunks[index++];
    setSub(truncate(chunk, 84));
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (state.voice) utterance.voice = state.voice;
    utterance.lang = state.voice?.lang || "en-GB";
    utterance.rate = 1;
    utterance.pitch = 0.85;
    utterance.volume = 1;
    let advanced = false;
    let watchdog = null;
    const advance = () => {
      if (advanced) return;
      advanced = true;
      clearTimeout(watchdog);
      if (seq === state.speechSeq) setTimeout(speakNext, 40);
    };
    utterance.onend = advance;
    utterance.onerror = advance;
    // Some platforms never fire onend (no voices, stuck engine); fail safe.
    watchdog = setTimeout(() => {
      if (seq !== state.speechSeq) {
        advanced = true;
        return;
      }
      try {
        speechSynthesis.cancel();
      } catch {}
      advance();
    }, Math.max(3500, chunk.length * 95 + 2000));
    try {
      speechSynthesis.speak(utterance);
    } catch {
      advance();
    }
  };

  speakNext();
}

function stopSpeaking() {
  if (!state.speaking) {
    state.speechSeq++;
    stopSpeechEngine();
    return;
  }
  state.speechSeq++;
  state.speaking = false;
  stopSpeechEngine();
  updateIdleStatus();
}

/* ---------------- speech recognition ---------------- */

function buildRecognizer() {
  if (!SR) {
    state.wakeMode = false;
    els.btnWake.disabled = true;
    els.btnWake.classList.remove("on");
    els.btnWake.textContent = "WAKE: N/A";
    return;
  }

  const recog = new SR();
  recog.lang = "en-US";
  recog.continuous = true;
  recog.interimResults = true;
  recog.maxAlternatives = 1;
  let finalBuffer = "";

  recog.onstart = () => {
    state.recogActive = true;
    updateIdleStatus();
  };

  recog.onresult = (event) => {
    if (state.speaking || Date.now() < state.speechCooldownUntil) return;
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finalBuffer += `${result[0].transcript} `;
      else interim += result[0].transcript;
    }
    if (interim) setSub(truncate(interim, 74));
    if (finalBuffer.trim()) {
      const text = finalBuffer.trim();
      finalBuffer = "";
      handleUtterance(text);
    }
  };

  recog.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      state.wakeMode = false;
      els.btnWake.classList.remove("on");
      els.btnWake.textContent = "WAKE: OFF";
      addBubble(
        "system",
        "Microphone access was denied. Allow it in System Settings → Privacy & Security → Microphone, then reload."
      );
      updateIdleStatus();
    } else if (event.error === "network") {
      addBubble("system", "Speech service network error. Check your connection or type instead.");
    }
  };

  recog.onend = () => {
    state.recogActive = false;
    if (state.started && state.wakeMode) {
      setTimeout(() => {
        if (state.started && state.wakeMode && !state.recogActive) startRecog();
      }, 350);
    }
    updateIdleStatus();
  };

  state.recog = recog;
}

function startRecog() {
  if (!state.recog || state.recogActive) return;
  try {
    state.recog.start();
  } catch {}
}

function stopRecog() {
  if (!state.recog || !state.recogActive) return;
  try {
    state.recog.stop();
  } catch {}
}

function handleUtterance(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return;

  if (state.pendingToken) {
    handleConfirmationSpeech(text);
    return;
  }

  const wake = text.match(/^(?:(?:hey|ok|okay)\s+)?jarvis\b[\s,.:!-]*/i);
  const bypass = state.pttBypass;
  state.pttBypass = false;

  let command = text;
  if (wake) {
    command = text.slice(wake[0].length).trim();
  } else if (!bypass && state.wakeMode) {
    setSub(`heard “${truncate(text, 44)}”`);
    return;
  }

  if (!command) {
    if (wake || bypass) speak("Yes, sir?");
    return;
  }
  sendMessage(command);
}

function handleConfirmationSpeech(text) {
  const t = text.toLowerCase();
  if (/(deny|reject|cancel|abort|negative|\bno\b|don'?t)/.test(t)) {
    respondConfirm(false);
    return;
  }
  if (/(authorize|authorise|approve|proceed|affirmative|\byes\b|do it|go ahead)/.test(t)) {
    respondConfirm(true);
    return;
  }
  speak("I need a clear yes or no, sir.");
}

/* ---------------- chat ---------------- */

function handleReply(data) {
  if (Array.isArray(data.steps)) data.steps.forEach(renderLog);
  if (data.requiresConfirmation) {
    showConfirm(data.requiresConfirmation);
    return;
  }
  const reply = String(data.reply || "").trim();
  if (!reply) {
    updateIdleStatus();
    return;
  }
  state.messages.push({ role: "assistant", content: reply });
  addBubble("jarvis", reply);
  speak(reply);
}

async function sendMessage(text) {
  const message = String(text || "").trim();
  if (!message || state.busy || state.pendingToken) return;

  state.busy = true;
  stopSpeaking();
  els.input.value = "";
  addBubble("user", message);
  state.messages.push({ role: "user", content: message });
  setStatus("PROCESSING");
  setSub("thinking…");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: state.messages.slice(-24), model: state.model }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Core error ${res.status}`);
    state.busy = false;
    handleReply(data);
  } catch (err) {
    state.busy = false;
    addBubble("system", err.message);
    setStatus("CORE OFFLINE");
    setSub("check that Ollama is running");
    speak(`My core is unreachable, sir. ${err.message}`);
    refreshStatus();
  }
}

function showConfirm(confirmation) {
  state.pendingToken = confirmation.token;
  els.modalTool.textContent = confirmation.tool || "action";
  els.modalSummary.textContent = confirmation.summary || "";
  els.modal.classList.remove("hidden");
  els.btnAuthorize.disabled = false;
  els.btnDeny.disabled = false;

  addBubble(
    "system",
    `Authorization required — ${confirmation.summary || confirmation.tool}`
  );
  renderLog({
    name: confirmation.tool || "action",
    args: confirmation.args,
    result: { status: "confirmation_required", summary: confirmation.summary },
  });

  setStatus("AWAITING AUTHORIZATION");
  setSub("say “authorize” or “deny”");
  speak(
    `Authorization required, sir. ${confirmation.summary || ""} Shall I proceed?`,
    () => {
      if (!state.pendingToken) return;
      setStatus("AWAITING AUTHORIZATION");
      setSub("say “authorize” or “deny”");
    }
  );
}

async function respondConfirm(approve) {
  if (!state.pendingToken || state.busy) return;
  const token = state.pendingToken;
  state.pendingToken = null;
  state.busy = true;
  stopSpeaking();

  els.modal.classList.add("hidden");
  els.btnAuthorize.disabled = true;
  els.btnDeny.disabled = true;
  addBubble("system", approve ? "Authorization granted." : "Authorization denied.");
  setStatus("PROCESSING");
  setSub(approve ? "executing authorized action…" : "standing down…");

  try {
    const res = await fetch("/api/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, approve }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Core error ${res.status}`);
    state.busy = false;
    handleReply(data);
  } catch (err) {
    state.busy = false;
    addBubble("system", err.message);
    updateIdleStatus();
  }
}

/* ---------------- activity log ---------------- */

function summarize(step) {
  const args =
    step.args && Object.keys(step.args).length ? JSON.stringify(step.args) : "";
  const r = step.result || {};
  let outcome = "";
  if (r.status === "confirmation_required") outcome = "awaiting authorization";
  else if (r.denied) outcome = "denied by user";
  else if (r.error) outcome = r.error;
  else if (r.message) outcome = r.message;
  else if (r.output) outcome = r.output;
  else if (Array.isArray(r.results)) {
    outcome = `${r.results.length} result(s)${r.results[0] ? ` — ${r.results[0]}` : ""}`;
  } else if (Array.isArray(r.items)) outcome = `${r.count} item(s) in ${r.path}`;
  else if (r.ok) outcome = "done";
  return [args, outcome].filter(Boolean).join("  →  ").slice(0, 320);
}

function renderLog(step) {
  if (!step || !step.name) return;
  const empty = els.log.querySelector(".log-empty");
  if (empty) empty.remove();

  const row = document.createElement("div");
  row.className = "log-entry";

  const head = document.createElement("div");
  head.className = "log-head";

  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });

  const name = document.createElement("span");
  name.className = "log-tool";
  name.textContent = step.name;

  const r = step.result || {};
  const isPending = r.status === "confirmation_required";
  const isOk = r.ok !== false && !r.error && !isPending && !r.denied;
  const status = document.createElement("span");
  status.className = `log-status ${isPending ? "warn" : isOk ? "ok" : "err"}`;
  status.textContent = isPending ? "AUTH" : r.denied ? "DENIED" : isOk ? "OK" : "ERR";

  head.append(time, name, status);

  const body = document.createElement("div");
  body.className = "log-body";
  body.textContent = summarize(step);

  row.append(head, body);
  els.log.prepend(row);
  while (els.log.children.length > 80) els.log.lastChild.remove();
}

/* ---------------- system telemetry ---------------- */

function gb(bytes) {
  if (!bytes) return "0 GB";
  const value = bytes / 1073741824;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} GB`;
}

function fmtUptime(sec) {
  const s = Number(sec) || 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
}

function setMeter(key, pct, label, invert = false) {
  const fill = els[`${key}Fill`];
  const value = els[`${key}Val`];
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const warm = invert ? p <= 30 && p > 15 : p >= 80 && p < 92;
  const hot = invert ? p <= 15 : p >= 92;
  fill.style.width = `${Math.max(2, p)}%`;
  fill.classList.toggle("warm", warm);
  fill.classList.toggle("hot", hot);
  value.textContent = label;
}

async function updateSysinfo() {
  try {
    const res = await fetch("/api/sysinfo", { cache: "no-store" });
    if (!res.ok) return;
    const d = await res.json();

    setMeter("cpu", d.cpuLoad, `${Math.round(d.cpuLoad)}%`);
    const memPct = d.memTotal ? (d.memUsed / d.memTotal) * 100 : 0;
    setMeter("mem", memPct, `${gb(d.memUsed)} / ${gb(d.memTotal)}`);

    if (d.disk && d.disk.total) {
      setMeter("disk", (d.disk.used / d.disk.total) * 100, `${gb(d.disk.free)} free`);
    }

    if (d.battery && d.battery.percent != null) {
      setMeter(
        "batt",
        d.battery.percent,
        `${d.battery.percent}%${d.battery.charging ? " · AC" : ""}`,
        true
      );
    } else {
      setMeter("batt", 0, "N/A");
    }

    els.uptimeVal.textContent = fmtUptime(d.uptimeSec);
    els.hostVal.textContent = d.hostname || "—";
  } catch {}
}

/* ---------------- server status + models ---------------- */

function setOnline(online) {
  els.conn.classList.toggle("online", online);
  els.connLabel.textContent = online ? "CORE ONLINE" : "CORE OFFLINE";
}

function fillModels(models, chosen) {
  els.modelSelect.innerHTML = "";
  for (const name of models) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    els.modelSelect.appendChild(option);
  }
  els.modelSelect.value = chosen;
}

let lastModelsKey = "";

async function refreshStatus() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    const data = await res.json();
    setOnline(!!data.ollama);
    els.hostVal.textContent = data.hostname || "—";

    if (data.models && data.models.length) {
      const current = state.model || "";
      const chosen = data.models.includes(current)
        ? current
        : data.models.includes(data.defaultModel)
          ? data.defaultModel
          : data.models[0];
      state.model = chosen;
      const key = data.models.join("|");
      if (key !== lastModelsKey) {
        fillModels(data.models, chosen);
        lastModelsKey = key;
      } else {
        els.modelSelect.value = chosen;
      }
      els.modelSelect.disabled = false;
    } else {
      els.modelSelect.disabled = true;
      els.modelSelect.innerHTML = "";
      const option = document.createElement("option");
      option.textContent = data.ollama ? "no models installed" : "core offline";
      els.modelSelect.appendChild(option);
    }
    return data;
  } catch {
    setOnline(false);
    return { ollama: false, models: [], defaultModel: "", hostname: "" };
  }
}

/* ---------------- canvas visualiser ---------------- */

function resizeCanvas() {
  const rect = els.canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  els.canvas.width = Math.max(1, Math.round(rect.width * dpr));
  els.canvas.height = Math.max(1, Math.round(rect.height * dpr));
}

function startVizLoop() {
  if (state.vizRunning) return;
  state.vizRunning = true;
  state.ctx = els.canvas.getContext("2d");
  requestAnimationFrame(drawViz);
}

function drawViz(ts) {
  requestAnimationFrame(drawViz);
  const ctx = state.ctx;
  if (!ctx) return;
  const w = els.canvas.width;
  const h = els.canvas.height;
  if (!w || !h || els.boot.classList.contains("hide") === false) return;

  ctx.clearRect(0, 0, w, h);
  const t = ts / 1000;
  const size = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;

  let level = 0.07 + 0.025 * (0.5 + 0.5 * Math.sin(t * 1.4));
  if (state.speaking) {
    level =
      0.28 +
      0.2 * Math.abs(Math.sin(t * 9)) +
      0.08 * Math.abs(Math.sin(t * 23)) +
      0.04 * Math.abs(Math.sin(t * 31));
  } else if (state.analyser && state.recogActive) {
    state.analyser.getByteFrequencyData(state.freq);
    let sum = 0;
    for (let i = 0; i < state.freq.length; i++) sum += state.freq[i];
    level = Math.min(1, sum / state.freq.length / 140);
  }

  const baseR = size * 0.315;
  ctx.save();
  ctx.translate(cx, cy);

  ctx.strokeStyle = "rgba(99,233,255,0.09)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, baseR, 0, Math.PI * 2);
  ctx.stroke();

  const bars = 120;
  const lineWidth = Math.max(1, size * 0.0045);
  for (let i = 0; i < bars; i++) {
    const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
    const wobble = 0.5 + 0.5 * Math.sin(i * 0.9 + t * 2.6) * Math.sin(i * 0.31 - t * 1.3);
    const energy = Math.max(0, level * (0.3 + 0.7 * wobble));
    const length = Math.max(1.2, energy * baseR * 1.25);
    const x1 = Math.cos(angle) * baseR;
    const y1 = Math.sin(angle) * baseR;
    const x2 = Math.cos(angle) * (baseR + length);
    const y2 = Math.sin(angle) * (baseR + length);
    const gold = i % 15 === 0;
    ctx.strokeStyle = gold
      ? `rgba(255,199,107,${0.3 + energy * 0.5})`
      : `rgba(99,233,255,${0.16 + energy * 0.6})`;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------------- microphone ---------------- */

async function initMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (state.audioCtx.state === "suspended") await state.audioCtx.resume();
    const source = state.audioCtx.createMediaStreamSource(stream);
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    state.analyser = analyser;
    state.freq = new Uint8Array(analyser.frequencyBinCount);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- boot ---------------- */

function addBootLine(text, kind) {
  const line = document.createElement("div");
  line.textContent = text;
  if (kind) line.className = kind;
  els.bootLog.appendChild(line);
}

let booted = false;

async function initialize() {
  if (booted) return;
  booted = true;
  els.btnInit.disabled = true;
  els.btnInit.textContent = "INITIALIZING…";

  const status = await refreshStatus();
  const micOk = await initMic();
  buildRecognizer();
  loadVoices();

  const lines = [
    ["ARC REACTOR ............ ONLINE", "ok"],
    [`NEURAL CORE ............ ${state.model || "NONE"}`, status.ollama ? "ok" : "err"],
    [
      `CORE UPLINK ............ ${status.ollama ? "STABLE" : "OFFLINE — RUN OLLAMA SERVE"}`,
      status.ollama ? "ok" : "err",
    ],
    ["MACOS BRIDGE ........... LINKED", "ok"],
    [`AUDIO INPUT ............ ${micOk ? "READY" : "TEXT ONLY"}`, micOk ? "ok" : "warn"],
    [
      `VOICE OUTPUT ........... ${"speechSynthesis" in window ? "READY" : "UNAVAILABLE"}`,
      "speechSynthesis" in window ? "ok" : "warn",
    ],
    ["ACTIVATION ............. COMPLETE", "ok"],
  ];

  for (const [text, kind] of lines) {
    addBootLine(text, kind);
    await sleep(230);
  }
  await sleep(620);

  els.boot.classList.add("hide");
  state.started = true;
  startVizLoop();
  startPolling();

  const hour = new Date().getHours();
  const salute =
    hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const greeting = status.ollama
    ? `${salute}, sir. All systems are online${
        state.model ? `, running on ${state.model}` : ""
      }.`
    : `${salute}, sir. My neural core is offline. Start Ollama, then refresh this page.`;

  addBubble("jarvis", greeting);
  state.messages.push({ role: "assistant", content: greeting });
  speak(greeting);
  if (state.wakeMode) startRecog();
  updateIdleStatus();
}

let polling = false;
function startPolling() {
  if (polling) return;
  polling = true;
  const tick = async () => {
    await updateSysinfo();
    setTimeout(tick, 4000);
  };
  tick();
  setInterval(refreshStatus, 20000);
}

/* ---------------- input wiring ---------------- */

function isTyping(target) {
  if (!target) return false;
  const tag = (target.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

els.btnInit.addEventListener("click", initialize);

els.btnVoice.classList.add("on");
els.btnWake.classList.add("on");

els.btnVoice.addEventListener("click", () => {
  state.voiceOn = !state.voiceOn;
  els.btnVoice.textContent = `VOICE: ${state.voiceOn ? "ON" : "OFF"}`;
  els.btnVoice.classList.toggle("on", state.voiceOn);
  if (!state.voiceOn) stopSpeaking();
  else if (state.started && !state.busy) speak("Voice output enabled, sir.");
});

els.btnWake.addEventListener("click", () => {
  if (!SR) return;
  state.wakeMode = !state.wakeMode;
  els.btnWake.textContent = `WAKE: ${state.wakeMode ? "ON" : "OFF"}`;
  els.btnWake.classList.toggle("on", state.wakeMode);
  if (state.wakeMode) {
    startRecog();
    if (state.started) speak("Wake word active, sir.");
  } else {
    stopRecog();
  }
  updateIdleStatus();
});

els.modelSelect.addEventListener("change", () => {
  state.model = els.modelSelect.value;
  localStorage.setItem("jarvis.model", state.model);
  addBubble("system", `Neural core switched to ${state.model}.`);
});

els.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = els.input.value.trim();
  if (!value) return;
  if (state.pendingToken) {
    const t = value.toLowerCase();
    if (/(deny|reject|cancel|abort|negative|\bno\b)/.test(t)) {
      respondConfirm(false);
    } else if (/(authorize|authorise|approve|proceed|confirm|\byes\b|do it)/.test(t)) {
      respondConfirm(true);
    } else {
      setSub("I need a clear yes or no, sir.");
    }
    els.input.value = "";
    return;
  }
  sendMessage(value);
});

els.btnAuthorize.addEventListener("click", () => respondConfirm(true));
els.btnDeny.addEventListener("click", () => respondConfirm(false));

els.reactorWrap.addEventListener("click", () => {
  if (!state.started || state.busy || state.pendingToken) return;
  stopSpeaking();
  state.pttBypass = true;
  startRecog();
  setStatus("LISTENING");
  setSub("listening… speak now");
  clearTimeout(state.pttTimer);
  state.pttTimer = setTimeout(() => {
    state.pttBypass = false;
    if (!state.wakeMode) stopRecog();
  }, 6000);
});

document.addEventListener("keydown", (event) => {
  if (state.pendingToken && !isTyping(event.target)) {
    const key = event.key.toLowerCase();
    if (key === "y") {
      event.preventDefault();
      respondConfirm(true);
    } else if (key === "n" || event.key === "Escape") {
      event.preventDefault();
      respondConfirm(false);
    }
    return;
  }

  if (event.code === "Space" && !isTyping(event.target) && state.started && !event.repeat) {
    event.preventDefault();
    if (state.busy || state.pendingToken) return;
    stopSpeaking();
    state.pttBypass = true;
    clearTimeout(state.pttTimer);
    state.pttTimer = setTimeout(() => {
      state.pttBypass = false;
    }, 5000);
    startRecog();
    setStatus("LISTENING");
    setSub("listening… release when finished");
  }
});

document.addEventListener("keyup", (event) => {
  if (event.code !== "Space" || isTyping(event.target) || !state.started) return;
  if (!state.wakeMode) {
    setTimeout(() => {
      if (!state.speaking && !state.busy) stopRecog();
    }, 1200);
  } else if (!state.recogActive) {
    startRecog();
  }
});

new ResizeObserver(resizeCanvas).observe(els.canvas);
resizeCanvas();
