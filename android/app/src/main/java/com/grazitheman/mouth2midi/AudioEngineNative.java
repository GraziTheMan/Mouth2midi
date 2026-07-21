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

    public native void nativeConfigure(String scale, int root, float gate, float minConfidence,
                                       int minNote, int maxNote, float settleTol);

    /** "sampleRate|framesPerBurst|lowLatency|running" */
    public native String nativeStatus();

    /** Newline-separated event lines; see native-lib.cpp for the format. */
    public native String nativePollEvents();

    // --- SPICE bridge --------------------------------------------------------

    /** Select the active detector: "yin" (native) or "spice" (Java worker). */
    public native void nativeSetDetector(String which);

    /**
     * Copy the most recent window of 16 kHz audio into {@code out}. Returns
     * false if fewer than out.length samples have been captured yet.
     */
    public native boolean nativePullSpiceWindow(float[] out);

    /** Feed a pitch computed by the Java SPICE worker into the note tracker. */
    public native void nativePushExternalPitch(float hz, float confidence, float rms);
}
