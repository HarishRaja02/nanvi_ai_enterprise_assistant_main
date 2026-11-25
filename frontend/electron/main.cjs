const { app, BrowserWindow, ipcMain, dialog, shell, Notification, session, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const {
  DesktopSearchEngine,
  extractPdfTextNode: engineExtractPdfText,
} = require('./desktopSearchEngine.cjs');
const { SearchSidecarClient } = require('./searchSidecarClient.cjs');

const desktopSearchEngine = new DesktopSearchEngine();
const searchSidecar = new SearchSidecarClient({ app });

let mainWindow = null;
let backendProcess = null;

function isBackendReachable(port = 8000) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health/live`, (res) => {
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function findProjectRoot() {
  const os = require('os');
  const home = os.homedir();
  const seeds = [
    process.cwd(),
    __dirname,
    process.resourcesPath || '',
    path.join(home, 'Desktop', 'nanvi_ai_enterprise_assistant'),
    path.join(home, 'Downloads', 'nanvi_ai_enterprise_assistant'),
    path.join(home, 'Documents', 'nanvi_ai_enterprise_assistant'),
    path.join('C:', 'Users', path.basename(home), 'Desktop', 'nanvi_ai_enterprise_assistant'),
    path.resolve(__dirname, '../../../../..'),
    path.resolve(__dirname, '../../../..'),
    path.resolve(__dirname, '../../..'),
    process.env.NANVI_PROJECT_ROOT || '',
  ].filter(Boolean);

  for (const seed of seeds) {
    let curr = path.resolve(seed);
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(curr, 'backend', 'main.py'))) {
        return curr;
      }
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }
  }
  return null;
}

function findPythonAndProject() {
  const projectDir = findProjectRoot();
  if (!projectDir) return null;

  const pythonCandidates = [
    path.join(projectDir, 'venv', 'Scripts', 'python.exe'),
    path.join(projectDir, '.venv', 'Scripts', 'python.exe'),
    path.join(projectDir, 'venv', 'bin', 'python'),
    'C:\\Python313\\python.exe',
    'python.exe',
    'python',
  ];

  for (const py of pythonCandidates) {
    if (py.includes(path.sep)) {
      if (fs.existsSync(py)) {
        return { pythonExe: py, projectDir };
      }
    } else {
      return { pythonExe: py, projectDir };
    }
  }
  return { pythonExe: 'python', projectDir };
}

async function ensureBackendStarted() {
  // In packaged desktop distributions (EXE/MSIX), connect directly to Vercel cloud backend.
  // Packaged app does not require Python or local .env files.
  if (app.isPackaged) {
    return;
  }
  const online = await isBackendReachable();
  if (online) return;

  const found = findPythonAndProject();
  if (!found) return;

  try {
    backendProcess = spawn(
      found.pythonExe,
      ['-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '8000'],
      {
        cwd: found.projectDir,
        env: {
          ...process.env,
          PYTHONPATH: found.projectDir,
          PYTHONUNBUFFERED: '1',
        },
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      }
    );

    let backendStopped = false;
    backendProcess.on('error', (err) => {
      backendStopped = true;
      console.error('Failed to spawn backend:', err);
    });
    backendProcess.on('exit', () => {
      backendStopped = true;
    });

    // Wait briefly (up to 8s) for backend; break immediately if python exits so startup never stalls 25s
    for (let i = 0; i < 16; i++) {
      if (backendStopped) break;
      await new Promise((r) => setTimeout(r, 500));
      if (backendStopped) break;
      if (await isBackendReachable()) {
        console.log(`Backend connected successfully in ${(i + 1) * 500}ms.`);
        break;
      }
    }
  } catch (err) {
    console.error('Error starting backend:', err);
  }
}

async function createWindow() {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    title: 'Nanvi AI Enterprise Assistant',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false, // Allows cross-origin fetch to localhost:8000 from file://
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.removeMenu();
  mainWindow.setMenuBarVisibility(false);

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    const indexPath = path.join(__dirname, '../dist/index.html');
    mainWindow.loadFile(indexPath);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Never allow external web pages (like Google/Microsoft accounts) to hijack the Electron application window
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  ensureOAuthLoopbackServer();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

let oauthHttpServer = null;

function ensureOAuthLoopbackServer() {
  if (oauthHttpServer) return;
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost:5173');
      const code = parsedUrl.searchParams.get('code');
      const state = parsedUrl.searchParams.get('state');
      const error = parsedUrl.searchParams.get('error');
      const connected = parsedUrl.searchParams.get('connected');
      const oauthStatus = parsedUrl.searchParams.get('status');

      if (connected && oauthStatus) {
        const providerName = connected === 'google'
          ? 'Google Workspace'
          : (connected === 'microsoft365' || connected === 'outlook' || connected === 'onedrive' || connected === 'sharepoint')
            ? 'Microsoft 365 / Outlook'
            : connected.charAt(0).toUpperCase() + connected.slice(1);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('oauth:callback-received', {
            connected,
            status: oauthStatus,
            error: error || undefined,
          });
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (oauthStatus === 'success') {
          res.end(`<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"/><title>Connected - Nanvi AI Assistant</title></head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #000000; color: #f8fafc;">
    <div style="background: #171717; border: 1px solid #262626; padding: 2.5rem; border-radius: 1rem; text-align: center; max-width: 440px;">
      <div style="width: 56px; height: 56px; background: #059669; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.25rem; font-size: 1.75rem; color: #ffffff;">&#10003;</div>
      <h1 style="margin: 0 0 0.5rem; font-size: 1.35rem;">${providerName} Connected!</h1>
      <p style="color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin: 0 0 1.5rem;">Your account is now connected to <strong>Nanvi AI Assistant</strong>. You can close this browser window and return to the app.</p>
      <button style="background: #2563eb; color: #ffffff; border: none; padding: 0.65rem 1.4rem; border-radius: 0.5rem; cursor: pointer; font-weight: 500;" onclick="window.close()">Close Window</button>
    </div>
  </body>
</html>`);
        } else {
          res.end(`<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"/><title>Connection Failed - Nanvi AI</title></head>
  <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #000000; color: #f8fafc;">
    <div style="background: #171717; border: 1px solid #262626; padding: 2rem; border-radius: 1rem; text-align: center; max-width: 420px;">
      <h1 style="color: #ef4444; font-size: 1.25rem; margin-top: 0;">Connection Failed (${providerName})</h1>
      <p style="color: #94a3b8; font-size: 0.95rem;">${error || 'Authorization could not be completed.'}</p>
    </div>
  </body>
</html>`);
        }
      } else if (code) {
        const isMicrosoft = (state && state.startsWith('ms_')) || req.url.toLowerCase().includes('microsoft');
        const provider = isMicrosoft ? 'microsoft' : 'google';
        const providerName = isMicrosoft ? 'Microsoft / Outlook' : 'Google';
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('oauth:callback-received', {
            code,
            state,
            provider,
            pathname: parsedUrl.pathname,
          });
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Connected - Nanvi AI Assistant</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0d14; color: #f8fafc; }
      .card { background: #111827; border: 1px solid #1f2937; padding: 2.5rem; border-radius: 1rem; text-align: center; max-width: 440px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #000000; color: #f8fafc; }
      .card { background: #171717; border: 1px solid #262626; padding: 2.5rem; border-radius: 1rem; text-align: center; max-width: 440px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
      .icon { width: 56px; height: 56px; background: #059669; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.25rem; font-size: 1.75rem; color: #ffffff; }
      h1 { margin: 0 0 0.5rem; font-size: 1.35rem; font-weight: 600; }
      p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin: 0 0 1.5rem; }
      .btn { background: #2563eb; color: #ffffff; border: none; padding: 0.65rem 1.4rem; border-radius: 0.5rem; cursor: pointer; font-weight: 500; font-size: 0.9rem; }
      .btn:hover { background: #1d4ed8; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon">&#10003;</div>
      <h1>Authorization Successful!</h1>
      <p>Your ${providerName} account has been connected to <strong>Nanvi AI Assistant</strong>.<br/>You can safely close this browser window and return to the application.</p>
      <button class="btn" onclick="window.close()">Close Window</button>
    </div>
  </body>
</html>`);
      } else if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"/><title>Authorization Failed - Nanvi AI</title></head>
  <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0d14; color: #f8fafc;">
    <div style="background: #111827; border: 1px solid #1f2937; padding: 2rem; border-radius: 1rem; text-align: center; max-width: 400px;">
  <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #000000; color: #f8fafc;">
    <div style="background: #171717; border: 1px solid #262626; padding: 2rem; border-radius: 1rem; text-align: center; max-width: 400px;">
      <h1 style="color: #ef4444; font-size: 1.25rem; margin-top: 0;">Authorization Canceled</h1>
      <p style="color: #94a3b8; font-size: 0.95rem;">${error}</p>
    </div>
  </body>
