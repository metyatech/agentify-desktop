import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTOPILOT_ACTIVITY_MAX_BYTES,
  AUTOPILOT_ACTIVITY_MAX_EVENTS,
  createAutopilotActivityStore,
} from '../autopilot-activity.mjs';
import { startHttpApi } from '../http-api.mjs';

function envelope(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: 'task-1',
    round: 1,
    executionId: 'execution-1',
    seq: 1,
    emittedAt: '2026-09-13T00:00:00.000Z',
    process: { pid: 1234, state: 'starting' },
    event: { kind: 'lifecycle', state: 'started', label: 'Codex started', exitCode: null },
    ...overrides,
  };
}

test('activity store validates lifecycle, ignores stale sequences, and persists across reopen', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-activity-'));
  const store = await createAutopilotActivityStore({ stateDir, now: () => Date.parse('2026-09-13T00:00:03.000Z') });
  assert.equal((await store.update(envelope())).accepted, true);
  assert.equal((await store.update(envelope({ seq: 2, emittedAt: '2026-09-13T00:00:01.000Z', process: { pid: 1234, state: 'running' }, event: { kind: 'lifecycle', state: 'heartbeat', label: 'Codex heartbeat', exitCode: null } }))).state.processState, 'running');
  assert.equal((await store.update(envelope({ seq: 2 }))).accepted, false);
  assert.equal(store.get().effectiveProcessState, 'running');
  const reopened = await createAutopilotActivityStore({ stateDir, now: () => Date.parse('2026-09-13T00:00:03.000Z') });
  assert.equal(reopened.get().lastSeq, 2);
  await fs.rm(stateDir, { recursive: true, force: true });
});

test('new execution replaces the current timeline and late old events cannot pollute it', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-activity-generation-'));
  const store = await createAutopilotActivityStore({ stateDir });
  await store.update(envelope());
  const next = envelope({ taskId: 'task-1', round: 2, executionId: 'execution-2', emittedAt: '2026-09-13T00:01:00.000Z', event: { kind: 'lifecycle', state: 'started', label: 'Codex started', exitCode: null } });
  assert.equal((await store.update(next)).accepted, true);
  assert.equal((await store.update(envelope({ seq: 99, emittedAt: '2026-09-13T00:00:30.000Z', event: { kind: 'message', state: 'completed', text: 'old execution' } }))).accepted, false);
  assert.equal(store.get().executionId, 'execution-2');
  assert.equal(store.get().events.some((record) => record.event.text === 'old execution'), false);
  await fs.rm(stateDir, { recursive: true, force: true });
});

test('activity store bounds retained count and serialized bytes and derives stale liveness', async () => {
  let now = Date.parse('2026-09-13T00:00:00.000Z');
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-activity-bounds-'));
  const store = await createAutopilotActivityStore({ stateDir, now: () => now, staleAfterMs: 10 });
  await store.update(envelope());
  for (let seq = 2; seq <= 620; seq += 1) {
    await store.update(envelope({ seq, emittedAt: new Date(now + seq).toISOString(), process: { pid: 1234, state: 'running' }, event: { kind: 'message', state: 'completed', text: 'x'.repeat(8000) } }));
  }
  const state = store.get();
  assert.ok(state.events.length <= AUTOPILOT_ACTIVITY_MAX_EVENTS);
  assert.ok(Buffer.byteLength(JSON.stringify(state), 'utf8') <= AUTOPILOT_ACTIVITY_MAX_BYTES + 512);
  now += 1000;
  assert.equal(store.get().effectiveProcessState, 'unknown');
  assert.equal(store.get().activityStale, true);
  await fs.rm(stateDir, { recursive: true, force: true });
});

test('activity HTTP endpoint requires auth and accepts only validated normalized envelopes', async (t) => {
  const accepted = [];
  const tabs = { listTabs: () => [], ensureTab: async () => 'tab-1', createTab: async () => 'tab-1', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0, token: 'secret', tabs, defaultTabId: 'tab-1', serverId: 'activity-test', stateDir: await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-activity-http-')),
    getStatus: async () => ({ ok: true }),
    getAutopilotActivity: async () => accepted.at(-1)?.state || null,
    onAutopilotActivity: async ({ envelope: value }) => { const result = { accepted: accepted.length === 0, state: value }; accepted.push(result); return result; },
  });
  t.after(() => server.close());
  const port = server.address().port;
  const post = async (token, value) => {
    const response = await fetch(`http://127.0.0.1:${port}/autopilot/activity`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
    return { response, body: await response.json() };
  };
  assert.equal((await post(null, envelope())).response.status, 401);
  assert.equal((await post('secret', { ...envelope(), event: { kind: 'private_reasoning', text: 'must reject' } })).response.status, 400);
  const valid = await post('secret', envelope());
  assert.equal(valid.response.status, 200);
  assert.equal(valid.body.accepted, true);
  assert.equal((await post('secret', envelope())).response.status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/autopilot/activity`, { headers: { authorization: 'Bearer secret' } })).status, 200);
});
