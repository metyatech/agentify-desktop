import assert from 'node:assert/strict';
import test from 'node:test';

import { autopilotActivityViewModel } from '../ui/autopilot-activity-view.mjs';

const base = {
  processState: 'running',
  pid: 1234,
  startedAt: '2026-09-13T00:00:00.000Z',
  lastActivityAt: '2026-09-13T00:00:57.000Z',
  lastOutputAt: '2026-09-13T00:00:42.000Z',
  events: [],
};

test('activity view shows separate elapsed, heartbeat, and output metadata', () => {
  const view = autopilotActivityViewModel(base, Date.parse('2026-09-13T00:01:00.000Z'));
  assert.equal(view.statusLabel, '● Running');
  assert.equal(view.elapsedLabel, 'Elapsed 1m 0s');
  assert.equal(view.pidLabel, 'PID 1234');
  assert.equal(view.lastActivityLabel, 'Last activity 3s ago');
  assert.equal(view.lastOutputLabel, 'Last output 18s ago');
});

test('stale heartbeat is shown as unknown rather than verified running', () => {
  const view = autopilotActivityViewModel({ ...base, processState: 'running', effectiveProcessState: 'unknown', activityStale: true }, Date.parse('2026-09-13T00:01:00.000Z'));
  assert.equal(view.statusLabel, '⚠ Activity heartbeat stale');
  assert.equal(view.activityStale, true);
});
