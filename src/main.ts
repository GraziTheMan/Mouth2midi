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
  capLow: $<HTMLButtonElement>('capLow'),
  capHigh: $<HTMLButtonElement>('capHigh'),
  capSilence: $<HTMLButtonElement>('capSilence'),
  cntLow: $('cntLow'),
  cntHigh: $('cntHigh'),
  cntSil: $('cntSil'),
  calibApply: $<HTMLButtonElement>('calibApply'),
  calibClose: $<HTMLButtonElement>('calibClose'),
  calibCloseX: $<HTMLButtonElement>('calibCloseX'),
  drumCalibBtn: $<HTMLButtonElement>('drumCalibBtn'),
  drumModal: $('drumModal'),
  drumText: $('drumText'),
  capKick: $<HTMLButtonElement>('capKick'),
  capSnare: $<HTMLButtonElement>('capSnare'),
  capHat: $<HTMLButtonElement>('capHat'),
  cntKick: $('cntKick'),
  cntSnare: $('cntSnare'),
  cntHat: $('cntHat'),
  drumSave: $<HTMLButtonElement>('drumSave'),
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
  isBeatbox: () => el.detector.value === 'beatbox',
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
  // Calibration capture: if a per-instrument button is armed, this hit becomes
  // one labelled sample and is NOT played/recorded (so calibrating never dumps
  // notes into a take). One tap = one sample.
  if (drumCapture) {
    const k = drumCapture;
    drumCapture = null;
    drumSamples[k].push(normFeat(p));
    roll.addDrum(k, p.velocity); // still show it landed
    onDrumSampleCaptured(k);
    return;
  }

  // If the user has calibrated their own drums, classify by nearest centroid
  // (which may reject the hit as noise); otherwise use the native heuristic.
  const kind: DrumKind | null = drumCentroids ? classifyDrum(p) : (p.kind as DrumKind);
  if (kind === null) {
    // Too far from every calibrated sound — treat as noise, ignore it.
    el.status.textContent = `(ignored — doesn't match your drums)`;
    return;
  }
  const note = DRUM_NOTE[kind] ?? 38;
  el.noteName.textContent = DRUM_LABEL[kind] ?? kind;
  el.freq.textContent = `vel ${p.velocity}`;
  // Surface the features so they can be screenshotted for tuning.
  const tag = drumCentroids ? '✓' : '';
  el.status.textContent = `${DRUM_LABEL[kind]} ${tag}  low=${(p.lowRatio ?? 0).toFixed(2)}  cent=${Math.round(p.centroid ?? 0)}Hz  decay=${(p.decay ?? 0).toFixed(2)}`;
  roll.addDrum(kind, p.velocity);
  if (!recording) return;
  const t = performance.now() - recordStart;
  // One-shot on GM drum channel 10 (index 9). Length tracks decay so a ringing
  // hit writes a slightly longer note than a snappy one (30..110ms).
  const lenMs = 30 + Math.min(1, Math.max(0, p.decay ?? 0)) * 80;
  recorded.push({ timeMs: t, note, velocity: p.velocity, on: true, channel: 9 });
  recorded.push({ timeMs: t + lenMs, note, velocity: 0, on: false, channel: 9 });
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
function percentile(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}

// Voice-calibration samples captured this session, one bucket per target.
let calLow: number[] = [];
let calHigh: number[] = [];
let calSilence: number[] = [];

function updateVoiceApply() {
  el.calibApply.disabled = calLow.length < 5 || calHigh.length < 5;
}

function openCalib() {
  calLow = [];
  calHigh = [];
  calSilence = [];
  calibCollector = null;
  el.cntLow.textContent = 'not set';
  el.cntHigh.textContent = 'not set';
  el.cntSil.textContent = 'not set';
  el.calibApply.disabled = true;
  el.calibText.innerHTML =
    'Tap a button, then hold that note for a second. One at a time, so a low note can\'t bleed into the high.';
  el.calibModal.removeAttribute('hidden');
}
function closeCalib() {
  calibCollector = null;
  [el.capLow, el.capHigh, el.capSilence].forEach((b) => b.classList.remove('listening'));
  el.calibModal.setAttribute('hidden', '');
}
el.calibBtn.addEventListener('click', openCalib);
el.calibClose.addEventListener('click', closeCalib);
el.calibCloseX.addEventListener('click', closeCalib);