</html>`);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Nanvi AI Assistant OAuth Listener');
      }
    } catch (_) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error processing OAuth callback');
    }
  });

  server.on('error', (err) => {
    // Port 5173 may already be used by Vite dev server in development; safely ignore
    console.log('[OAuth] Loopback listener skipped (port busy):', err.message);
  });

  try {
    server.listen(5173, '127.0.0.1', () => {
      oauthHttpServer = server;
      console.log('[OAuth] Loopback listener active on http://127.0.0.1:5173');
    });
  } catch (err) {
    console.log('[OAuth] Loopback listen failed:', err.message);
  }
}

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeOs = require('node:os');
const nodeZlib = require('node:zlib');

const DESKTOP_APPROVED_FOLDERS = new Set();
const DESKTOP_IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', 'venv', '.venv', '.pytest_cache',
  '$recycle.bin', 'system volume information', 'recovery', '$winreagent', 'config.msi', 'msocache',
  '$windows.~bt', '$windows.~ws', '$sysreset', 'windows', 'program files', 'program files (x86)',
  'programdata', 'windowsapps', 'wpsystem', 'steamlibrary', 'xboxgames', 'onedrivetemp',
  'appdata', 'perflogs', 'found.000', 'temp', 'tmp', '.cache', '.next', 'dist', 'build', 'release',
]);
const DESKTOP_SUPPORTED_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.json', '.jsonl', '.log', '.pdf', '.docx',
  '.xlsx', '.xlsm', '.pptx', '.html', '.htm', '.xml', '.rtf', '.doc', '.xls', '.ppt',
  '.tsv', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif',
]);
const DESKTOP_MAX_FILE_BYTES = 50 * 1024 * 1024;

function getApprovedFoldersFile() {
  try {
    return nodePath.join(app.getPath('userData'), 'approved-folders.json');
  } catch {
    return null;
  }
}

function loadApprovedFoldersFromDisk() {
  const fp = getApprovedFoldersFile();
  if (!fp || !nodeFs.existsSync(fp)) return;
  try {
    const raw = JSON.parse(nodeFs.readFileSync(fp, 'utf-8'));
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === 'string' && item.trim()) {
          const resolved = nodePath.resolve(item);
          if (!isBlockedSystemPath(resolved) && nodeFs.existsSync(resolved)) {
            DESKTOP_APPROVED_FOLDERS.add(resolved);
          }
        }
      }
    }
  } catch {
    // ignore corrupt cache file
  }
}

function saveApprovedFoldersToDisk() {
  const fp = getApprovedFoldersFile();
  if (!fp) return;
  try {
    nodeFs.mkdirSync(nodePath.dirname(fp), { recursive: true });
    nodeFs.writeFileSync(fp, JSON.stringify(Array.from(DESKTOP_APPROVED_FOLDERS)), 'utf-8');
  } catch {
    // ignore write failure in read-only sandbox
  }
}

function getConnectedFolderFile() {
  try {
    return nodePath.join(app.getPath('userData'), 'connected-folder.json');
  } catch {
    return null;
  }
}

function loadConnectedFolderFromDisk() {
  const fp = getConnectedFolderFile();
  if (!fp || !nodeFs.existsSync(fp)) return null;
  try {
    const raw = JSON.parse(nodeFs.readFileSync(fp, 'utf-8'));
    if (raw && raw.folderPath && nodeFs.existsSync(raw.folderPath)) {
      DESKTOP_APPROVED_FOLDERS.add(nodePath.resolve(raw.folderPath));
      return raw;
    }
  } catch {
    return null;
  }
  return null;
}

function saveConnectedFolderToDisk(meta) {
  const fp = getConnectedFolderFile();
  if (!fp) return;
  try {
    nodeFs.mkdirSync(nodePath.dirname(fp), { recursive: true });
    if (!meta) {
      if (nodeFs.existsSync(fp)) {
        nodeFs.unlinkSync(fp);
      }
    } else {
      nodeFs.writeFileSync(fp, JSON.stringify(meta, null, 2), 'utf-8');
    }
  } catch {
    // ignore
  }
}

function isPathUnderApprovedFolder(targetPath) {
  if (!targetPath) return false;
  const resolved = nodePath.resolve(expandManualFolderPath(String(targetPath)) || String(targetPath));
  const norm = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  for (const folder of DESKTOP_APPROVED_FOLDERS) {
    const folderNorm = process.platform === 'win32' ? folder.toLowerCase() : folder;
    const prefix = folderNorm.endsWith(nodePath.sep) ? folderNorm : folderNorm + nodePath.sep;
    if (norm === folderNorm || norm.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function expandManualFolderPath(rawPath) {
  let cleaned = String(rawPath || '').trim().replace(/^['"“”`]|['"“”`]$/g, '').trim();
  if (!cleaned) return '';
  cleaned = cleaned.replace(/%([^%]+)%/g, (m, varName) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === varName.toLowerCase());
    return key ? (process.env[key] || m) : m;
  });
  if (cleaned === '~' || cleaned.startsWith('~/') || cleaned.startsWith('~\\')) {
    cleaned = nodePath.join(nodeOs.homedir(), cleaned.slice(2));
  }
  if (/^[A-Za-z]:[/\\]*$/.test(cleaned)) {
    cleaned = `${cleaned[0].toUpperCase()}:\\`;
  }
  return cleaned;
}

