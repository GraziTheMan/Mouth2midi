package com.grazitheman.mouth2midi;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the app-local native plugin before the bridge starts.
        registerPlugin(Mouth2MidiPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
