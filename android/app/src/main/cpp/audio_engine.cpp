#include "audio_engine.h"

#include <android/log.h>

#include <chrono>

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
        // VoiceRecognition preset disables AGC/AEC processing that would smear
        // the signal and hurt pitch tracking.
        ->setInputPreset(oboe::InputPreset::VoiceRecognition)
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

    yin_ = std::make_unique<Yin>(sampleRate_, kWindow);
    filled_ = 0;

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

void AudioEngine::analyzeWindow() {
    const PitchResult pitch = yin_->process(ring_.data(), kWindow);
    const int64_t t = nowMs();
    if (listener_) listener_->onPitch(pitch, t);

    const NoteAction action =
        tracker_.update(pitch.frequency, pitch.confidence, pitch.rms);
    if (action.kind != NoteAction::None && listener_) {
        listener_->onNote(action, t);
    }
}

oboe::DataCallbackResult AudioEngine::onAudioReady(oboe::AudioStream* /*stream*/,
                                                   void* audioData,
                                                   int32_t numFrames) {
    const float* in = static_cast<const float*>(audioData);

    // Slide incoming frames into the analysis window; run YIN every kHop
    // samples so consecutive windows overlap (smoother pitch track).
    for (int32_t i = 0; i < numFrames; ++i) {
        if (filled_ < kWindow) {
            ring_[filled_++] = in[i];
        } else {
            // Shift left by one hop when full, then append.
            std::move(ring_.begin() + kHop, ring_.end(), ring_.begin());
            filled_ = kWindow - kHop;
            ring_[filled_++] = in[i];
        }
        if (filled_ == kWindow && (i % kHop) == 0) {
            analyzeWindow();
        }
    }
    return oboe::DataCallbackResult::Continue;
}

}  // namespace m2m
