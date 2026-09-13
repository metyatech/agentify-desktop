import assert from 'node:assert/strict';
import test from 'node:test';

import { activityMatchesTask, activityViewUpdate, autopilotActivityViewModel, toggleAutopilotActivityExpanded, visibleActivityCursor } from '../ui/autopilot-activity-view.mjs';

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

test('starting also expires to unknown and fresh activity recovers liveness', () => {
  const started = autopilotActivityViewModel({ ...base, processState: 'starting', effectiveProcessState: 'unknown', lastActivityAt: '2026-09-13T00:00:00.000Z' }, Date.parse('2026-09-13T00:00:16.000Z'));
  assert.equal(started.kind, 'unknown');
  const recovered = autopilotActivityViewModel({ ...base, processState: 'running', effectiveProcessState: 'running', activityStale: false }, Date.parse('2026-09-13T00:01:00.000Z'));
  assert.equal(recovered.statusLabel, '● Running');
});

test('activity identity matches only the current task and does not hide a newer round', () => {
  assert.equal(activityMatchesTask({ taskId: 'task-A', round: 1 }, { taskId: 'task-B', phase: 'executing', round: 1 }), false);
  assert.equal(activityMatchesTask({ taskId: 'task-A', round: 1 }, { taskId: 'task-A', phase: 'executing', round: 2 }), false);
  assert.equal(activityMatchesTask({ taskId: 'task-A', round: 3 }, { taskId: 'task-A', phase: 'executing', round: 2 }), true);
});

test('toggle state and visible cursor have explicit, non-inverted contracts', () => {
  assert.deepEqual(toggleAutopilotActivityExpanded(true), { expanded: false, hidden: true, ariaExpanded: 'false' });
  assert.deepEqual(toggleAutopilotActivityExpanded(false), { expanded: true, hidden: false, ariaExpanded: 'true' });
  assert.deepEqual(visibleActivityCursor({ taskId: 'task-1', executionId: 'exec-1', events: [{ seq: 4, event: { kind: 'message' } }] }), { taskId: 'task-1', executionId: 'exec-1', lastVisibleSeq: 4 });
  assert.deepEqual(visibleActivityCursor({ taskId: 'task-1', executionId: 'exec-1', events: [{ seq: 5, event: { kind: 'lifecycle', state: 'heartbeat' } }] }), { taskId: 'task-1', executionId: 'exec-1', lastVisibleSeq: 0 });
});

test('scroll update preserves upward position and only flags actual visible output', () => {
  const previous = { taskId: 'task-1', executionId: 'exec-1', lastVisibleSeq: 4 };
  assert.deepEqual(activityViewUpdate(previous, { ...previous, lastVisibleSeq: 5 }, false), { newVisibleOutput: true, showNewOutput: true, scrollMode: 'preserve' });
  assert.deepEqual(activityViewUpdate(previous, { ...previous, lastVisibleSeq: 4 }, false), { newVisibleOutput: false, showNewOutput: false, scrollMode: 'preserve' });
  assert.deepEqual(activityViewUpdate(previous, { ...previous, lastVisibleSeq: 5 }, true), { newVisibleOutput: true, showNewOutput: false, scrollMode: 'bottom' });
});
