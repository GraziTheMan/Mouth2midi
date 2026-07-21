#include "spice_detector.h"

#include <android/log.h>

#include <algorithm>
#include <cmath>

#include "tensorflow/lite/interpreter.h"
#include "tensorflow/lite/kernels/register.h"
#include "tensorflow/lite/model.h"

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "Mouth2MIDI-SPICE", __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, "Mouth2MIDI-SPICE", __VA_ARGS__)

namespace m2m {

// SPICE pitch→Hz calibration (from the model card).
static constexpr float kPtOffset = 25.58f;
static constexpr float kPtSlope = 63.07f;

struct SpiceDetector::Impl {
    std::unique_ptr<tflite::FlatBufferModel> model;
    std::unique_ptr<tflite::Interpreter> interpreter;
};

SpiceDetector::SpiceDetector(int sampleRate, const void* modelBytes, size_t modelSize)
    : impl_(std::make_unique<Impl>()), sampleRate_(sampleRate) {
    if (!modelBytes || modelSize == 0) {
        LOGI("No SPICE model provided; detector unavailable (engine uses YIN).");
        return;
    }
    impl_->model = tflite::FlatBufferModel::BuildFromBuffer(
        static_cast<const char*>(modelBytes), modelSize);
    if (!impl_->model) {
        LOGW("Failed to parse SPICE model.");
        return;
    }
    tflite::ops::builtin::BuiltinOpResolver resolver;
    tflite::InterpreterBuilder(*impl_->model, resolver)(&impl_->interpreter);
    if (!impl_->interpreter || impl_->interpreter->AllocateTensors() != kTfLiteOk) {
        LOGW("Failed to build SPICE interpreter.");
        impl_->interpreter.reset();
        return;
    }
    available_ = true;
    LOGI("SPICE model loaded (%zu bytes).", modelSize);
}

SpiceDetector::~SpiceDetector() = default;

PitchResult SpiceDetector::process(const float* samples, size_t n) {
    PitchResult r;
    if (samples && n > 0) {
        float energy = 0.0f;
        for (size_t i = 0; i < n; ++i) energy += samples[i] * samples[i];
        r.rms = std::sqrt(energy / static_cast<float>(n));
    }
    if (!available_ || !impl_->interpreter) return r;  // engine falls back to YIN

    // Downsample 48k → 16k (SPICE's rate) by simple decimation. A proper
    // polyphase resampler is a later refinement; decimation is fine for a first
    // pass since we low-pass implicitly via the analysis window.
    const int decim = std::max(1, sampleRate_ / 16000);
    resampled_.clear();
    for (size_t i = 0; i < n; i += decim) resampled_.push_back(samples[i]);

    auto* interp = impl_->interpreter.get();
    const int inIdx = interp->inputs()[0];
    // SPICE takes a 1-D variable-length float input; resize to our window.
    interp->ResizeInputTensor(inIdx, {static_cast<int>(resampled_.size())});
    if (interp->AllocateTensors() != kTfLiteOk) return r;
    std::copy(resampled_.begin(), resampled_.end(), interp->typed_input_tensor<float>(0));

    if (interp->Invoke() != kTfLiteOk) return r;

    // Outputs: [0] pitch (0..1), [1] uncertainty (0..1). Take the last frame.
    const float* pitchOut = interp->typed_output_tensor<float>(0);
    const float* uncOut = interp->typed_output_tensor<float>(1);
    const TfLiteTensor* pitchTensor = interp->output_tensor(0);
    const int frames = pitchTensor->dims->size > 0
                           ? pitchTensor->dims->data[pitchTensor->dims->size - 1]
                           : 1;
    const int last = frames > 0 ? frames - 1 : 0;

    const float pitch = pitchOut[last];
    const float uncertainty = uncOut ? uncOut[last] : 0.0f;
    const float cqtBin = pitch * kPtSlope + kPtOffset;
    r.frequency = 10.0f * std::pow(2.0f, cqtBin / 12.0f);
    r.confidence = 1.0f - uncertainty;
    if (r.confidence < 0.0f) r.confidence = 0.0f;
    return r;
}

}  // namespace m2m
