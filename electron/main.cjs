// Electron entry point for the Windows desktop build.
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// The app was called "Incli" before. Electron keeps data in a folder named after the app, so on
// the first Pegscrape launch copy the saved map tiles (IndexedDB) across from the old folder.
function migrateFromIncli() {
  try {
    const oldDb = path.join(app.getPath('appData'), 'Incli', 'IndexedDB');
    const newDb = path.join(app.getPath('userData'), 'IndexedDB');
    if (fs.existsSync(oldDb) && !fs.existsSync(newDb)) fs.cpSync(oldDb, newDb, { recursive: true });
  } catch {
    // Not critical: the map simply re-downloads tiles.
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 420,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    // build/icon.png (made by scripts/make-icon.ps1) is the exe's icon; this copy is the window's.
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    title: 'Pegscrape',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Open map attribution links etc. in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  // Web Bluetooth (the logger link, src/lib/loggerLink.ts): Electron has no device chooser of
  // its own and calls this as devices turn up. The request already filters on the logger's
  // service, so take the first one found; give up after 20 s (the app then says "no logger").
  let pickBluetooth = null;
  let pickTimer = null;
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    if (pickBluetooth !== callback) {
      pickBluetooth = callback;
      clearTimeout(pickTimer);
      pickTimer = setTimeout(() => {
        if (pickBluetooth === callback) callback('');
        pickBluetooth = null;
      }, 20_000);
    }
    const logger = devices.find((d) => /^Pegscrape/i.test(d.deviceName)) ?? devices[0];
    if (logger) {
      clearTimeout(pickTimer);
      pickBluetooth = null;
      callback(logger.deviceId);
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  migrateFromIncli();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
