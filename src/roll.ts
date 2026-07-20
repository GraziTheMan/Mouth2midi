import type { Scale } from './mouth2midi';

/**
 * Live scrolling piano-roll. Time flows right→left with "now" at the right
 * edge. It overlays two things so you can see where the detector agrees with
 * your voice:
 *   - the raw pitch trace (continuous, what YIN heard), and
 *   - committed MIDI note blocks (quantized note-on/off the recorder captures).
 *
 * Purely a monitor — it reads events, holds no app state, and runs on its own
 * rAF loop whether or not the engine is running.
 */

export interface RollOptions {
  currentScale: () => Scale;
  currentRoot: () => number; // MIDI note of scale root
  isRecording: () => boolean;
  range: () => [number, number]; // [minNote, maxNote] gate bounds
}

export interface Roll {
  addPitch(midiFloat: number, confidence: number): void;
  addNote(type: 'noteOn' | 'noteOff', note: number, velocity: number): void;
}

const SCALE_STEPS: Record<Scale, number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
};

const WINDOW_MS = 6000; // visible time span
const GAP_MS = 140; // break the pitch line across silences longer than this

const COL = {
  bg: '#15171d',
  lane: '#20232c',
  laneInScale: '#272b39',
  octaveLine: '#31384a',
  trace: '#21d4a8',
  note: '#7c5cff',
  now: '#4a5169',
  rec: '#ff5c72',
  label: '#6b7180',
  range: '#f0a63a',
};

interface PitchPoint {
  t: number;
  midi: number;
  conf: number;
}
interface Segment {
  note: number;
  start: number;
  end: number | null;
  vel: number;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function createRoll(canvas: HTMLCanvasElement, opts: RollOptions): Roll {
  const ctx = canvas.getContext('2d');
  const pitches: PitchPoint[] = [];
  const segments: Segment[] = [];

  // Eased view range (MIDI) so the vertical zoom follows your range smoothly.
  let viewLo = 52;
  let viewHi = 76;

  let cssW = 0;
  let cssH = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    cssW = canvas.clientWidth;
    cssH = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  new ResizeObserver(resize).observe(canvas);
  window.addEventListener('resize', resize);

  function prune(now: number) {
    const cutoff = now - WINDOW_MS;
    while (pitches.length && pitches[0].t < cutoff) pitches.shift();
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i];
      if ((s.end ?? now) < cutoff) segments.splice(i, 1);
    }
  }

  function targetRange(): [number, number] {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pitches) {
      if (p.midi < lo) lo = p.midi;
      if (p.midi > hi) hi = p.midi;
    }
    for (const s of segments) {
      if (s.note < lo) lo = s.note;
      if (s.note > hi) hi = s.note;
    }
    if (!isFinite(lo)) {
      lo = 60;
      hi = 60;
    }
    const mid = (lo + hi) / 2;
    let span = Math.max(hi - lo + 6, 14); // pad + minimum span
    span = Math.min(span, 48);
    return [mid - span / 2, mid + span / 2];
  }

  const xForTime = (now: number, t: number) => cssW * (1 - (now - t) / WINDOW_MS);
  const yForMidi = (midi: number) =>
    cssH * (1 - (midi - viewLo) / (viewHi - viewLo));

  function render() {
    requestAnimationFrame(render);
    if (!ctx) return;
    const now = performance.now();
    prune(now);

    const [tLo, tHi] = targetRange();
    viewLo += (tLo - viewLo) * 0.08;
    viewHi += (tHi - viewHi) * 0.08;

    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    // Note lanes, shading the ones in the active scale.
    const scale = opts.currentScale();
    const root = ((opts.currentRoot() % 12) + 12) % 12;
    const steps = new Set(SCALE_STEPS[scale].map((s) => (s + root) % 12));
    const loN = Math.floor(viewLo);
    const hiN = Math.ceil(viewHi);
    for (let n = loN; n <= hiN; n++) {
      const yTop = yForMidi(n + 0.5);
      const yBot = yForMidi(n - 0.5);
      const pc = ((n % 12) + 12) % 12;
      ctx.fillStyle = steps.has(pc) ? COL.laneInScale : COL.lane;
      ctx.fillRect(0, yTop, cssW, yBot - yTop);
      if (pc === 0) {
        ctx.strokeStyle = COL.octaveLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, yBot);
        ctx.lineTo(cssW, yBot);
        ctx.stroke();
        ctx.fillStyle = COL.label;
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(`${NOTE_NAMES[pc]}${Math.floor(n / 12) - 1}`, 4, yBot - 3);
      }
    }

    // One-second time gridlines for a sense of scale.
    ctx.strokeStyle = COL.lane;
    ctx.lineWidth = 1;
    for (let s = 0; s <= WINDOW_MS / 1000; s++) {
      const x = xForTime(now, now - s * 1000);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssH);
      ctx.stroke();
    }

    // Committed note blocks.
    const laneH = cssH / (viewHi - viewLo);
    for (const seg of segments) {
      const x0 = xForTime(now, seg.start);
      const x1 = xForTime(now, seg.end ?? now);
      const y = yForMidi(seg.note) - laneH * 0.4;
      const h = laneH * 0.8;
      ctx.fillStyle = COL.note;
      ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, seg.vel / 110);
      roundRect(ctx, x0, y, Math.max(2, x1 - x0), h, 3);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Raw pitch trace, broken across silences.
    ctx.strokeStyle = COL.trace;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    let drawing = false;
    let prevT = 0;
    ctx.beginPath();
    for (const p of pitches) {
      const x = xForTime(now, p.t);
      const y = yForMidi(p.midi);
      if (!drawing || p.t - prevT > GAP_MS) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        ctx.lineTo(x, y);
      }
      prevT = p.t;
    }
    ctx.stroke();

    // Pitch-range gate bounds: shade the excluded regions and dash the edges,
    // so you can see when your pitch (green trace) falls outside the band.
    const [rLo, rHi] = opts.range();
    const yHi = yForMidi(rHi + 0.5);
    const yLo = yForMidi(rLo - 0.5);
    ctx.fillStyle = 'rgba(10,11,15,0.34)';
    if (yHi > 0) ctx.fillRect(0, 0, cssW, Math.min(yHi, cssH));
    if (yLo < cssH) ctx.fillRect(0, Math.max(0, yLo), cssW, cssH - Math.max(0, yLo));
    ctx.strokeStyle = COL.range;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    for (const y of [yHi, yLo]) {
      if (y >= 0 && y <= cssH) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(cssW, y);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // "Now" line + recording indicator.
    ctx.strokeStyle = opts.isRecording() ? COL.rec : COL.now;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cssW - 1, 0);
    ctx.lineTo(cssW - 1, cssH);
    ctx.stroke();
    if (opts.isRecording()) {
      ctx.fillStyle = COL.rec;
      ctx.beginPath();
      ctx.arc(cssW - 12, 12, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  requestAnimationFrame(render);

  return {
    addPitch(midiFloat: number, confidence: number) {
      if (midiFloat <= 0) return;
      pitches.push({ t: performance.now(), midi: midiFloat, conf: confidence });
    },
    addNote(type, note, velocity) {
      const now = performance.now();
      if (type === 'noteOn') {
        segments.push({ note, start: now, end: null, vel: velocity });
      } else {
        // Close the most recent open segment for this note.
        for (let i = segments.length - 1; i >= 0; i--) {
          if (segments[i].note === note && segments[i].end === null) {
            segments[i].end = now;
            break;
          }
        }
      }
    },
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
