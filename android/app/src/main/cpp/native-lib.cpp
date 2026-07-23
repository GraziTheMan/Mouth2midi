#include <jni.h>

#include <deque>
#include <memory>
#include <mutex>
#include <string>

#include "audio_engine.h"

using namespace m2m;

namespace {

// One serialized event line pushed up to Java. Format (pipe-separated):
//   note|<on|off|retrig>|<note>|<vel>|<offNote>|<ts>
//   pitch|<freqHz>|<midiFloat>|<confidence>|<rms>|<ts>
// Java splits these and forwards to the Capacitor bridge. A production build
// would use a lock-free SPSC ring here instead of a mutex-guarded deque, but
// this is simple, correct, and off the audio hot path except for a short push.
struct EventQueue : EngineListener {
    std::mutex mtx;
    std::deque<std::string> events;
    static constexpr size_t kMax = 256;  // drop oldest if UI stalls

    void push(std::string s) {
        std::lock_guard<std::mutex> lock(mtx);
        if (events.size() >= kMax) events.pop_front();
        events.push_back(std::move(s));
    }

    void onNote(const NoteAction& a, int64_t ts) override {
        const char* kind = a.kind == NoteAction::NoteOn      ? "on"
                           : a.kind == NoteAction::NoteOff    ? "off"
                           : a.kind == NoteAction::Retrigger  ? "retrig"
                                                              : "none";
        push("note|" + std::string(kind) + "|" + std::to_string(a.note) + "|" +
             std::to_string(a.velocity) + "|" + std::to_string(a.offNote) + "|" +
             std::to_string(ts));
    }

    void onPercussion(const BeatHit& h, int64_t ts) override {
        const char* k = h.kind == 0 ? "kick" : h.kind == 1 ? "snare" : "hat";
        // perc|kind|vel|low|high|zcr|centroid|decay|ts
        push("perc|" + std::string(k) + "|" + std::to_string(h.velocity) + "|" +
             std::to_string(h.lowRatio) + "|" + std::to_string(h.highRatio) + "|" +
             std::to_string(h.zcr) + "|" + std::to_string(h.centroid) + "|" +
             std::to_string(h.decay) + "|" + std::to_string(ts));
    }

    void onPitch(const PitchResult& p, int64_t ts) override {
        // midiFloat: only meaningful when voiced.
        float midiFloat = 0.0f;
        if (p.frequency > 0.0f) {
            midiFloat = 69.0f + 12.0f * std::log2(p.frequency / 440.0f);
        }
        push("pitch|" + std::to_string(p.frequency) + "|" +
             std::to_string(midiFloat) + "|" + std::to_string(p.confidence) +
             "|" + std::to_string(p.rms) + "|" + std::to_string(ts));
    }
};

std::unique_ptr<EventQueue> g_queue;
std::unique_ptr<AudioEngine> g_engine;

Scale parseScale(const std::string& s) {
    if (s == "major") return Scale::Major;
    if (s == "minor") return Scale::Minor;
    if (s == "pentatonic") return Scale::Pentatonic;
    if (s == "blues") return Scale::Blues;
    if (s == "dorian") return Scale::Dorian;
    return Scale::Chromatic;
}

}  // namespace

extern "C" {

JNIEXPORT jboolean JNICALL
Java_com_grazitheman_mouth2midi_AudioEngineNative_nativeStart(JNIEnv*, jobject) {
    if (!g_queue) g_queue = std::make_unique<EventQueue>();
    if (!g_engine) g_engine = std::make_unique<AudioEngine>(g_queue.get());
    return g_engine->start() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_grazitheman_mouth2midi_AudioEngineNative_nativeStop(JNIEnv*, jobject) {
    if (g_engine) g_engine->stop();
}

JNIEXPORT void JNICALL
Java_com_grazitheman_mouth2midi_AudioEngineNative_nativeConfigure(
    JNIEnv* env, jobject, jstring scale, jint root, jfloat gate, jfloat minConf,
    jint minNote, jint maxNote, jfloat settleTol) {
    if (!g_engine) return;
    const char* scaleChars = env->GetStringUTFChars(scale, nullptr);
    TrackerConfig cfg;
    cfg.scale = parseScale(scaleChars ? scaleChars : "chromatic");
    cfg.scaleRoot = root;
    cfg.gateThreshold = gate;
    cfg.minConfidence = minConf;
    cfg.minNote = minNote;
    cfg.maxNote = maxNote;
    cfg.settleTol = settleTol;
    env->ReleaseStringUTFChars(scale, scaleChars);
    g_engine->configure(cfg);
}

// Returns status as "sampleRate|framesPerBurst|lowLatency|running".
JNIEXPORT jstring JNICALL
Java_com_grazitheman_mouth2midi_AudioEngineNative_nativeStatus(JNIEnv* env,
                                                               jobject) {
    std::string s;
    if (g_engine) {
        s = std::to_string(g_engine->sampleRate()) + "|" +
            std::to_string(g_engine->framesPerBurst()) + "|" +
            (g_engine->isLowLatency() ? "1" : "0") + "|" +
            (g_engine->isRunning() ? "1" : "0");
    } else {
        s = "48000|0|0|0";
    }
    return env->NewStringUTF(s.c_str());
}

// Drains up to N queued events, newline-joined. Java polls this on a timer.
JNIEXPORT jstring JNICALL
Java_com_grazitheman_mouth2midi_AudioEngineNative_nativePollEvents(JNIEnv* env,
                                                                   jobject) {
    std::string out;
    if (g_queue) {
        std::lock_guard<std::mutex> lock(g_queue->mtx);
        while (!g_queue->events.empty()) {
            out += g_queue->events.front();
            out += "\n";
            g_queue->events.pop_front();
        }
    }
    return env->NewStringUTF(out.c_str());
}

// --- SPICE bridge ------------------------------------------------------------

JNIEXPORT void JNICALL
Java_com_grazitheman_mouth2midi_AudioEngineNative_nativeSetDetector(
    JNIEnv* env, jobject, jstring which) {
    if (!g_engine) return;
    const char* s = env->GetStringUTFChars(which, nullptr);
    const std::string which_s = s ? s : "yin";
    env->ReleaseStringUTFChars(which, s);
    g_engine->setSpiceMode(which_s == "spice");
    g_engine->setBeatboxMode(which_s == "beatbox");
}

// Copy the latest 16 kHz window into `out`; returns false if not enough audio.
JNIEXPORT jboolean JNICALL
Java_com_grazitheman_mouth2midi_AudioEngineNative_nativePullSpiceWindow(
    JNIEnv* env, jobject, jfloatArray out) {
    if (!g_engine) return JNI_FALSE;
    const jsize n = env->GetArrayLength(out);
    std::vector<float> tmp(static_cast<size_t>(n));
    if (!g_engine->pullSpiceWindow(tmp.data(), static_cast<size_t>(n))) {
        return JNI_FALSE;
    }
    env->SetFloatArrayRegion(out, 0, n, tmp.data());
    return JNI_TRUE;
}

JNIEXPORT void JNICALL
Java_com_grazitheman_mouth2midi_AudioEngineNative_nativePushExternalPitch(
    JNIEnv*, jobject, jfloat hz, jfloat confidence, jfloat rms) {
    if (!g_engine) return;
    g_engine->pushExternalPitch(hz, confidence, rms);
}

}  // extern "C"
