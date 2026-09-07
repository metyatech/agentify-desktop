import assert from 'node:assert/strict';
import test from 'node:test';

import { autopilotProposalViewModel, deriveAutopilotProposalAuthority } from '../ui/autopilot-proposal-view.mjs';

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
  const error = autopilotProposalViewModel({ proposal, watchStatus: watch('observed', { status: 'error', lastError: { code: 'TURNS_FAILED' } }) });
  assert.equal(error.key, 'error');
  assert.equal(error.label, 'エラー停止');
  assert.equal(error.disableRequest, true);
  assert.match(error.detail, /再承認・再送せず/u);
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
    assert.equal(view.key, 'reviewing');
    assert.equal(view.disableRequest, true);
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
    assert.equal(view.key, taskStatus.status === 'completed' ? 'completed' : 'stale');
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

test('lifecycle labels distinguish preparation from Codex execution', () => {
  assert.equal(autopilotProposalViewModel({ proposal, watchStatus: watch('approved') }).label, '承認済み — 実行準備中');
  assert.equal(autopilotProposalViewModel({ proposal, watchStatus: watch('launch-started') }).label, 'Codex実行中');
});

test('task view distinguishes review, fix, delivery, completion, and blocked states', () => {
  assert.equal(autopilotProposalViewModel({ proposal, taskStatus: { taskId: 'task-1', status: 'running', phase: 'reviewing' }, watchStatus: watch('running') }).key, 'reviewing');
  assert.equal(autopilotProposalViewModel({ proposal, taskStatus: { taskId: 'task-1', status: 'running', phase: 'fixing', reviewRound: 2, reviewMaxRounds: 10 }, watchStatus: watch('running') }).label, '修正中 2/10');
  assert.equal(autopilotProposalViewModel({ proposal, taskStatus: { taskId: 'task-1', status: 'running', phase: 'delivery' }, watchStatus: watch('running') }).key, 'delivery');
  assert.equal(autopilotProposalViewModel({ proposal, taskStatus: { taskId: 'task-1', status: 'completed' }, watchStatus: watch('completed') }).key, 'completed');
  assert.equal(autopilotProposalViewModel({ proposal, taskStatus: { taskId: 'task-1', status: 'blocked', errorCode: 'REVIEW_TIMEOUT' }, watchStatus: watch('blocked') }).errorCode, 'REVIEW_TIMEOUT');
});

test('renderer authority ignores historical proposal-looking state without current V2 or active execution', () => {
  assert.deepEqual(deriveAutopilotProposalAuthority({
    proposalTicket: null,
    watchStatus: watch('completed'),
    taskStatus: { taskId: 'task-1', status: 'completed' },
  }), null);
  assert.equal(deriveAutopilotProposalAuthority({
    proposalTicket: null,
    watchStatus: watch('blocked'),
    taskStatus: { taskId: 'task-1', status: 'blocked' },
  }), null);
  assert.equal(deriveAutopilotProposalAuthority({
    proposalTicket: null,
    watchStatus: watch('observed'),
    taskStatus: null,
  }), null);
  assert.equal(deriveAutopilotProposalAuthority({
    proposalTicket: null,
    watchStatus: watch('running', { stale: true }),
    taskStatus: null,
  }), null);
  assert.deepEqual(deriveAutopilotProposalAuthority({
    proposalTicket: null,
    watchStatus: watch('running'),
    taskStatus: { taskId: 'different-task', status: 'running' },
  }), { proposalId: null, taskId: 'different-task', approvalCode: null });
});

test('renderer authority derives only unresolved V2 tickets and active durable execution', () => {
  assert.deepEqual(deriveAutopilotProposalAuthority({
    proposalTicket: { schemaVersion: 2, state: 'pending', proposalId: 'p1', taskId: 'task-1', approvalCode: '4216E4AE' },
  }), { proposalId: 'p1', taskId: 'task-1', approvalCode: '4216E4AE' });
  assert.deepEqual(deriveAutopilotProposalAuthority({
    proposalTicket: null,
    watchStatus: watch('running'),
  }), proposal);
  assert.deepEqual(deriveAutopilotProposalAuthority({
    proposalTicket: null,
    taskStatus: { taskId: 'task-1', status: 'running' },
  }), { proposalId: null, taskId: 'task-1', approvalCode: null });
});
