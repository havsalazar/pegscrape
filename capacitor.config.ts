import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.incli.app',
  appName: 'Pegscrape',
  webDir: 'dist',
  backgroundColor: '#0a0a0a',
  // Debug builds otherwise log every bridge call, and a ride download makes thousands
  // (one per Bluetooth notification).
  loggingBehavior: 'none',
};

export default config;