function isBlockedSystemPath(resolvedPath) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/[\\/]+$/, '');
  const target = norm(resolvedPath);
  if (!target || target === '/' || /^[a-z]:$/i.test(target)) {
    // Allow non-C: drive roots (e.g. D:\ preset) only if not C:\ system drive root
    return !target || target === '/' || target === 'c:';
  }
  const blocked = [
    process.env.SystemRoot || 'C:\\Windows',
    process.env.ProgramFiles || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'C:\\Windows',
    '/etc',
    '/sys',
    '/usr',
    '/bin',
    '/sbin',
  ];
  return blocked.some((b) => {
    const bNorm = norm(nodePath.resolve(b));
    return target === bNorm || target.startsWith(bNorm + nodePath.sep.toLowerCase());
  });
}

const QUICK_FILE_COUNT_CACHE = new Map();
const WARM_IN_FLIGHT_PATHS = new Map();

async function walkApprovedFolderEntries(rootResolved, maxFiles = 5000) {
  const entries = [];
  const stack = [{ dir: rootResolved, depth: 0 }];
  const visitedDirs = new Set();
  let ops = 0;
  while (stack.length > 0 && entries.length < maxFiles) {
    const { dir, depth } = stack.pop();
    if (depth > 22) continue;
    const normKey = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (visitedDirs.has(normKey)) continue;
    visitedDirs.add(normKey);
    ops++;
    if (ops % 12 === 0) {
      await new Promise((r) => setImmediate(r));
    }
    let dirents;
    try {
      dirents = await nodeFs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (entries.length >= maxFiles) break;
      ops++;
      if (ops % 60 === 0) {
        await new Promise((r) => setImmediate(r));
      }
      if (d.name.startsWith('.') || d.name.startsWith('$') || d.name.startsWith('~$')) continue;
      if (typeof d.isSymbolicLink === 'function' && d.isSymbolicLink()) continue;
      const fullPath = nodePath.join(dir, d.name);
      if (d.isDirectory()) {
        if (DESKTOP_IGNORED_DIRS.has(d.name.toLowerCase())) continue;
        try {
          const lst = await nodeFs.promises.lstat(fullPath);
          if (lst.isSymbolicLink()) continue;
        } catch {
          continue;
        }
        stack.push({ dir: fullPath, depth: depth + 1 });
      } else if (d.isFile()) {
        const ext = nodePath.extname(d.name).toLowerCase();
        if (!DESKTOP_SUPPORTED_EXTS.has(ext)) continue;
        try {
          const st = await nodeFs.promises.stat(fullPath);
          if (st.size > 0 && st.size <= DESKTOP_MAX_FILE_BYTES) {
            entries.push({
              absPath: fullPath,
              relativePath: nodePath.relative(rootResolved, fullPath).replace(/\\/g, '/'),
              name: d.name,
              size: st.size,
              lastModified: Math.round(st.mtimeMs),
            });
          }
        } catch {
          // ignore unreadable entries
        }
      }
    }
  }
  return entries;
}

