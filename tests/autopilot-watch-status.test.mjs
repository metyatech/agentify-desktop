import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAutopilotWatchStatus } from '../autopilot-watch-status.mjs';

const base = {
  schemaVersion: 1,
  tabKey: 'autopilot-production',
  status: 'healthy',
  lastPollAt: '2026-09-13T00:00:00.000Z',
  lastError: null,
  proposal: null,
  updatedAt: '2026-09-13T00:00:00.000Z',
};

test('watch status carries bounded user-action summary without transcript text', () => {
  const snapshot = validateAutopilotWatchStatus({
    ...base,
    userAction: {
      taskId: 'task-1',
      sourceReviewRound: 3,
      state: 'reply-detected',
      userTurnCount: 2,
      replyTurnCount: 2,
      detectedAt: '2026-09-13T00:00:00.000Z',
      canResume: true,
      reason: 'USER_ACTION_REPLY_READY',
    },
  });
  assert.equal(snapshot.userAction.state, 'reply-detected');
  assert.equal(snapshot.userAction.canResume, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret answer/u);
});

test('watch status rejects raw transcript-like unknown fields and out-of-range counts', () => {
  assert.throws(() => validateAutopilotWatchStatus({ ...base, userAction: { taskId: 'task-1', sourceReviewRound: 3, state: 'reply-detected', userTurnCount: 65, replyTurnCount: 1, detectedAt: null, canResume: true, reason: null } }), /invalid_autopilot_watch_status/iu);
  assert.throws(() => validateAutopilotWatchStatus({ ...base, userAction: { taskId: 'task-1', sourceReviewRound: 3, state: 'reply-detected', userTurnCount: 1, replyTurnCount: 1, detectedAt: null, canResume: true, reason: null, text: 'secret answer' } }), /invalid_autopilot_watch_status/iu);
});
