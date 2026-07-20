#include "yin.h"

#include <cmath>

namespace m2m {

Yin::Yin(int sampleRate, size_t bufferSize, float threshold)
    : sampleRate_(sampleRate),
      bufferSize_(bufferSize),
      halfBuffer_(bufferSize / 2),
      threshold_(threshold),
      yinBuffer_(bufferSize / 2, 0.0f) {}

// Step 1: squared-difference function d(tau).
void Yin::difference(const float* samples) {
    for (size_t tau = 0; tau < halfBuffer_; ++tau) {
        float sum = 0.0f;
        for (size_t i = 0; i < halfBuffer_; ++i) {
            const float delta = samples[i] - samples[i + tau];
            sum += delta * delta;
        }
        yinBuffer_[tau] = sum;
    }
}

// Step 2: cumulative mean normalized difference d'(tau).
void Yin::cumulativeMeanNormalizedDifference() {
    yinBuffer_[0] = 1.0f;
    float runningSum = 0.0f;
    for (size_t tau = 1; tau < halfBuffer_; ++tau) {
        runningSum += yinBuffer_[tau];
        // Guard against divide-by-zero on pure silence.
        yinBuffer_[tau] *= (runningSum > 0.0f)
                               ? static_cast<float>(tau) / runningSum
                               : 1.0f;
    }
}

// Step 3: absolute threshold — first dip below threshold, then descend to its
// local minimum. Returns -1 if nothing qualifies (unvoiced).
int Yin::absoluteThreshold() {
    for (size_t tau = 2; tau < halfBuffer_; ++tau) {
        if (yinBuffer_[tau] < threshold_) {
            while (tau + 1 < halfBuffer_ &&
                   yinBuffer_[tau + 1] < yinBuffer_[tau]) {
                ++tau;
            }
            return static_cast<int>(tau);
        }
    }
    return -1;
}

// Step 4: parabolic interpolation around the chosen lag for sub-sample
// precision (better tuning accuracy, especially at high notes).
float Yin::parabolicInterpolation(int tauEstimate) const {
    if (tauEstimate <= 0 || tauEstimate >= static_cast<int>(halfBuffer_) - 1) {
        return static_cast<float>(tauEstimate);
    }
    const float s0 = yinBuffer_[tauEstimate - 1];
    const float s1 = yinBuffer_[tauEstimate];
    const float s2 = yinBuffer_[tauEstimate + 1];
    const float denom = 2.0f * (2.0f * s1 - s2 - s0);
    if (std::fabs(denom) < 1e-9f) return static_cast<float>(tauEstimate);
    return tauEstimate + (s2 - s0) / denom;
}

PitchResult Yin::process(const float* samples, size_t n) {
    PitchResult r;
    if (n < bufferSize_) return r;  // need a full window

    // RMS for gating / velocity.
    float energy = 0.0f;
    for (size_t i = 0; i < bufferSize_; ++i) energy += samples[i] * samples[i];
    r.rms = std::sqrt(energy / static_cast<float>(bufferSize_));

    difference(samples);
    cumulativeMeanNormalizedDifference();

    const int tau = absoluteThreshold();
    if (tau < 0) return r;  // unvoiced

    const float betterTau = parabolicInterpolation(tau);
    r.frequency = static_cast<float>(sampleRate_) / betterTau;
    // Aperiodicity at the lag → confidence. d'(tau) near 0 = strongly periodic.
    r.confidence = 1.0f - yinBuffer_[tau];
    if (r.confidence < 0.0f) r.confidence = 0.0f;
    return r;
}

}  // namespace m2m
