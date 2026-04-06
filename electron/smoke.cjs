/**
 * Run: npm run build:electron && npx electron electron/smoke.cjs
 * Verifies preload exposes window.grist (no Vite; about:blank only).
 */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const preload = path.join(__dirname, "..", "dist-electron", "preload.cjs");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await win.loadURL("about:blank");
    const ok = await win.webContents.executeJavaScript(
      "typeof window.grist === 'object' && window.grist !== null && typeof window.grist.ping === 'function'"
    );
    await win.close();
    if (!ok) {
      console.error("SMOKE_FAIL: window.grist or grist.ping missing");
      app.exit(1);
      return;
    }
    console.log("SMOKE_OK: preload exposed window.grist");
    app.exit(0);
  } catch (e) {
    console.error("SMOKE_FAIL:", e);
    try {
      await win.close();
    } catch {
      /* ignore */
    }
    app.exit(1);
  }
});
