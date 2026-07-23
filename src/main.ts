import { Mouth2Midi, type Scale } from './mouth2midi';
import { renderSmf, type RecordedNote } from './smf';
import { createRoll } from './roll';
import './style.css';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  latency: $('latency'),
  noteName: $('noteName'),
  centsNeedle: $('centsNeedle'),
  freq: $('freq'),
  level: $('levelFill'),
  scale: $<HTMLSelectElement>('scale'),
  root: $<HTMLSelectElement>('root'),
  gate: $<HTMLInputElement>('gate'),
  gateVal: $('gateVal'),
  conf: $<HTMLInputElement>('conf'),
  confVal: $('confVal'),
  capture: $<HTMLInputElement>('capture'),
  captureVal: $('captureVal'),
  centsBand: $('centsBand'),
  rangeLo: $<HTMLInputElement>('rangeLo'),
  rangeHi: $<HTMLInputElement>('rangeHi'),
  rangeLoVal: $('rangeLoVal'),
  rangeHiVal: $('rangeHiVal'),
  quant: $<HTMLSelectElement>('quant'),
  metro: $<HTMLSelectElement>('metro'),
  detector: $<HTMLSelectElement>('detector'),
  bpm: $<HTMLInputElement>('bpm'),
  bpmVal: $('bpmVal'),
  playBtn: $<HTMLButtonElement>('playBtn'),
  recBtn: $<HTMLButtonElement>('recBtn'),
  saveBtn: $<HTMLButtonElement>('saveBtn'),
  status: $('status'),
  roll: $<HTMLCanvasElement>('roll'),
  beatRow: $('beatRow'),
  helpBtn: $<HTMLButtonElement>('helpBtn'),
  helpModal: $('helpModal'),
  helpClose: $<HTMLButtonElement>('helpClose'),
  calibBtn: $<HTMLButtonElement>('calibBtn'),
  calibModal: $('calibModal'),
  calibText: $('calibText'),
  calibRun: $<HTMLButtonElement>('calibRun'),
  calibClose: $<HTMLButtonElement>('calibClose'),
  calibCloseX: $<HTMLButtonElement>('calibCloseX'),
  drumCalibBtn: $<HTMLButtonElement>('drumCalibBtn'),
  drumModal: $('drumModal'),
  drumText: $('drumText'),
  drumRun: $<HTMLButtonElement>('drumRun'),
  drumReset: $<HTMLButtonElement>('drumReset'),
  drumClose: $<HTMLButtonElement>('drumClose'),
  drumCloseX: $<HTMLButtonElement>('drumCloseX'),
};

let running = false;
let recording = false;
let recordStart = 0;
let recorded: RecordedNote[] = [];
let bpm = 120;

// Live piano-roll sheet — created before the listeners that feed it.
const roll = createRoll(el.roll, {
  currentScale: () => el.scale.value as Scale,
  currentRoot: () => Number(el.root.value),
  isRecording: () => recording,
  range: () => [Number(el.rangeLo.value), Number(el.rangeHi.value)],
  captureTol: () => Number(el.capture.value) / 100,
});

