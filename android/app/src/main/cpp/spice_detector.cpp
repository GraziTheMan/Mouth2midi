#include "spice_detector.h"

#include <cmath>

namespace m2m {

// SPICE inference does NOT run here. The tensorflow-lite AAR only exposes a
// Java/JNI library (no C++ prefab), so pitch is computed by the TFLite Java
// Interpreter on a worker thread and pushed into the native NoteTracker via
// JNI. This class stays a compiling placeholder in the PitchDetector hierarchy;
// see docs/ML-SPICE.md for the actual (Java-side) integration.
struct SpiceDetector::Impl {};

SpiceDetector::SpiceDetector(int sampleRate, const void* modelBytes, size_t modelSize)
    : impl_(std::make_unique<Impl>()), sampleRate_(sampleRate) {
    (void)modelBytes;
    (void)modelSize;
    available_ = false;  // C++ SPICE path unused; inference happens in Java.
}

SpiceDetector::~SpiceDetector() = default;

PitchResult SpiceDetector::process(const float* samples, size_t n) {
    PitchResult r;
    if (samples && n > 0) {
        float energy = 0.0f;
        for (size_t i = 0; i < n; ++i) energy += samples[i] * samples[i];
        r.rms = std::sqrt(energy / static_cast<float>(n));
    }
    return r;
}

}  // namespace m2m
