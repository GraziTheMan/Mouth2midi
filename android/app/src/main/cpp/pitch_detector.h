#pragma once
#include <cstddef>

namespace m2m {

// Result of one pitch analysis window. Shared by every detector so they are
// interchangeable behind the PitchDetector interface.
struct PitchResult {
    float frequency = 0.0f;   // Hz, 0 if unvoiced / no confident pitch
    float confidence = 0.0f;  // 0..1
    float rms = 0.0f;         // 0..1 RMS of the analysis window
};

/**
 * Common interface for pitch estimators so the audio engine can swap between
 * the deterministic YIN detector and a learned one (SPICE via TFLite) without
 * changing the rest of the pipeline. The chosen detector's output feeds the
 * same NoteTracker.
 */
class PitchDetector {
public:
    virtual ~PitchDetector() = default;

    /** Analyze one window of mono float samples in [-1, 1]. */
    virtual PitchResult process(const float* samples, size_t n) = 0;

    /** Short identifier for logging / UI ("yin", "spice"). */
    virtual const char* name() const = 0;

    /**
     * Whether this detector is ready to run. A detector that needs an external
     * model (SPICE) reports false until the model is loaded, letting the engine
     * fall back to YIN.
     */
    virtual bool isAvailable() const { return true; }
};

}  // namespace m2m