function midiToName(midiFloat: number): string {
  const rounded = Math.round(midiFloat);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

// The meter is ±50¢ across ~160px (1.6px/cent). Draw the capture band to that
// scale so you can see how much slack you have around the target pitch.
function updateCaptureBand() {
  const cents = Number(el.capture.value);
  el.centsBand.style.width = `${cents * 2 * 1.6}px`;
}

// Calibration taps the pitch stream when set (see runCalibration).
let calibCollector: ((p: PitchSample) => void) | null = null;
interface PitchSample {
  frequency: number;
  midiFloat: number;
  confidence: number;
  rms: number;
}

function pushConfig() {
  void Mouth2Midi.configure({
    scale: el.scale.value as Scale,
    scaleRoot: Number(el.root.value),
    channel: 0,
    gateThreshold: Number(el.gate.value),
    minConfidence: Number(el.conf.value),
    minNote: Number(el.rangeLo.value),
    maxNote: Number(el.rangeHi.value),
    settleTol: Number(el.capture.value) / 100, // cents → semitones
  });
}

// --- Live pitch → tuner UI ---------------------------------------------------
void Mouth2Midi.addListener('pitch', (p) => {
  // Input-level meter updates on every frame, voiced or not, so you can see
  // the mic is delivering signal even before a pitch locks. sqrt curve makes
  // quiet input visible; the marker at the gate threshold shows where notes
  // start triggering.
  const levelPct = Math.min(100, Math.sqrt(Math.max(0, p.rms)) * 200);
  el.level.style.width = `${levelPct}%`;

  if (p.frequency <= 0) {
    el.noteName.textContent = '—';
    el.freq.textContent = '0 Hz';
    el.centsNeedle.style.transform = 'translateX(0)';
    return;
  }
  el.noteName.textContent = midiToName(p.midiFloat);
  el.freq.textContent = `${p.frequency.toFixed(1)} Hz`;
  const cents = (p.midiFloat - Math.round(p.midiFloat)) * 100; // -50..+50
  el.centsNeedle.style.transform = `translateX(${cents * 1.6}px)`;

  roll.addPitch(p.midiFloat, p.confidence);
  calibCollector?.(p);
});

// --- Note events → recorder + live sheet -------------------------------------
void Mouth2Midi.addListener('note', (n) => {
  roll.addNote(n.type, n.note, n.velocity);
  if (!recording) return;
  recorded.push({
    timeMs: performance.now() - recordStart,
    note: n.note,
    velocity: n.velocity,
    on: n.type === 'noteOn',
  });
});

// --- Percussion (beatbox) events → GM drum notes on channel 10 ---------------
const DRUM_NOTE: Record<DrumKind, number> = { kick: 36, snare: 38, hat: 42 };
const DRUM_LABEL: Record<DrumKind, string> = { kick: 'KICK', snare: 'SNARE', hat: 'HAT' };
void Mouth2Midi.addListener('percussion', (p) => {
  // Calibration (when active) taps the raw hit stream before anything else.
  drumCollector?.(p);

  // If the user has calibrated their own drums, classify by nearest centroid;
  // otherwise fall back to the native heuristic label.
  const kind: DrumKind = drumCentroids ? classifyDrum(p) : (p.kind as DrumKind);
  const note = DRUM_NOTE[kind] ?? 38;
  el.noteName.textContent = DRUM_LABEL[kind] ?? kind;
  el.freq.textContent = `vel ${p.velocity}`;
  // Surface the classification features so they can be screenshotted for tuning.
  const tag = drumCentroids ? '✓' : '';
  el.status.textContent = `${DRUM_LABEL[kind]} ${tag}  low=${(p.lowRatio ?? 0).toFixed(2)}  high=${(p.highRatio ?? 0).toFixed(2)}  zcr=${(p.zcr ?? 0).toFixed(2)}`;
  if (!recording) return;
  const t = performance.now() - recordStart;
  // One-shot: a short note on GM drum channel 10 (index 9).
  recorded.push({ timeMs: t, note, velocity: p.velocity, on: true, channel: 9 });
  recorded.push({ timeMs: t + 40, note, velocity: 0, on: false, channel: 9 });
});

// --- Transport ---------------------------------------------------------------
el.playBtn.addEventListener('click', async () => {
  if (!running) {
    pushConfig();
    await Mouth2Midi.start();
    running = true;
    // Apply the selected engine now that the native engine exists — selecting
    // it before Start would otherwise no-op (engine not created yet).
    if (el.detector.value !== 'yin') {
      await Mouth2Midi.setDetector({
        detector: el.detector.value as 'yin' | 'spice' | 'beatbox',
      });
    }
    el.playBtn.textContent = 'Stop';
    el.playBtn.classList.add('active');
    el.recBtn.disabled = false;

    const status = await Mouth2Midi.getStatus();
    const rtMs = status.framesPerBurst
      ? ((status.framesPerBurst / status.sampleRate) * 1000).toFixed(1)
      : '?';
    el.latency.textContent = status.lowLatency
      ? `⚡ ${rtMs}ms buf`
      : `${rtMs}ms buf`;
    el.status.textContent = status.lowLatency
      ? 'Low-latency (exclusive/MMAP) stream granted.'
      : 'Running (shared stream — expect higher latency).';
  } else {
    await Mouth2Midi.stop();
    running = false;
    if (recording) stopRecording();
    stopMetro();
    el.playBtn.textContent = 'Start';
    el.playBtn.classList.remove('active');
    el.recBtn.disabled = true;
  }
});

el.recBtn.addEventListener('click', () => {
  if (recording) {
    stopRecording();
    return;
  }
  if (countingIn) return; // already counting in
  if (el.metro.value === 'on') startCountInThenRecord();
  else beginRecording();
});

function beginRecording() {
  recorded = [];
  recordStart = performance.now();
  recording = true;
  el.recBtn.classList.add('active');
  el.saveBtn.disabled = true;
  el.status.textContent = 'Recording…';
}

function stopRecording() {
  recording = false;
  stopMetro();
  el.recBtn.classList.remove('active');
  el.saveBtn.disabled = recorded.length === 0;
  el.status.textContent = `Captured ${recorded.length} MIDI events.`;
}

// --- Metronome (mic-safe: visual + haptic, no audio) -------------------------
let metroTimer: ReturnType<typeof setTimeout> | undefined;
let countingIn = false;
const COUNT_IN_BEATS = 4;
const beatDots = Array.from(el.beatRow.querySelectorAll<HTMLElement>('.beat-dot'));

const beatMs = () => 60000 / bpm;

async function pulseHaptic(strong: boolean) {
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: strong ? ImpactStyle.Medium : ImpactStyle.Light });
  } catch {
    /* no haptics on web / unsupported */
  }
}

