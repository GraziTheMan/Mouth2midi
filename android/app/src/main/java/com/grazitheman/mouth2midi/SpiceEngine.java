package com.grazitheman.mouth2midi;

import android.util.Log;

import org.tensorflow.lite.Interpreter;

import java.nio.ByteBuffer;
import java.util.HashMap;
import java.util.Map;

/**
 * Runs Google's SPICE pitch model via the TFLite Java Interpreter on a
 * background thread. It pulls 16 kHz windows from the native engine, infers
 * pitch, maps it to Hz, and pushes the result back into the native NoteTracker
 * (which then emits the same note/pitch events the UI already consumes).
 *
 * Deliberately off the realtime audio thread — a neural net on the audio
 * callback would xrun. ~50 Hz update tracks a sung melody comfortably.
 */
public class SpiceEngine {

    private static final String TAG = "Mouth2MIDI-SPICE";

    // 16 kHz analysis window fed to SPICE (~64 ms). Tunable for latency vs.
    // stability once measured on-device.
    private static final int WINDOW = 1024;
    private static final long PERIOD_MS = 20; // ~50 Hz inference

    // SPICE pitch → Hz calibration (model card).
    private static final float PT_OFFSET = 25.58f;
    private static final float PT_SLOPE = 63.07f;

    private final AudioEngineNative engine;
    private final Interpreter interpreter;
    private final int inputRank;
    private volatile boolean running = false;
    private Thread worker;

    public SpiceEngine(AudioEngineNative engine, ByteBuffer model) {
        this.engine = engine;
        Interpreter.Options opts = new Interpreter.Options();
        opts.setNumThreads(2);
        this.interpreter = new Interpreter(model, opts);
        // SPICE takes a 1-D [num_samples] input; resize to our fixed window.
        this.inputRank = interpreter.getInputTensor(0).shape().length;
        if (inputRank == 1) {
            interpreter.resizeInput(0, new int[] { WINDOW });
        } else {
            interpreter.resizeInput(0, new int[] { 1, WINDOW });
        }
        interpreter.allocateTensors();
        int[] outShape = interpreter.getOutputTensor(0).shape();
        Log.i(TAG, "SPICE loaded. inputRank=" + inputRank + " outFrames=" + outShape[outShape.length - 1]);
    }

    public void start() {
        if (running) return;
        running = true;
        worker = new Thread(this::loop, "spice-worker");
        worker.start();
    }

    public void stop() {
        running = false;
        if (worker != null) {
            worker.interrupt();
            worker = null;
        }
        try {
            interpreter.close();
        } catch (Exception ignored) {
        }
    }

    private void loop() {
        final float[] window = new float[WINDOW];
        while (running) {
            try {
                if (engine.nativePullSpiceWindow(window)) {
                    infer(window);
                }
                Thread.sleep(PERIOD_MS);
            } catch (InterruptedException e) {
                break;
            } catch (Exception e) {
                Log.w(TAG, "SPICE inference error", e);
                try {
                    Thread.sleep(100);
                } catch (InterruptedException ignored) {
                    break;
                }
            }
        }
    }

    private void infer(float[] window) {
        float rms = 0f;
        for (float v : window) rms += v * v;
        rms = (float) Math.sqrt(rms / window.length);

        int[] outShape = interpreter.getOutputTensor(0).shape();
        int frames = outShape[outShape.length - 1];
        float[] pitchOut = new float[frames];
        float[] uncOut = new float[frames];

        Object input = (inputRank == 1) ? window : new float[][] { window };
        Map<Integer, Object> outputs = new HashMap<>();
        outputs.put(0, pitchOut);
        outputs.put(1, uncOut);
        interpreter.runForMultipleInputsOutputs(new Object[] { input }, outputs);

        int last = frames - 1;
        float pitch = pitchOut[last];
        float uncertainty = uncOut[last];
        float cqtBin = pitch * PT_SLOPE + PT_OFFSET;
        float hz = (float) (10.0 * Math.pow(2.0, cqtBin / 12.0));
        float confidence = 1f - uncertainty;
        if (confidence < 0f) confidence = 0f;

        engine.nativePushExternalPitch(hz, confidence, rms);
    }
}
