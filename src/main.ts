import { Mouth2Midi, type Scale } from './mouth2midi';
import { renderSmf, type RecordedNote } from './smf';
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
  playBtn: $<HTMLButtonElement>('playBtn'),
  recBtn: $<HTMLButtonElement>('recBtn'),
  saveBtn: $<HTMLButtonElement>('saveBtn'),
  status: $('status'),
};

let running = false;
let recording = false;
let recordStart = 0;
let recorded: RecordedNote[] = [];

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
});

// --- Note events → recorder --------------------------------------------------
void Mouth2Midi.addListener('note', (n) => {
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
  const bytes = renderSmf(recorded, 120);
  const filename = `mouth2midi-${Date.now()}.mid`;
  await exportMidi(filename, bytes);
});

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
