#pragma once
#include <oboe/Oboe.h>

#include <atomic>
#include <memory>
#include <vector>

#include "note_tracker.h"
#include "pitch_detector.h"
#include "yin.h"

namespace m2m {

/**
 * Callback invoked from the audio thread with each finalized note decision and
 * live pitch frame. Implementations MUST be realtime-safe if they run inline;
 * the reference JNI layer instead pushes onto a lock-free queue drained by a
 * separate thread that calls into Java (JNI attach is not realtime-safe).
 */
class EngineListener {
public:
    virtual ~EngineListener() = default;
    virtual void onNote(const NoteAction& action, int64_t timestampMs) = 0;
    virtual void onPitch(const PitchResult& pitch, int64_t timestampMs) = 0;
};

/**
 * Low-latency mic capture via Oboe. Requests exclusive mode + performance-mode
 * LowLatency so AAudio can hand us an MMAP fast path on capable hardware
 * (Snapdragon 8 Gen 3 in the S24 Ultra qualifies). Audio frames are fed
 * through YIN → NoteTracker on the audio callback.
 */
class AudioEngine : public oboe::AudioStreamDataCallback {
public:
    explicit AudioEngine(EngineListener* listener);
    ~AudioEngine() override;

    bool start();
    void stop();
    void configure(const TrackerConfig& cfg);

    bool isRunning() const { return running_.load(); }
    int sampleRate() const { return sampleRate_; }
    int framesPerBurst() const { return framesPerBurst_; }
    bool isLowLatency() const { return lowLatency_.load(); }

    // oboe::AudioStreamDataCallback
    oboe::DataCallbackResult onAudioReady(oboe::AudioStream* stream,
                                          void* audioData,
                                          int32_t numFrames) override;

private:
    void analyzeWindow();

    EngineListener* listener_;
    std::shared_ptr<oboe::AudioStream> stream_;
    // Active pitch estimator. Defaults to YIN; swappable for a learned detector
    // (SpiceDetector) once its model is bundled — the rest of the pipeline is
    // detector-agnostic.
    std::unique_ptr<PitchDetector> detector_;
    NoteTracker tracker_;

    int sampleRate_ = 48000;
    int framesPerBurst_ = 0;
    static constexpr size_t kWindow = 2048;  // YIN analysis window
    static constexpr size_t kHop = 512;      // ~10.7ms at 48k

    std::vector<float> ring_;   // accumulates samples up to kWindow
    size_t filled_ = 0;

    std::atomic<bool> running_{false};
    std::atomic<bool> lowLatency_{false};
};

}  // namespace m2m
