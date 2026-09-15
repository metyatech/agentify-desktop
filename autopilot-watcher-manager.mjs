import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const AUTOPILOT_WATCHER_SHUTDOWN_TIMEOUT_MS = 2_000;

export function watcherPaths(root) {
  const tasks = path.join(root, 'tasks');
  return { config: path.join(tasks, '.conversation-watch', 'config.json'), lock: path.join(tasks, '.conversation-watch', 'watch.lock.json'), controllerLock: path.join(tasks, '.controller-run.lock.json') };
}

export function validateAutopilotWatcherConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_autopilot_watcher_config');
  for (const [field, valueToCheck] of [['nodeExecutable', value.nodeExecutable], ['controllerEntryPath', value.controllerEntryPath], ['controllerRepoRoot', value.controllerRepoRoot]]) {
    if (typeof valueToCheck !== 'string' || !path.isAbsolute(valueToCheck) || /[\0\r\n"]/u.test(valueToCheck)) throw new Error(`invalid_autopilot_watcher_config_${field}`);
  }
  if (typeof value.enabled !== 'boolean') throw new Error('invalid_autopilot_watcher_config_enabled');
  return { ...value, nodeExecutable: path.resolve(value.nodeExecutable), controllerEntryPath: path.resolve(value.controllerEntryPath), controllerRepoRoot: path.resolve(value.controllerRepoRoot) };
}

export async function readAutopilotWatcherConfig(root, { readFile = fs.readFile } = {}) {
  const paths = watcherPaths(path.resolve(root));
  return validateAutopilotWatcherConfig(JSON.parse(await readFile(paths.config, 'utf8')));
}

export function createAutopilotWatcherManager({ root = null, initialError = null, readFile = fs.readFile, lstat = fs.lstat, unlink = fs.unlink, spawnImpl = spawn, isPidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }, platform = process.platform, env = process.env, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), startupTimeoutMs = 2_000, shutdownTimeoutMs = AUTOPILOT_WATCHER_SHUTDOWN_TIMEOUT_MS, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const paths = root ? watcherPaths(root) : null;
  let child = null;
  let childFailure = null;
  let current = initialError
    ? { status: 'error', detail: initialError }
    : root ? { status: 'offline', detail: 'Watcher is not configured.' } : { status: 'not-configured', detail: 'Watcher is not configured.' };
  const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
  const readConfig = async () => validateAutopilotWatcherConfig(await readJson(paths.config));
  const inspect = async () => {
    if (initialError) return current;
    if (!root) {
      current = { status: 'not-configured', detail: 'Watcher is not configured.' };
      return current;
    }
    let config;
    try { config = await readConfig(); } catch (error) { if (error.code === 'ENOENT') { current = { status: 'offline', detail: 'Watcher is not configured.' }; return current; } current = { status: 'error', detail: 'Watcher configuration is unreadable.' }; return current; }
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
      if (childFailure) return childFailure;
      if (current.status === 'error') return current;
      const state = await inspect();
      if (state.status === 'running' || state.status === 'error') return state;
      if (childFailure) return childFailure;
      if (current.status === 'error') return current;
      if (!child || child.exitCode !== null) return current;
      await sleep(50);
    }
    current = { status: 'error', detail: 'Watcher did not create a live lock after starting.' };
    return current;
  };
  const waitForOwnedChildExit = async (ownedChild) => {
    if (!ownedChild || ownedChild.exitCode !== null) return true;
    if (typeof ownedChild.once !== 'function') return false;
    return await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeoutImpl(timer);
        ownedChild.removeListener?.('exit', onExit);
        ownedChild.removeListener?.('error', onError);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const onError = () => finish(ownedChild.exitCode !== null);
      ownedChild.once('exit', onExit);
      ownedChild.once('error', onError);
      timer = setTimeoutImpl(() => finish(false), Math.max(0, shutdownTimeoutMs));
      try {
        ownedChild.kill();
      } catch {
        finish(false);
        return;
      }
      if (ownedChild.exitCode !== null) finish(true);
    });
  };
  const stopOwnedChild = async () => {
    const ownedChild = child;
    if (!ownedChild || ownedChild.exitCode !== null) {
      if (child === ownedChild) child = null;
      return true;
    }
    const exited = await waitForOwnedChildExit(ownedChild);
    if (!exited) {
      current = { status: 'error', detail: 'Watcher child did not exit within the shutdown timeout.' };
      return false;
    }
    if (child === ownedChild) child = null;
    return true;
  };
  const start = async () => {
    if (initialError) return current;
    if (!root) return { status: 'not-configured', detail: 'Watcher is not configured.' };
    const state = await inspect();
    if (state.status === 'running' || state.status === 'error') return state;
    let config; try { config = await readConfig(); } catch { return state; }
    if (config.enabled !== true) return state;
    if (child && child.exitCode === null) return await waitForRunning();
    current = { status: 'starting', detail: 'Watcher is starting.' };
    childFailure = null;
    try {
      child = spawnImpl(config.nodeExecutable, [config.controllerEntryPath, 'watch', 'run'], { cwd: config.controllerRepoRoot, env: { ...env, AI_AUTOPILOT_ROOT: root }, windowsHide: true, shell: false, stdio: 'ignore', detached: false });
    } catch (error) {
      child = null;
      current = { status: 'error', detail: `Watcher failed to start: ${String(error?.message || error)}` };
      return current;
    }
    child.once?.('error', (error) => { childFailure = { status: 'error', detail: String(error?.message || error) }; current = childFailure; });
    child.once?.('exit', (code) => { child = null; if (code !== 0) { childFailure = { status: 'error', detail: `Watcher exited (${code}).` }; current = childFailure; } else current = { status: 'offline', detail: 'Watcher stopped.' }; });
    return await waitForRunning();
  };
  return { paths, inspect, getState: inspect, start, async restart() { if (!(await stopOwnedChild())) return current; return await start(); }, getStatus: () => current, async stop() { await stopOwnedChild(); } };
}
