import assert from 'node:assert/strict';
import test from 'node:test';

import {
  callControlCenterApi,
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
  await assert.rejects(
    callControlCenterApi({ getState: () => new Promise(() => {}) }, 'getState', undefined, { required: true, timeoutMs: 5 }),
    (error) => error.code === 'IPC_TIMEOUT_GETSTATE'
  );
});

test('startup error display codes are bounded and do not expose error details', () => {
  assert.equal(safeControlCenterErrorCode({ code: 'IPC_TIMEOUT_GETSTATE' }), 'IPC_TIMEOUT_GETSTATE');
  assert.equal(safeControlCenterErrorCode({ code: 'secret/path?value' }), 'SECRET_PATH_VALUE');
  assert.equal(safeControlCenterErrorCode(new Error('conversation URL')), 'CONTROL_CENTER_STARTUP_FAILED');
});