function pulseBeat(beat: number) {
  const downbeat = beat % 4 === 0;
  const dot = beatDots[beat % 4];
  if (dot) {
    dot.classList.toggle('downbeat', downbeat);
    dot.classList.add('lit');
    setTimeout(() => dot.classList.remove('lit'), 110);
  }
  void pulseHaptic(downbeat);
}

function stopMetro() {
  if (metroTimer) clearTimeout(metroTimer);
  metroTimer = undefined;
  countingIn = false;
  el.beatRow.setAttribute('hidden', '');
}

// One bar of count-in (visual + haptic), then start recording on the downbeat
// and keep the beat going through the take. No audio, so nothing bleeds into
// the mic.
function startCountInThenRecord() {
  countingIn = true;
  el.beatRow.removeAttribute('hidden');
  const start = performance.now();
  let beat = 0;
  const step = () => {
    pulseBeat(beat);
    if (beat < COUNT_IN_BEATS) {
      el.status.textContent = `Count-in… ${COUNT_IN_BEATS - beat}`;
    }
    if (beat === COUNT_IN_BEATS) {
      countingIn = false;
      beginRecording();
    }
    beat++;
    const next = start + beat * beatMs();
    metroTimer = setTimeout(step, Math.max(0, next - performance.now()));
  };
  step();
}

el.saveBtn.addEventListener('click', async () => {
  if (recorded.length === 0) return;
  const div = Number(el.quant.value); // 0 = off, else 1/div note
  const notes = div > 0 ? quantizeToGrid(recorded, bpm, div) : recorded;
  const bytes = renderSmf(notes, bpm);
  const filename = `mouth2midi-${Date.now()}.mid`;
  await exportMidi(filename, bytes);
});

/**
 * Snap recorded note starts/ends to a rhythmic grid so the export lines up in
 * the DAW. grid = a 1/`div` note at the given tempo. Notes are kept at least
 * one grid cell long.
 */
