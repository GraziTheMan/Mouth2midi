package com.grazitheman.mouth2midi;

/**
 * Thin JNI wrapper around the C++ Oboe engine (libmouth2midi.so).
 *
 * All the real-time work happens in C++. Java only starts/stops/configures the
 * engine and polls a queue of serialized events, which the Capacitor plugin
 * forwards to the web layer.
 */
public final class AudioEngineNative {

    static {
        System.loadLibrary("mouth2midi");
    }

    public native boolean nativeStart();

    public native void nativeStop();

    public native void nativeConfigure(String scale, int root, float gate, float minConfidence);

    /** "sampleRate|framesPerBurst|lowLatency|running" */
    public native String nativeStatus();

    /** Newline-separated event lines; see native-lib.cpp for the format. */
    public native String nativePollEvents();
}
