import assert from 'node:assert/strict';
import test from 'node:test';

import { autopilotProposalViewModel } from '../ui/autopilot-proposal-view.mjs';

const proposal = { proposalId: '123e4567-e89b-42d3-a456-426614174000', taskId: 'task-1', approvalCode: '4216E4AE' };
const watch = (state, overrides = {}) => ({ status: 'healthy', stale: false, ageMs: 1000, lastError: null, proposal: { ...proposal, state }, ...overrides });

test('proposal stays in watcher confirmation until matching observed status arrives', () => {
  assert.equal(autopilotProposalViewModel({ proposal }).key, 'watching');
  assert.equal(autopilotProposalViewModel({ proposal, watchStatus: watch('observed', { proposal: { ...proposal, proposalId: '123e4567-e89b-42d3-a456-426614174001', state: 'observed' } }) }).key, 'watching');
  const view = autopilotProposalViewModel({ proposal, watchStatus: watch('observed') });
  assert.equal(view.key, 'approval-waiting');
  assert.equal(view.command, '開始して 4216E4AE');
  assert.equal(view.disableRequest, true);
});

test('watcher errors and stale heartbeat never become approval', () => {
  assert.equal(autopilotProposalViewModel({ proposal, watchStatus: watch('observed', { status: 'error', lastError: { code: 'TURNS_FAILED' } }) }).key, 'error');
  const stale = autopilotProposalViewModel({ proposal, watchStatus: watch('observed', { stale: true, ageMs: 16000 }) });
  assert.equal(stale.key, 'stale');
  assert.equal(stale.command, null);
});

test('matching running task overrides a stale launch-started watcher heartbeat', () => {
  const view = autopilotProposalViewModel({
    proposal,
    watchStatus: watch('launch-started', { stale: true, ageMs: 16000 }),
    taskStatus: { taskId: 'task-1', status: 'running', phase: 'verifying' },
  });
  assert.equal(view.key, 'running');
  assert.equal(view.command, null);
  assert.equal(view.disableRequest, true);
});

test('matching running task overrides stale and error watcher mirrors', () => {
  for (const watchStatus of [
    watch('running', { stale: true, ageMs: 16000 }),
    watch('observed', { status: 'error', lastError: { code: 'WATCH_POST_FAILED' } }),
  ]) {
    const view = autopilotProposalViewModel({
      proposal,
      watchStatus,
      taskStatus: { taskId: 'task-1', status: 'running', phase: 'reviewing' },
    });
    assert.deepEqual({ key: view.key, label: view.label, command: view.command, disableRequest: view.disableRequest }, {
      key: 'running', label: '実行中', command: null, disableRequest: true,
    });
  }
});

test('unrelated or terminal task status does not override watcher state', () => {
  for (const taskStatus of [
    { taskId: 'old-task', status: 'running' },
    { taskId: 'task-1', status: 'completed' },
  ]) {
    const view = autopilotProposalViewModel({
      proposal,
      watchStatus: watch('observed', { stale: true, ageMs: 16000 }),
      taskStatus,
    });
    assert.equal(view.key, 'stale');
    assert.equal(view.command, null);
  }
});

test('normal observed proposal still waits for approval without a matching running task', () => {
  const view = autopilotProposalViewModel({ proposal, watchStatus: watch('observed') });
  assert.equal(view.key, 'approval-waiting');
  assert.equal(view.command, '開始して 4216E4AE');
});

test('approval and launch lifecycle disable duplicate proposal requests', () => {
  for (const state of ['approved', 'launch-prepared', 'launch-started', 'running']) {
    assert.equal(autopilotProposalViewModel({ proposal, watchStatus: watch(state) }).disableRequest, true);
  }
});
