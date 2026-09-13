import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTOPILOT_ACTIVITY_MAX_BYTES,
  AUTOPILOT_ACTIVITY_MAX_EVENTS,
  AUTOPILOT_ACTIVITY_MAX_FILE_BYTES,
  autopilotActivityPath,
  createAutopilotActivityStore,
  validateAutopilotActivityEnvelope,
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
  assert.equal(store.get().events.length, 1);
  assert.equal(store.get().lastOutputAt, null);
  const reopened = await createAutopilotActivityStore({ stateDir, now: () => Date.parse('2026-09-13T00:00:03.000Z') });
  assert.equal(reopened.get().lastSeq, 2);
  await fs.rm(stateDir, { recursive: true, force: true });
});

test('heartbeats update liveness without consuming visible timeline history', async () => {
  let now = Date.parse('2026-09-13T00:00:00.000Z');
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-activity-heartbeats-'));
  const store = await createAutopilotActivityStore({ stateDir, now: () => now });
  await store.update(envelope({ event: { kind: 'message', state: 'completed', text: 'keep this message' } }));
  for (let seq = 2; seq <= 601; seq += 1) {
    now += 1;
    await store.update(envelope({ seq, emittedAt: new Date(now).toISOString(), process: { pid: 1234, state: 'running' }, event: { kind: 'lifecycle', state: 'heartbeat', label: 'Codex heartbeat', exitCode: null } }));
  }
  assert.equal(store.get().lastSeq, 601);
  assert.equal(store.get().processState, 'running');
  assert.equal(store.get().events.length, 1);
  assert.equal(store.get().events[0].event.text, 'keep this message');
  assert.equal(store.get().lastOutputAt, '2026-09-13T00:00:00.000Z');
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

test('new execution without a start event recovers only from a newer generation and rejects late old data', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-activity-lost-start-'));
  const store = await createAutopilotActivityStore({ stateDir });
  await store.update(envelope({ executionId: '1000000000000-execution-1' }));
  assert.equal((await store.update(envelope({ executionId: '1000000000001-execution-2', seq: 2, emittedAt: '2026-09-13T00:00:01.000Z', process: { pid: 1234, state: 'running' }, event: { kind: 'message', state: 'completed', text: 'recovered execution' } }))).accepted, true);
  assert.equal(store.get().executionId, '1000000000001-execution-2');
  assert.equal((await store.update(envelope({ executionId: '1000000000000-execution-1', seq: 99, emittedAt: '2026-09-13T00:00:02.000Z', process: { pid: 1234, state: 'running' }, event: { kind: 'message', state: 'completed', text: 'late old execution' } }))).accepted, false);
  assert.equal(store.get().events.some((record) => record.event.text === 'late old execution'), false);
  await fs.rm(stateDir, { recursive: true, force: true });
});

test('newer cross-task activity recovers when the start event was lost and rejects late old task data', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-activity-cross-task-'));
  const store = await createAutopilotActivityStore({ stateDir });
  await store.update(envelope({ taskId: 'task-A', executionId: '1000-execution-1', emittedAt: '2026-09-13T00:00:00.000Z' }));
  const recovered = await store.update(envelope({
    taskId: 'task-B', executionId: '2000-execution-2', seq: 1, emittedAt: '2026-09-13T00:00:01.000Z',
    process: { pid: 2345, state: 'running' }, event: { kind: 'message', state: 'completed', text: 'recovered task B' },
  }));
  assert.equal(recovered.accepted, true);
  assert.equal(store.get().taskId, 'task-B');
  assert.equal(store.get().executionId, '2000-execution-2');
  assert.equal(store.get().events[0].event.text, 'recovered task B');
  const late = await store.update(envelope({
    taskId: 'task-A', executionId: '1000-execution-1', seq: 99, emittedAt: '2026-09-13T00:00:02.000Z',
    process: { pid: 1234, state: 'running' }, event: { kind: 'message', state: 'completed', text: 'late task A' },
  }));
  assert.equal(late.accepted, false);
  assert.equal(store.get().taskId, 'task-B');
  assert.equal(store.get().events.some((record) => record.event.text === 'late task A'), false);
  await fs.rm(stateDir, { recursive: true, force: true });
});

test('cross-task recovery fails closed without generation proof while explicit start remains valid', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-activity-cross-task-validation-'));
  const store = await createAutopilotActivityStore({ stateDir });
  await store.update(envelope({ taskId: 'task-A', executionId: '1000-execution-1', emittedAt: '2026-09-13T00:00:00.000Z' }));
  const legacy = await store.update(envelope({
    taskId: 'task-B', executionId: 'legacy-execution-2', seq: 1, emittedAt: '2026-09-13T00:00:01.000Z',
    process: { pid: 2345, state: 'running' }, event: { kind: 'message', state: 'completed', text: 'must reject' },
  }));
  assert.equal(legacy.accepted, false);
  const started = await store.update(envelope({
    taskId: 'task-B', executionId: 'legacy-execution-2', seq: 1, emittedAt: '2026-09-13T00:00:01.000Z',
    process: { pid: 2345, state: 'starting' }, event: { kind: 'lifecycle', state: 'started', label: 'Codex started', exitCode: null },
  }));
  assert.equal(started.accepted, true);
  assert.equal(store.get().taskId, 'task-B');
  await fs.rm(stateDir, { recursive: true, force: true });
});

