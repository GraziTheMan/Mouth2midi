#include "audio_engine.h"

#include <android/log.h>

#include <algorithm>
#include <chrono>
#include <cmath>

#define LOG_TAG "Mouth2MIDI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)

namespace m2m {

static int64_t nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
        .count();
}

AudioEngine::AudioEngine(EngineListener* listener) : listener_(listener) {
    ring_.resize(kWindow, 0.0f);
    spiceRing_.resize(kSpiceRing, 0.0f);
}

AudioEngine::~AudioEngine() { stop(); }

bool AudioEngine::start() {
    if (running_.load()) return true;

    oboe::AudioStreamBuilder builder;
    builder.setDirection(oboe::Direction::Input)
        ->setPerformanceMode(oboe::PerformanceMode::LowLatency)
        ->setSharingMode(oboe::SharingMode::Exclusive)  // ask for MMAP fast path
        ->setFormat(oboe::AudioFormat::Float)
        ->setChannelCount(oboe::ChannelCount::Mono)
        ->setSampleRate(48000)
        ->setSampleRateConversionQuality(oboe::SampleRateConversionQuality::Medium)
        // Unprocessed preset asks the device for the rawest possible signal —
        // no AGC/AEC/noise-suppression/high-pass. Those all smear pitch and
        // (via the low-cut) swallow low notes, so we want them off. Devices
        // that can't honor it fall back to their default automatically.
        ->setInputPreset(oboe::InputPreset::Unprocessed)
        ->setDataCallback(this);

    oboe::Result result = builder.openStream(stream_);
    if (result != oboe::Result::OK) {
        LOGW("Failed to open input stream: %s", oboe::convertToText(result));
        return false;
    }

    sampleRate_ = stream_->getSampleRate();
    framesPerBurst_ = stream_->getFramesPerBurst();
    lowLatency_.store(stream_->getSharingMode() == oboe::SharingMode::Exclusive &&
                      stream_->getPerformanceMode() == oboe::PerformanceMode::LowLatency);

    // Default to YIN. To A/B a learned detector, construct a SpiceDetector and
    // use it when isAvailable(); it falls back here otherwise.
    detector_ = std::make_unique<Yin>(sampleRate_, kWindow);
    beat_ = std::make_unique<BeatDetector>(sampleRate_);
    beatScratch_.resize(8192);
    filled_ = 0;
    spiceWritePos_ = 0;
    spiceDecimCount_ = 0;
    spicePublished_.store(0);

    // A small multiple of the burst size keeps callbacks tight without xruns.
    stream_->setBufferSizeInFrames(framesPerBurst_ * 2);

    result = stream_->requestStart();
    if (result != oboe::Result::OK) {
        LOGW("Failed to start stream: %s", oboe::convertToText(result));
        stream_->close();
        stream_.reset();
        return false;
    }

    running_.store(true);
    LOGI("Engine started: %d Hz, burst=%d, lowLatency=%d", sampleRate_,
         framesPerBurst_, lowLatency_.load() ? 1 : 0);
    return true;
}

void AudioEngine::stop() {
    if (!running_.load()) return;
    running_.store(false);
    if (stream_) {
        stream_->requestStop();
        stream_->close();
        stream_.reset();
    }
    tracker_.reset();
}

void AudioEngine::configure(const TrackerConfig& cfg) { tracker_.configure(cfg); }

void AudioEngine::emit(const PitchResult& pitch, int64_t t) {
    if (listener_) listener_->onPitch(pitch, t);
    const NoteAction action =
        tracker_.update(pitch.frequency, pitch.confidence, pitch.rms);
    if (action.kind != NoteAction::None && listener_) {
        listener_->onNote(action, t);
    }
}

void AudioEngine::analyzeWindow() {
    const PitchResult pitch = detector_->process(ring_.data(), kWindow);
    emit(pitch, nowMs());
}

bool AudioEngine::pullSpiceWindow(float* out, size_t n) {
    const size_t w = spicePublished_.load(std::memory_order_acquire);
    if (w < n) return false;  // not enough captured yet
    for (size_t i = 0; i < n; ++i) {
        out[i] = spiceRing_[(w - n + i) % kSpiceRing];
    }
    return true;
}

void AudioEngine::pushExternalPitch(float hz, float confidence, float rms) {
    PitchResult p;
    p.frequency = hz;
    p.confidence = confidence;
    p.rms = rms;
    emit(p, nowMs());
}

oboe::DataCallbackResult AudioEngine::onAudioReady(oboe::AudioStream* /*stream*/,
                                                   void* audioData,
                                                   int32_t numFrames) {
    const float* in = static_cast<const float*>(audioData);

    // Beatbox mode: onset detection + kick/snare/hat classification on the
    // gained signal; emit percussion hits. No pitch tracking.
    if (beatboxMode_.load(std::memory_order_relaxed) && beat_) {
        BeatHit hits[8];
        int off = 0;
        while (off < numFrames) {
            const int chunk =
                std::min(static_cast<int>(beatScratch_.size()), numFrames - off);
            for (int i = 0; i < chunk; ++i) {
                beatScratch_[i] = std::tanh(in[off + i] * kInputGain);
            }
            const int nh = beat_->process(beatScratch_.data(), chunk, hits, 8);
            const int64_t t = nowMs();
            for (int h = 0; h < nh && listener_; ++h) {
                listener_->onPercussion(hits[h].kind, hits[h].velocity, t);
            }
            off += chunk;
        }
        return oboe::DataCallbackResult::Continue;
    }

    // SPICE mode: skip YIN entirely; just downsample 48k → 16k into the ring for
    // the Java worker to read. YIN mode: run the sliding-window analysis.
    if (spiceMode_.load(std::memory_order_relaxed)) {
        for (int32_t i = 0; i < numFrames; ++i) {
            if (++spiceDecimCount_ >= kSpiceDecim) {
                spiceDecimCount_ = 0;
                spiceRing_[spiceWritePos_ % kSpiceRing] = std::tanh(in[i] * kInputGain);
                ++spiceWritePos_;
                spicePublished_.store(spiceWritePos_, std::memory_order_release);
            }
        }
        return oboe::DataCallbackResult::Continue;
    }

    // Accumulate samples into the analysis window. Once it fills, run YIN and
    // slide the window left by one hop so successive analyses overlap
    // (kWindow - kHop samples of history are retained). Analysis then runs
    // once per kHop samples (~10.7ms at 48k) regardless of how the callback's
    // frame count aligns with the hop — the previous `i % kHop` gate keyed off
    // the per-callback index and almost never fired.
    for (int32_t i = 0; i < numFrames; ++i) {
        ring_[filled_++] = std::tanh(in[i] * kInputGain);
        if (filled_ == kWindow) {
            analyzeWindow();
            std::move(ring_.begin() + kHop, ring_.end(), ring_.begin());
            filled_ = kWindow - kHop;
        }
    }
    return oboe::DataCallbackResult::Continue;
}

}  // namespace m2m
