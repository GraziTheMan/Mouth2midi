package com.grazitheman.mouth2midi;

import android.Manifest;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Capacitor bridge. JS calls start/stop/configure/getStatus; native events
 * (note/pitch/percussion) are pushed back to JS via notifyListeners().
 *
 * Events are produced on the C++ audio thread and queued there; a Java handler
 * polls that queue on the main looper and re-emits them. Polling at ~120 Hz is
 * far finer than the ~90 Hz YIN hop, so no note events are lost, and it keeps
 * JNI calls off the realtime audio thread entirely.
 */
@CapacitorPlugin(
    name = "Mouth2Midi",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
    }
)
public class Mouth2MidiPlugin extends Plugin {

    private final AudioEngineNative engine = new AudioEngineNative();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean polling = false;
    private SpiceEngine spice;
    private static final String SPICE_ASSET = "spice.tflite";

    private static final long POLL_INTERVAL_MS = 8; // ~120 Hz

    private final Runnable pollTask = new Runnable() {
        @Override
        public void run() {
            drainEvents();
            if (polling) handler.postDelayed(this, POLL_INTERVAL_MS);
        }
    };

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "onMicPermission");
            return;
        }
        startEngine(call);
    }

    @com.getcapacitor.annotation.PermissionCallback
    private void onMicPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startEngine(call);
        } else {
            call.reject("Microphone permission denied");
        }
    }

    private void startEngine(PluginCall call) {
        boolean ok = engine.nativeStart();
        if (!ok) {
            call.reject("Failed to start audio engine");
            return;
        }
        polling = true;
        handler.postDelayed(pollTask, POLL_INTERVAL_MS);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        polling = false;
        handler.removeCallbacks(pollTask);
        stopSpice();
        engine.nativeStop();
        call.resolve();
    }

    /**
     * Select the pitch detector: "yin" (native, default) or "spice" (learned,
     * Java TFLite worker). SPICE needs the model bundled at assets/spice.tflite;
     * if it's missing or fails to load, we stay on YIN and report available:false
     * so the UI can explain it. Resolves { detector, available }.
     */
    @PluginMethod
    public void setDetector(PluginCall call) {
        String which = call.getString("detector", "yin");
        JSObject ret = new JSObject();
        if ("spice".equals(which)) {
            if (spice == null) {
                ByteBuffer model = loadSpiceModel();
                if (model == null) {
                    engine.nativeSetDetector("yin");
                    ret.put("detector", "yin");
                    ret.put("available", false);
                    call.resolve(ret);
                    return;
                }
                try {
                    spice = new SpiceEngine(engine, model);
                    spice.start();
                } catch (Throwable t) {
                    spice = null;
                    engine.nativeSetDetector("yin");
                    ret.put("detector", "yin");
                    ret.put("available", false);
                    ret.put("error", String.valueOf(t.getMessage()));
                    call.resolve(ret);
                    return;
                }
            }
            engine.nativeSetDetector("spice");
            ret.put("detector", "spice");
            ret.put("available", true);
        } else if ("beatbox".equals(which)) {
            stopSpice();
            engine.nativeSetDetector("beatbox");
            ret.put("detector", "beatbox");
            ret.put("available", true);
        } else {
            stopSpice();
            engine.nativeSetDetector("yin");
            ret.put("detector", "yin");
            ret.put("available", true);
        }
        call.resolve(ret);
    }

    private void stopSpice() {
        engine.nativeSetDetector("yin");
        if (spice != null) {
            spice.stop();
            spice = null;
        }
    }

    /** Read assets/spice.tflite into a direct ByteBuffer, or null if absent. */
    private ByteBuffer loadSpiceModel() {
        try (InputStream is = getContext().getAssets().open(SPICE_ASSET)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] chunk = new byte[16384];
            int r;
            while ((r = is.read(chunk)) > 0) bos.write(chunk, 0, r);
            byte[] bytes = bos.toByteArray();
            ByteBuffer buf = ByteBuffer.allocateDirect(bytes.length).order(ByteOrder.nativeOrder());
            buf.put(bytes);
            buf.rewind();
            return buf;
        } catch (Exception e) {
            return null; // model not bundled yet
        }
    }

    @PluginMethod
    public void configure(PluginCall call) {
        String scale = call.getString("scale", "chromatic");
        int root = call.getInt("scaleRoot", 60);
        float gate = call.getFloat("gateThreshold", 0.02f);
        float minConf = call.getFloat("minConfidence", 0.72f);
        int minNote = call.getInt("minNote", 36);
        int maxNote = call.getInt("maxNote", 96);
        float settleTol = call.getFloat("settleTol", 0.4f);
        engine.nativeConfigure(scale, root, gate, minConf, minNote, maxNote, settleTol);
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        String[] parts = engine.nativeStatus().split("\\|");
        JSObject ret = new JSObject();
        ret.put("sampleRate", parts.length > 0 ? Integer.parseInt(parts[0]) : 48000);
        ret.put("framesPerBurst", parts.length > 1 ? Integer.parseInt(parts[1]) : 0);
        ret.put("lowLatency", parts.length > 2 && "1".equals(parts[2]));
        ret.put("running", parts.length > 3 && "1".equals(parts[3]));
        call.resolve(ret);
    }

    private void drainEvents() {
        String blob = engine.nativePollEvents();
        if (blob == null || blob.isEmpty()) return;
        for (String line : blob.split("\n")) {
            if (line.isEmpty()) continue;
            String[] p = line.split("\\|");
            switch (p[0]) {
                case "note":
                    emitNote(p);
                    break;
                case "pitch":
                    emitPitch(p);
                    break;
                case "perc":
                    emitPercussion(p);
                    break;
                default:
                    break;
            }
        }
    }

    private void emitNote(String[] p) {
        // note|<on|off|retrig>|<note>|<vel>|<offNote>|<ts>
        String kind = p[1];
        int note = Integer.parseInt(p[2]);
        int vel = Integer.parseInt(p[3]);
        int offNote = Integer.parseInt(p[4]);
        long ts = Long.parseLong(p[5]);

        if ("retrig".equals(kind)) {
            // Release the previous note, then attack the new one.
            notifyNote("noteOff", offNote, 0, ts);
            notifyNote("noteOn", note, vel, ts);
        } else if ("on".equals(kind)) {
            notifyNote("noteOn", note, vel, ts);
        } else if ("off".equals(kind)) {
            notifyNote("noteOff", note, 0, ts);
        }
    }

    private void notifyNote(String type, int note, int vel, long ts) {
        JSObject e = new JSObject();
        e.put("type", type);
        e.put("note", note);
        e.put("velocity", vel);
        e.put("timestampMs", ts);
        notifyListeners("note", e);
    }

    private void emitPitch(String[] p) {
        // pitch|<freqHz>|<midiFloat>|<confidence>|<rms>|<ts>
        JSObject e = new JSObject();
        e.put("frequency", Float.parseFloat(p[1]));
        e.put("midiFloat", Float.parseFloat(p[2]));
        e.put("confidence", Float.parseFloat(p[3]));
        e.put("rms", Float.parseFloat(p[4]));
        notifyListeners("pitch", e);
    }

    private void emitPercussion(String[] p) {
        // perc|<kick|snare|hat>|<vel>|<lowRatio>|<highRatio>|<zcr>|<ts>
        JSObject e = new JSObject();
        e.put("kind", p[1]);
        e.put("velocity", Integer.parseInt(p[2]));
        e.put("lowRatio", Float.parseFloat(p[3]));
        e.put("highRatio", Float.parseFloat(p[4]));
        e.put("zcr", Float.parseFloat(p[5]));
        e.put("timestampMs", Long.parseLong(p[6]));
        notifyListeners("percussion", e);
    }
}
