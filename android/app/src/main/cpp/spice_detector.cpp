#include "spice_detector.h"

#include <cmath>

namespace m2m {

// The interpreter lives behind pImpl so this translation unit has no TFLite
// include/link dependency yet. When TFLite is added (see docs/ML-SPICE.md),
// Impl gains the tflite::Interpreter, FlatBufferModel, and delegate members.
struct SpiceDetector::Impl {
    // std::unique_ptr<tflite::FlatBufferModel> model;
    // std::unique_ptr<tflite::Interpreter> interpreter;
};

SpiceDetector::SpiceDetector(int sampleRate, const void* modelBytes, size_t modelSize)
    : impl_(std::make_unique<Impl>()), sampleRate_(sampleRate) {
    // No model yet → stay unavailable so AudioEngine falls back to YIN.
    // Integration TODO (docs/ML-SPICE.md):
    //   1. model = BuildFromBuffer(modelBytes, modelSize)
    //   2. build interpreter, apply GPU/NNAPI delegate for the Snapdragon NPU
    //   3. allocate tensors; cache input/output indices
    //   4. available_ = (interpreter != nullptr)
    (void)modelBytes;
    (void)modelSize;
    available_ = false;
}

SpiceDetector::~SpiceDetector() = default;

PitchResult SpiceDetector::process(const float* samples, size_t n) {
    PitchResult r;
    // RMS is cheap and useful even before the model runs.
    if (samples && n > 0) {
        float energy = 0.0f;
        for (size_t i = 0; i < n; ++i) energy += samples[i] * samples[i];
        r.rms = std::sqrt(energy / static_cast<float>(n));
    }
    if (!available_) return r;  // fall back handled by the engine

    // Integration TODO (docs/ML-SPICE.md):
    //   - resample the 48k window to 16k into resampled_
    //   - copy into the input tensor, Invoke()
    //   - read the pitch output (0..1) and confidence output
    //   - map pitch to Hz: f = PT_OFFSET * 2^(pitch * PT_SLOPE / 12)  (SPICE
    //     calibration constants), set r.frequency / r.confidence
    return r;
}

}  // namespace m2m
