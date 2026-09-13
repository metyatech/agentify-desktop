import path from 'node:path';
import { spawn } from 'node:child_process';

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const MAX_OUTPUT_BYTES = 64 * 1024;
const RESULT_KEYS = new Set(['safeToResume', 'safeToSelect', 'reason', 'taskId', 'sourceReviewRound', 'expectedExecutionRound', 'userTurnCount', 'replyTurnCount', 'reviewResponseIndex', 'answerLastIndex', 'conversationUrlHash', 'applied', 'attempt']);

export function buildAutopilotUserActionResumeSpawn({ invocation, taskId, env = process.env } = {}) {
  if (!TASK_ID_PATTERN.test(String(taskId || ''))) throw new Error('invalid_task_id');
  const value = invocation && typeof invocation === 'object' ? invocation : {};
  for (const field of ['managementRoot', 'nodeExecutable', 'controllerEntryPath', 'controllerRepoRoot']) {
    if (typeof value[field] !== 'string' || !path.isAbsolute(value[field]) || /[\0\r\n"]/u.test(value[field])) throw new Error(`invalid_autopilot_controller_invocation_${field}`);
  }
  return {
    file: value.nodeExecutable,
    args: [value.controllerEntryPath, 'watch', 'user-action-resume', String(taskId), '--apply', '--json'],
    options: {
      cwd: value.controllerRepoRoot,
      env: { ...env, AI_AUTOPILOT_ROOT: value.managementRoot },
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  };
}

export function validateAutopilotUserActionResumeResult(value, expectedTaskId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !RESULT_KEYS.has(key)) || value.taskId !== expectedTaskId || typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > 96 || /[\0\r\n]/u.test(value.reason)) throw new Error('invalid_user_action_resume_result');
  if (typeof value.safeToResume !== 'boolean' || typeof value.safeToSelect !== 'boolean' || typeof value.applied !== 'boolean') throw new Error('invalid_user_action_resume_result');
  for (const field of ['sourceReviewRound', 'expectedExecutionRound', 'attempt', 'userTurnCount', 'replyTurnCount', 'reviewResponseIndex', 'answerLastIndex']) {
    if (value[field] !== null && value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field] < 0)) throw new Error('invalid_user_action_resume_result');
  }
  if (value.conversationUrlHash !== null && value.conversationUrlHash !== undefined && !/^[0-9a-f]{64}$/u.test(String(value.conversationUrlHash))) throw new Error('invalid_user_action_resume_result');
  return value;
}

export function runAutopilotUserActionResume({ invocation, taskId, env = process.env, spawnImpl = spawn } = {}) {
  const request = buildAutopilotUserActionResumeSpawn({ invocation, taskId, env });
  return new Promise((resolve, reject) => {
    const child = spawnImpl(request.file, request.args, request.options);
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_BYTES); });
    child.stderr?.on('data', () => {});
    child.once?.('error', () => {
      const error = new Error('USER_ACTION_RESUME_FAILED');
      error.code = 'USER_ACTION_RESUME_FAILED';
      reject(error);
    });
    child.once?.('exit', (code) => {
      let result = null;
      try {
        result = validateAutopilotUserActionResumeResult(JSON.parse(stdout), taskId);
      } catch {
        result = null;
      }
      if (result) {
        resolve(result);
        return;
      }
      if (code !== 0) {
        const error = new Error('USER_ACTION_RESUME_FAILED');
        error.code = 'USER_ACTION_RESUME_FAILED';
        error.data = { exitCode: Number.isInteger(code) ? code : null };
        reject(error);
        return;
      }
      const error = new Error('USER_ACTION_RESUME_INVALID_RESULT');
      error.code = 'USER_ACTION_RESUME_INVALID_RESULT';
      reject(error);
    });
  });
}
