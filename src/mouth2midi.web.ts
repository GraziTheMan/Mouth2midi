import { WebPlugin } from '@capacitor/core';
import type { EngineConfig, Mouth2MidiPlugin } from './mouth2midi';

/**
 * Web fallback so the Vite UI runs in a desktop browser without a device.
 *
 * There is deliberately no browser pitch detection here: the whole point of
 * the project is that Web Audio is too slow for playable latency, so the web
 * build is a UI-only harness. Everything real happens in the native engine.
 */
export class Mouth2MidiWeb extends WebPlugin implements Mouth2MidiPlugin {
  private running = false;

  async start(): Promise<void> {
    this.running = true;
    console.info('[Mouth2Midi/web] start() — no native engine in the browser.');
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async configure(config: Partial<EngineConfig>): Promise<void> {
    console.info('[Mouth2Midi/web] configure()', config);
  }

  async getStatus() {
    return {
      running: this.running,
      sampleRate: 48000,
      framesPerBurst: 0,
      lowLatency: false,
    };
  }

  async setDetector(_options: { detector: 'yin' | 'spice' | 'beatbox' }) {
    return { detector: 'yin', available: false };
  }
}
