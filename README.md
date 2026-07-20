# Mouth2MIDI

A Vochlea/Dubler-style real-time **voice-to-MIDI** instrument for Android
(targeting the Galaxy S24 Ultra / Snapdragon 8 Gen 3).

Sing or hum → get clean, scale-quantized MIDI notes with instrument-grade
latency; record a take and save it as a `.mid` file. Built the right way for
low latency: **all real-time DSP is native C++ on Google Oboe**, with a
fast Vite/Capacitor web UI on top.

> Status: **Phase 1 scaffold.** The web UI runs today; the native engine
> (Oboe + a real YIN pitch detector + note tracker + JNI bridge) is wired into
> a committed Capacitor Android project and built on every push by GitHub
> Actions — grab the APK from the workflow artifacts (see [CI](#ci--getting-the-apk)).

## Why not just Web Audio?

Because it can't hit playable latency on Android. Anything over ~15ms
mouth-to-note feels disconnected. The only reliable path to sub-15ms is to
bypass the Java/OS audio mixer and go to the metal:

- **Oboe → AAudio, exclusive mode + MMAP** for the mic stream.
- **YIN** (autocorrelation) for pitch — fast and accurate on a monophonic
  voice, and far better than raw FFT for this.
- **JNI + a Capacitor plugin** so the beautiful UI stays HTML/JS but talks to
  the native engine instantly.

A realistic latency note: the audio *buffer* can be a few ms, but pitched notes
also need enough signal to detect a period — a low note fundamentally needs
~20ms before YIN can be sure. Percussion/beatbox hits can be much faster. So
drums will always feel snappier than sung pitch; that's physics, not a bug.

## Architecture

```
┌─────────────────────────────────────────┐
│  Web UI  (Vite + TypeScript, Capacitor)  │   src/
│  tuner · scale/root · gate · record/save │
└───────────────┬──────────────────────────┘
                │  Capacitor plugin (registerPlugin)
                │  commands down · events up
┌───────────────▼──────────────────────────┐
│  Mouth2MidiPlugin (Java)                  │   android/app/src/main/java/
│  perms · polls native event queue         │
└───────────────┬──────────────────────────┘
                │  JNI
┌───────────────▼──────────────────────────┐
│  C++ engine                               │   android/app/src/main/cpp/
│  Oboe input (exclusive/MMAP)              │
│    → YIN pitch detector                   │
│    → NoteTracker (gate/quantize/debounce) │
│    → event queue                          │
└───────────────────────────────────────────┘
```

`.mid` export lives in the web layer ([`src/smf.ts`](src/smf.ts)) — a proper
Standard MIDI File writer — and saves via Capacitor Filesystem on device.

## Roadmap

- **Phase 1 — Core instrument (this scaffold).** Oboe input, YIN pitch, note
  tracking with scale quantization, live tuner UI, `.mid` recording. Goal:
  prove the latency is playable.
- **Phase 1.5 — Live MIDI out.** Emit notes over **BLE MIDI** (most reliable
  cross-platform; DAWs see it natively) and, where the device's USB stack
  allows, USB-gadget MIDI. Uses Android `MidiManager`.
- **Phase 2 — Note-logic polish.** Better onset/offset, glide handling,
  octave-error suppression, velocity curves. This is where "feel" is won.
- **Phase 3 — Beatbox mode.** Onset detection + a tiny TFLite classifier
  (kick/snare/hat) mapped to MIDI drum notes. The plugin already reserves a
  `percussion` event.

## Getting started

### Web UI (no device needed)

```bash
npm install
npm run dev      # open the printed localhost URL
```

In the browser there's no native engine, so the tuner stays quiet — it's a
UI harness. `.mid` "Save" falls back to a browser download so you can verify
the file writer. To exercise real audio, build the native app.

### Native app (Android)

The Capacitor `android/` project is committed with the native engine already
wired in (CMake + Oboe + the plugin registered in `MainActivity`). You only
need to refresh the web assets and build:

```bash
npm run build
npx cap sync android     # copies dist/ into the android project
npx cap open android     # build & run on the S24 Ultra from Android Studio
# ...or headless:
cd android && ./gradlew assembleDebug
```

Requirements: JDK 17, Android SDK 34, NDK `26.1.10909125`, CMake `3.22.1`
(Android Studio installs these; CI installs them explicitly).

## CI — getting the APK

Every push to `main` (and every PR) triggers
[`.github/workflows/android.yml`](.github/workflows/android.yml), which builds
a debug APK on a GitHub-hosted runner and uploads it as a workflow artifact
named **`mouth2midi-debug-apk`**. Open the run under the repo's **Actions**
tab and download it from the artifacts section — no local Android toolchain
needed. `workflow_dispatch` lets you trigger a build manually too.

## Project layout

```
src/                        Web UI + plugin bridge + SMF writer
  main.ts                   UI wiring, recorder, .mid export
  mouth2midi.ts             Capacitor plugin interface (typed)
  mouth2midi.web.ts         Browser no-op fallback
  smf.ts                    Standard MIDI File writer
android/app/src/main/cpp/   C++ engine (Oboe + YIN + note tracker + JNI)
android/app/src/main/java/  MainActivity + Mouth2MidiPlugin + JNI wrapper
.github/workflows/          GitHub Actions Android build
capacitor.config.ts         App id, webDir, dev live-reload hook
```

## License

MIT — see [LICENSE](LICENSE).
