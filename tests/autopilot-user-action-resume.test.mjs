import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { buildAutopilotUserActionResumeSpawn, runAutopilotUserActionResume, validateAutopilotUserActionResumeResult } from '../autopilot-user-action-resume.mjs';

const invocation = {
  managementRoot: 'X:/management',
  nodeExecutable: 'X:/node/node.exe',
  controllerEntryPath: 'X:/management/repos/owner/ai-autopilot/bin/ai-autopilot.mjs',
  controllerRepoRoot: 'X:/management/repos/owner/ai-autopilot',
};

function child({ stdout = '', code = 0 } = {}) {
  const value = new EventEmitter();
  value.stdout = new EventEmitter();
  value.stderr = new EventEmitter();
  value.exitCode = null;
  value.emitResult = () => { if (stdout) value.stdout.emit('data', stdout); value.exitCode = code; value.emit('exit', code); };
  return value;
}

test('resume spawn uses configured controller invocation, not management root', () => {
  const request = buildAutopilotUserActionResumeSpawn({ invocation, taskId: 'task-1', env: { PATH: 'safe' } });
  assert.equal(request.file, invocation.nodeExecutable);
  assert.deepEqual(request.args, [invocation.controllerEntryPath, 'watch', 'user-action-resume', 'task-1', '--apply', '--json']);
  assert.equal(request.options.cwd, invocation.controllerRepoRoot);
  assert.equal(request.options.env.AI_AUTOPILOT_ROOT, invocation.managementRoot);
  assert.equal(request.options.shell, false);
  assert.notEqual(request.args[0], 'X:/management/bin/ai-autopilot.mjs');
});

test('resume subprocess validates task-bound result and rejects malformed or nonzero output', async () => {
  const calls = [];
  const good = child({ stdout: JSON.stringify({ taskId: 'task-1', safeToResume: true, safeToSelect: true, applied: true, reason: 'USER_ACTION_REPLY_READY', sourceReviewRound: 3, expectedExecutionRound: 4, attempt: 1, userTurnCount: 1, replyTurnCount: 1, reviewResponseIndex: 4, answerLastIndex: 5, conversationUrlHash: 'a'.repeat(64) }) });
  const resultPromise = runAutopilotUserActionResume({ invocation, taskId: 'task-1', spawnImpl: (file, args, options) => { calls.push({ file, args, options }); return good; } });
  good.emitResult();
  const result = await resultPromise;
  assert.equal(result.applied, true);
  assert.equal(result.safeToSelect, true);
  assert.equal(calls[0].file, invocation.nodeExecutable);
  await assert.rejects(() => Promise.resolve().then(() => validateAutopilotUserActionResumeResult({ taskId: 'task-1', safeToResume: true, applied: true, reason: 'ok', answer: 'secret' }, 'task-1')), /invalid_user_action_resume_result/u);
  const failed = child({ code: 2 });
  const failedPromise = runAutopilotUserActionResume({ invocation, taskId: 'task-1', spawnImpl: () => failed });
  failed.emitResult();
  await assert.rejects(failedPromise, (error) => error.code === 'USER_ACTION_RESUME_FAILED');
});

test('resume subprocess preserves a valid structured domain result on nonzero exit', async () => {
  const resultValue = {
    taskId: 'task-1',
    safeToResume: false,
    safeToSelect: true,
    applied: false,
    reason: 'LOCK_CONFLICT',
    sourceReviewRound: 3,
    expectedExecutionRound: 4,
    userTurnCount: 1,
    replyTurnCount: 1,
    reviewResponseIndex: 4,
    answerLastIndex: 5,
    conversationUrlHash: 'a'.repeat(64),
  };
  const failed = child({ stdout: JSON.stringify(resultValue), code: 2 });
  const resultPromise = runAutopilotUserActionResume({ invocation, taskId: 'task-1', spawnImpl: () => failed });
  failed.emitResult();
  assert.deepEqual(await resultPromise, resultValue);

  const queryFailure = child({ stdout: JSON.stringify({ ...resultValue, reason: 'AGENTIFY_QUERY_NOT_DISPATCHED' }), code: 2 });
  const queryPromise = runAutopilotUserActionResume({ invocation, taskId: 'task-1', spawnImpl: () => queryFailure });
  queryFailure.emitResult();
  assert.equal((await queryPromise).reason, 'AGENTIFY_QUERY_NOT_DISPATCHED');
});

test('nonzero resume exit still rejects wrong-task and unknown-field output', async () => {
  const wrongTask = child({ stdout: JSON.stringify({ taskId: 'task-2', safeToResume: false, safeToSelect: true, applied: false, reason: 'LOCK_CONFLICT' }), code: 2 });
  const wrongTaskPromise = runAutopilotUserActionResume({ invocation, taskId: 'task-1', spawnImpl: () => wrongTask });
  wrongTask.emitResult();
  await assert.rejects(wrongTaskPromise, (error) => error.code === 'USER_ACTION_RESUME_FAILED');

  const unknownField = child({ stdout: JSON.stringify({ taskId: 'task-1', safeToResume: false, safeToSelect: true, applied: false, reason: 'LOCK_CONFLICT', unexpected: true }), code: 2 });
  const unknownFieldPromise = runAutopilotUserActionResume({ invocation, taskId: 'task-1', spawnImpl: () => unknownField });
  unknownField.emitResult();
  await assert.rejects(unknownFieldPromise, (error) => error.code === 'USER_ACTION_RESUME_FAILED');
});

test('resume subprocess accepts an expected no-reply inspection result with exit 0', async () => {
  const pending = child({ stdout: JSON.stringify({ taskId: 'task-1', safeToResume: false, safeToSelect: false, applied: false, reason: 'USER_ACTION_REPLY_NOT_FOUND', sourceReviewRound: 3, expectedExecutionRound: 4, userTurnCount: 0, replyTurnCount: 0, reviewResponseIndex: 4, answerLastIndex: null, conversationUrlHash: 'a'.repeat(64) }) });
  const resultPromise = runAutopilotUserActionResume({ invocation, taskId: 'task-1', spawnImpl: () => pending });
  pending.emitResult();
  const result = await resultPromise;
  assert.equal(result.reason, 'USER_ACTION_REPLY_NOT_FOUND');
  assert.equal(result.applied, false);
  assert.equal(result.safeToSelect, false);
});

test('resume result requires the exact safeToSelect boolean', () => {
  assert.throws(() => validateAutopilotUserActionResumeResult({ taskId: 'task-1', safeToResume: true, applied: true, reason: 'ok' }, 'task-1'), /invalid_user_action_resume_result/u);
  assert.doesNotThrow(() => validateAutopilotUserActionResumeResult({ taskId: 'task-1', safeToResume: false, safeToSelect: false, applied: false, reason: 'USER_ACTION_REPLY_NOT_FOUND' }, 'task-1'));
});
