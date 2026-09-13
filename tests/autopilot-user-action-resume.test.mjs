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
  const good = child({ stdout: JSON.stringify({ taskId: 'task-1', safeToResume: true, applied: true, reason: 'USER_ACTION_REPLY_READY', sourceReviewRound: 3, expectedExecutionRound: 4, attempt: 1, userTurnCount: 1, replyTurnCount: 1, reviewResponseIndex: 4, answerLastIndex: 5, conversationUrlHash: 'a'.repeat(64) }) });
  const resultPromise = runAutopilotUserActionResume({ invocation, taskId: 'task-1', spawnImpl: (file, args, options) => { calls.push({ file, args, options }); return good; } });
  good.emitResult();
  const result = await resultPromise;
  assert.equal(result.applied, true);
  assert.equal(calls[0].file, invocation.nodeExecutable);
  await assert.rejects(() => Promise.resolve().then(() => validateAutopilotUserActionResumeResult({ taskId: 'task-1', safeToResume: true, applied: true, reason: 'ok', answer: 'secret' }, 'task-1')), /invalid_user_action_resume_result/u);
  const failed = child({ code: 2 });
  const failedPromise = runAutopilotUserActionResume({ invocation, taskId: 'task-1', spawnImpl: () => failed });
  failed.emitResult();
  await assert.rejects(failedPromise, (error) => error.code === 'USER_ACTION_RESUME_FAILED');
});
