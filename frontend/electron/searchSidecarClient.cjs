const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Manages lifecycle and authenticated 127.0.0.1 loopback IPC for the
 * Nanvi Desktop Multi-Engine Search Sidecar (SQLite + Tantivy + hnswlib).
 */
class SearchSidecarClient {
  constructor({ app }) {
    this.app = app;
    this.process = null;
    this.host = '127.0.0.1';
    this.port = 0;
    this.token = null;
    this.ready = false;
    this.startingPromise = null;
    this.restarts = 0;
    this.shuttingDown = false;
    this.lastError = null;
    this.profile = null;
  }

  _resolveLocalDataDir() {
    if (process.env.NANVI_LOCAL_DATA_DIR) {
      return process.env.NANVI_LOCAL_DATA_DIR;
    }
    if (process.env.LOCALAPPDATA) {
      return path.join(process.env.LOCALAPPDATA, 'NanviAssistant');
    }
    try {
      return path.join(this.app.getPath('appData'), 'NanviAssistant');
    } catch {
      return path.join(this.app.getPath('userData'), 'NanviSearchData');
    }
  }

  _resolveLaunchCommand() {
    if (this.app.isPackaged) {
      const packagedExe = path.join(
        process.resourcesPath,
        'search-sidecar',
        process.platform === 'win32' ? 'nanvi-search-sidecar.exe' : 'nanvi-search-sidecar'
      );
      if (fs.existsSync(packagedExe)) {
        return {
          cmd: packagedExe,
          args: [],
          cwd: path.dirname(packagedExe),
          mode: 'packaged-sidecar',
        };
      }
      return null;
    }

    const repoRoot = path.resolve(__dirname, '..', '..');
    const winVenvPython = path.join(repoRoot, 'venv', 'Scripts', 'python.exe');
    const unixVenvPython = path.join(repoRoot, 'venv', 'bin', 'python');
    const pythonCmd = fs.existsSync(winVenvPython)
      ? winVenvPython
      : fs.existsSync(unixVenvPython)
        ? unixVenvPython
        : null;
    const entryCheck = path.join(repoRoot, 'backend', 'desktop_search', 'sidecar.py');
    if (pythonCmd && fs.existsSync(entryCheck)) {
      return {
        cmd: pythonCmd,
        args: ['-m', 'backend.desktop_search.sidecar'],
        cwd: repoRoot,
        mode: 'dev-python',
      };
    }
    return null;
  }