function quantizeToGrid(events: RecordedNote[], tempo: number, div: number): RecordedNote[] {
  const gridMs = (4 * (60000 / tempo)) / div;
  const snap = (t: number) => Math.round(t / gridMs) * gridMs;

  // Pair on/off (monophonic-friendly FIFO per note).
  const open = new Map<number, { start: number; vel: number }[]>();
  const paired: { note: number; vel: number; start: number; end: number }[] = [];
  for (const e of events) {
    if (e.on) {
      const q = open.get(e.note) ?? [];
      q.push({ start: e.timeMs, vel: e.velocity });
      open.set(e.note, q);
    } else {
      const q = open.get(e.note);
      const started = q?.shift();
      if (started) paired.push({ note: e.note, vel: started.vel, start: started.start, end: e.timeMs });
    }
  }

  const out: RecordedNote[] = [];
  for (const n of paired) {
    let s = snap(n.start);
    let en = snap(n.end);
    if (en <= s) en = s + gridMs;
    out.push({ timeMs: s, note: n.note, velocity: n.vel, on: true });
    out.push({ timeMs: en, note: n.note, velocity: 0, on: false });
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Export the recording. On device we write the .mid to app cache, then open the
 * OS share sheet so the file can go straight into Cubasis, Files, Drive, etc.
 * (App storage isn't reachable on-device otherwise.) In the browser we fall
 * back to a plain download.
 */
async function exportMidi(filename: string, bytes: Uint8Array) {
  const { Capacitor } = await import('@capacitor/core');

  if (Capacitor.isNativePlatform()) {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');
      const { uri } = await Filesystem.writeFile({
        path: filename,
        data: bytesToBase64(bytes),
        directory: Directory.Cache,
      });
      await Share.share({
        title: filename,
        text: 'MIDI export from Mouth2MIDI',
        files: [uri],
        dialogTitle: 'Export MIDI file',
      });
      el.status.textContent = `Exported ${filename} — choose where to send it.`;
    } catch (err) {
      // User dismissing the share sheet also lands here; keep it quiet.
      el.status.textContent = `Export canceled.`;
      console.warn('[Mouth2Midi] export failed/canceled', err);
    }
    return;
  }

  // Browser dev fallback: download.
  const blob = new Blob([bytes as BlobPart], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  el.status.textContent = `Downloaded ${filename}.`;
}

// --- Config UI wiring --------------------------------------------------------
el.scale.addEventListener('change', pushConfig);
el.root.addEventListener('change', pushConfig);
el.gate.addEventListener('input', () => {
  el.gateVal.textContent = Number(el.gate.value).toFixed(3);
  pushConfig();
});
el.conf.addEventListener('input', () => {
  el.confVal.textContent = Number(el.conf.value).toFixed(2);
  pushConfig();
});
el.capture.addEventListener('input', () => {
  el.captureVal.textContent = el.capture.value;
  updateCaptureBand();
  pushConfig();
});
updateCaptureBand();

// --- Pitch engine (YIN / SPICE) toggle --------------------------------------
el.detector.addEventListener('change', async () => {
  const want = el.detector.value as 'yin' | 'spice' | 'beatbox';
  const res = await Mouth2Midi.setDetector({ detector: want });
  if (want === 'spice' && !res.available) {
    // Model not bundled (or failed to load) — revert the UI to YIN.
    el.detector.value = 'yin';
    el.status.textContent =
      'SPICE model not found (add assets/spice.tflite). Staying on YIN.';
    return;
  }
  const label =
    res.detector === 'spice'
      ? 'SPICE pitch (AI)'
      : res.detector === 'beatbox'
        ? '🥁 Beatbox (drums) — kick/snare/hat → GM drums'
        : 'YIN pitch';
  el.status.textContent = `Engine: ${label}`;
});

// --- Help modal --------------------------------------------------------------
el.helpBtn.addEventListener('click', () => el.helpModal.removeAttribute('hidden'));
el.helpClose.addEventListener('click', () => el.helpModal.setAttribute('hidden', ''));
el.helpModal.addEventListener('click', (e) => {
  if (e.target === el.helpModal) el.helpModal.setAttribute('hidden', ''); // tap backdrop
});
el.bpm.addEventListener('input', () => {
  bpm = Number(el.bpm.value);
  el.bpmVal.textContent = String(bpm);
});

function syncRangeLabels() {
  // Keep low strictly below high so the band is always valid.
  let lo = Number(el.rangeLo.value);
  let hi = Number(el.rangeHi.value);
  if (lo >= hi) {
    if (document.activeElement === el.rangeLo) hi = lo + 1;
    else lo = hi - 1;
    el.rangeLo.value = String(lo);
    el.rangeHi.value = String(hi);
  }
  el.rangeLoVal.textContent = midiToName(lo);
  el.rangeHiVal.textContent = midiToName(hi);
}
el.rangeLo.addEventListener('input', () => {
  syncRangeLabels();
  pushConfig();
});
el.rangeHi.addEventListener('input', () => {
  syncRangeLabels();
  pushConfig();
});
syncRangeLabels();

// --- Voice calibration -------------------------------------------------------
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function percentile(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}

function openCalib() {
  el.calibText.innerHTML =
    'This sets your range band and gate to your voice.<br />Make sure the mic is running (Start), then press Begin.';
  el.calibRun.disabled = false;
  el.calibModal.removeAttribute('hidden');
}
function closeCalib() {
  calibCollector = null;
  el.calibModal.setAttribute('hidden', '');
}
el.calibBtn.addEventListener('click', openCalib);
el.calibClose.addEventListener('click', closeCalib);
el.calibCloseX.addEventListener('click', closeCalib);

el.calibRun.addEventListener('click', runCalibration);

async function runCalibration() {
  if (!running) {
    el.calibText.textContent = 'Press Start first so the mic is live, then Begin.';
    return;
  }
  el.calibRun.disabled = true;
  const low: number[] = [];
  const high: number[] = [];
  const silence: number[] = [];

  const phase = async (label: string, ms: number, cb: (p: PitchSample) => void) => {
    calibCollector = cb;
    for (let s = Math.ceil(ms / 1000); s > 0; s--) {
      el.calibText.innerHTML = `${label}<br /><span style="font-size:44px">${s}</span>`;
      await delay(1000);
    }
    calibCollector = null;
  };

  await phase('Hum your LOWEST comfortable note', 3000, (p) => {
    if (p.frequency > 0 && p.confidence > 0.6) low.push(p.midiFloat);
  });
  await phase('Now your HIGHEST comfortable note', 3000, (p) => {
    if (p.frequency > 0 && p.confidence > 0.6) high.push(p.midiFloat);
  });
  await phase('Stay silent…', 2000, (p) => {
    silence.push(p.rms);
  });

  el.calibRun.disabled = false;

  if (low.length < 5 || high.length < 5) {
    el.calibText.textContent = "Didn't catch enough — hum steadily and try Begin again.";
    return;
  }

  // Robust low/high from percentiles, padded a semitone, kept ordered.
  let loNote = Math.max(24, Math.floor(percentile(low, 20)) - 1);
  let hiNote = Math.min(96, Math.ceil(percentile(high, 80)) + 1);
  if (hiNote <= loNote) hiNote = loNote + 1;

  // Gate a touch above the measured noise floor.
  const noise = silence.length ? percentile(silence, 90) : 0.01;
  const gate = Math.min(0.15, Math.max(0.008, Math.round((noise * 1.7) / 0.005) * 0.005));

  el.rangeLo.value = String(loNote);
  el.rangeHi.value = String(hiNote);
  el.gate.value = String(gate);
  el.gateVal.textContent = gate.toFixed(3);
  syncRangeLabels();
  pushConfig();

  el.calibText.innerHTML = `Done! Range <b>${midiToName(loNote)}–${midiToName(
    hiNote,
  )}</b>, gate <b>${gate.toFixed(3)}</b>.<br />Adjust the sliders any time.`;
}

// --- Drum calibration (per-user, nearest-centroid) ---------------------------
// The global heuristic thresholds are whack-a-mole: every voice's kick/snare/hat
// sit in different feature ranges, so a fixed cutoff that suits one person mis-
// labels the next. Instead we let each user tap out their own three sounds, learn
// the centroid (mean feature fingerprint) of each, and then classify every live
// hit by "which of MY three sounds is this closest to?". Pure on-device maths on
// features that already ride along in the hit event — no data leaves the phone.

type DrumKind = 'kick' | 'snare' | 'hat';
type DrumFeat = [number, number, number]; // normalized [low, high, zcr]
type DrumCentroids = Record<DrumKind, DrumFeat>;

// Normalize the three features to comparable ~0..1 ranges so Euclidean distance
// weights them evenly. Divisors come from observed on-device spreads: lowRatio
// tops out near 1, highRatio near 3, zcr near 0.6.
function normFeat(p: { lowRatio?: number; highRatio?: number; zcr?: number }): DrumFeat {
  return [(p.lowRatio ?? 0) / 1.0, (p.highRatio ?? 0) / 3.0, (p.zcr ?? 0) / 0.6];
}

const DRUM_KEY = 'm2m.drumCentroids';

function loadDrumCentroids(): DrumCentroids | null {
  try {
    const raw = localStorage.getItem(DRUM_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as DrumCentroids;
    if (c?.kick && c?.snare && c?.hat) return c;
  } catch {
    /* corrupt / unavailable storage — fall back to heuristic */
  }
  return null;
}

let drumCentroids: DrumCentroids | null = loadDrumCentroids();
// Set while a calibration phase is collecting hits (see runDrumCalibration).
let drumCollector: ((p: { lowRatio?: number; highRatio?: number; zcr?: number }) => void) | null =
  null;

function classifyDrum(p: { lowRatio?: number; highRatio?: number; zcr?: number }): DrumKind {
  if (!drumCentroids) return 'snare';
  const f = normFeat(p);
  let best: DrumKind = 'snare';
  let bestD = Infinity;
  (Object.keys(drumCentroids) as DrumKind[]).forEach((k) => {
    const c = drumCentroids![k];
    const d = (f[0] - c[0]) ** 2 + (f[1] - c[1]) ** 2 + (f[2] - c[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  });
  return best;
}

function mean(feats: DrumFeat[]): DrumFeat {
  const s: DrumFeat = [0, 0, 0];
  for (const f of feats) {
    s[0] += f[0];
    s[1] += f[1];
    s[2] += f[2];
  }
  const n = feats.length || 1;
  return [s[0] / n, s[1] / n, s[2] / n];
}

function refreshDrumButton() {
  el.drumCalibBtn.textContent = drumCentroids
    ? '🥁 Drums calibrated ✓ (redo)'
    : '🥁 Calibrate my drums';
}
refreshDrumButton();

function openDrum() {
  el.drumText.innerHTML = drumCentroids
    ? "You've already calibrated. Press Begin to redo, or Reset to go back to the built-in detector."
    : "Teach the app <b>your</b> kick, snare and hi-hat.<br />Make sure the mic is running (Start), then press Begin.";
  el.drumRun.disabled = false;
  el.drumModal.removeAttribute('hidden');
}
function closeDrum() {
  drumCollector = null;
  el.drumModal.setAttribute('hidden', '');
}
el.drumCalibBtn.addEventListener('click', openDrum);
el.drumClose.addEventListener('click', closeDrum);
el.drumCloseX.addEventListener('click', closeDrum);
el.drumModal.addEventListener('click', (e) => {
  if (e.target === el.drumModal) closeDrum();
});
el.drumReset.addEventListener('click', () => {
  drumCentroids = null;
  try {
    localStorage.removeItem(DRUM_KEY);
  } catch {
    /* ignore */
  }
  refreshDrumButton();
  el.drumText.innerHTML = 'Reset — back to the built-in drum detector.';
});
el.drumRun.addEventListener('click', runDrumCalibration);

async function runDrumCalibration() {
  if (!running) {
    el.drumText.textContent = 'Press Start first so the mic is live, then Begin.';
    return;
  }
  // Calibration only makes sense with the beatbox engine feeding hits; switch to
  // it (and the UI selector) if we're not already there.
  if (el.detector.value !== 'beatbox') {
    el.detector.value = 'beatbox';
    await Mouth2Midi.setDetector({ detector: 'beatbox' });
  }
  el.drumRun.disabled = true;

  // Collect every hit that arrives during a labelled window.
  const collect = (label: string, ms: number): Promise<DrumFeat[]> =>
    new Promise((resolve) => {
      const feats: DrumFeat[] = [];
      drumCollector = (p) => feats.push(normFeat(p));
      let remaining = Math.ceil(ms / 1000);
      const tick = () => {
        el.drumText.innerHTML = `${label}<br /><span style="font-size:40px">${remaining}</span><br /><span style="opacity:.7">${feats.length} caught</span>`;
        if (remaining <= 0) {
          drumCollector = null;
          resolve(feats);
          return;
        }
        remaining--;
        setTimeout(tick, 1000);
      };
      tick();
    });

  const kickF = await collect('Tap your KICK ~5 times (e.g. a "b" / "puh")', 5000);
  const snareF = await collect('Now your SNARE ~5 times (e.g. "psh" / "kah")', 5000);
  const hatF = await collect('Now your HI-HAT ~5 times (e.g. "ts" / "tss")', 5000);

  el.drumRun.disabled = false;

  if (kickF.length < 2 || snareF.length < 2 || hatF.length < 2) {
    const short = [
      kickF.length < 2 ? 'kick' : null,
      snareF.length < 2 ? 'snare' : null,
      hatF.length < 2 ? 'hat' : null,
    ]
      .filter(Boolean)
      .join(', ');
    el.drumText.innerHTML = `Didn't catch enough ${short}. Tap a bit louder/steadier and press Begin again.`;
    return;
  }

  drumCentroids = {
    kick: mean(kickF),
    snare: mean(snareF),
    hat: mean(hatF),
  };
  try {
    localStorage.setItem(DRUM_KEY, JSON.stringify(drumCentroids));
  } catch {
    /* storage full/unavailable — stays in memory for this session */
  }
  refreshDrumButton();

  el.drumText.innerHTML = `Done! Learned your kick (${kickF.length}), snare (${snareF.length}) and hat (${hatF.length}).<br />Every hit now snaps to your closest sound. Reset any time.`;
}