async function countSupportedFilesFast(rootResolved, limit = 50000, budgetMs = 1100) {
  const cacheKey = process.platform === 'win32' ? rootResolved.toLowerCase() : rootResolved;
  const cached = QUICK_FILE_COUNT_CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < 20000) {
    return cached.count;
  }

  const startedAt = Date.now();
  let count = 0;
  let ops = 0;
  const stack = [{ dir: rootResolved, depth: 0 }];
  const visitedDirs = new Set();
  let hitBudget = false;

  while (stack.length > 0 && count < limit) {
    if ((Date.now() - startedAt) > budgetMs) {
      hitBudget = true;
      break;
    }
    const { dir, depth } = stack.pop();
    if (depth > 22) continue;
    const normKey = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (visitedDirs.has(normKey)) continue;
    visitedDirs.add(normKey);

    ops++;
    if (ops % 12 === 0) {
      await new Promise((r) => setImmediate(r));
    }

    let dirents;
    try {
      dirents = await nodeFs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      ops++;
      if (ops % 80 === 0) {
        await new Promise((r) => setImmediate(r));
        if ((Date.now() - startedAt) > budgetMs) {
          hitBudget = true;
          break;
        }
      }
      if (d.name.startsWith('.') || d.name.startsWith('$') || d.name.startsWith('~$')) continue;
      if (typeof d.isSymbolicLink === 'function' && d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        if (DESKTOP_IGNORED_DIRS.has(d.name.toLowerCase())) continue;
        const subDir = nodePath.join(dir, d.name);
        stack.push({ dir: subDir, depth: depth + 1 });
      } else if (d.isFile()) {
        const ext = nodePath.extname(d.name).toLowerCase();
        if (DESKTOP_SUPPORTED_EXTS.has(ext)) {
          count++;
          if (count >= limit) break;
        }
      }
    }
    if (hitBudget) break;
  }

  // If count hit the quick UI deadline, persist current count right away and keep counting cleanly
  // in tiny background slices without ever delaying UI folder connect or app launch!
  QUICK_FILE_COUNT_CACHE.set(cacheKey, { count, ts: Date.now() });
  if (hitBudget && count > 0) {
    setImmediate(async () => {
      try {
        while (stack.length > 0 && count < limit) {
          const { dir, depth } = stack.pop();
          if (depth > 22) continue;
          const normKey = process.platform === 'win32' ? dir.toLowerCase() : dir;
          if (visitedDirs.has(normKey)) continue;
          visitedDirs.add(normKey);
          let dirents;
          try {
            dirents = await nodeFs.promises.readdir(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const d of dirents) {
            ops++;
            if (ops % 60 === 0) await new Promise((r) => setImmediate(r));
            if (d.name.startsWith('.') || d.name.startsWith('$') || d.name.startsWith('~$')) continue;
            if (typeof d.isSymbolicLink === 'function' && d.isSymbolicLink()) continue;
            if (d.isDirectory()) {
              if (!DESKTOP_IGNORED_DIRS.has(d.name.toLowerCase())) {
                stack.push({ dir: nodePath.join(dir, d.name), depth: depth + 1 });
              }
            } else if (d.isFile()) {
              if (DESKTOP_SUPPORTED_EXTS.has(nodePath.extname(d.name).toLowerCase())) {
                count++;
                if (count >= limit) break;
              }
            }
          }
          await new Promise((r) => setImmediate(r));
        }
        QUICK_FILE_COUNT_CACHE.set(cacheKey, { count, ts: Date.now() });
        const cur = loadConnectedFolderFromDisk();
        if (cur && cur.folderPath && nodePath.resolve(cur.folderPath).toLowerCase() === rootResolved.toLowerCase()) {
          saveConnectedFolderToDisk({ ...cur, fileCount: count });
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('fs:folderCountUpdated', { folderPath: rootResolved, fileCount: count });
        }
      } catch {
        // non-fatal background count
      }
    });
  }
  return count;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripXmlTagsNode(xml) {
  return decodeXmlEntities(
    String(xml || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(w:p|row|p|div|li|tr|h[1-6]|br)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readZipEntriesNode(buf) {
  const entries = new Map();
  if (!buf || buf.length < 22) return entries;
  let eocdPos = -1;
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) return entries;

  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  let cdPos = buf.readUInt32LE(eocdPos + 16);
  for (let idx = 0; idx < totalEntries && cdPos + 46 <= buf.length; idx++) {
    if (buf.readUInt32LE(cdPos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(cdPos + 10);
    const compSize = buf.readUInt32LE(cdPos + 20);
    const nameLen = buf.readUInt16LE(cdPos + 28);
    const extraLen = buf.readUInt16LE(cdPos + 30);
    const commentLen = buf.readUInt16LE(cdPos + 32);
    const localOff = buf.readUInt32LE(cdPos + 42);
    const name = buf.subarray(cdPos + 46, cdPos + 46 + nameLen).toString('utf8');
    cdPos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) continue;

    const rawSlice = buf.subarray(dataStart, dataStart + compSize);
    try {
      if (method === 0) {
        entries.set(name, rawSlice);
      } else if (method === 8) {
        entries.set(name, nodeZlib.inflateRawSync(rawSlice));
      }
    } catch {
      // skip corrupt zip entry
    }
  }
  return entries;
}

function extractOfficeTextNode(ext, buf) {
  const entries = readZipEntriesNode(buf);
  const lower = new Map();
  for (const [k, v] of entries.entries()) lower.set(k.toLowerCase(), v);

  if (ext === '.docx') {
    const raw = lower.get('word/document.xml');
    return raw ? stripXmlTagsNode(raw.toString('utf8')) : '';
  }

  if (ext === '.xlsx' || ext === '.xlsm') {
    const shared = [];
    const ssRaw = lower.get('xl/sharedstrings.xml');
    if (ssRaw) {
      const ssXml = ssRaw.toString('utf8');
      const siMatches = ssXml.match(/<si[\s\S]*?<\/si>/gi) || [];
      for (const si of siMatches) {
        shared.push(stripXmlTagsNode(si));
      }
    }
    const sheets = Array.from(entries.keys())
      .filter((k) => /^xl\/worksheets\/sheet.*\.xml$/i.test(k))
      .sort()
      .slice(0, 15);
    const out = [];
    for (const sName of sheets) {
      out.push(`--- Sheet: ${nodePath.basename(sName, '.xml')} ---`);
      const sRaw = entries.get(sName);
      if (!sRaw) continue;
      const sXml = sRaw.toString('utf8');
      const rows = sXml.match(/<row\b[^>]*>[\s\S]*?<\/row>/gi) || [];
      for (const row of rows.slice(0, 800)) {
        const vals = [];
        const cells = row.match(/<c\b[^>]*>[\s\S]*?<\/c>/gi) || [];
        for (const c of cells) {
          const isShared = /\bt=["']s["']/i.test(c);
          const mVal = c.match(/<(?:v|t)[^>]*>([\s\S]*?)<\/(?:v|t)>/i);
          if (!mVal) continue;
          const rawVal = decodeXmlEntities(mVal[1]).trim();
          if (!rawVal) continue;
          if (isShared) {
            const idx = parseInt(rawVal, 10);
            vals.push(Number.isFinite(idx) && idx >= 0 && idx < shared.length ? shared[idx] : rawVal);
          } else {
            vals.push(rawVal);
          }
        }
        if (vals.length > 0) out.push(vals.join(' | '));
      }
    }
    return out.join('\n').trim();
  }

  if (ext === '.pptx') {
    const slides = Array.from(entries.keys())
      .filter((k) => /^ppt\/slides\/slide.*\.xml$/i.test(k))
      .sort();
    return slides
      .map((s) => stripXmlTagsNode((entries.get(s) || Buffer.alloc(0)).toString('utf8')))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function extractPdfTextNode(buf) {
  return engineExtractPdfText(buf);
}

function warmDesktopFolder(resolvedPath) {
  const key = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  const prevTs = WARM_IN_FLIGHT_PATHS.get(key) || 0;
  if (Date.now() - prevTs < 15000) {
    return;
  }
  WARM_IN_FLIGHT_PATHS.set(key, Date.now());
  setImmediate(() => {
    searchSidecar.warmWorkspace(resolvedPath).then((res) => {
      if (!res && !searchSidecar.ready) {
        return desktopSearchEngine.warmIndexAsync(resolvedPath);
      }
      return res;
    }).catch(() => {
      if (!searchSidecar.ready) {
        desktopSearchEngine.warmIndexAsync(resolvedPath).catch(() => { });
      }
    });
  });
}

async function searchApprovedFolderOnDisk(rootResolved, query, topChunksLimit = 8, topFilesLimit = 10, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const sidecarResult = await searchSidecar.search(rootResolved, query, {
    topChunksLimit,
    topFilesLimit,
    ...opts,
  });
  if (sidecarResult) {
    return sidecarResult;
  }
  const fallback = desktopSearchEngine.search(rootResolved, query, {
    topChunksLimit,
    topFilesLimit,
    ...opts,
  });
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback.engines_used)) {
    fallback.engines_used = ['node_fallback'];
    fallback.offline_mode = opts.cloudConnected === undefined ? true : !opts.cloudConnected;
    fallback.generation_mode = opts.cloudConnected ? 'cloud_llm' : 'retrieval_only';
  }
  return fallback;
}

const DESKTOP_TEXT_CACHE = new Map();
const DESKTOP_PLAIN_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.yaml', '.yml', '.rtf',
]);

function readAndExtractFileTextCached(absPath, ext) {
  let st;
  try {
    st = nodeFs.statSync(absPath);
    if (!st.isFile() || st.size <= 0 || st.size > DESKTOP_MAX_FILE_BYTES) return '';
  } catch {
    return '';
  }
  const prev = DESKTOP_TEXT_CACHE.get(absPath);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
    return prev.text;
  }

  let text = '';
  try {
    if (DESKTOP_PLAIN_EXTS.has(ext)) {
      text = nodeFs.readFileSync(absPath, 'utf8').trim();
    } else if (ext === '.html' || ext === '.htm' || ext === '.xml') {
      text = stripXmlTagsNode(nodeFs.readFileSync(absPath, 'utf8'));
    } else if (ext === '.docx' || ext === '.xlsx' || ext === '.xlsm' || ext === '.pptx') {
      text = extractOfficeTextNode(ext, nodeFs.readFileSync(absPath));
    } else if (ext === '.pdf') {
      text = extractPdfTextNode(nodeFs.readFileSync(absPath));
    }
  } catch {
    text = '';
  }

  if (DESKTOP_TEXT_CACHE.size > 4000) {
    DESKTOP_TEXT_CACHE.clear();
  }
  DESKTOP_TEXT_CACHE.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, text });
  return text;
}

