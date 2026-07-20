import { defineConfig } from 'vite';

// Capacitor loads the built web assets from `dist/` (see capacitor.config.ts
// webDir). During development you can also live-reload onto the device by
// pointing capacitor.config.ts server.url at your dev-server LAN address.
export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
  server: {
    host: true, // expose on LAN so the phone can hit the dev server
    port: 5173,
  },
});
