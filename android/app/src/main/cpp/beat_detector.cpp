#include "beat_detector.h"

#include <algorithm>
#include <cmath>
#ifdef BEAT_DEBUG
#include <cstdio>
#endif

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace m2m {

BeatDetector::BeatDetector(int sampleRate) : sampleRate_(sampleRate) {
    classWin_ = static_cast<size_t>(sampleRate_ * 0.025);  // 25 ms
    ringSize_ = classWin_;
    ring_.assign(ringSize_, 0.0f);
}

void BeatDetector::reset() {
    writePos_ = 0;
    fastEnv_ = slowEnv_ = 0.0f;
    refractory_ = 0;
    onsetLevel_ = 0.0f;
    pending_ = false;
    pendingCount_ = 0;
    armed_ = true;
    std::fill(ring_.begin(), ring_.end(), 0.0f);
}

void BeatDetector::setSensitivity(float s) {
    if (s < 0.0f) s = 0.0f;
    if (s > 1.0f) s = 1.0f;
    // More sensitive → lower floor + smaller required jump.
    floor_ = 0.12f - 0.10f * s;   // 0.12 .. 0.02
    ratio_ = 2.4f - 0.9f * s;     // 2.4 .. 1.5
}

void BeatDetector::setOnsetFloor(float floor) {
    // Keep a small minimum so the detector never fires on pure numerical noise.
    if (floor < 0.015f) floor = 0.015f;
    if (floor > 1.0f) floor = 1.0f;
    floor_ = floor;
}

int BeatDetector::process(const float* samples, int n, BeatHit* out, int maxHits) {
    int count = 0;
    for (int i = 0; i < n; ++i) {
        const float x = samples[i];
        ring_[writePos_ % ringSize_] = x;
        ++writePos_;

        const float a = std::fabs(x);
        fastEnv_ += 0.30f * (a - fastEnv_);
        slowEnv_ += 0.004f * (a - slowEnv_);

        if (refractory_ > 0) --refractory_;

        // Delayed classification: once the post-onset window has filled, label it.
        if (pending_) {
            if (--pendingCount_ <= 0) {
                pending_ = false;
                if (count < maxHits) out[count++] = classify();
            }
        }

        // Re-arm (hysteresis): after a hit we won't fire again until the fast
        // envelope actually falls back down — below a fraction of the level that
        // triggered it, or near the floor. This is what stops a single vocal
        // sound (a plosive's vowel tail, a snare's "shhh") from re-triggering as
        // its envelope wobbles. One attack → one hit.
        if (!armed_ && fastEnv_ < std::max(floor_ * 0.6f, onsetLevel_ * kRearmFrac)) {
            armed_ = true;
        }

        // New onset: armed, past the minimum gap, and the fast env jumps above
        // both the adaptive baseline and the floor.
        if (armed_ && refractory_ == 0 && !pending_ &&
            fastEnv_ > slowEnv_ * ratio_ && fastEnv_ > floor_) {
            onsetLevel_ = fastEnv_;
            armed_ = false;
            refractory_ = static_cast<int>(sampleRate_ * 0.045);  // 45 ms min gap
            pending_ = true;
            pendingCount_ = static_cast<int>(classWin_);
        }
    }
    return count;
}

// Thresholds calibrated on real on-device captures. From the sample set:
//   kicks : low 0.53-0.74, high 0.00-0.36, zcr 0.01-0.08
//   snares: low 0.20-0.33, high 0.11-0.59, zcr 0.03-0.11
//   hats  : low 0.00-0.07, high 1.14-2.67, zcr 0.36-0.56
// Kick is low-dominated; hat vs snare separates cleanly on ZCR (big gap
// 0.11 -> 0.36), with a high-frequency-ratio backup. Earlier the hat cutoff
// (high > 2.2) was far too strict, so hats fell through to snare.
BeatHit::Kind BeatDetector::labelFrom(float lowRatio, float highRatio, float zcr) {
    if (lowRatio > 0.42f && zcr < 0.15f) return BeatHit::Kick;
    if (zcr > 0.20f || highRatio > 0.90f) return BeatHit::Hat;
    return BeatHit::Snare;
}

BeatHit BeatDetector::classify() const {
    // Analyze the most recent classWin_ samples (the transient just captured).
    // One-pole low-pass (~250 Hz) for low-band energy; first difference
    // (pre-emphasis) for high-band; zero-crossing rate for noisiness.
    const float lpAlpha = 0.03f;  // ~250 Hz at 48k
    float lp = 0.0f;
    float prev = 0.0f;
    double lowE = 0.0, highE = 0.0, totalE = 0.0;
    int crossings = 0;
    float peak = 0.0f;
    // Split the window in half to measure how fast the transient dies (decay).
    const size_t half = classWin_ / 2;
    double e1 = 0.0, e2 = 0.0;

    const size_t start = writePos_ - classWin_;
    for (size_t k = 0; k < classWin_; ++k) {
        const float x = ring_[(start + k) % ringSize_];
        lp += lpAlpha * (x - lp);
        const float d = x - prev;  // first difference → emphasises high freqs
        const double x2 = static_cast<double>(x) * x;
        lowE += static_cast<double>(lp) * lp;
        highE += static_cast<double>(d) * d;
        totalE += x2;
        if (k < half) e1 += x2; else e2 += x2;
        if ((x >= 0.0f) != (prev >= 0.0f)) ++crossings;
        prev = x;
        const float ax = std::fabs(x);
        if (ax > peak) peak = ax;
    }

    const double eps = 1e-9;
    const double lowRatio = lowE / (totalE + eps);
    const double highRatio = highE / (totalE + eps);  // first-diff emphasises highs
    const double zcr = static_cast<double>(crossings) / static_cast<double>(classWin_);
    // Spectral centroid (Hz) from the derivative estimate:
    //   f_c ≈ (fs / 2π) · sqrt(Σd² / Σx²).
    // A cheap, FFT-free brightness measure — kicks land low, hats high.
    const double centroid =
        (static_cast<double>(sampleRate_) / (2.0 * M_PI)) * std::sqrt(highRatio);
    // Decay: energy in the 2nd half vs the 1st. Short/snappy (hat) → ~0;
    // ringing (kick) → toward 1. Independent of brightness, so it separates
    // hat (dies instantly) from snare (lingers) where spectral features can't.
    const double decay = std::sqrt(e2 / (e1 + eps));
#ifdef BEAT_DEBUG
    std::fprintf(stderr,
                 "  [feat] lowRatio=%.3f highRatio=%.3f zcr=%.3f centroid=%.0f decay=%.3f\n",
                 lowRatio, highRatio, zcr, centroid, decay);
#endif

    BeatHit hit;
    hit.kind = labelFrom(static_cast<float>(lowRatio), static_cast<float>(highRatio),
                         static_cast<float>(zcr));

    // Velocity from the onset level (perceptual-ish curve).
    float v = std::sqrt(onsetLevel_) * 180.0f + 20.0f;
    if (v < 1.0f) v = 1.0f;
    if (v > 127.0f) v = 127.0f;
    hit.velocity = static_cast<int>(v);
    hit.lowRatio = static_cast<float>(lowRatio);
    hit.highRatio = static_cast<float>(highRatio);
    hit.zcr = static_cast<float>(zcr);
    hit.centroid = static_cast<float>(centroid);
    hit.decay = static_cast<float>(decay);
    return hit;
}

}  // namespace m2m