// Record one on-demand window (~1.4s) into a bucket, with the button pulsing.
function captureVoice(
  btn: HTMLButtonElement,
  label: string,
  onSample: (p: PitchSample) => void,
  onDone: () => void,
) {
  if (!running) {
    el.calibText.textContent = 'Press Start first so the mic is live.';
    return;
  }
  [el.capLow, el.capHigh, el.capSilence].forEach((b) => b.classList.remove('listening'));
  btn.classList.add('listening');
  el.calibText.innerHTML = `Listening… <b>${label}</b>`;
  calibCollector = onSample;
  setTimeout(() => {
    calibCollector = null;
    btn.classList.remove('listening');
    onDone();
    updateVoiceApply();
  }, 1400);
}

el.capLow.addEventListener('click', () => {
  calLow = [];
  captureVoice(
    el.capLow,
    'hold your LOWEST note',
    (p) => {
      if (p.frequency > 0 && p.confidence > 0.6) calLow.push(p.midiFloat);
    },
    () => {
      el.cntLow.textContent = calLow.length >= 5 ? `${midiToName(percentile(calLow, 50))} ✓` : 'too quiet — retry';
      el.calibText.innerHTML = calLow.length >= 5 ? 'Low note captured.' : "Didn't catch it — hold a steady note and retry.";
    },
  );
});
el.capHigh.addEventListener('click', () => {
  calHigh = [];
  captureVoice(
    el.capHigh,
    'hold your HIGHEST note',
    (p) => {
      if (p.frequency > 0 && p.confidence > 0.6) calHigh.push(p.midiFloat);
    },
    () => {
      el.cntHigh.textContent = calHigh.length >= 5 ? `${midiToName(percentile(calHigh, 50))} ✓` : 'too quiet — retry';
      el.calibText.innerHTML = calHigh.length >= 5 ? 'High note captured.' : "Didn't catch it — hold a steady note and retry.";
    },
  );
});
el.capSilence.addEventListener('click', () => {
  calSilence = [];
  captureVoice(
    el.capSilence,
    'stay silent',
    (p) => calSilence.push(p.rms),
    () => {
      el.cntSil.textContent = 'captured ✓';
      el.calibText.innerHTML = 'Silence captured (sets the noise gate).';
    },
  );
});

el.calibApply.addEventListener('click', () => {
  if (calLow.length < 5 || calHigh.length < 5) return;
  // Robust low/high from percentiles, padded a semitone, kept ordered.
  let loNote = Math.max(24, Math.floor(percentile(calLow, 20)) - 1);
  let hiNote = Math.min(96, Math.ceil(percentile(calHigh, 80)) + 1);
  if (hiNote <= loNote) hiNote = loNote + 1;

  // Gate a touch above the measured noise floor (default if silence skipped).
  const noise = calSilence.length ? percentile(calSilence, 90) : 0.01;
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
});

// --- Drum calibration (per-user, nearest-centroid) ---------------------------
// The global heuristic thresholds are whack-a-mole: every voice's kick/snare/hat
// sit in different feature ranges, so a fixed cutoff that suits one person mis-
// labels the next. Instead we let each user tap out their own three sounds, learn
// the centroid (mean feature fingerprint) of each, and then classify every live
// hit by "which of MY three sounds is this closest to?". Pure on-device maths on
// features that already ride along in the hit event — no data leaves the phone.

type DrumKind = 'kick' | 'snare' | 'hat';
type DrumFeat = number[]; // normalized feature vector (see FEAT_DIM)
interface DrumCentroids {
  v: number; // feature-set version; bump when FEAT changes to force recalibration
  kick: DrumFeat;
  snare: DrumFeat;
  hat: DrumFeat;
}