function chunkTextWindows(text, maxChunks = 16) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= 1000) return [clean];
  const out = [];
  let start = 0;
  while (start < clean.length && out.length < maxChunks) {
    let end = start + 1000;
    if (end < clean.length) {
      const nl = clean.lastIndexOf('\n', end);
      if (nl > start + 450) end = nl + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - 150);
  }
  return out;
}

// Search and extraction delegated to persistent desktopSearchEngine (desktopSearchEngine.cjs)

// IPC Handlers
ipcMain.handle('dialog:selectFolder', async () => {
  const targetWin = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!targetWin) return null;
  const result = await dialog.showOpenDialog(targetWin, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Company Folder for Nanvi Assistant',
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const selectedPath = nodePath.resolve(result.filePaths[0]);
  DESKTOP_APPROVED_FOLDERS.add(selectedPath);
  saveApprovedFoldersToDisk();
  const fileCount = await countSupportedFilesFast(selectedPath);
  saveConnectedFolderToDisk({
    folderPath: selectedPath,
    folderName: nodePath.basename(selectedPath) || selectedPath,
    fileCount,
    lastSyncedAt: new Date().toISOString(),
  });
  warmDesktopFolder(selectedPath);
  return selectedPath;
});

ipcMain.handle('fs:listFolderFiles', async (_event, folderPath) => {
  if (!isPathUnderApprovedFolder(folderPath)) return [];
  const rootResolved = nodePath.resolve(String(folderPath));
  return await walkApprovedFolderEntries(rootResolved);
});

