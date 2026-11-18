import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `tauri android dev` sets TAURI_DEV_HOST so the phone can reach the dev server over the network.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Relative asset paths, so the build loads the same way in every webview.
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
    // On Windows the cwd's drive-letter case (d:\ vs D:\) can differ between shells, which made
    // the bundler load React twice ("Cannot read properties of null (reading 'useState')").
    dedupe: ['react', 'react-dom'],
  },
  // Tauri loads the dev server from a fixed URL (src-tauri/tauri.conf.json, devUrl).
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 5183 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
