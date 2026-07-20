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
  rangeLo: $<HTMLInputElement>('rangeLo'),
  rangeHi: $<HTMLInputElement>('rangeHi'),
  rangeLoVal: $('rangeLoVal'),
  rangeHiVal: $('rangeHiVal'),
  quant: $<HTMLSelectElement>('quant'),
  bpm: $<HTMLInputElement>('bpm'),
  bpmVal: $('bpmVal'),
  playBtn: $<HTMLButtonElement>('playBtn'),
  recBtn: $<HTMLButtonElement>('recBtn'),
  saveBtn: $<HTMLButtonElement>('saveBtn'),
  status: $('status'),
  roll: $<HTMLCanvasElement>('roll'),
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
});

function midiToName(midiFloat: number): string {
  const rounded = Math.round(midiFloat);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
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

// --- Transport ---------------------------------------------------------------
el.playBtn.addEventListener('click', async () => {
  if (!running) {
    pushConfig();
    await Mouth2Midi.start();
    running = true;
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
    el.playBtn.textContent = 'Start';
    el.playBtn.classList.remove('active');
    el.recBtn.disabled = true;
  }
});

el.recBtn.addEventListener('click', () => {
  if (!recording) {
    recorded = [];
    recordStart = performance.now();
    recording = true;
    el.recBtn.classList.add('active');
    el.saveBtn.disabled = true;
    el.status.textContent = 'Recording…';
  } else {
    stopRecording();
  }
});

function stopRecording() {
  recording = false;
  el.recBtn.classList.remove('active');
  el.saveBtn.disabled = recorded.length === 0;
  el.status.textContent = `Captured ${recorded.length} MIDI events.`;
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
