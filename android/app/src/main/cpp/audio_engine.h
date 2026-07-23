#pragma once
#include <oboe/Oboe.h>

#include <atomic>
#include <memory>
#include <vector>

#include "beat_detector.h"
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
    virtual void onPercussion(const BeatHit& hit, int64_t timestampMs) = 0;
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

    // --- SPICE (Java-side learned detector) bridge ---------------------------
    // In SPICE mode the audio callback only fills a 16 kHz ring; YIN + tracking
    // are skipped. A Java worker pulls windows, runs the TFLite model, and feeds
    // pitch back via pushExternalPitch (which then drives the NoteTracker).
    void setSpiceMode(bool on) { spiceMode_.store(on); }
    bool spiceMode() const { return spiceMode_.load(); }
    // Beatbox mode: run onset detection + kick/snare/hat classification instead
    // of pitch tracking, emitting onPercussion.
    void setBeatboxMode(bool on) { beatboxMode_.store(on); }
    // Copy the most recent n samples of 16 kHz audio into out. Returns false if
    // fewer than n samples have been captured yet.
    bool pullSpiceWindow(float* out, size_t n);
    // Feed an externally computed pitch (from the Java SPICE worker) into the
    // note tracker. Runs on the worker thread, not the audio thread.
    void pushExternalPitch(float hz, float confidence, float rms);

    // oboe::AudioStreamDataCallback
    oboe::DataCallbackResult onAudioReady(oboe::AudioStream* stream,
                                          void* audioData,
                                          int32_t numFrames) override;

private:
    void analyzeWindow();
    void emit(const PitchResult& pitch, int64_t t);

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
    // The Unprocessed input preset (chosen for clean pitch + low-note pickup)
    // has no automatic gain, so raw levels are low. Apply a fixed makeup gain
    // with tanh soft-clipping so the RMS gate works at a normal setting and
    // SPICE (which never reports silence) can be gated by level.
    static constexpr float kInputGain = 4.0f;

    std::vector<float> ring_;   // accumulates samples up to kWindow
    size_t filled_ = 0;

    // 16 kHz downsampled ring read by the Java SPICE worker.
    static constexpr size_t kSpiceRing = 16000;  // 1 second
    static constexpr int kSpiceDecim = 3;        // 48k -> 16k
    std::vector<float> spiceRing_;
    size_t spiceWritePos_ = 0;                   // audio-thread only
    std::atomic<size_t> spicePublished_{0};      // visible to readers
    int spiceDecimCount_ = 0;
    std::atomic<bool> spiceMode_{false};

    // Beatbox detection (Tier 1, native).
    std::unique_ptr<BeatDetector> beat_;
    std::vector<float> beatScratch_;
    std::atomic<bool> beatboxMode_{false};

    std::atomic<bool> running_{false};
    std::atomic<bool> lowLatency_{false};
};

}  // namespace m2m
