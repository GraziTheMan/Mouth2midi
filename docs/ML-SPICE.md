# Learned pitch detection with SPICE (TFLite)

This is the plan for Track A of the ML work: replacing/augmenting YIN with a
learned pitch model to eliminate octave errors ("phantom notes") and improve
robustness in noise.

## Why SPICE

YIN is autocorrelation-based: fast and low-latency, but structurally prone to
octave slips and noise sensitivity. **SPICE** (Self-supervised PItch Estimation,
Google) learns pitch from the spectral fingerprint, so it largely avoids octave
errors and holds up in noise. It's lightweight and ships as a TFLite model,
which makes it a good first on-device model. (CREPE-tiny is the heavier,
higher-accuracy alternative if SPICE isn't good enough.)

## Current state (scaffold)

- `pitch_detector.h` — `PitchDetector` interface + shared `PitchResult`.
- `yin.{h,cpp}` — implements `PitchDetector` (`name() == "yin"`).
- `spice_detector.{h,cpp}` — skeleton implementing `PitchDetector`; reports
  `isAvailable() == false` so the engine falls back to YIN.
- `audio_engine.cpp` — holds a `std::unique_ptr<PitchDetector>`, defaults to
  YIN. Swapping detectors is a one-line change once SPICE is available.

So the pipeline is already detector-agnostic. The remaining work is wiring
TFLite + the model.

## Architecture decision: TFLite **Java** Interpreter, not C++

We tried linking the TFLite C++ API via prefab and hit a wall:
`find_package(tensorflowlite)` fails because the `org.tensorflow:tensorflow-lite`
AAR ships **only the Java/JNI library — no C++ prefab package**. Rather than
build TFLite from source, SPICE runs through the **Java `Interpreter`** on a
worker thread. This also keeps neural-net inference **off the realtime audio
thread** (a hard requirement — a per-hop NN on the audio callback would xrun).

The `org.tensorflow:tensorflow-lite` dependency is kept in `build.gradle` for
exactly this (the Java API); no CMake/native TFLite linkage.

## Integration steps (Java path)

1. **Native audio tap.** In `AudioEngine`, keep a small lock-free ring of the
   most recent mono samples **downsampled to 16 kHz** (SPICE's rate), filled
   from the audio callback (realtime-safe). Expose JNI
   `nativePullSpiceWindow(float[] out) -> bool` that copies the latest window
   for a Java thread to read (no allocation on the audio thread).

2. **Java SPICE worker** (`SpiceEngine.java`): load `spice.tflite` into a TFLite
   `Interpreter` (optionally with the NNAPI/GPU delegate for the Snapdragon
   NPU). On a background thread, poll `nativePullSpiceWindow`, `run()` the
   interpreter, read outputs, map to Hz:
   ```
   PT_OFFSET = 25.58, PT_SLOPE = 63.07
   cqt_bin   = pitch * PT_SLOPE + PT_OFFSET
   hz        = 10 * 2^(cqt_bin / 12)
   confidence = 1 - uncertainty
   ```
   Push the result down via JNI `nativePushExternalPitch(hz, confidence, rms)`.

3. **Native tracker on pushed pitch.** `nativePushExternalPitch` runs the
   existing `NoteTracker` (cheap, not realtime-critical) and enqueues the
   resulting note/pitch events on the same queue Java already polls. In SPICE
   mode the audio callback skips YIN + tracking and only fills the 16k ring.

4. **Model delivery.** No binary in the repo. `SpiceEngine` downloads
   `spice.tflite` once to `filesDir` (Kaggle/TF Hub, URL overridable) and caches
   it. Until present, SPICE reports unavailable and the app stays on YIN.

5. **A/B toggle.** A `detector` setting (`"yin"` | `"spice"`) via a new plugin
   method + UI selector; `getStatus()` reports the active detector and whether
   SPICE fell back.

6. **Measure on-device.** SPICE need not run every hop — 30–50 Hz tracks a sung
   melody fine and eases the latency/CPU budget. Log inference time and tune the
   rate. Real-device, build-measure-adjust loop.

## Notes

- Keep YIN as the default and always-available fallback. SPICE is opt-in until
  proven on-device.
- The octave-error guard in `NoteTracker` stays useful for YIN; it's a no-op for
  SPICE (which won't produce octave jumps), so it can remain unconditionally.

## Track B (later): timbre / percussion

Beatbox classification (kick/snare/hat) and vowel→CC need a **separate** model
trained on *labeled* samples you record, plus an offline training step. Do this
after Track A proves the TFLite pipeline end-to-end.
