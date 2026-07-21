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

## Integration steps

1. **Add the TFLite dependency** to `android/app/build.gradle`:
   ```gradle
   dependencies {
       implementation 'org.tensorflow:tensorflow-lite:2.16.1'
       implementation 'org.tensorflow:tensorflow-lite-gpu:2.16.1' // NNAPI/GPU delegate
   }
   android { buildFeatures { prefab true } } // already enabled for Oboe
   ```
   Expose the TFLite C++ headers/libs to CMake (prefab package
   `tensorflow-lite`), then in `CMakeLists.txt`:
   ```cmake
   find_package(tensorflowlite REQUIRED CONFIG)
   target_link_libraries(mouth2midi tensorflowlite::tensorflowlite ...)
   ```
   NOTE: verify the exact prefab target name for the TFLite version chosen — this
   is the step most likely to need on-device iteration.

2. **Bundle the model.** Put `spice.tflite` in
   `android/app/src/main/assets/`. Load its bytes in Java (AssetManager) and
   pass the buffer down through JNI to `SpiceDetector`, or memory-map it.
   Model: TF Hub `google/spice/2` (or the lite variant).

3. **Fill in `SpiceDetector`** (`spice_detector.cpp`):
   - Build `FlatBufferModel::BuildFromBuffer(modelBytes, modelSize)`.
   - Build the interpreter; apply the GPU or NNAPI delegate for the Snapdragon
     NPU; `AllocateTensors()`.
   - Per window: **resample 48 kHz → 16 kHz** (SPICE's expected rate) into
     `resampled_`, copy into the input tensor, `Invoke()`.
   - Read outputs: SPICE returns a normalized `pitch` (0..1) and an
     `uncertainty`. Map to Hz with SPICE's calibration:
     ```
     PT_OFFSET = 25.58, PT_SLOPE = 63.07
     cqt_bin   = pitch * PT_SLOPE + PT_OFFSET
     hz        = 10 * 2^(cqt_bin / 12)
     confidence = 1 - uncertainty
     ```
   - Set `available_ = true` on success.

4. **A/B toggle.** Add a `detector` field (`"yin"` | `"spice"`) to the config
   path (JNI `nativeConfigure` → `AudioEngine`), and a UI selector. When
   `"spice"` is chosen but `!detector->isAvailable()`, fall back to YIN and
   surface that in `getStatus()` so the UI can show it.

5. **Measure on-device.** The hard constraint is latency: inference must fit the
   ~10.7 ms hop. Log inference time; if it's too slow at the full hop rate, run
   SPICE at a lower rate (e.g. every other hop) and interpolate, or downsize the
   window. This needs a real device — expect a build-measure-adjust loop.

## Notes

- Keep YIN as the default and always-available fallback. SPICE is opt-in until
  proven on-device.
- The octave-error guard in `NoteTracker` stays useful for YIN; it's a no-op for
  SPICE (which won't produce octave jumps), so it can remain unconditionally.

## Track B (later): timbre / percussion

Beatbox classification (kick/snare/hat) and vowel→CC need a **separate** model
trained on *labeled* samples you record, plus an offline training step. Do this
after Track A proves the TFLite pipeline end-to-end.
