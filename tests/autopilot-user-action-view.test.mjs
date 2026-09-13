import assert from 'node:assert/strict';
import test from 'node:test';

import { autopilotUserActionViewModel } from '../ui/autopilot-user-action-view.mjs';

const blocked = { taskId: 'task-1', status: 'blocked', latestVerdict: 'USER_ACTION_REQUIRED' };

test('user-action view keeps unmatched or non-action tasks hidden', () => {
  assert.equal(autopilotUserActionViewModel({ ...blocked, taskId: 'task-2' }, { userAction: { taskId: 'task-1', state: 'reply-detected', canResume: true } }).visible, true);
  assert.equal(autopilotUserActionViewModel({ ...blocked, latestVerdict: 'FIX_REQUIRED' }, null).visible, false);
});

test('user-action view exposes bounded states and enables only an exact detected reply', () => {
  const base = { userAction: { taskId: 'task-1', userTurnCount: 2, replyTurnCount: 2, canResume: true } };
  assert.equal(autopilotUserActionViewModel(blocked, { ...base, userAction: { ...base.userAction, state: 'waiting-for-reply' } }).heading, '回答待ち');
  const detected = autopilotUserActionViewModel(blocked, { ...base, userAction: { ...base.userAction, state: 'reply-detected' } });
  assert.equal(detected.heading, '回答を検出しました');
  assert.equal(detected.buttonLabel, 'この回答で再開');
  assert.equal(detected.canResume, true);
  assert.equal(autopilotUserActionViewModel(blocked, { ...base, userAction: { ...base.userAction, state: 'authorized' } }).canResume, false);
  assert.equal(autopilotUserActionViewModel(blocked, { ...base, userAction: { ...base.userAction, state: 'resuming' } }).heading, '再開中…');
  assert.equal(autopilotUserActionViewModel(blocked, { ...base, userAction: { ...base.userAction, state: 'stale' } }).heading, '回答を再確認してください');
});

test('user-action view does not expose raw reply text and bounds counts', () => {
  const view = autopilotUserActionViewModel(blocked, { userAction: { taskId: 'task-1', state: 'reply-detected', userTurnCount: 999, replyTurnCount: -1, canResume: true, text: 'secret answer' } });
  assert.equal(view.userTurnCount, 64);
  assert.equal(view.replyTurnCount, 0);
  assert.doesNotMatch(JSON.stringify(view), /secret answer/u);
});
