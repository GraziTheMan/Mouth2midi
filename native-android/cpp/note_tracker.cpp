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
    // Perceptual-ish curve: sqrt maps quiet input to usable velocities.
    float v = std::sqrt(rms) * 300.0f;
    if (v < 1.0f) v = 1.0f;
    if (v > 127.0f) v = 127.0f;
    return static_cast<int>(v);
}

void NoteTracker::reset() {
    activeNote_ = -1;
    candidateNote_ = -1;
    candidateFrames_ = 0;
    silentFrames_ = 0;
}

NoteAction NoteTracker::update(float frequency, float confidence, float rms) {
    NoteAction action;

    const bool voiced =
        frequency > 0.0f && confidence >= cfg_.minConfidence && rms >= cfg_.gateThreshold;

    if (!voiced) {
        candidateNote_ = -1;
        candidateFrames_ = 0;
        if (activeNote_ >= 0) {
            if (++silentFrames_ >= cfg_.offHoldFrames) {
                action.kind = NoteAction::NoteOff;
                action.note = activeNote_;
                activeNote_ = -1;
                silentFrames_ = 0;
            }
        }
        return action;
    }

    silentFrames_ = 0;
    const float midiFloat = 69.0f + 12.0f * std::log2(frequency / 440.0f);
    const int target = quantize(midiFloat);

    if (target == activeNote_) {
        // Sustaining the same note — nothing to emit.
        candidateNote_ = -1;
        candidateFrames_ = 0;
        return action;
    }

    // A different note than what's sounding: require it to persist (debounce)
    // before committing, to reject vibrato/octave-flicker.
    if (target == candidateNote_) {
        ++candidateFrames_;
    } else {
        candidateNote_ = target;
        candidateFrames_ = 1;
    }

    if (candidateFrames_ >= cfg_.onHoldFrames) {
        const int velocity = rmsToVelocity(rms);
        if (activeNote_ >= 0) {
            action.kind = NoteAction::Retrigger;
            action.offNote = activeNote_;
        } else {
            action.kind = NoteAction::NoteOn;
        }
        action.note = target;
        action.velocity = velocity;
        activeNote_ = target;
        candidateNote_ = -1;
        candidateFrames_ = 0;
    }
    return action;
}

}  // namespace m2m