// Bump whenever the feature vector changes so stale calibrations are discarded
// (old saves were 3-D [low, high, zcr]; v2 is 4-D and swaps highRatio for the
// better-scaled spectral centroid, and adds the decay/envelope axis).
const FEAT_VERSION = 2;
const FEAT_DIM = 4;

// Normalize each feature to a comparable ~0..1 range so Euclidean distance
// weights them evenly. We deliberately drop highRatio (it's just sqrt-redundant
// with the centroid) and keep four semi-independent axes:
//   low   — bass energy   → kick
//   zcr   — noisiness (count-based brightness)
//   cent  — spectral centroid in Hz (energy-based brightness)
//   decay — envelope tail  → separates hat (snappy) from snare (lingers)
type PercFeatures = {
  lowRatio?: number;
  highRatio?: number;
  zcr?: number;
  centroid?: number;
  decay?: number;
};
function normFeat(p: PercFeatures): DrumFeat {
  return [
    (p.lowRatio ?? 0) / 1.0,
    (p.zcr ?? 0) / 0.6,
    (p.centroid ?? 0) / 9000,
    (p.decay ?? 0) / 1.2,
  ];
}

const DRUM_KEY = 'm2m.drumCentroids';

function loadDrumCentroids(): DrumCentroids | null {
  try {
    const raw = localStorage.getItem(DRUM_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as DrumCentroids;
    // Reject saves from an older feature set (dimensions won't line up).
    if (c?.v !== FEAT_VERSION) return null;
    if (c.kick?.length === FEAT_DIM && c.snare?.length === FEAT_DIM && c.hat?.length === FEAT_DIM)
      return c;
  } catch {
    /* corrupt / unavailable storage — fall back to heuristic */
  }
  return null;
}

let drumCentroids: DrumCentroids | null = loadDrumCentroids();
// The instrument whose next hit should be captured as a calibration sample,
// or null when not calibrating. Armed by the per-instrument capture buttons.
let drumCapture: DrumKind | null = null;
// Samples collected in the open calibration session, before Save.
const drumSamples: Record<DrumKind, DrumFeat[]> = { kick: [], snare: [], hat: [] };
const DRUM_MIN_SAMPLES = 3;

function dist2(a: DrumFeat, b: DrumFeat): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return s;
}

// Outlier-reject radius from the (otherwise-unused-in-beatbox) Confidence slider:
// higher confidence = stricter = a hit must sit closer to one of your learned
// sounds or it's dropped as noise. This is what stops random car/room sounds
// from being forced into a kick/snare/hat.
function rejectRadius(): number {
  const conf = Number(el.conf.value); // 0.5..0.99
  const t = Math.min(1, Math.max(0, (conf - 0.5) / (0.99 - 0.5)));
  return 0.85 - t * (0.85 - 0.18); // loose 0.85 → strict 0.18 (Euclidean dist)
}

// Nearest calibrated centroid, or null if the hit is too far from all of them
// (an outlier we should ignore rather than mislabel).
function classifyDrum(p: PercFeatures): DrumKind | null {
  if (!drumCentroids) return 'snare';
  const f = normFeat(p);
  let best: DrumKind = 'snare';
  let bestD = Infinity;
  (['kick', 'snare', 'hat'] as DrumKind[]).forEach((k) => {
    const d = dist2(f, drumCentroids![k]);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  });
  const r = rejectRadius();
  if (bestD > r * r) return null; // no calibrated sound is close enough
  return best;
}

function mean(feats: DrumFeat[]): DrumFeat {
  const s = new Array(FEAT_DIM).fill(0);
  for (const f of feats) for (let i = 0; i < FEAT_DIM; i++) s[i] += f[i];
  const n = feats.length || 1;
  return s.map((v) => v / n);
}

function refreshDrumButton() {
  el.drumCalibBtn.textContent = drumCentroids
    ? '🥁 Drums calibrated ✓ (redo)'
    : '🥁 Calibrate my drums';
}
refreshDrumButton();

const DRUM_CAP_BTN: Record<DrumKind, HTMLButtonElement> = {
  kick: el.capKick,
  snare: el.capSnare,
  hat: el.capHat,
};
const DRUM_CNT_EL: Record<DrumKind, HTMLElement> = {
  kick: el.cntKick,
  snare: el.cntSnare,
  hat: el.cntHat,
};

