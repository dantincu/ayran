const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

// Register ayran-notes:// protocol for deep links
app.setAsDefaultProtocolClient('ayran-notes');

// Enable sandboxed preload
app.enableSandbox();

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    title: 'Ayran Notes',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs limited Node access
    },
  });

  // Load the Expo web build
  const distPath = path.join(__dirname, '..', 'dist', 'index.html');
  if (fs.existsSync(distPath)) {
    win.loadFile(distPath);
  } else {
    // Dev mode: load from Expo dev server
    win.loadURL('http://localhost:8081');
  }

  if (process.argv.includes('--dev-tools')) {
    win.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  // Register local file protocol to serve dist assets
  protocol.registerFileProtocol('file', (request, callback) => {
    const filePath = request.url.slice('file://'.length);
    callback({ path: filePath });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: File system operations exposed to renderer via preload
ipcMain.handle('fs:readFile', async (_, filePath) => {
  return fs.promises.readFile(filePath, 'utf-8');
});

ipcMain.handle('fs:writeFile', async (_, filePath, content) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, 'utf-8');
});

ipcMain.handle('fs:readFileBytes', async (_, filePath) => {
  const buf = await fs.promises.readFile(filePath);
  return Array.from(buf); // Transfer as array for IPC
});

ipcMain.handle('fs:writeFileBytes', async (_, filePath, bytes) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, Buffer.from(bytes));
});

ipcMain.handle('fs:deleteFile', async (_, filePath) => {
  await fs.promises.unlink(filePath).catch(() => {});
});

ipcMain.handle('fs:listDir', async (_, dirPath) => {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const stats = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dirPath, entry.name);
      const stat = await fs.promises.stat(full).catch(() => null);
      return {
        name: entry.name,
        path: full.replace(/\\/g, '/'),
        isDirectory: entry.isDirectory(),
        size: stat?.size,
        modifiedAt: stat ? new Date(stat.mtimeMs).toISOString() : undefined,
      };
    }),
  );
  return stats;
});

ipcMain.handle('fs:createDir', async (_, dirPath) => {
  await fs.promises.mkdir(dirPath, { recursive: true });
});

ipcMain.handle('fs:deleteDir', async (_, dirPath) => {
  await fs.promises.rm(dirPath, { recursive: true, force: true });
});

ipcMain.handle('fs:moveFile', async (_, srcPath, destPath) => {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await fs.promises.rename(srcPath, destPath);
});

ipcMain.handle('fs:copyFile', async (_, srcPath, destPath) => {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await fs.promises.copyFile(srcPath, destPath);
});

ipcMain.handle('fs:exists', async (_, filePath) => {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('fs:stat', async (_, filePath) => {
  try {
    const stat = await fs.promises.stat(filePath);
    return {
      name: path.basename(filePath),
      path: filePath.replace(/\\/g, '/'),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
});

// Dialog: open folder picker
ipcMain.handle('dialog:openFolder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Notebook Root Folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

// Print to PDF
ipcMain.handle('print:toPdf', async (event, html) => {
  const tmpWin = new BrowserWindow({ show: false });
  await tmpWin.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  const buf = await tmpWin.webContents.printToPDF({});
  tmpWin.close();
  return Array.from(buf);
});
