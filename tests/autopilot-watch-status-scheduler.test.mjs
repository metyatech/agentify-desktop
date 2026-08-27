import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTOPILOT_WATCH_STATUS_STALE_AFTER_MS } from '../autopilot-watch-status.mjs';
import { createAutopilotWatchStatusStaleScheduler } from '../ui/autopilot-watch-status-scheduler.mjs';

test('watch status stale scheduler refreshes once after the conservative heartbeat threshold', () => {
  let now = Date.parse('2026-08-27T00:00:00.000Z');
  const timers = [];
  let calls = 0;
  const scheduler = createAutopilotWatchStatusStaleScheduler({
    now: () => now,
    setTimeoutImpl: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeoutImpl: () => {},
    onStale: () => { calls += 1; },
  });
  scheduler.schedule({ lastPollAt: '2026-08-27T00:00:00.000Z', stale: false });
  assert.equal(timers[0].delay, AUTOPILOT_WATCH_STATUS_STALE_AFTER_MS + 1);
  now += AUTOPILOT_WATCH_STATUS_STALE_AFTER_MS + 1;
  timers[0].callback();
  assert.equal(calls, 1);
});
