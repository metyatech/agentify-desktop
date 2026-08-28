import assert from 'node:assert/strict';
import test from 'node:test';

import {
  callControlCenterApi,
  CONTROL_CENTER_STARTUP_IPC_TIMEOUT_MS,
  safeControlCenterErrorCode,
} from '../ui/control-center-startup.mjs';

test('required startup bridge APIs reject when the bridge is unavailable', async () => {
  await assert.rejects(
    callControlCenterApi(null, 'getState', undefined, { required: true, timeoutMs: 10 }),
    (error) => error.code === 'BRIDGE_API_UNAVAILABLE'
  );
});

test('required startup bridge APIs surface rejected calls', async () => {
  for (const name of ['getState', 'getSettings', 'listWatchFolders']) {
    const bridge = { [name]: async () => { throw Object.assign(new Error('private detail'), { code: 'READ_FAILED' }); } };
    await assert.rejects(
      callControlCenterApi(bridge, name, undefined, { required: true, timeoutMs: 10 }),
      (error) => error.code === 'READ_FAILED'
    );
  }
});

test('pending startup bridge calls reject with a bounded API timeout code', async () => {
  for (const name of ['getState', 'getSettings', 'listWatchFolders']) {
    await assert.rejects(
      callControlCenterApi({ [name]: () => new Promise(() => {}) }, name, undefined, { required: true, timeoutMs: 5 }),
      (error) => error.code === `IPC_TIMEOUT_${name.toUpperCase()}`
    );
  }
});

test('startup timeout is explicit while ordinary API calls have no implicit timeout', async () => {
  assert.equal(CONTROL_CENTER_STARTUP_IPC_TIMEOUT_MS, 15_000);
  let timerCalls = 0;
  const result = await callControlCenterApi({ getState: async () => ({ ok: true }) }, 'getState', undefined, {
    required: true,
    setTimeoutImpl: () => { timerCalls += 1; return 1; },
    clearTimeoutImpl: () => {},
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(timerCalls, 0);
});

test('proposal request waits for backend lifecycle beyond 20 minutes without renderer timeout', async () => {
  let resolveRequest;
  let rendererTimerCalls = 0;
  const attemptDurations = [9 * 60 * 1000 + 50 * 1000, 10 * 60 * 1000, 2 * 60 * 1000 + 1];
  assert.ok(attemptDurations.reduce((total, duration) => total + duration, 0) > 20 * 60 * 1000);
  const request = callControlCenterApi(
    { requestAutopilotProposal: () => new Promise((resolve) => { resolveRequest = resolve; }) },
    'requestAutopilotProposal',
    undefined,
    {
      required: true,
      setTimeoutImpl: () => { rendererTimerCalls += 1; throw new Error('renderer_timeout_must_not_be_used'); },
      clearTimeoutImpl: () => {},
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rendererTimerCalls, 0);
  resolveRequest({ proposal: { proposalId: 'proposal-1' } });
  assert.deepEqual(await request, { proposal: { proposalId: 'proposal-1' } });
});

test('startup error display codes are bounded and do not expose error details', () => {
  assert.equal(safeControlCenterErrorCode({ code: 'IPC_TIMEOUT_GETSTATE' }), 'IPC_TIMEOUT_GETSTATE');
  assert.equal(safeControlCenterErrorCode({ code: 'secret/path?value' }), 'SECRET_PATH_VALUE');
  assert.equal(safeControlCenterErrorCode(new Error('conversation URL')), 'CONTROL_CENTER_STARTUP_FAILED');
});
