import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { AUTOPILOT_WATCHER_SHUTDOWN_TIMEOUT_MS, createAutopilotWatcherManager, readAutopilotWatcherConfig, watcherPaths } from '../autopilot-watcher-manager.mjs';

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

test('final shutdown prevents an in-flight start from spawning after inspection resumes', async () => {
  const files = {};
  const paths = watcherPaths('D:/shutdown-race');
  files[paths.config] = config;
  let inspectionEntered;
  const inspectionEnteredPromise = new Promise((resolve) => { inspectionEntered = resolve; });
  let releaseInspection;
  const inspectionGate = new Promise((resolve) => { releaseInspection = resolve; });
  let blockFirstConfigRead = true;
  let spawnCount = 0;
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  const manager = createAutopilotWatcherManager({
    root: 'D:/shutdown-race',
    readFile: async (file) => {
      if (file === paths.config && blockFirstConfigRead) {
        blockFirstConfigRead = false;
        inspectionEntered();
        await inspectionGate;
      }
      if (!(file in files)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
      return files[file];
    },
    lstat: async (file) => { if (file === paths.controllerLock) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return {}; },
    unlink: async (file) => { delete files[file]; },
    spawnImpl: () => { spawnCount += 1; files[paths.lock] = JSON.stringify({ pid: 4001 }); return child; },
    isPidAlive: (pid) => pid === 4001,
    sleep: async () => {},
    startupTimeoutMs: 100,
    env: {},
  });

  const start = manager.start();
  await inspectionEnteredPromise;
  const stop = manager.stop();
  releaseInspection();
  await Promise.all([start, stop]);
  assert.equal(spawnCount, 0);
});

test('final shutdown keeps later starts offline without spawning', async () => {
  const files = {};
  const paths = watcherPaths('D:/shutdown-before-start');
  files[paths.config] = config;
  let spawnCount = 0;
  const manager = createAutopilotWatcherManager({
    root: 'D:/shutdown-before-start',
    readFile: async (file) => { if (!(file in files)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return files[file]; },
    lstat: async (file) => { if (file === paths.controllerLock) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return {}; },
    unlink: async (file) => { delete files[file]; },
    spawnImpl: () => { spawnCount += 1; throw new Error('unexpected spawn'); },
    env: {},
  });

  await manager.stop();
  assert.equal((await manager.start()).status, 'offline');
  assert.equal(spawnCount, 0);
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

test('watcher config preserves distinct management and controller roots', async () => {
  const root = 'X:/management';
  const paths = watcherPaths(root);
  const files = {
    [paths.config]: JSON.stringify({ enabled: true, nodeExecutable: 'X:/node/node.exe', controllerEntryPath: 'X:/management/repos/owner/ai-autopilot/bin/ai-autopilot.mjs', controllerRepoRoot: 'X:/management/repos/owner/ai-autopilot' }),
  };
  const config = await readAutopilotWatcherConfig(root, { readFile: async (file) => files[file] });
  assert.equal(config.controllerRepoRoot, 'X:\\management\\repos\\owner\\ai-autopilot');
  assert.equal(config.controllerEntryPath, 'X:\\management\\repos\\owner\\ai-autopilot\\bin\\ai-autopilot.mjs');
  assert.notEqual(config.controllerEntryPath, 'X:\\management\\bin\\ai-autopilot.mjs');
});

test('restart waits for the owned child to exit before spawning exactly one replacement', async () => {
  const files = {};
  const paths = watcherPaths('D:/restart-race');
  files[paths.config] = config;
  let activePid = null;
  let spawnCount = 0;
  let releaseExit;
  const exitGate = new Promise((resolve) => { releaseExit = resolve; });
  const children = [];
  const spawnImpl = () => {
    const pid = spawnCount === 0 ? 1001 : 1002;
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {
      if (pid === 1001) {
        exitGate.then(() => {
          activePid = null;
          delete files[paths.lock];
          child.exitCode = 0;
          child.emit('exit', 0);
        });
      }
    };
    activePid = pid;
    files[paths.lock] = JSON.stringify({ pid });
    children.push(child);
    spawnCount += 1;
    return child;
  };
  const manager = createAutopilotWatcherManager({
    root: 'D:/restart-race',
    readFile: async (file) => { if (!(file in files)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return files[file]; },
    lstat: async (file) => { if (file === paths.controllerLock) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return {}; },
    unlink: async (file) => { delete files[file]; },
    spawnImpl,
    isPidAlive: (pid) => pid === activePid,
    sleep: async () => {},
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 100,
    env: {},
  });

  assert.equal((await manager.start()).status, 'running');
  const restart = manager.restart();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnCount, 1);
  releaseExit();
  assert.equal((await restart).status, 'running');
  assert.equal(spawnCount, 2);
  assert.equal(children.length, 2);
  assert.equal((await manager.getState()).pid, 1002);
});

test('restart fails closed on an owned child that does not exit and does not spawn a replacement', async () => {
  assert.equal(AUTOPILOT_WATCHER_SHUTDOWN_TIMEOUT_MS, 2_000);
  const files = {};
  const paths = watcherPaths('D:/restart-timeout');
  files[paths.config] = config;
  let spawnCount = 0;
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {};
  const manager = createAutopilotWatcherManager({
    root: 'D:/restart-timeout',
    readFile: async (file) => { if (!(file in files)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return files[file]; },
    lstat: async (file) => { if (file === paths.controllerLock) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return {}; },
    unlink: async (file) => { delete files[file]; },
    spawnImpl: () => { spawnCount += 1; files[paths.lock] = JSON.stringify({ pid: 2001 }); return child; },
    isPidAlive: (pid) => pid === 2001,
    sleep: async () => {},
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 1,
    env: {},
  });

  assert.equal((await manager.start()).status, 'running');
  const state = await manager.restart();
  assert.equal(state.status, 'error');
  assert.match(state.detail, /shutdown timeout/);
  assert.equal(spawnCount, 1);
});

test('offline restart safely starts a watcher', async () => {
  const files = {};
  const paths = watcherPaths('D:/offline-restart');
  files[paths.config] = config;
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {};
  const manager = createAutopilotWatcherManager({
    root: 'D:/offline-restart',
    readFile: async (file) => { if (!(file in files)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return files[file]; },
    lstat: async (file) => { if (file === paths.controllerLock) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return {}; },
    unlink: async (file) => { delete files[file]; },
    spawnImpl: () => { files[paths.lock] = JSON.stringify({ pid: 3001 }); return child; },
    isPidAlive: (pid) => pid === 3001,
    sleep: async () => {},
    startupTimeoutMs: 100,
    env: {},
  });
  assert.equal((await manager.restart()).status, 'running');
});

test('stale watcher lock plus controller lock fails closed without unlink or spawn', async () => {
  const files = {};
  const paths = watcherPaths('D:/controller-lock');
  files[paths.config] = config;
  files[paths.lock] = JSON.stringify({ pid: 44 });
  let controllerLockRead = false;
  let spawnCount = 0;
  const manager = createAutopilotWatcherManager({
    root: 'D:/controller-lock',
    readFile: async (file) => { if (!(file in files)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return files[file]; },
    lstat: async (file) => {
      if (file === paths.controllerLock) {
        controllerLockRead = true;
        return {};
      }
      return {};
    },
    unlink: async (file) => { delete files[file]; },
    spawnImpl: () => { spawnCount += 1; throw new Error('unexpected spawn'); },
    isPidAlive: () => false,
    env: {},
  });
  const state = await manager.start();
  assert.equal(state.status, 'error');
  assert.match(state.detail, /controller lock exists/);
  assert.equal(controllerLockRead, true);
  assert.equal(files[paths.lock] !== undefined, true);
  assert.equal(spawnCount, 0);
});

test('restart never kills or replaces a live watcher not owned by the manager', async () => {
  const f = fixture({});
  f.files[f.paths.config] = config;
  f.files[f.paths.lock] = JSON.stringify({ pid: 44 });
  let killCalled = false;
  let spawnCount = 0;
  const externalChild = { exitCode: null, kill: () => { killCalled = true; } };
  const manager = createAutopilotWatcherManager({
    root: 'D:/auto',
    readFile: async (file) => { if (!(file in f.files)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return f.files[file]; },
    lstat: async (file) => { if (file === f.paths.controllerLock) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return {}; },
    unlink: async (file) => { f.files[file] = undefined; },
    spawnImpl: () => { spawnCount += 1; return externalChild; },
    isPidAlive: () => true,
    env: {},
  });
  assert.equal((await manager.restart()).status, 'running');
  assert.equal(killCalled, false);
  assert.equal(spawnCount, 0);
});

test('spawn failure is surfaced as an explicit error', async () => {
  const f = fixture({});
  f.files[f.paths.config] = config;
  const manager = createAutopilotWatcherManager({
    root: 'D:/auto',
    readFile: async (file) => { if (!(file in f.files)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return f.files[file]; },
    lstat: async (file) => { if (file === f.paths.controllerLock) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return {}; },
    spawnImpl: () => { throw new Error('spawn denied'); },
    env: {},
  });
  const state = await manager.start();
  assert.equal(state.status, 'error');
  assert.match(state.detail, /spawn denied/);
});

test('nonzero child exit is surfaced as an explicit error', async () => {
  const f = fixture({});
  f.files[f.paths.config] = config;
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {};
  const manager = createAutopilotWatcherManager({
    root: 'D:/auto',
    readFile: async (file) => { if (!(file in f.files)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return f.files[file]; },
    lstat: async (file) => { if (file === f.paths.controllerLock) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return {}; },
    spawnImpl: () => { queueMicrotask(() => { child.exitCode = 23; child.emit('exit', 23); }); return child; },
    sleep: async () => {},
    startupTimeoutMs: 100,
    env: {},
  });
  const state = await manager.start();
  assert.equal(state.status, 'error');
  assert.match(state.detail, /Watcher exited \(23\)/);
});

test('missing live lock before startup deadline fails closed', async () => {
  const f = fixture({});
  f.files[f.paths.config] = config;
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {};
  const manager = createAutopilotWatcherManager({
    root: 'D:/auto',
    readFile: async (file) => { if (!(file in f.files)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return f.files[file]; },
    lstat: async (file) => { if (file === f.paths.controllerLock) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return {}; },
    spawnImpl: () => child,
    sleep: async () => {},
    startupTimeoutMs: 1,
    env: {},
  });
  const state = await manager.start();
  assert.equal(state.status, 'error');
  assert.match(state.detail, /live lock/);
});

test('disabled config stays offline without spawning', async () => {
  const f = fixture({});
  f.files[f.paths.config] = JSON.stringify({ enabled: false, nodeExecutable: 'D:/node.exe', controllerEntryPath: 'D:/controller.mjs', controllerRepoRoot: 'D:/' });
  const state = await f.manager.start();
  assert.equal(state.status, 'offline');
  assert.equal(f.calls.some((call) => call[0] === 'spawn'), false);
});

test('invalid config is surfaced as an explicit error without spawning', async () => {
  const f = fixture({});
  f.files[f.paths.config] = JSON.stringify({ enabled: true, nodeExecutable: 'relative-node.exe', controllerEntryPath: 'D:/controller.mjs', controllerRepoRoot: 'D:/' });
  const state = await f.manager.start();
  assert.equal(state.status, 'error');
  assert.match(state.detail, /configuration is unreadable/);
  assert.equal(f.calls.some((call) => call[0] === 'spawn'), false);
});
