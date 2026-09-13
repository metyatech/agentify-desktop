import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTOPILOT_ACTIVITY_STALE_AFTER_MS } from '../ui/autopilot-activity-view.mjs';
import { createAutopilotActivityStaleScheduler } from '../ui/autopilot-activity-scheduler.mjs';

test('activity stale scheduler refreshes once after the heartbeat boundary and replaces old timers', () => {
  let now = Date.parse('2026-09-13T00:00:00.000Z');
  const timers = [];
  let staleCalls = 0;
  const scheduler = createAutopilotActivityStaleScheduler({ now: () => now, setTimeoutImpl: (callback, delay) => { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; }, clearTimeoutImpl: (timer) => { timer.cleared = true; }, onStale: () => { staleCalls += 1; } });
  const activity = { processState: 'running', lastActivityAt: '2026-09-13T00:00:00.000Z' };
  scheduler.schedule(activity);
  assert.equal(timers[0].delay, AUTOPILOT_ACTIVITY_STALE_AFTER_MS + 1);
  scheduler.schedule({ ...activity, lastActivityAt: '2026-09-13T00:00:01.000Z' });
  assert.equal(timers[0].cleared, true);
  timers[0].callback();
  assert.equal(staleCalls, 0);
  now = Date.parse('2026-09-13T00:00:16.001Z');
  timers[1].callback();
  assert.equal(staleCalls, 1);
});
