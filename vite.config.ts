import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Relative asset paths so the build loads from file:// (Electron) and the Capacitor WebView.
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
    // On Windows the cwd's drive-letter case (d:\ vs D:\) can differ between shells, which made
    // the bundler load React twice ("Cannot read properties of null (reading 'useState')").
    dedupe: ['react', 'react-dom'],
  },
});
