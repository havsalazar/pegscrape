// Keeps the app running while a BLE download is in progress with the screen off.
//
// On Android this needs a foreground service with a notification. The Capacitor version had one
// (KeepAlivePlugin + TransferService on the main branch); the Tauri port of it, a small mobile
// plugin, is still to do. Until then, and on Windows where it isn't needed, this does nothing.

/** Start keeping the app alive; never throws (worst case the download is just not protected). */
export async function keepAliveStart(_text: string) {}

export async function keepAliveStop() {}