  async ensureStarted() {
    if (this.shuttingDown) return false;
    if (this.ready && this.process && !this.process.killed && this.port > 0) {
      return true;
    }
    if (this.startingPromise) {
      return this.startingPromise;
    }
    this.startingPromise = this._spawnSidecar().finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  _spawnSidecar() {
    const launch = this._resolveLaunchCommand();
    if (!launch) {
      this.lastError = 'sidecar_binary_not_present';
      return Promise.resolve(false);
    }

    const localDataDir = this._resolveLocalDataDir();
    try {
      fs.mkdirSync(localDataDir, { recursive: true });
    } catch {
      // handled in child
    }

    const token = crypto.randomBytes(32).toString('base64url');
    this.token = token;
    this.ready = false;
    this.port = 0;

    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      const timeout = setTimeout(() => {
        this.lastError = 'sidecar_start_timeout';
        done(false);
      }, 25000);

      let child;
      try {
        child = spawn(
          launch.cmd,
          [...launch.args, '--host', '127.0.0.1', '--port', '0', '--data-dir', localDataDir],
          {
            cwd: launch.cwd,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              PYTHONUNBUFFERED: '1',
              NANVI_LOCAL_DATA_DIR: localDataDir,
            },
          }
        );
      } catch (err) {
        clearTimeout(timeout);
        this.lastError = err?.message || 'spawn_failed';
        done(false);
        return;
      }

      this.process = child;
      let stdoutBuf = '';
      let stderrTail = '';

      try {
        child.stdin.write(`${token}\n`);
        child.stdin.end();
      } catch {
        // ignore if child exited immediately
      }

      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && parsed.status === 'ready' && parsed.port) {
              this.host = parsed.host || '127.0.0.1';
              this.port = Number(parsed.port);
              this.profile = parsed.profile || null;
              this.ready = true;
              this.lastError = null;
              clearTimeout(timeout);
              done(true);
            }
          } catch {
            // ignore non-banner output
          }
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-1500);
      });

      child.on('exit', (code) => {
        clearTimeout(timeout);
        const wasReady = this.ready;
        this.ready = false;
        this.port = 0;
        this.process = null;
        if (!wasReady) {
          this.lastError = stderrTail || `sidecar_exited_${code}`;
          done(false);
        } else if (!this.shuttingDown && this.restarts < 3) {
          this.restarts += 1;
          setTimeout(() => {
            this.ensureStarted().catch(() => {});
          }, 1500 * this.restarts);
        }
      });
    });
  }

  _requestJson(method, route, payload = null, timeoutMs = 6000) {
    if (!this.ready || !this.port || !this.token) {
      return Promise.resolve(null);
    }
    const bodyStr = payload ? JSON.stringify(payload) : null;
    const headers = {
      'X-Nanvi-Sidecar-Token': this.token,
    };
    if (bodyStr !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr, 'utf8');
    }

    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: this.host,
          port: this.port,
          path: route,
          method,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(raw));
              } catch {
                resolve(null);
              }
            } else {
              resolve(null);
            }
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
      if (bodyStr !== null) req.write(bodyStr);
      req.end();
    });
  }

  async warmWorkspace(folderPath, options = {}) {
    const ok = await this.ensureStarted();
    if (!ok) return null;
    return this._requestJson(
      'POST',
      '/internal/warm',
      {
        folder_path: folderPath,
        tenant_id: options.tenantId || 'default-tenant',
        user_id: options.userId || 'desktop-user',
        wait_for_drain: Boolean(options.waitForDrain),
      },
      25000
    );
  }

  shutdownSync() {
    this.shuttingDown = true;
    const child = this.process;
    this.process = null;
    this.ready = false;
    this.port = 0;
    if (child && child.pid) {
      try {
        if (process.platform === 'win32') {
          const { spawnSync } = require('child_process');
          spawnSync('taskkill', ['/F', '/PID', String(child.pid), '/T'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 1500,
          });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        try {
          child.kill();
        } catch {
          // ignore
        }
      }
    }
  }

  async search(folderPath, query, options = {}) {
    const ok = await this.ensureStarted();
    if (!ok) return null;
    return this._requestJson(
      'POST',
      '/internal/search',
      {
        folder_path: folderPath,
        query: String(query || ''),
        offset: Number(options.offset || 0),
        page_size: Number(options.topFilesLimit || options.pageSize || 10),
        top_chunks_limit: Number(options.topChunksLimit || 8),
        top_files_limit: Number(options.topFilesLimit || 10),
        tenant_id: options.tenantId || 'default-tenant',
        user_id: options.userId || 'desktop-user',
        role: options.role || (Array.isArray(options.roles) && options.roles[0]) || 'Superior',
        roles: Array.isArray(options.roles) && options.roles.length > 0 ? options.roles : [options.role || 'Superior', 'CEO'],
        department: options.department || null,
        folder_prefix: options.folderPrefix || null,
        exclude_sensitive: Boolean(options.excludeSensitive),
        cloud_connected: Boolean(options.cloudConnected),
      },
      25000
    );
  }

  async getStatus(folderPath = null) {
    if (!this.ready) {
      return {
        sidecarReady: false,
        lastError: this.lastError,
        fallbackActive: true,
      };
    }
    const qs = folderPath ? `?folder_path=${encodeURIComponent(folderPath)}` : '';
    const res = await this._requestJson('GET', `/internal/status${qs}`, null, 3000);
    if (!res) {
      return {
        sidecarReady: false,
        lastError: 'status_unreachable',
        fallbackActive: true,
      };
    }
    return {
      sidecarReady: true,
      profile: this.profile,
      fallbackActive: false,
      ...res,
    };
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.ready && this.port && this.token) {
      await this._requestJson('POST', '/internal/shutdown', {}, 1500);
    }
    const child = this.process;
    this.process = null;
    this.ready = false;
    this.port = 0;
    if (child && child.pid) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/F', '/PID', String(child.pid), '/T'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // ignore
      }
    }
  }
}

module.exports = { SearchSidecarClient };