test('multiline activity is normalized, persisted, and reopened without flattening', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-activity-multiline-'));
  const store = await createAutopilotActivityStore({ stateDir });
  await store.update(envelope({ event: { kind: 'message', state: 'completed', text: 'Implemented Undo test.\r\nRunning UE 5.7 next.' } }));
  await store.update(envelope({
    seq: 2, emittedAt: '2026-09-13T00:00:01.000Z', process: { pid: 1234, state: 'running' },
    event: { kind: 'command', itemId: 'cmd-1', state: 'completed', command: 'npm test', output: 'PASS test-a\r\nPASS test-b\r\nexit 0', exitCode: 0 },
  }));
  assert.equal(store.get().events[0].event.text, 'Implemented Undo test.\nRunning UE 5.7 next.');
  assert.equal(store.get().events[1].event.output, 'PASS test-a\nPASS test-b\nexit 0');
  const reopened = await createAutopilotActivityStore({ stateDir });
  assert.equal(reopened.get().events[0].event.text, 'Implemented Undo test.\nRunning UE 5.7 next.');
  assert.equal(reopened.get().events[1].event.output, 'PASS test-a\nPASS test-b\nexit 0');
  assert.throws(() => validateAutopilotActivityEnvelope(envelope({ event: { kind: 'message', state: 'completed', text: 'unsafe\u0000text' } })));
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

test('starting and running become unknown when heartbeat expires and recover on fresh activity', async () => {
  let now = Date.parse('2026-09-13T00:00:00.000Z');
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-activity-liveness-'));
  const store = await createAutopilotActivityStore({ stateDir, now: () => now, staleAfterMs: 10 });
  await store.update(envelope());
  now += 11;
  assert.equal(store.get().effectiveProcessState, 'unknown');
  await store.update(envelope({ seq: 2, emittedAt: new Date(now).toISOString(), process: { pid: 1234, state: 'running' }, event: { kind: 'lifecycle', state: 'heartbeat', label: 'Codex heartbeat', exitCode: null } }));
  assert.equal(store.get().effectiveProcessState, 'running');
  await fs.rm(stateDir, { recursive: true, force: true });
});

test('command lifecycle events with one item id coalesce into one visible card', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-activity-command-'));
  const store = await createAutopilotActivityStore({ stateDir });
  const states = ['started', 'updated', 'updated', 'completed'];
  for (const [index, state] of states.entries()) {
    await store.update(envelope({ seq: index + 1, process: { pid: 1234, state: state === 'completed' ? 'exited' : 'running' }, event: { kind: 'command', itemId: 'cmd-1', state, command: 'git diff --check', output: `output-${index}`, exitCode: state === 'completed' ? 0 : null } }));
  }
  assert.equal(store.get().events.length, 1);
  assert.equal(store.get().events[0].event.state, 'completed');
  assert.equal(store.get().events[0].event.output, 'output-3');
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
  assert.equal(valid.body.activity, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(valid.body), 'utf8') < 64 * 1024);
  assert.equal((await post('secret', envelope())).response.status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/autopilot/activity`, { headers: { authorization: 'Bearer secret' } })).status, 200);
});

test('activity POST returns a small ACK even when retained GET state is large', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-activity-ack-'));
  const store = await createAutopilotActivityStore({ stateDir });
  const tabs = { listTabs: () => [], ensureTab: async () => 'tab-1', createTab: async () => 'tab-1', closeTab: async () => true, getControllerById: () => ({}) };
  const server = await startHttpApi({
    port: 0, token: 'secret', tabs, defaultTabId: 'tab-1', serverId: 'activity-ack-test', stateDir,
    getStatus: async () => ({ ok: true }), getAutopilotActivity: async () => store.get(), onAutopilotActivity: async ({ envelope: value }) => store.update(value),
  });
  t.after(() => server.close());
  const port = server.address().port;
  for (let seq = 1; seq <= 20; seq += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/autopilot/activity`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify(envelope({ seq, emittedAt: new Date(Date.parse('2026-09-13T00:00:00.000Z') + seq).toISOString(), event: { kind: 'message', state: 'completed', text: 'x'.repeat(8000) }, process: { pid: 1234, state: 'running' } })) });
    assert.equal(response.status, 200);
  }
  const final = await fetch(`http://127.0.0.1:${port}/autopilot/activity`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify(envelope({ seq: 21, emittedAt: '2026-09-13T00:00:00.021Z', event: { kind: 'lifecycle', state: 'heartbeat', label: 'Codex heartbeat', exitCode: null }, process: { pid: 1234, state: 'running' } })) });
  const body = await final.text();
  assert.equal(final.status, 200);
  assert.ok(Buffer.byteLength(body, 'utf8') < 64 * 1024);
  assert.deepEqual(JSON.parse(body), { ok: true, accepted: true });
  const persisted = await fs.stat(autopilotActivityPath(stateDir));
  assert.ok(persisted.size <= AUTOPILOT_ACTIVITY_MAX_FILE_BYTES);
  await fs.rm(stateDir, { recursive: true, force: true });
});

test('malformed or oversized persisted activity fails closed on reopen', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-activity-reopen-'));
  await fs.writeFile(autopilotActivityPath(stateDir), JSON.stringify({ schemaVersion: 1, events: [{ event: { kind: 'message', text: '<script>' } }] }), 'utf8');
  const malformed = await createAutopilotActivityStore({ stateDir });
  assert.equal(malformed.get(), null);
  await fs.writeFile(autopilotActivityPath(stateDir), 'x'.repeat(AUTOPILOT_ACTIVITY_MAX_FILE_BYTES + 1), 'utf8');
  const oversized = await createAutopilotActivityStore({ stateDir });
  assert.equal(oversized.get(), null);
  await fs.rm(stateDir, { recursive: true, force: true });
});
