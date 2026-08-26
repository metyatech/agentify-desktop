import assert from 'node:assert/strict';
import test from 'node:test';

import { autopilotStatusViewModel } from '../ui/autopilot-status-view.mjs';

const base = {
  schemaVersion: 1,
  taskId: 'task-1',
  title: 'Task title',
  repository: 'owner/repo',
  targetBranch: 'main',
  status: 'running',
  phase: 'executing',
  round: 2,
  maxRounds: 10,
  latestVerdict: 'FIX_REQUIRED',
  verification: { completed: 2, total: 3, failed: 0 },
  error: null,
  updatedAt: '2026-08-26T00:00:00.000Z',
};

test('view model exposes phase, round, target, verdict, and verification progress', () => {
  const view = autopilotStatusViewModel(base, Date.parse('2026-08-26T00:00:01.000Z'));
  assert.equal(view.statusLabel, '● Executing');
  assert.equal(view.roundLabel, 'Round 2 / 10');
  assert.equal(view.targetLabel, 'owner/repo → main');
  assert.equal(view.verdictLabel, 'Latest review: FIX_REQUIRED');
  assert.equal(view.verificationLabel, 'Verification 2/3');
});

test('view model distinguishes completed, blocked, and stale running states', () => {
  assert.equal(autopilotStatusViewModel({ ...base, status: 'completed', phase: 'completed', latestVerdict: 'PASS' }, Date.now()).statusLabel, '✓ Completed');
  assert.equal(autopilotStatusViewModel({ ...base, status: 'blocked', phase: 'blocked', error: { code: 'UNAUTHORIZED_EARLY_DELIVERY', message: 'Target changed' } }, Date.now()).statusLabel, '✕ Blocked');
  const stale = autopilotStatusViewModel(base, Date.parse('2026-08-26T00:11:00.000Z'));
  assert.equal(stale.statusLabel, '⚠ Stale');
  assert.equal(stale.phaseLabel, 'Last phase: Executing');
});