ipcMain.handle('fs:approveAndListFolderFiles', async (_event, rawPath) => {
  const expanded = expandManualFolderPath(rawPath);
  if (!expanded) {
    return { ok: false, error: 'Please provide a valid folder path.' };
  }
  const resolved = nodePath.resolve(expanded);
  if (isBlockedSystemPath(resolved)) {
    return { ok: false, error: 'System folders cannot be connected for security.' };
  }
  try {
    if (!nodeFs.existsSync(resolved) || !nodeFs.statSync(resolved).isDirectory()) {
      return { ok: false, error: `Folder not found on this computer: ${resolved}` };
    }
  } catch (err) {
    return { ok: false, error: `Cannot access folder ${resolved}: ${err?.message || 'Permission denied'}` };
  }
  DESKTOP_APPROVED_FOLDERS.add(resolved);
  saveApprovedFoldersToDisk();
  const entries = await walkApprovedFolderEntries(resolved);
  saveConnectedFolderToDisk({
    folderPath: resolved,
    folderName: nodePath.basename(resolved) || resolved,
    fileCount: entries.length,
    lastSyncedAt: new Date().toISOString(),
  });
  warmDesktopFolder(resolved);
  return {
    ok: true,
    folderPath: resolved,
    entries,
  };
});

ipcMain.handle('fs:connectFolderFast', async (_event, rawPath) => {
  const expanded = expandManualFolderPath(rawPath);
  if (!expanded) {
    return { ok: false, error: 'Please provide a valid folder path.' };
  }
  const resolved = nodePath.resolve(expanded);
  if (isBlockedSystemPath(resolved)) {
    return { ok: false, error: 'System folders cannot be connected for security.' };
  }
  try {
    if (!nodeFs.existsSync(resolved) || !nodeFs.statSync(resolved).isDirectory()) {
      return { ok: false, error: `Folder not found on this computer: ${resolved}` };
    }
  } catch (err) {
    return { ok: false, error: `Cannot access folder ${resolved}: ${err?.message || 'Permission denied'}` };
  }
  DESKTOP_APPROVED_FOLDERS.add(resolved);
  saveApprovedFoldersToDisk();
  const fileCount = await countSupportedFilesFast(resolved);
  saveConnectedFolderToDisk({
    folderPath: resolved,
    folderName: nodePath.basename(resolved) || resolved,
    fileCount,
    lastSyncedAt: new Date().toISOString(),
  });
  warmDesktopFolder(resolved);
  return {
    ok: true,
    folderPath: resolved,
    fileCount,
  };
});

