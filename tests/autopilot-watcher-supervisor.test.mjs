import assert from 'node:assert/strict';
import test from 'node:test';

import { createAutopilotWatcherSupervisor } from '../autopilot-watcher-supervisor.mjs';

function clock() {
  let value = 0;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

function timerHarness() {
  const callbacks = [];
  const cleared = [];
  return {
    callbacks,
    cleared,
    setInterval: (callback) => { callbacks.push(callback); return callbacks.length; },
    clearInterval: (id) => { cleared.push(id); },
  };
}

test('live watcher health checks do not spawn a replacement', async () => {
  const timers = timerHarness();
  let starts = 0;
  const supervisor = createAutopilotWatcherSupervisor({
    watcher: { getState: async () => ({ status: 'running', pid: 12, detail: 'Watcher is running.' }), start: async () => { starts += 1; return { status: 'running', pid: 13 }; } },
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });
  await supervisor.start();
  await timers.callbacks[0]();
  assert.equal(starts, 0);
});

test('stale offline health is recovered with exactly one replacement', async () => {
  const timers = timerHarness();
  let reads = 0;
  let starts = 0;
  const supervisor = createAutopilotWatcherSupervisor({
    watcher: {
      getState: async () => (++reads === 1 ? { status: 'offline', detail: 'Stale watcher lock recovered.' } : { status: 'running', pid: 22, detail: 'Watcher is running.' }),
      start: async () => { starts += 1; return { status: 'running', pid: 22, detail: 'Watcher is running.' }; },
    },
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });
  const state = await supervisor.start();
  assert.equal(state.status, 'running');
  await timers.callbacks[0]();
  assert.equal(starts, 1);
});

test('controller-lock error is fail closed and never auto-starts', async () => {
  const timers = timerHarness();
  let starts = 0;
  const supervisor = createAutopilotWatcherSupervisor({
    watcher: { getState: async () => ({ status: 'error', detail: 'Stale watcher lock cannot be recovered while controller lock exists.' }), start: async () => { starts += 1; return { status: 'running' }; } },
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });
  const state = await supervisor.start();
  await timers.callbacks[0]();
  assert.equal(state.status, 'error');
  assert.equal(starts, 0);
});

test('overlapping health checks share one inspect/start flow', async () => {
  const timers = timerHarness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  const supervisor = createAutopilotWatcherSupervisor({
    watcher: { getState: async () => { reads += 1; await gate; return { status: 'running', pid: 30 }; }, start: async () => ({ status: 'running', pid: 30 }) },
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });
  const first = supervisor.start();
  const second = supervisor.inspectNow();
  const third = supervisor.inspectNow();
  assert.equal(second, third);
  release();
  await first;
  assert.equal(reads, 1);
});

test('failed replacement uses bounded backoff and does not restart storm', async () => {
  const timers = timerHarness();
  const time = clock();
  let starts = 0;
  const supervisor = createAutopilotWatcherSupervisor({
    watcher: { getState: async () => ({ status: 'offline', detail: 'Watcher stopped.' }), start: async () => { starts += 1; return { status: 'error', detail: 'spawn failed' }; } },
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
    retryBackoffMs: 1000,
    now: time.now,
  });
  await supervisor.start();
  await timers.callbacks[0]();
  const waiting = await supervisor.inspectNow();
  assert.equal(starts, 1);
  assert.equal(waiting.status, 'error');
  time.advance(1000);
  await timers.callbacks[0]();
  assert.equal(starts, 2);
});

test('watcher exit is detected and recovered once', async () => {
  const timers = timerHarness();
  let reads = 0;
  let starts = 0;
  const published = [];
  const supervisor = createAutopilotWatcherSupervisor({
    watcher: {
      getState: async () => (++reads === 1 ? { status: 'running', pid: 51 } : { status: 'offline', detail: 'Watcher stopped.' }),
      start: async () => { starts += 1; return { status: 'running', pid: 52 }; },
    },
    onStateChanged: (state) => published.push(state.status),
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });
  await supervisor.start();
  timers.callbacks[0]();
  const state = await supervisor.inspectNow();
  assert.equal(state.status, 'running');
  assert.equal(starts, 1);
  assert.deepEqual(published, ['running', 'offline', 'starting', 'running']);
});

test('disabled watcher remains offline without spawning', async () => {
  const timers = timerHarness();
  let starts = 0;
  const supervisor = createAutopilotWatcherSupervisor({
    watcher: { getState: async () => ({ status: 'offline', detail: 'Watcher is disabled.' }), start: async () => { starts += 1; return { status: 'offline' }; } },
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });
  await supervisor.start();
  await timers.callbacks[0]();
  assert.equal(starts, 0);
});

test('state changes are published and stop cancels future health checks', async () => {
  const timers = timerHarness();
  const published = [];
  let running = true;
  const supervisor = createAutopilotWatcherSupervisor({
    watcher: { getState: async () => running ? { status: 'running', pid: 41 } : { status: 'error', detail: 'Watcher failed.' }, start: async () => ({ status: 'running', pid: 42 }) },
    onStateChanged: (state) => published.push(state.status),
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });
  await supervisor.start();
  running = false;
  await timers.callbacks[0]();
  supervisor.stop();
  assert.deepEqual(published, ['running', 'error']);
  assert.deepEqual(timers.cleared, [1]);
});

test('shutdown prevents a pending health check from starting a watcher', async () => {
  const timers = timerHarness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let starts = 0;
  const supervisor = createAutopilotWatcherSupervisor({
    watcher: {
      getState: async () => { await gate; return { status: 'offline', detail: 'Watcher stopped.' }; },
      start: async () => { starts += 1; return { status: 'running' }; },
    },
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });
  const pending = supervisor.start();
  supervisor.stop();
  release();
  await pending;
  assert.equal(starts, 0);
  assert.deepEqual(timers.cleared, [1]);
});
