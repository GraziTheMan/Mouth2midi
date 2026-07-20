#include "note_tracker.h"

#include <cmath>

namespace m2m {

const std::vector<int>& NoteTracker::scaleSteps(Scale s) {
    static const std::vector<int> chromatic = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
    static const std::vector<int> major = {0, 2, 4, 5, 7, 9, 11};
    static const std::vector<int> minor = {0, 2, 3, 5, 7, 8, 10};
    static const std::vector<int> pentatonic = {0, 3, 5, 7, 10};
    static const std::vector<int> blues = {0, 3, 5, 6, 7, 10};
    static const std::vector<int> dorian = {0, 2, 3, 5, 7, 9, 10};
    switch (s) {
        case Scale::Major: return major;
        case Scale::Minor: return minor;
        case Scale::Pentatonic: return pentatonic;
        case Scale::Blues: return blues;
        case Scale::Dorian: return dorian;
        case Scale::Chromatic:
        default: return chromatic;
    }
}

int NoteTracker::quantize(float midiFloat) const {
    if (cfg_.scale == Scale::Chromatic) {
        int n = static_cast<int>(std::lround(midiFloat));
        return n < 0 ? 0 : (n > 127 ? 127 : n);
    }
    const std::vector<int>& steps = scaleSteps(cfg_.scale);
    const int root = cfg_.scaleRoot % 12;

    // Search the nearest allowed pitch class across neighbouring octaves.
    int best = static_cast<int>(std::lround(midiFloat));
    float bestDist = 1e9f;
    const int center = static_cast<int>(std::lround(midiFloat));
    for (int octave = -1; octave <= 1; ++octave) {
        const int base = ((center / 12) + octave) * 12;
        for (int step : steps) {
            const int candidate = base + ((root + step) % 12);
            const float dist = std::fabs(midiFloat - candidate);
            if (dist < bestDist) {
                bestDist = dist;
                best = candidate;
            }
        }
    }
    return best < 0 ? 0 : (best > 127 ? 127 : best);
}

static int rmsToVelocity(float rms) {
    // Map singing-level RMS (~0.02..0.4) to a musical velocity spread instead
    // of pinning everything at 127. sqrt gives a perceptual-ish curve.
    float v = std::sqrt(rms) * 170.0f + 12.0f;
    if (v < 1.0f) v = 1.0f;
    if (v > 127.0f) v = 127.0f;
    return static_cast<int>(v);
}

void NoteTracker::reset() {
    activeNote_ = -1;
    candidateNote_ = -1;
    candidateFrames_ = 0;
    silentFrames_ = 0;
    smoothed_ = 0.0f;
    haveSmoothed_ = false;
}

// Release the sounding note (if any) after enough unvoiced/out-of-range frames.
static NoteAction releaseAfterHold(int& active, int& silent, int offHold) {
    NoteAction action;
    if (active >= 0 && ++silent >= offHold) {
        action.kind = NoteAction::NoteOff;
        action.note = active;
        active = -1;
        silent = 0;
    }
    return action;
}

NoteAction NoteTracker::update(float frequency, float confidence, float rms) {
    const bool voiced =
        frequency > 0.0f && confidence >= cfg_.minConfidence && rms >= cfg_.gateThreshold;

    if (!voiced) {
        candidateNote_ = -1;
        candidateFrames_ = 0;
        haveSmoothed_ = false;  // don't smooth across a gap
        return releaseAfterHold(activeNote_, silentFrames_, cfg_.offHoldFrames);
    }

    const float midiFloat = 69.0f + 12.0f * std::log2(frequency / 440.0f);

    // Smooth the pitch (EMA) before quantizing to tame vibrato/jitter.
    if (!haveSmoothed_) {
        smoothed_ = midiFloat;
        haveSmoothed_ = true;
    } else {
        smoothed_ += kSmoothAlpha * (midiFloat - smoothed_);
    }

    // Pitch-range gate: outside the band, behave as if unvoiced for triggering.
    if (smoothed_ < cfg_.minNote - 0.5f || smoothed_ > cfg_.maxNote + 0.5f) {
        candidateNote_ = -1;
        candidateFrames_ = 0;
        return releaseAfterHold(activeNote_, silentFrames_, cfg_.offHoldFrames);
    }

    silentFrames_ = 0;
    const int target = quantize(smoothed_);

    // Already sounding this note → sustain, nothing to emit.
    if (target == activeNote_) {
        candidateNote_ = -1;
        candidateFrames_ = 0;
        return NoteAction{};
    }

    // Only a *settled* pitch (parked near a scale note) can start a new note.
    // While sliding, the smoothed pitch sits between notes, so this is false and
    // the current note keeps sounding (legato) instead of a staircase forming.
    const bool settled = std::fabs(smoothed_ - target) <= kSettleTol;
    if (!settled) {
        candidateNote_ = -1;
        candidateFrames_ = 0;
        return NoteAction{};
    }

    if (target == candidateNote_) {
        ++candidateFrames_;
    } else {
        candidateNote_ = target;
        candidateFrames_ = 1;
    }

    NoteAction action;
    if (candidateFrames_ >= cfg_.onHoldFrames) {
        action.velocity = rmsToVelocity(rms);
        if (activeNote_ >= 0) {
            action.kind = NoteAction::Retrigger;
            action.offNote = activeNote_;
        } else {
            action.kind = NoteAction::NoteOn;
        }
        action.note = target;
        activeNote_ = target;
        candidateNote_ = -1;
        candidateFrames_ = 0;
    }
    return action;
}

}  // namespace m2m
