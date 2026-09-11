import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function watcherPaths(root) {
  const tasks = path.join(root, 'tasks');
  return { config: path.join(tasks, '.conversation-watch', 'config.json'), lock: path.join(tasks, '.conversation-watch', 'watch.lock.json'), controllerLock: path.join(tasks, '.controller-run.lock.json') };
}

export function createAutopilotWatcherManager({ root = null, initialError = null, readFile = fs.readFile, lstat = fs.lstat, unlink = fs.unlink, spawnImpl = spawn, isPidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, platform = process.platform, env = process.env, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), startupTimeoutMs = 2_000 } = {}) {
  const paths = root ? watcherPaths(root) : null;
  let child = null;
  let current = initialError
    ? { status: 'error', detail: initialError }
    : root ? { status: 'offline', detail: 'Watcher is not configured.' } : { status: 'not-configured', detail: 'Watcher is not configured.' };
  const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
  const inspect = async () => {
    if (initialError) return current;
    if (!root) {
      current = { status: 'not-configured', detail: 'Watcher is not configured.' };
      return current;
    }
    let config;
    try { config = await readJson(paths.config); } catch (error) { if (error.code === 'ENOENT') { current = { status: 'offline', detail: 'Watcher is not configured.' }; return current; } current = { status: 'error', detail: 'Watcher configuration is unreadable.' }; return current; }
    if (config.enabled !== true) { current = { status: 'offline', detail: 'Watcher is disabled.' }; return current; }
    let lock;
    try { lock = await readJson(paths.lock); } catch (error) { if (error.code === 'ENOENT') { current = { status: child ? 'starting' : 'offline', detail: 'Watcher is starting.' }; return current; } current = { status: 'error', detail: 'Watcher lock is ambiguous.' }; return current; }
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) { current = { status: 'error', detail: 'Watcher lock owner is invalid.' }; return current; }
    if (isPidAlive(lock.pid)) { current = { status: 'running', pid: lock.pid, detail: 'Watcher is running.' }; return current; }
    try { await lstat(paths.controllerLock); current = { status: 'error', detail: 'Stale watcher lock cannot be recovered while controller lock exists.' }; return current; } catch (error) { if (error.code !== 'ENOENT') { current = { status: 'error', detail: 'Controller lock state is ambiguous.' }; return current; } }
    try { await unlink(paths.lock); } catch (error) { if (error.code !== 'ENOENT') { current = { status: 'error', detail: 'Stale watcher lock could not be removed.' }; return current; } }
    current = { status: 'offline', detail: 'Stale watcher lock recovered.' };
    return current;
  };
  const waitForRunning = async () => {
    const deadline = Date.now() + Math.max(0, startupTimeoutMs);
    while (Date.now() <= deadline) {
      const state = await inspect();
      if (state.status === 'running' || state.status === 'error') return state;
      if (!child || child.exitCode !== null) return current;
      await sleep(50);
    }
    current = { status: 'error', detail: 'Watcher did not create a live lock after starting.' };
    return current;
  };
  const start = async () => {
    if (initialError) return current;
    if (!root) return { status: 'not-configured', detail: 'Watcher is not configured.' };
    const state = await inspect();
    if (state.status === 'running' || state.status === 'error') return state;
    let config; try { config = await readJson(paths.config); } catch { return state; }
    if (config.enabled !== true) return state;
    if (child && child.exitCode === null) return await waitForRunning();
    current = { status: 'starting', detail: 'Watcher is starting.' };
    child = spawnImpl(config.nodeExecutable, [config.controllerEntryPath, 'watch', 'run'], { cwd: config.controllerRepoRoot, env: { ...env, AI_AUTOPILOT_ROOT: root }, windowsHide: true, shell: false, stdio: 'ignore', detached: false });
    child.once?.('error', (error) => { current = { status: 'error', detail: String(error?.message || error) }; });
    child.once?.('exit', (code) => { child = null; if (code !== 0) current = { status: 'error', detail: `Watcher exited (${code}).` }; else current = { status: 'offline', detail: 'Watcher stopped.' }; });
    return await waitForRunning();
  };
  return { paths, inspect, start, async restart() { if (child && child.exitCode === null) { try { child.kill(); } catch {} child = null; } return await start(); }, getStatus: () => current, async stop() { if (child && child.exitCode === null) { try { child.kill(); } catch {} } child = null; } };
}
