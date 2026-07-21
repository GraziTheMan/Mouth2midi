#pragma once
#include <cstddef>
#include <memory>
#include <vector>

#include "pitch_detector.h"

namespace m2m {

/**
 * Learned pitch detector backed by Google's SPICE model (Self-supervised
 * PItch Estimation) running through TensorFlow Lite.
 *
 * WHY: YIN is fast but structurally prone to octave errors (harmonic slips) and
 * degrades in noise. SPICE learns pitch from the full spectral fingerprint, so
 * it is far more robust — directly targeting the octave "phantom notes" and
 * noisy-environment misses YIN produces.
 *
 * STATUS: scaffold only. This compiles and reports isAvailable() == false until
 * the TFLite runtime + model are wired in, so the engine transparently falls
 * back to YIN. See docs/ML-SPICE.md for the integration steps (add the TFLite
 * dependency, bundle spice.tflite in assets, load it here, map outputs to Hz).
 */
class SpiceDetector : public PitchDetector {
public:
    // modelBytes/modelSize: the loaded spice.tflite blob (from Android assets).
    // Pass nullptr/0 to construct an unavailable detector (current default).
    SpiceDetector(int sampleRate, const void* modelBytes, size_t modelSize);
    ~SpiceDetector() override;

    PitchResult process(const float* samples, size_t n) override;
    const char* name() const override { return "spice"; }
    bool isAvailable() const override { return available_; }

private:
    struct Impl;                 // hides the TFLite interpreter (pImpl)
    std::unique_ptr<Impl> impl_;
    int sampleRate_;
    bool available_ = false;

    // SPICE expects 16 kHz mono. We resample the incoming 48 kHz window here.
    std::vector<float> resampled_;
};

}  // namespace m2m
