#pragma once
#include <cstddef>
#include <vector>

#include "pitch_detector.h"

namespace m2m {

/**
 * YIN fundamental-frequency estimator for monophonic signals (de Cheveigné &
 * Kawahara, 2002). Real implementation: difference function, cumulative mean
 * normalized difference, absolute threshold with local-minimum search, and
 * parabolic interpolation for sub-sample lag precision.
 *
 * Designed for realtime use: preallocates its scratch buffers so process()
 * does no heap allocation on the audio thread.
 */
class Yin : public PitchDetector {
public:
    /**
     * @param sampleRate   e.g. 48000
     * @param bufferSize   analysis window length in samples. Must be >= 2x the
     *                     longest period you want to detect. For an 80 Hz low
     *                     voice at 48k that is ~1200 samples, so 2048 is a
     *                     sensible default (covers ~47 Hz and up).
     * @param threshold    YIN absolute threshold (typical 0.10–0.15). Lower =
     *                     stricter (fewer false pitches), higher = more
     *                     sensitive (more octave errors).
     */
    Yin(int sampleRate, size_t bufferSize, float threshold = 0.12f);

    /** Analyze one window of mono float samples in [-1, 1]. */
    PitchResult process(const float* samples, size_t n) override;

    const char* name() const override { return "yin"; }

    void setThreshold(float t) { threshold_ = t; }

private:
    void difference(const float* samples);
    void cumulativeMeanNormalizedDifference();
    int absoluteThreshold();
    float parabolicInterpolation(int tauEstimate) const;

    int sampleRate_;
    size_t bufferSize_;
    size_t halfBuffer_;
    float threshold_;
    std::vector<float> yinBuffer_;  // size halfBuffer_
};

}  // namespace m2m
