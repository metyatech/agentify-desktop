import assert from 'node:assert/strict';
import test from 'node:test';

import {
  autopilotTaskSurfaceViewModel,
  autopilotUserActionViewModel,
} from '../ui/autopilot-user-action-view.mjs';

const blocked = { taskId: 'task-1', status: 'blocked', latestVerdict: 'USER_ACTION_REQUIRED' };
const healthy = { status: 'healthy', stale: false };

test('fresh watch user-action owns the surface even when task status is historical', () => {
  const taskStatus = { taskId: 'local-health-marker', status: 'completed', latestVerdict: 'PASS' };
  const originalTaskStatus = structuredClone(taskStatus);
  const surface = autopilotTaskSurfaceViewModel({
    taskStatus,
    watchStatus: {
      ...healthy,
      userAction: { taskId: 'task-61999d7a-9380-477a-864d-1e8bdd959308', state: 'reply-detected', canResume: true },
    },
  });
  assert.equal(surface.kind, 'user-action');
  assert.equal(surface.taskId, 'task-61999d7a-9380-477a-864d-1e8bdd959308');
  assert.equal(surface.buttonLabel, 'この回答で再開');
  assert.equal(surface.canResume, true);
  assert.notEqual(surface.taskId, 'local-health-marker');
  assert.deepEqual(taskStatus, originalTaskStatus);
});

test('user-action view keeps non-action tasks hidden', () => {
  assert.equal(autopilotUserActionViewModel({ ...blocked, latestVerdict: 'FIX_REQUIRED' }, null).visible, false);
  assert.equal(autopilotUserActionViewModel({ ...blocked, taskId: 'task-2' }, null).visible, false);
});

test('same-task status conflicts fail closed', () => {
  const surface = autopilotTaskSurfaceViewModel({
    taskStatus: { taskId: 'task-1', status: 'completed', latestVerdict: 'PASS' },
    watchStatus: { ...healthy, userAction: { taskId: 'task-1', state: 'reply-detected', canResume: true } },
  });
  assert.equal(surface.kind, 'conflict');
  assert.equal(surface.canResume, false);
  assert.equal(surface.visible, false);
});

test('stale or unhealthy watch status cannot own the action surface', () => {
  const userAction = { taskId: 'task-1', state: 'reply-detected', canResume: true };
  assert.equal(autopilotTaskSurfaceViewModel({ taskStatus: null, watchStatus: { ...healthy, stale: true, userAction } }).kind, 'task-status');
  assert.equal(autopilotTaskSurfaceViewModel({ taskStatus: null, watchStatus: { status: 'error', stale: false, userAction } }).kind, 'task-status');
});

test('matching blocked UAR status remains a valid action surface', () => {
  assert.equal(autopilotUserActionViewModel(blocked, { ...healthy, userAction: { taskId: 'task-1', state: 'reply-detected', canResume: true } }).visible, true);
});

test('user-action view exposes bounded states and enables only an exact detected reply', () => {
  const base = { ...healthy, userAction: { taskId: 'task-1', userTurnCount: 2, replyTurnCount: 2, canResume: true } };
  const waiting = autopilotUserActionViewModel(blocked, { ...base, userAction: { ...base.userAction, state: 'waiting-for-reply' } });
  assert.equal(waiting.heading, '回答待ち');
  assert.equal(waiting.buttonLabel, '回答を確認');
  assert.equal(waiting.canCheck, true);
  const detected = autopilotUserActionViewModel(blocked, { ...base, userAction: { ...base.userAction, state: 'reply-detected' } });
  assert.equal(detected.heading, '回答を検出しました');
  assert.equal(detected.buttonLabel, 'この回答で再開');
  assert.equal(detected.canResume, true);
  const stale = autopilotUserActionViewModel(blocked, { ...base, userAction: { ...base.userAction, state: 'stale' } });
  assert.equal(stale.buttonLabel, '回答を再確認');
  assert.equal(stale.canCheck, true);
  assert.equal(autopilotUserActionViewModel(blocked, { ...base, userAction: { ...base.userAction, state: 'authorized' } }).canResume, false);
  assert.equal(autopilotUserActionViewModel(blocked, { ...base, userAction: { ...base.userAction, state: 'resuming' } }).heading, '再開中…');
  assert.equal(autopilotUserActionViewModel(blocked, { ...base, userAction: { ...base.userAction, state: 'stale' } }).heading, '回答を再確認してください');
});

test('user-action view does not expose raw reply text and bounds counts', () => {
  const view = autopilotUserActionViewModel(blocked, { ...healthy, userAction: { taskId: 'task-1', state: 'reply-detected', userTurnCount: 999, replyTurnCount: -1, canResume: true, text: 'secret answer' } });
  assert.equal(view.userTurnCount, 64);
  assert.equal(view.replyTurnCount, 0);
  assert.doesNotMatch(JSON.stringify(view), /secret answer/u);
});
