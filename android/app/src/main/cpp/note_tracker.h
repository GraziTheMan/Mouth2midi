#pragma once
#include <array>
#include <cstdint>
#include <vector>

namespace m2m {

enum class Scale { Chromatic, Major, Minor, Pentatonic, Blues, Dorian };

struct TrackerConfig {
    Scale scale = Scale::Minor;
    int scaleRoot = 69;           // MIDI note of the root (69 = A)
    float gateThreshold = 0.02f;  // RMS gate
    float minConfidence = 0.72f;  // YIN confidence gate
    // A candidate note must stay *settled* (pitch parked near a scale note) for
    // this many frames before it commits. At ~10.7ms/frame, 3 ≈ 32ms. This is
    // what rejects notes you merely slide through.
    int onHoldFrames = 3;
    // Frames of unvoiced input tolerated before a sounding note is released.
    // Higher = a held note survives brief breath/consonant dropouts instead of
    // being chopped into fragments. 6 ≈ 64ms.
    int offHoldFrames = 6;
    // Pitch range gate (inclusive, MIDI note numbers). Pitches outside this band
    // never trigger notes — kills stray sub-range blips and acts as a coarse
    // "sing within these bounds" auto-tune guide.
    int minNote = 36;             // C2
    int maxNote = 96;             // C7
};

struct NoteAction {
    enum Kind { None, NoteOn, NoteOff, Retrigger } kind = None;
    int note = -1;       // committed (quantized) note for On/Retrigger
    int velocity = 0;    // 0..127
    int offNote = -1;    // note to release on Retrigger
};

/**
 * Turns a stream of per-frame pitch estimates into stable, quantized MIDI
 * note-on/off decisions. This is where the "feel" of the instrument lives.
 *
 * Segmentation principle: a note commits only when the (smoothed) pitch
 * *settles* near a scale note and holds; pitches merely passed through during a
 * slide never commit, and a sounding note survives brief unvoiced gaps. That
 * turns a slur into two notes instead of a staircase, and a wobbly sustain into
 * one note instead of a machine-gun.
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

    // How close (in semitones) the smoothed pitch must sit to a scale note to
    // count as "settled" on it. A slide is moving, so it rarely satisfies this.
    static constexpr float kSettleTol = 0.4f;
    // EMA smoothing factor applied to the incoming pitch (0..1, higher = less
    // smoothing). Tames vibrato/jitter before quantization.
    static constexpr float kSmoothAlpha = 0.4f;

    TrackerConfig cfg_{};
    int activeNote_ = -1;      // currently sounding note, -1 = none
    int candidateNote_ = -1;   // settled note awaiting on-hold confirmation
    int candidateFrames_ = 0;
    int silentFrames_ = 0;
    float smoothed_ = 0.0f;    // EMA of incoming midiFloat
    bool haveSmoothed_ = false;
};

}  // namespace m2m
