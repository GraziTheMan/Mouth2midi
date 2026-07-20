import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.grazitheman.mouth2midi',
  appName: 'Mouth2MIDI',
  webDir: 'dist',
  android: {
    // We need the mic at the lowest latency the device will grant. The native
    // Oboe engine requests exclusive/MMAP mode; nothing to configure here for
    // that, but keep the web layer from grabbing the mic via getUserMedia so
    // there is no contention with the native input stream.
    allowMixedContent: true,
  },
  // For live-reload dev on-device, uncomment and set to your machine's LAN IP:
  // server: {
  //   url: 'http://192.168.1.50:5173',
  //   cleartext: true,
  // },
};

export default config;
