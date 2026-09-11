import assert from 'node:assert/strict';
import test from 'node:test';

import { createAutopilotWatcherManager, watcherPaths } from '../autopilot-watcher-manager.mjs';

function fixture(files, { alive = () => false } = {}) {
  const calls = [];
  const readFile = async (file) => { if (!(file in files)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return files[file]; };
  const lstat = async (file) => { if (file.endsWith('controller-run.lock.json')) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return {}; };
  const unlink = async (file) => { calls.push(['unlink', file]); delete files[file]; };
  const child = { exitCode: null, once() {}, kill() { this.exitCode = 0; } };
  const spawnImpl = (...args) => { calls.push(['spawn', ...args]); return child; };
  const manager = createAutopilotWatcherManager({ root: 'D:/auto', readFile, lstat, unlink, spawnImpl, isPidAlive: alive, env: {} });
  return { manager, files, calls, paths: watcherPaths('D:/auto') };
}

const config = JSON.stringify({ enabled: true, nodeExecutable: 'D:/node.exe', controllerEntryPath: 'D:/controller.mjs', controllerRepoRoot: 'D:/', tabKey: 'autopilot-production' });

test('watcher starts hidden in background when absent and does not duplicate a live watcher', async () => {
  const f = fixture({});
  assert.equal((await f.manager.start()).status, 'offline');
  f.files[f.paths.config] = config;
  await f.manager.start();
  assert.equal(f.calls.filter((call) => call[0] === 'spawn').length, 1);
  assert.equal(f.calls[0][3].windowsHide, true);
});

test('dead owner stale lock is removed only without controller lock; live owner is preserved', async () => {
  const f = fixture({});
  f.files[f.paths.config] = config;
  f.files[f.paths.lock] = JSON.stringify({ pid: 44 });
  await f.manager.start();
  assert.equal(f.calls.some((call) => call[0] === 'unlink' && call[1] === f.paths.lock), true);
  const live = fixture({}); live.files[live.paths.config] = config; live.files[live.paths.lock] = JSON.stringify({ pid: 44 });
  const manager = createAutopilotWatcherManager({ root: 'D:/auto', readFile: async (file) => { if (file === live.paths.config) return config; return live.files[file]; }, lstat: async (file) => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }, isPidAlive: () => true, env: {} });
  assert.equal((await manager.inspect()).status, 'running');
});

test('manager confirms the spawned watcher lock before reporting Running and never touches the controller lock', async () => {
  const files = {};
  const paths = watcherPaths('D:/custom-management-root');
  files[paths.config] = config;
  let spawnCount = 0;
  const child = { exitCode: null, once() {}, kill() { this.exitCode = 0; } };
  const manager = createAutopilotWatcherManager({
    root: 'D:/custom-management-root',
    readFile: async (file) => { if (!(file in files)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return files[file]; },
    lstat: async (file) => { if (file === paths.controllerLock) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return {}; },
    unlink: async (file) => { delete files[file]; },
    spawnImpl: () => { spawnCount += 1; files[paths.lock] = JSON.stringify({ pid: 1234 }); return child; },
    isPidAlive: (pid) => pid === 1234,
    sleep: async () => {},
    startupTimeoutMs: 100,
    env: {},
  });
  assert.equal((await manager.start()).status, 'running');
  assert.equal((await manager.start()).status, 'running');
  assert.equal(spawnCount, 1);
  assert.equal(paths.controllerLock.endsWith('.controller-run.lock.json'), true);
});

test('getState refreshes an externally started watcher and does not leave a dead PID Running', async () => {
  let alive = true;
  const f = fixture({});
  f.files[f.paths.config] = config;
  f.files[f.paths.lock] = JSON.stringify({ pid: 4567 });
  const manager = createAutopilotWatcherManager({
    root: 'D:/auto',
    readFile: async (file) => { if (!(file in f.files)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return f.files[file]; },
    lstat: async (file) => { if (file === f.paths.controllerLock) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return {}; },
    unlink: async (file) => { f.calls.push(['unlink', file]); delete f.files[file]; },
    spawnImpl: (...args) => { f.calls.push(['spawn', ...args]); return { exitCode: null, once() {}, kill() {} }; },
    isPidAlive: () => alive,
    env: {},
  });
  assert.equal((await manager.getState()).status, 'running');
  alive = false;
  assert.equal((await manager.getState()).status, 'offline');
  assert.equal((await manager.getState()).status, 'offline');
  assert.equal(f.calls.filter((call) => call[0] === 'spawn').length, 0);
  assert.equal(f.calls.filter((call) => call[0] === 'unlink' && call[1] === f.paths.controllerLock).length, 0);
});

test('manager reports Not configured without guessing a management root', async () => {
  const manager = createAutopilotWatcherManager();
  assert.equal((await manager.start()).status, 'not-configured');
  assert.equal((await manager.inspect()).status, 'not-configured');
});
