// Keeps the app running while a BLE download is in progress with the screen off.
// Android: a foreground service with a notification (android/.../TransferService.java).
// Elsewhere it does nothing.
import { Capacitor, registerPlugin } from '@capacitor/core';

interface KeepAlivePlugin {
  start(opts: { text: string }): Promise<void>;
  stop(): Promise<void>;
}

const native = Capacitor.getPlatform() === 'android' ? registerPlugin<KeepAlivePlugin>('KeepAlive') : null;

/** Start keeping the app alive; never throws (worst case the download is just not protected). */
export async function keepAliveStart(text: string) {
  await native?.start({ text }).catch(() => {});
}

export async function keepAliveStop() {
  await native?.stop().catch(() => {});
}
