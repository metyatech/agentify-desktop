import test from 'node:test';
import assert from 'node:assert/strict';

import { createControlCenterShowGate, hasStartMinimizedArg } from '../launch-mode.mjs';

test('launch mode: normal initial launch is interactive', () => {
  assert.equal(hasStartMinimizedArg(['Agentify Desktop.exe']), false);
});

test('launch mode: start-minimized initial launch stays in the background', () => {
  assert.equal(hasStartMinimizedArg(['Agentify Desktop.exe', '--start-minimized']), true);
});

test('launch mode: background instance plus second normal launch shows Control Center', async () => {
  const calls = [];
  const gate = createControlCenterShowGate(() => calls.push('show'));

  await gate.request();
  assert.deepEqual(calls, []);
  await gate.markReady();
  assert.deepEqual(calls, ['show']);
});

test('launch mode: background instance plus second start-minimized launch does not show Control Center', async () => {
  const calls = [];
  const gate = createControlCenterShowGate(() => calls.push('show'));

  if (!hasStartMinimizedArg(['Agentify Desktop.exe', '--start-minimized'])) await gate.request();
  await gate.markReady();

  assert.deepEqual(calls, []);
});

test('launch mode: early second-instance request is retained until UI is ready', async () => {
  const calls = [];
  const gate = createControlCenterShowGate(() => calls.push('show'));

  assert.equal(gate.isReady(), false);
  assert.equal(gate.isPending(), false);
  await gate.request();
  assert.equal(gate.isPending(), true);
  await gate.markReady();

  assert.equal(gate.isReady(), true);
  assert.equal(gate.isPending(), false);
  assert.deepEqual(calls, ['show']);
});

test('launch mode: second normal launch reuses the existing Control Center callback', async () => {
  const calls = [];
  const gate = createControlCenterShowGate(() => calls.push('show'));

  await gate.markReady();
  await gate.request();
  assert.deepEqual(calls, ['show']);
});

test('launch mode: repeated normal launches never request a new main instance', async () => {
  let showCount = 0;
  const gate = createControlCenterShowGate(() => { showCount += 1; });

  await gate.markReady();
  await gate.request();
  await gate.request();

  assert.equal(showCount, 2);
});
