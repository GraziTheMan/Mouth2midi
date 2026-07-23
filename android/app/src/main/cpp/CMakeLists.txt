cmake_minimum_required(VERSION 3.22.1)
project(mouth2midi LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Release audio code wants aggressive optimization; NEON is available on all
# arm64 Android targets (S24 Ultra is arm64-v8a).
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -ffast-math")

# --- Oboe ---------------------------------------------------------------------
# Pulled in via the Prefab package published by the 'com.google.oboe:oboe'
# AAR (add it to the module build.gradle dependencies; see native-android
# README). Prefab exposes the `oboe::oboe` target.
find_package(oboe REQUIRED CONFIG)

# NOTE: TensorFlow Lite is NOT linked here. The org.tensorflow:tensorflow-lite
# AAR ships only the Java/JNI library, not a C++ prefab package, so SPICE
# inference runs through the TFLite *Java* Interpreter on a worker thread and
# feeds pitch back into this native engine via JNI (see docs/ML-SPICE.md).

add_library(mouth2midi SHARED
    native-lib.cpp
    audio_engine.cpp
    yin.cpp
    spice_detector.cpp
    note_tracker.cpp
    beat_detector.cpp
)

find_library(log-lib log)

target_link_libraries(mouth2midi
    oboe::oboe
    ${log-lib}
)
