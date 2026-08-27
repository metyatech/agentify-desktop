import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTOPILOT_STATUS_FILE,
  createAutopilotStatusStore,
  validateAutopilotStatus,
} from '../autopilot-status.mjs';
import {
  AUTOPILOT_WATCH_STATUS_FILE,
  createAutopilotWatchStatusStore,
  validateAutopilotWatchStatus,
} from '../autopilot-watch-status.mjs';

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: 'onedrive-logout-error',
    title: 'Logout error',
    repository: 'metyatech/course-exams',
    targetBranch: 'main',
    status: 'running',
    phase: 'verifying',
    round: 2,
    maxRounds: 10,
    latestVerdict: 'FIX_REQUIRED',
    verification: { completed: 2, total: 3, failed: 0 },
    error: null,
    updatedAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

test('autopilot status validation rejects unknown fields, malformed counts, and unsafe metadata', () => {
  assert.throws(() => validateAutopilotStatus({ ...snapshot(), secret: 'no' }), /invalid_autopilot_status/u);
  assert.throws(() => validateAutopilotStatus({ ...snapshot(), verification: { completed: 3, total: 2, failed: 0 } }), /invalid_autopilot_status/u);
  assert.throws(() => validateAutopilotStatus({ ...snapshot(), repository: 'D:/secret' }), /invalid_autopilot_status/u);
  assert.throws(() => validateAutopilotStatus({ ...snapshot(), updatedAt: 'not-a-date' }), /invalid_autopilot_status/u);
});

test('autopilot status persists, reloads, and marks an old running snapshot stale', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-autopilot-status-'));
  const first = await createAutopilotStatusStore({ stateDir, now: () => Date.parse('2026-08-26T00:00:00.000Z'), staleAfterMs: 60_000 });
  await first.update(snapshot());
  const second = await createAutopilotStatusStore({ stateDir, now: () => Date.parse('2026-08-26T00:02:00.000Z'), staleAfterMs: 60_000 });
  assert.equal(second.get().taskId, 'onedrive-logout-error');
  assert.equal(second.get().stale, true);
  assert.ok((await fs.readFile(path.join(stateDir, AUTOPILOT_STATUS_FILE), 'utf8')).includes('onedrive-logout-error'));
  await assert.rejects(() => second.update(snapshot({ updatedAt: '2026-08-25T23:59:00.000Z' })), /stale_autopilot_status/u);
  await fs.rm(stateDir, { recursive: true, force: true });
});

test('terminal status is not marked stale and host task metadata stays null', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-autopilot-status-terminal-'));
  const store = await createAutopilotStatusStore({ stateDir, now: () => Date.parse('2026-08-26T00:00:00.000Z') });
  const saved = await store.update(snapshot({ repository: null, targetBranch: null, status: 'completed', phase: 'completed', latestVerdict: 'PASS', verification: { completed: 0, total: 0, failed: 0 } }));
  assert.equal(saved.stale, false);
  assert.equal(saved.repository, null);
  await store.clear();
  const restarted = await createAutopilotStatusStore({ stateDir, now: () => Date.parse('2026-08-26T00:00:01.000Z') });
  assert.equal(restarted.get(), null);
  await fs.rm(stateDir, { recursive: true, force: true });
});

test('watch status validates bounded proposal metadata, persists heartbeat, and clears without touching task status', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-autopilot-watch-status-'));
  const snapshot = {
    schemaVersion: 1,
    tabKey: 'autopilot-production',
    status: 'healthy',
    lastPollAt: '2026-08-27T00:00:00.000Z',
    lastError: null,
    proposal: {
      proposalId: '123e4567-e89b-42d3-a456-426614174000',
      taskId: 'task-1',
      approvalCode: '4216E4AE',
      state: 'observed',
      updatedAt: '2026-08-27T00:00:00.000Z',
    },
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
  assert.throws(() => validateAutopilotWatchStatus({ ...snapshot, conversationText: 'secret' }), /invalid_autopilot_watch_status/u);
  const first = await createAutopilotWatchStatusStore({ stateDir, now: () => Date.parse('2026-08-27T00:00:05.000Z') });
  const stored = await first.update(snapshot);
  assert.equal(stored.proposal.approvalCode, '4216E4AE');
  assert.equal(stored.stale, false);
  const second = await createAutopilotWatchStatusStore({ stateDir, now: () => Date.parse('2026-08-27T00:00:20.000Z') });
  assert.equal(second.get().stale, true);
  await second.clear();
  assert.equal(second.get(), null);
  await assert.rejects(() => fs.access(path.join(stateDir, AUTOPILOT_WATCH_STATUS_FILE)), { code: 'ENOENT' });
  await fs.rm(stateDir, { recursive: true, force: true });
});
