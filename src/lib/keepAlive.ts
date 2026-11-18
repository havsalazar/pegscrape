// Keeps the app running while a BLE download is in progress with the screen off.
//
// On Android this needs a foreground service with a notification, which is still to do (a small
// Tauri mobile plugin). Short screen-off periods already work without it. On Windows it isn't
// needed. Until then this does nothing.

/** Start keeping the app alive; never throws (worst case the download is just not protected). */
export async function keepAliveStart(_text: string) {}

export async function keepAliveStop() {}
