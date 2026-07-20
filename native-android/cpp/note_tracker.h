#pragma once
#include <array>
#include <cstdint>
#include <vector>

namespace m2m {

enum class Scale { Chromatic, Major, Minor, Pentatonic, Blues, Dorian };

struct TrackerConfig {
    Scale scale = Scale::Minor;
    int scaleRoot = 69;        // MIDI note of the root (69 = A)
    float gateThreshold = 0.02f;  // RMS gate
    float minConfidence = 0.85f;  // YIN confidence gate
    // Frames a new candidate note must persist before we commit a note-on.
    // This is the anti-jitter / anti-octave-flip guard. At ~10ms/frame, 2
    // frames ≈ 20ms of debounce.
    int onHoldFrames = 2;
    // Frames of silence/unvoiced before we send note-off (avoids choppy
    // retriggering through short consonant gaps).
    int offHoldFrames = 3;
};

struct NoteAction {
    enum Kind { None, NoteOn, NoteOff, Retrigger } kind = None;
    int note = -1;       // committed (quantized) note for On/Retrigger
    int velocity = 0;    // 0..127
    int offNote = -1;    // note to release on Retrigger
};

/**
 * Turns a stream of per-frame pitch estimates into stable, quantized MIDI
 * note-on/off decisions. This is where the "feel" of the instrument lives:
 * gating, scale-snapping, and debounce hysteresis so a wobbly voice does not
 * produce a machine-gun of spurious notes.
 */
class NoteTracker {
public:
    void configure(const TrackerConfig& cfg) { cfg_ = cfg; }

    /**
     * @param frequency  Hz from YIN (0 if unvoiced)
     * @param confidence 0..1 from YIN
     * @param rms        0..1 window RMS
     */
    NoteAction update(float frequency, float confidence, float rms);

    void reset();

    /** Quantize a fractional MIDI note to the active scale. */
    int quantize(float midiFloat) const;

private:
    static const std::vector<int>& scaleSteps(Scale s);

    TrackerConfig cfg_{};
    int activeNote_ = -1;      // currently sounding note, -1 = none
    int candidateNote_ = -1;   // note awaiting on-hold confirmation
    int candidateFrames_ = 0;
    int silentFrames_ = 0;
};

}  // namespace m2m