ipcMain.handle('fs:getPersistedDesktopFolder', async () => {
  return loadConnectedFolderFromDisk();
});

ipcMain.handle('fs:savePersistedDesktopFolder', async (_event, meta) => {
  if (meta && meta.folderPath) {
    const expanded = expandManualFolderPath(meta.folderPath) || meta.folderPath;
    const resolved = nodePath.resolve(expanded);
    const normalizedMeta = {
      ...meta,
      folderPath: resolved,
      folderName: meta.folderName || nodePath.basename(resolved) || resolved,
    };
    saveConnectedFolderToDisk(normalizedMeta);
    DESKTOP_APPROVED_FOLDERS.add(resolved);
    saveApprovedFoldersToDisk();
    warmDesktopFolder(resolved);
  } else {
    saveConnectedFolderToDisk(meta);
  }
  return true;
});

ipcMain.handle('fs:searchFolder', async (_event, folderPath, query, topChunksLimit = 8, topFilesLimit = 10, options = {}) => {
  if (!folderPath) return null;
  const resolved = nodePath.resolve(String(folderPath));
  if (!isPathUnderApprovedFolder(resolved)) return null;
  if (!nodeFs.existsSync(resolved)) return null;
  return searchApprovedFolderOnDisk(resolved, query, topChunksLimit, topFilesLimit, options);
});

ipcMain.handle('fs:getSearchStatus', async (_event, folderPath) => {
  const resolved = folderPath ? nodePath.resolve(String(folderPath)) : null;
  return searchSidecar.getStatus(resolved);
});

ipcMain.handle('fs:revokeApprovedFolder', async (_event, folderPath) => {
  if (!folderPath) {
    DESKTOP_APPROVED_FOLDERS.clear();
    saveConnectedFolderToDisk(null);
  } else {
    const resolvedNorm = nodePath.resolve(String(folderPath)).toLowerCase();
    for (const existing of Array.from(DESKTOP_APPROVED_FOLDERS)) {
      if (existing.toLowerCase() === resolvedNorm) {
        DESKTOP_APPROVED_FOLDERS.delete(existing);
      }
    }
    const currentConnected = loadConnectedFolderFromDisk();
    if (currentConnected && nodePath.resolve(currentConnected.folderPath).toLowerCase() === resolvedNorm) {
      saveConnectedFolderToDisk(null);
    }
  }
  saveApprovedFoldersToDisk();
  return true;
});

ipcMain.handle('fs:readFileBytes', async (_event, filePath) => {
  if (!filePath) return null;
  let target = String(filePath).replace(/^file:\/\/\/?/, '');
  if (process.platform === 'win32') target = target.replace(/\//g, '\\');
  let resolvedTarget = nodePath.resolve(target);
  if (!nodeFs.existsSync(resolvedTarget)) {
    const cleanRel = String(filePath).replace(/^file:\/\/\/?/, '').replace(/\\/g, '/').replace(/^\/+/, '');
    for (const folder of DESKTOP_APPROVED_FOLDERS) {
      const cand1 = nodePath.resolve(folder, target);
      const cand2 = nodePath.resolve(folder, cleanRel);
      const cand3 = nodePath.resolve(folder, nodePath.basename(cleanRel));
      if (nodeFs.existsSync(cand1)) { resolvedTarget = cand1; break; }
      if (nodeFs.existsSync(cand2)) { resolvedTarget = cand2; break; }
      if (nodeFs.existsSync(cand3)) { resolvedTarget = cand3; break; }
    }
  }
  if (!isPathUnderApprovedFolder(resolvedTarget)) return null;
  try {
    const st = nodeFs.statSync(resolvedTarget);
    if (!st.isFile() || st.size > DESKTOP_MAX_FILE_BYTES) return null;
    const buf = nodeFs.readFileSync(resolvedTarget);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return null;
  }
});

ipcMain.handle('app:notification', (_event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title: title || 'Nanvi AI', body }).show();
    return true;
  }
  return false;
});

