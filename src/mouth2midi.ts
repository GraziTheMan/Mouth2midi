import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Bridge to the native audio engine (Oboe + YIN in C++, reached through JNI).
 *
 * The JS side only ever sends *configuration* and *transport* commands down,
 * and receives *events* (note on/off, live pitch, percussion hits) back up.
 * All real-time DSP happens native — nothing latency-sensitive lives in JS.
 */

export type Scale =
  | 'chromatic'
  | 'major'
  | 'minor'
  | 'pentatonic'
  | 'blues'
  | 'dorian';

export interface EngineConfig {
  /** Root note for scale quantization, as a MIDI note number (60 = C4). */
  scaleRoot: number;
  /** Scale used to snap detected pitch to musical notes. */
  scale: Scale;
  /** MIDI channel for melodic notes (0-15). */
  channel: number;
  /**
   * Below this RMS level (0..1) the engine treats input as silence and will
   * not emit note-on events. Raises the noise floor / gates breath noise.
   */
  gateThreshold: number;
  /**
   * Minimum confidence (0..1) from the YIN detector before a pitch is trusted.
   * Higher = fewer octave errors / spurious notes, but drops quiet notes.
   */
  minConfidence: number;
  /** Lowest MIDI note that may trigger; pitches below are ignored. */
  minNote: number;
  /** Highest MIDI note that may trigger; pitches above are ignored. */
  maxNote: number;
  /**
   * Capture band in semitones: how close the pitch must sit to a scale note to
   * register (0.1 ≈ ±10¢ strict, 0.5 ≈ ±50¢ forgiving).
   */
  settleTol: number;
}

export interface NoteEvent {
  type: 'noteOn' | 'noteOff';
  /** Quantized MIDI note number. */
  note: number;
  /** 0..127. */
  velocity: number;
  /** Native monotonic timestamp in milliseconds. */
  timestampMs: number;
}

export interface PitchEvent {
  /** Raw detected fundamental in Hz (pre-quantization), or 0 if unvoiced. */
  frequency: number;
  /** Fractional MIDI note number (69 = A4 = 440Hz), for a smooth tuner UI. */
  midiFloat: number;
  /** YIN aperiodicity-based confidence, 0..1. */
  confidence: number;
  rms: number;
}

export type PercussionKind = 'kick' | 'snare' | 'hat';

export interface PercussionEvent {
  kind: PercussionKind;
  velocity: number;
  timestampMs: number;
  /** Classification features, surfaced for on-device tuning + calibration. */
  lowRatio?: number;
  highRatio?: number;
  zcr?: number;
  /** Spectral centroid in Hz (brightness). */
  centroid?: number;
  /** Envelope decay: RMS(2nd half)/RMS(1st half); ~0 snappy, →1 ringing. */
  decay?: number;
}

export interface Mouth2MidiPlugin {
  /** Acquire the mic + start the low-latency input stream. */
  start(): Promise<void>;
  /** Stop the stream and release the mic. */
  stop(): Promise<void>;
  /** Push new engine configuration; safe to call while running. */
  configure(config: Partial<EngineConfig>): Promise<void>;
  /** Report the negotiated native latency/buffer, for display + tuning. */
  getStatus(): Promise<{
    running: boolean;
    sampleRate: number;
    framesPerBurst: number;
    /** True if the device granted AAudio exclusive/MMAP (lowest latency). */
    lowLatency: boolean;
  }>;
  /**
   * Select the pitch detector. "spice" needs the model bundled at
   * assets/spice.tflite; if absent it stays on "yin" and returns
   * available:false so the UI can explain it.
   */
  setDetector(options: { detector: 'yin' | 'spice' | 'beatbox' }): Promise<{
    detector: string;
    available: boolean;
    error?: string;
  }>;

  addListener(
    eventName: 'note',
    listener: (event: NoteEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'pitch',
    listener: (event: PitchEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'percussion',
    listener: (event: PercussionEvent) => void,
  ): Promise<PluginListenerHandle>;
}

/**
 * On web (dev in a browser) there is no native engine, so calls no-op. This
 * lets the UI run in `npm run dev` without a device. Real audio only happens
 * once the app is running natively via Capacitor.
 */
export const Mouth2Midi = registerPlugin<Mouth2MidiPlugin>('Mouth2Midi', {
  web: () => import('./mouth2midi.web').then((m) => new m.Mouth2MidiWeb()),
});
