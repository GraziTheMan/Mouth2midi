/**
 * Minimal Standard MIDI File (SMF, format 0) writer.
 *
 * You record a stream of timestamped note events from the native engine, then
 * call `renderSmf()` to get a valid .mid file as bytes. This is the "easy"
 * part of the project, but doing it correctly (variable-length delta times,
 * running status not assumed, proper track chunk length) matters if you want
 * DAWs to open the file cleanly.
 */

export interface RecordedNote {
  /** Time from record-start, in milliseconds. */
  timeMs: number;
  note: number; // 0..127
  velocity: number; // 1..127; a value of 0 is treated as note-off by MIDI
  on: boolean; // true = note-on, false = note-off
  channel?: number; // 0..15, default 0
}

/** Ticks per quarter note (PPQ). 480 is a common, DAW-friendly resolution. */
const PPQ = 480;

/** Encode a MIDI variable-length quantity. */
function writeVarLen(value: number): number[] {
  let buffer = value & 0x7f;
  const bytes: number[] = [];
  while ((value >>= 7) > 0) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  // Flush
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
}

function writeUint32(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function writeUint16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

/**
 * Render recorded notes to SMF bytes.
 * @param notes  Events in any order (they are sorted by time here).
 * @param bpm    Tempo written into the file. Absolute event times are
 *               converted to ticks using this tempo.
 */
export function renderSmf(notes: RecordedNote[], bpm = 120): Uint8Array {
  const sorted = [...notes].sort((a, b) => a.timeMs - b.timeMs);

  const msPerQuarter = 60000 / bpm;
  const msToTicks = (ms: number) => Math.round((ms / msPerQuarter) * PPQ);

  const track: number[] = [];

  // Tempo meta-event (FF 51 03 tttttt), microseconds per quarter note.
  const usPerQuarter = Math.round(60000000 / bpm);
  track.push(
    ...writeVarLen(0),
    0xff,
    0x51,
    0x03,
    (usPerQuarter >>> 16) & 0xff,
    (usPerQuarter >>> 8) & 0xff,
    usPerQuarter & 0xff,
  );

  let lastTick = 0;
  for (const ev of sorted) {
    const tick = msToTicks(ev.timeMs);
    const delta = Math.max(0, tick - lastTick);
    lastTick = tick;

    const channel = (ev.channel ?? 0) & 0x0f;
    const status = (ev.on ? 0x90 : 0x80) | channel;
    track.push(
      ...writeVarLen(delta),
      status,
      ev.note & 0x7f,
      (ev.on ? ev.velocity : 0) & 0x7f,
    );
  }

  // End-of-track meta-event.
  track.push(...writeVarLen(0), 0xff, 0x2f, 0x00);

  const header = [
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    ...writeUint32(6), // header length
    ...writeUint16(0), // format 0
    ...writeUint16(1), // one track
    ...writeUint16(PPQ), // division
  ];

  const trackChunk = [
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    ...writeUint32(track.length),
    ...track,
  ];

  return new Uint8Array([...header, ...trackChunk]);
}