function updateDrumCounts() {
  (['kick', 'snare', 'hat'] as DrumKind[]).forEach((k) => {
    DRUM_CNT_EL[k].textContent = `${drumSamples[k].length} sample${drumSamples[k].length === 1 ? '' : 's'}`;
  });
  const ready = (['kick', 'snare', 'hat'] as DrumKind[]).every(
    (k) => drumSamples[k].length >= DRUM_MIN_SAMPLES,
  );
  el.drumSave.disabled = !ready;
}

// A capture button was armed and its hit arrived (from the percussion listener).
function onDrumSampleCaptured(k: DrumKind) {
  DRUM_CAP_BTN[k].classList.remove('listening');
  updateDrumCounts();
  const n = drumSamples[k].length;
  const need = Math.max(0, DRUM_MIN_SAMPLES - n);
  el.drumText.innerHTML = need
    ? `Got a ${k.toUpperCase()} (${n}). ${need} more each to enable Save.`
    : `Got a ${k.toUpperCase()} (${n}). Add more or press Save.`;
}

async function armDrumCapture(k: DrumKind) {
  if (!running) {
    el.drumText.textContent = 'Press Start first so the mic is live.';
    return;
  }
  // Capturing needs the beatbox engine feeding hits.
  if (el.detector.value !== 'beatbox') {
    el.detector.value = 'beatbox';
    await Mouth2Midi.setDetector({ detector: 'beatbox' });
  }
  // Re-arming a different button cancels the previous arm.
  (['kick', 'snare', 'hat'] as DrumKind[]).forEach((other) =>
    DRUM_CAP_BTN[other].classList.remove('listening'),
  );
  drumCapture = k;
  DRUM_CAP_BTN[k].classList.add('listening');
  el.drumText.innerHTML = `Listening… make your <b>${k.toUpperCase()}</b> now.`;
}

(['kick', 'snare', 'hat'] as DrumKind[]).forEach((k) => {
  DRUM_CAP_BTN[k].addEventListener('click', () => void armDrumCapture(k));
});

function openDrum() {
  // Fresh session of samples each time the modal opens.
  drumSamples.kick = [];
  drumSamples.snare = [];
  drumSamples.hat = [];
  drumCapture = null;
  updateDrumCounts();
  el.drumText.innerHTML = drumCentroids
    ? "Already calibrated. Recapture your sounds to redo, or Reset to go back to the built-in detector."
    : "Tap a button, then make that one sound. 3+ each. One tap = one sample.";
  el.drumModal.removeAttribute('hidden');
}
function closeDrum() {
  drumCapture = null;
  (['kick', 'snare', 'hat'] as DrumKind[]).forEach((k) =>
    DRUM_CAP_BTN[k].classList.remove('listening'),
  );
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
  drumSamples.kick = [];
  drumSamples.snare = [];
  drumSamples.hat = [];
  drumCapture = null;
  try {
    localStorage.removeItem(DRUM_KEY);
  } catch {
    /* ignore */
  }
  refreshDrumButton();
  updateDrumCounts();
  el.drumText.innerHTML = 'Reset — back to the built-in drum detector.';
});
el.drumSave.addEventListener('click', () => {
  const ready = (['kick', 'snare', 'hat'] as DrumKind[]).every(
    (k) => drumSamples[k].length >= DRUM_MIN_SAMPLES,
  );
  if (!ready) return;
  drumCentroids = {
    v: FEAT_VERSION,
    kick: mean(drumSamples.kick),
    snare: mean(drumSamples.snare),
    hat: mean(drumSamples.hat),
  };
  try {
    localStorage.setItem(DRUM_KEY, JSON.stringify(drumCentroids));
  } catch {
    /* storage full/unavailable — stays in memory for this session */
  }
  refreshDrumButton();
  el.drumText.innerHTML = `Saved! Learned kick (${drumSamples.kick.length}), snare (${drumSamples.snare.length}), hat (${drumSamples.hat.length}). Every hit now snaps to your closest sound.`;
});
