#include "beat_detector.h"

#include <algorithm>
#include <cmath>
#ifdef BEAT_DEBUG
#include <cstdio>
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
    std::fill(ring_.begin(), ring_.end(), 0.0f);
}

void BeatDetector::setSensitivity(float s) {
    if (s < 0.0f) s = 0.0f;
    if (s > 1.0f) s = 1.0f;
    // More sensitive → lower floor + smaller required jump.
    floor_ = 0.12f - 0.10f * s;   // 0.12 .. 0.02
    ratio_ = 2.4f - 0.9f * s;     // 2.4 .. 1.5
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

        // New onset: fast env jumps above the baseline and a floor.
        if (refractory_ == 0 && !pending_ &&
            fastEnv_ > slowEnv_ * ratio_ && fastEnv_ > floor_) {
            onsetLevel_ = fastEnv_;
            refractory_ = static_cast<int>(sampleRate_ * 0.07);  // 70 ms gap
            pending_ = true;
            pendingCount_ = static_cast<int>(classWin_);
        }
    }
    return count;
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

    const size_t start = writePos_ - classWin_;
    for (size_t k = 0; k < classWin_; ++k) {
        const float x = ring_[(start + k) % ringSize_];
        lp += lpAlpha * (x - lp);
        const float d = x - prev;  // first difference → emphasises high freqs
        lowE += static_cast<double>(lp) * lp;
        highE += static_cast<double>(d) * d;
        totalE += static_cast<double>(x) * x;
        if ((x >= 0.0f) != (prev >= 0.0f)) ++crossings;
        prev = x;
        const float ax = std::fabs(x);
        if (ax > peak) peak = ax;
    }

    const double eps = 1e-9;
    const double lowRatio = lowE / (totalE + eps);
    const double highRatio = highE / (totalE + eps);  // first-diff emphasises highs
    const double zcr = static_cast<double>(crossings) / static_cast<double>(classWin_);
#ifdef BEAT_DEBUG
    std::fprintf(stderr, "  [feat] lowRatio=%.3f highRatio=%.3f zcr=%.3f\n", lowRatio,
                 highRatio, zcr);
#endif

    BeatHit hit;
    if (lowRatio > 0.5 && zcr < 0.10) {
        hit.kind = BeatHit::Kick;      // low-dominated, few crossings
    } else if (highRatio > 2.2) {
        hit.kind = BeatHit::Hat;       // energy concentrated at the very top
    } else {
        hit.kind = BeatHit::Snare;     // broadband middle ground
    }

    // Velocity from the onset level (perceptual-ish curve).
    float v = std::sqrt(onsetLevel_) * 180.0f + 20.0f;
    if (v < 1.0f) v = 1.0f;
    if (v > 127.0f) v = 127.0f;
    hit.velocity = static_cast<int>(v);
    hit.lowRatio = static_cast<float>(lowRatio);
    hit.highRatio = static_cast<float>(highRatio);
    hit.zcr = static_cast<float>(zcr);
    return hit;
}

}  // namespace m2m
