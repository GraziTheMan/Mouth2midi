#pragma once
#include <cstddef>
#include <vector>

namespace m2m {

struct BeatHit {
    enum Kind { Kick, Snare, Hat } kind = Kick;
    int velocity = 0;  // 1..127
    // Classification features, surfaced for on-device tuning.
    float lowRatio = 0.0f;
    float highRatio = 0.0f;
    float zcr = 0.0f;
};

/**
 * Beatbox onset detector + heuristic kick/snare/hat classifier (Tier 1 — no ML).
 *
 * Onset: a fast/slow amplitude-envelope tracker flags a transient when the fast
 * envelope jumps above the slow baseline (with a refractory gap to avoid double
 * triggers). Classification is delayed a few ms so the window holds the actual
 * attack, then a hit is labelled from cheap time-domain features:
 *   - low-band energy ratio (one-pole low-pass) → kick is low-dominated,
 *   - zero-crossing rate + pre-emphasis (high-freq) energy → hats are noisy/high,
 *   - everything in between → snare.
 *
 * All cheap and realtime-safe (runs on the audio thread, no FFT, no allocation
 * in process()). Thresholds are first-pass and meant to be tuned on-device; the
 * eventual upgrade is a learned classifier (see docs/ML-SPICE.md, Track B).
 */
class BeatDetector {
public:
    explicit BeatDetector(int sampleRate);

    void reset();
    /** 0..1; higher = more sensitive (lower onset threshold). */
    void setSensitivity(float s);

    /**
     * Label a hit from its features. Thresholds calibrated on real on-device
     * beatbox captures (see beat_detector.cpp). Exposed for unit testing.
     */
    static BeatHit::Kind labelFrom(float lowRatio, float highRatio, float zcr);

    /**
     * Feed a block of gained mono samples. Writes up to maxHits detected hits to
     * out and returns how many. Realtime-safe.
     */
    int process(const float* samples, int n, BeatHit* out, int maxHits);

private:
    BeatHit classify() const;

    int sampleRate_;
    size_t ringSize_;
    size_t classWin_;   // samples analyzed per hit (~25ms)
    std::vector<float> ring_;
    size_t writePos_ = 0;

    float fastEnv_ = 0.0f;
    float slowEnv_ = 0.0f;
    int refractory_ = 0;
    float onsetLevel_ = 0.0f;

    bool pending_ = false;
    int pendingCount_ = 0;

    float floor_ = 0.05f;   // minimum fast-env level to fire
    float ratio_ = 1.9f;    // fast/slow jump factor to fire
};

}  // namespace m2m
