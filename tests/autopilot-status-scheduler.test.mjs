import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTOPILOT_STATUS_STALE_AFTER_MS } from '../ui/autopilot-status-view.mjs';
import { createAutopilotStatusStaleScheduler } from '../ui/autopilot-status-scheduler.mjs';

const base = {
  status: 'running',
  updatedAt: '2026-08-26T00:00:00.000Z',
};

test('stale scheduler schedules one local refresh at the threshold and does not duplicate it', () => {
  let now = Date.parse(base.updatedAt);
  const timers = [];
  let staleCalls = 0;
  const scheduler = createAutopilotStatusStaleScheduler({
    now: () => now,
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => { timer.cleared = true; },
    onStale: () => { staleCalls += 1; },
  });

  scheduler.schedule(base);
  scheduler.schedule(base);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, AUTOPILOT_STATUS_STALE_AFTER_MS + 1);

  now += AUTOPILOT_STATUS_STALE_AFTER_MS + 1;
  timers[0].callback();
  assert.equal(staleCalls, 1);
});

test('completed and blocked snapshots cancel a pending stale refresh', () => {
  let now = Date.parse(base.updatedAt);
  const timers = [];
  const scheduler = createAutopilotStatusStaleScheduler({
    now: () => now,
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => { timer.cleared = true; },
  });

  scheduler.schedule(base);
  scheduler.schedule({ ...base, status: 'completed' });
  assert.equal(timers[0].cleared, true);
  scheduler.schedule({ ...base, status: 'blocked' });
  assert.equal(timers.length, 1);
});

test('a new running snapshot replaces the old timer without allowing the old callback to render', () => {
  let now = Date.parse(base.updatedAt);
  const timers = [];
  let staleCalls = 0;
  const scheduler = createAutopilotStatusStaleScheduler({
    now: () => now,
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => { timer.cleared = true; },
    onStale: () => { staleCalls += 1; },
  });

  scheduler.schedule(base);
  const next = { ...base, updatedAt: '2026-08-26T00:01:00.000Z' };
  scheduler.schedule(next);
  assert.equal(timers.length, 2);
  assert.equal(timers[0].cleared, true);
  timers[0].callback();
  assert.equal(staleCalls, 0);
  timers[1].callback();
  assert.equal(staleCalls, 1);
});
