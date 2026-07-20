# Native Android engine — wiring guide

These are the native sources for the low-latency engine. Capacitor generates
the actual `android/` Gradle project (git-ignored), so these files live here in
version control and get copied in during setup. Follow the steps once; after
that `npx cap sync` keeps the web assets updated.

## Layout

```
native-android/
├── cpp/                       C++ engine (Oboe + YIN + note tracker + JNI)
│   ├── CMakeLists.txt
│   ├── native-lib.cpp         JNI entry points
│   ├── audio_engine.{h,cpp}   Oboe input stream, exclusive/MMAP fast path
│   ├── yin.{h,cpp}            YIN pitch detector (real implementation)
│   └── note_tracker.{h,cpp}   pitch → quantized MIDI note logic
└── java/com/grazitheman/mouth2midi/
    ├── AudioEngineNative.java  JNI wrapper (loads libmouth2midi.so)
    └── Mouth2MidiPlugin.java   Capacitor plugin (JS bridge)
```

## One-time setup

1. **Generate the Android project:**
   ```bash
   npm install
   npm run build
   npx cap add android
   ```

2. **Add the C++ sources.** Copy `native-android/cpp` into the app module:
   ```bash
   mkdir -p android/app/src/main/cpp
   cp native-android/cpp/* android/app/src/main/cpp/
   ```

3. **Add the Java sources** to the app package:
   ```bash
   mkdir -p android/app/src/main/java/com/grazitheman/mouth2midi
   cp native-android/java/com/grazitheman/mouth2midi/*.java \
      android/app/src/main/java/com/grazitheman/mouth2midi/
   ```

4. **Wire up CMake + Oboe in `android/app/build.gradle`:**
   ```gradle
   android {
       defaultConfig {
           ndk { abiFilters 'arm64-v8a' } // S24 Ultra
       }
       externalNativeBuild {
           cmake { path "src/main/cpp/CMakeLists.txt" }
       }
       buildFeatures { prefab true }   // exposes Oboe to CMake
   }
   dependencies {
       implementation 'com.google.oboe:oboe:1.9.0'
   }
   ```

5. **Register the plugin.** Capacitor auto-discovers plugins in the app
   package, so `Mouth2MidiPlugin` is picked up once it compiles. If you use an
   explicit registration list, add it in `MainActivity`:
   ```java
   registerPlugin(Mouth2MidiPlugin.class);
   ```

6. **Manifest permission** — add to `android/app/src/main/AndroidManifest.xml`:
   ```xml
   <uses-permission android:name="android.permission.RECORD_AUDIO" />
   <uses-feature android:name="android.hardware.microphone" android:required="true" />
   ```

7. **Build & run:**
   ```bash
   npx cap open android   # opens Android Studio; Run onto the S24 Ultra
   ```

## Verifying the low-latency path

On first `start()`, check Logcat for:

```
Engine started: 48000 Hz, burst=96, lowLatency=1
```

`lowLatency=1` means AAudio granted exclusive mode (the MMAP fast path). If you
see `lowLatency=0`, the device fell back to a shared stream — still works, just
higher latency. The in-app latency badge reflects the same status.

## Notes / production TODOs

- The event queue in `native-lib.cpp` uses a mutex-guarded deque. For the
  hot path, swap it for a lock-free SPSC ring buffer so the audio thread never
  contends on a lock.
- Percussion (`kick`/`snare`/`hat`) classification is not wired yet — that is
  Phase 3 (TFLite). The plugin event contract already reserves the
  `percussion` event so the UI won't need changes.
- Live MIDI output (BLE MIDI / USB) is Phase 1.5 — see the root README.