ipcMain.handle('app:openExternal', (_event, url) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
  }
});

ipcMain.handle('shell:openPath', async (_event, filePath) => {
  if (!filePath) return { error: 'Empty file path' };
  try {
    let normPath = String(filePath).replace(/^file:\/\/\/?/, '');
    if (process.platform === 'win32') normPath = normPath.replace(/\//g, '\\');
    if (!nodeFs.existsSync(normPath)) {
      const cleanRel = String(filePath).replace(/^file:\/\/\/?/, '').replace(/\\/g, '/').replace(/^\/+/, '');
      for (const folder of DESKTOP_APPROVED_FOLDERS) {
        const cand1 = nodePath.resolve(folder, normPath);
        const cand2 = nodePath.resolve(folder, cleanRel);
        const cand3 = nodePath.resolve(folder, nodePath.basename(cleanRel));
        if (nodeFs.existsSync(cand1)) { normPath = cand1; break; }
        if (nodeFs.existsSync(cand2)) { normPath = cand2; break; }
        if (nodeFs.existsSync(cand3)) { normPath = cand3; break; }
      }
    }
    const err = await shell.openPath(normPath);
    if (err) {
      console.warn('shell.openPath error:', err);
      return { error: err };
    }
    return { success: true };
  } catch (ex) {
    return { error: ex.message };
  }
});

ipcMain.handle('shell:showItemInFolder', async (_event, filePath) => {
  if (!filePath) return false;
  try {
    const normPath = String(filePath).replace(/^file:\/\/\/?/, '');
    shell.showItemInFolder(normPath);
    return true;
  } catch (_) {
    return false;
  }
});

ipcMain.handle('voice:getMicAccessStatus', async () => {
  try {
    if (systemPreferences && typeof systemPreferences.getMediaAccessStatus === 'function') {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      return { status: String(status || 'unknown'), platform: process.platform };
    }
  } catch (_) {
    // ignore platform lookup errors
  }
  return { status: 'unknown', platform: process.platform };
});

ipcMain.handle('voice:requestMicAccess', async () => {
  try {
    if (process.platform === 'darwin' && systemPreferences && typeof systemPreferences.askForMediaAccess === 'function') {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      return { granted: Boolean(granted), status: granted ? 'granted' : 'denied' };
    }
    if (systemPreferences && typeof systemPreferences.getMediaAccessStatus === 'function') {
      const status = String(systemPreferences.getMediaAccessStatus('microphone') || 'unknown');
      return { granted: status !== 'denied' && status !== 'restricted', status };
    }
  } catch (_) {
    // ignore
  }
  return { granted: true, status: 'unknown' };
});

ipcMain.handle('voice:openMicSettings', async () => {
  try {
    if (process.platform === 'win32') {
      await shell.openExternal('ms-settings:privacy-microphone');
      return true;
    }
    if (process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
      return true;
    }
  } catch (_) {
    // ignore
  }
  return false;
});

// App Lifecycle
app.whenReady().then(async () => {
  // Automatically grant media/microphone permissions so Voice Assistant works seamlessly
  if (session && session.defaultSession) {
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      if (permission === 'media' || permission === 'microphone' || permission === 'audioCapture') {
        return true;
      }
      return true;
    });

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === 'media' || permission === 'microphone' || permission === 'audioCapture') {
        callback(true);
        return;
      }
      callback(true);
    });

    if (typeof session.defaultSession.setDevicePermissionHandler === 'function') {
      session.defaultSession.setDevicePermissionHandler(() => true);
    }
  }

  desktopSearchEngine.setCacheDir(path.join(app.getPath('userData'), 'search-index-cache'));
  searchSidecar.ensureStarted().catch(() => { });
  loadApprovedFoldersFromDisk();
  const persistedMeta = loadConnectedFolderFromDisk();
  await ensureBackendStarted();
  await createWindow();

  if (persistedMeta && persistedMeta.folderPath) {
    const resolvedPersisted = path.resolve(String(persistedMeta.folderPath));
    if (fs.existsSync(resolvedPersisted)) {
      setTimeout(() => {
        warmDesktopFolder(resolvedPersisted);
      }, 1200);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('will-quit', () => {
  desktopSearchEngine.closeWatchers();
  searchSidecar.shutdownSync();
  if (oauthHttpServer) {
    try {
      oauthHttpServer.close();
    } catch (_) { }
    oauthHttpServer = null;
  }
  if (backendProcess && backendProcess.pid) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/PID', String(backendProcess.pid), '/T'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        backendProcess.kill();
      }
    } catch (_) { }
    backendProcess = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
