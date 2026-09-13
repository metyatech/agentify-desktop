import path from 'node:path';
import fs from 'node:fs/promises';

import { atomicWriteFile, defaultStateDir } from './state.mjs';

export const AUTOPILOT_ACTIVITY_SCHEMA_VERSION = 1;
export const AUTOPILOT_ACTIVITY_FILE = 'autopilot-activity.json';
export const AUTOPILOT_ACTIVITY_STALE_AFTER_MS = 15_000;
export const AUTOPILOT_ACTIVITY_MAX_EVENTS = 500;
export const AUTOPILOT_ACTIVITY_MAX_BYTES = 2 * 1024 * 1024;
export const AUTOPILOT_ACTIVITY_MAX_EVENT_BYTES = 64 * 1024;
export const AUTOPILOT_ACTIVITY_MAX_FILE_BYTES = AUTOPILOT_ACTIVITY_MAX_BYTES + 1024;

const PROCESS_STATES = new Set(['starting', 'running', 'exited', 'failed']);
const EVENT_KINDS = new Set(['lifecycle', 'message', 'command', 'file', 'tool', 'thinking']);
const ENVELOPE_KEYS = new Set(['schemaVersion', 'taskId', 'round', 'executionId', 'seq', 'emittedAt', 'process', 'event']);
const STATE_KEYS = new Set(['schemaVersion', 'taskId', 'round', 'executionId', 'processState', 'pid', 'startedAt', 'finishedAt', 'lastActivityAt', 'lastOutputAt', 'lastSeq', 'events']);
const RECORD_KEYS = new Set(['seq', 'emittedAt', 'pid', 'event']);

export function autopilotActivityPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, AUTOPILOT_ACTIVITY_FILE);
}

export function validateAutopilotActivityEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || Object.keys(value).some((key) => !ENVELOPE_KEYS.has(key))) throw invalidActivity('invalid envelope');
  const taskId = safeText(value.taskId, 'taskId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(taskId)) throw invalidActivity('taskId is invalid');
  const executionId = safeText(value.executionId, 'executionId', 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(executionId)) throw invalidActivity('executionId is invalid');
  if (!Number.isInteger(value.round) || value.round < 1 || value.round > 10) throw invalidActivity('round is invalid');
  if (!Number.isSafeInteger(value.seq) || value.seq < 1) throw invalidActivity('seq is invalid');
  const emittedAt = canonicalTimestamp(value.emittedAt, 'emittedAt');
  if (!value.process || typeof value.process !== 'object' || Array.isArray(value.process) || Object.keys(value.process).some((key) => !['pid', 'state'].includes(key))) throw invalidActivity('process is invalid');
  const pid = value.process.pid === null ? null : value.process.pid;
  if ((pid !== null && (!Number.isInteger(pid) || pid < 1)) || !PROCESS_STATES.has(value.process.state)) throw invalidActivity('process is invalid');
  const event = validateEvent(value.event);
  const envelope = { schemaVersion: 1, taskId, round: value.round, executionId, seq: value.seq, emittedAt, process: { pid, state: value.process.state }, event };
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > AUTOPILOT_ACTIVITY_MAX_EVENT_BYTES) throw invalidActivity('event is too large');
  return envelope;
}

export async function createAutopilotActivityStore({
  stateDir = defaultStateDir(),
  staleAfterMs = AUTOPILOT_ACTIVITY_STALE_AFTER_MS,
  now = () => Date.now(),
} = {}) {
  let current = await readPersistedActivity(stateDir);
  const view = () => {
    if (!current) return null;
    const lastMs = current.lastActivityAt ? Date.parse(current.lastActivityAt) : NaN;
    const activityStale = ['starting', 'running'].includes(current.processState) && (!Number.isFinite(lastMs) || now() - lastMs > staleAfterMs);
    return { ...current, activityStale, effectiveProcessState: activityStale ? 'unknown' : current.processState };
  };
  return {
    get: view,
    async update(input) {
      const envelope = validateAutopilotActivityEnvelope(input);
      if (!current || isNewExecution(current, envelope)) {
        if (current && !isAllowedNewExecution(current, envelope)) return { accepted: false, reason: 'stale_execution', state: view() };
        current = createState(envelope);
      } else {
        if (current.executionId !== envelope.executionId || envelope.seq <= current.lastSeq) return { accepted: false, reason: 'stale_sequence', state: view() };
        if (current.processState === 'exited' || current.processState === 'failed') return { accepted: false, reason: 'terminal_execution', state: view() };
        current = appendEvent(current, envelope);
      }
      await persist(stateDir, current);
      return { accepted: true, state: view() };
    },
    async clear() {
      try { await fs.unlink(autopilotActivityPath(stateDir)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      current = null;
      return null;
    },
  };
}

function isNewExecution(current, envelope) {
  return current.taskId !== envelope.taskId || current.round !== envelope.round || current.executionId !== envelope.executionId;
}

function isAllowedNewExecution(current, envelope) {
  const isStart = envelope.event.kind === 'lifecycle' && envelope.event.state === 'started';
  const emittedAt = Date.parse(envelope.emittedAt);
  const currentAt = Date.parse(current.lastActivityAt || current.startedAt || envelope.emittedAt);
  if (current.taskId !== envelope.taskId) return isStart && emittedAt >= currentAt;
  if (isStart || envelope.round > current.round) return emittedAt >= currentAt;
  const currentGeneration = executionGeneration(current.executionId);
  const nextGeneration = executionGeneration(envelope.executionId);
  return emittedAt >= currentAt && currentGeneration !== null && nextGeneration !== null && nextGeneration > currentGeneration;
}

function executionGeneration(executionId) {
  const match = /^(\d{13})-/u.exec(executionId);
  return match ? Number(match[1]) : null;
}

function createState(envelope) {
  return {
    schemaVersion: 1,
    taskId: envelope.taskId,
    round: envelope.round,
    executionId: envelope.executionId,
    processState: envelope.process.state === 'starting' ? 'starting' : envelope.process.state === 'failed' ? 'failed' : envelope.process.state === 'exited' ? 'exited' : 'running',
    pid: envelope.process.pid,
    startedAt: envelope.event.kind === 'lifecycle' && envelope.event.state === 'started' ? envelope.emittedAt : null,
    finishedAt: ['completed', 'failed'].includes(envelope.event.state) && envelope.event.kind === 'lifecycle' ? envelope.emittedAt : null,
    lastActivityAt: envelope.emittedAt,
    lastOutputAt: isOutputEvent(envelope.event) ? envelope.emittedAt : null,
    lastSeq: envelope.seq,
    events: isVisibleEvent(envelope.event) ? [recordFor(envelope)] : [],
  };
}

function appendEvent(current, envelope) {
  const event = recordFor(envelope);
  const next = {
    ...current,
    processState: nextProcessState(current.processState, envelope),
    pid: envelope.process.pid ?? current.pid,
    startedAt: current.startedAt || (envelope.event.kind === 'lifecycle' && envelope.event.state === 'started' ? envelope.emittedAt : null),
    finishedAt: envelope.event.kind === 'lifecycle' && ['completed', 'failed'].includes(envelope.event.state) ? envelope.emittedAt : current.finishedAt,
    lastActivityAt: envelope.emittedAt,
    lastOutputAt: isOutputEvent(envelope.event) ? envelope.emittedAt : current.lastOutputAt,
    lastSeq: envelope.seq,
    events: isVisibleEvent(envelope.event) ? appendVisibleRecord(current.events, event).slice(-AUTOPILOT_ACTIVITY_MAX_EVENTS) : current.events,
  };
  while (Buffer.byteLength(JSON.stringify(next), 'utf8') > AUTOPILOT_ACTIVITY_MAX_BYTES && next.events.length > 1) next.events.shift();
  return next;
}

function appendVisibleRecord(events, record) {
  if (record.event.kind !== 'command' || !record.event.itemId) return [...events, record];
  const index = events.findLastIndex((entry) => entry.event?.kind === 'command' && entry.event.itemId === record.event.itemId);
  if (index < 0) return [...events, record];
  const next = [...events];
  next[index] = record;
  return next;
}

function nextProcessState(previous, envelope) {
  if (envelope.event.kind === 'lifecycle' && envelope.event.state === 'failed') return 'failed';
  if (envelope.event.kind === 'lifecycle' && envelope.event.state === 'completed') return 'exited';
  if (envelope.event.kind === 'lifecycle' && envelope.event.state === 'started') return 'starting';
  return 'running';
}

function isOutputEvent(event) { return event.kind !== 'lifecycle' || event.state === 'failed'; }
function isVisibleEvent(event) { return event.kind !== 'lifecycle' || event.state !== 'heartbeat'; }
function recordFor(envelope) { return { seq: envelope.seq, emittedAt: envelope.emittedAt, pid: envelope.process.pid, event: envelope.event }; }

async function persist(stateDir, value) {
  await fs.mkdir(stateDir, { recursive: true });
  await atomicWriteFile(autopilotActivityPath(stateDir), `${JSON.stringify(value)}\n`);
}

async function readPersistedActivity(stateDir) {
  try {
    const activityPath = autopilotActivityPath(stateDir);
    const stats = await fs.lstat(activityPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > AUTOPILOT_ACTIVITY_MAX_FILE_BYTES) return null;
    const value = JSON.parse(await fs.readFile(activityPath, 'utf8'));
    const state = validatePersistedState(value);
    return Buffer.byteLength(JSON.stringify(state), 'utf8') <= AUTOPILOT_ACTIVITY_MAX_BYTES ? state : null;
  } catch { return null; }
}

function validatePersistedState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || Object.keys(value).some((key) => !STATE_KEYS.has(key))) throw invalidActivity('persisted state is invalid');
  const taskId = safeText(value.taskId, 'taskId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(taskId)) throw invalidActivity('persisted taskId is invalid');
  const executionId = safeText(value.executionId, 'executionId', 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(executionId)) throw invalidActivity('persisted executionId is invalid');
  if (!Number.isInteger(value.round) || value.round < 1 || value.round > 10 || !PROCESS_STATES.has(value.processState)) throw invalidActivity('persisted identity is invalid');
  if (value.pid !== null && (!Number.isInteger(value.pid) || value.pid < 1)) throw invalidActivity('persisted pid is invalid');
  for (const field of ['startedAt', 'finishedAt', 'lastActivityAt', 'lastOutputAt']) if (value[field] !== null) canonicalTimestamp(value[field], field);
  if (!Number.isSafeInteger(value.lastSeq) || value.lastSeq < 0 || !Array.isArray(value.events) || value.events.length > AUTOPILOT_ACTIVITY_MAX_EVENTS) throw invalidActivity('persisted state bounds are invalid');
  const records = value.events.map(validatePersistedRecord);
  if (records.some((record) => record.seq > value.lastSeq) || new Set(records.map((record) => record.seq)).size !== records.length) throw invalidActivity('persisted sequence is invalid');
  return {
    schemaVersion: 1, taskId, round: value.round, executionId, processState: value.processState, pid: value.pid,
    startedAt: value.startedAt, finishedAt: value.finishedAt, lastActivityAt: value.lastActivityAt, lastOutputAt: value.lastOutputAt,
    lastSeq: value.lastSeq, events: records.filter((record) => isVisibleEvent(record.event)),
  };
}

function validatePersistedRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !RECORD_KEYS.has(key))) throw invalidActivity('persisted event record is invalid');
  if (!Number.isSafeInteger(value.seq) || value.seq < 1) throw invalidActivity('persisted event sequence is invalid');
  const emittedAt = canonicalTimestamp(value.emittedAt, 'event.emittedAt');
  const pid = value.pid === null ? null : value.pid;
  if (pid !== null && (!Number.isInteger(pid) || pid < 1)) throw invalidActivity('persisted event pid is invalid');
  const event = validateEvent(value.event);
  const record = { seq: value.seq, emittedAt, pid, event };
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > AUTOPILOT_ACTIVITY_MAX_EVENT_BYTES) throw invalidActivity('persisted event is too large');
  return record;
}

function validateEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !EVENT_KINDS.has(value.kind)) throw invalidActivity('event is invalid');
  const kind = value.kind;
  if (kind === 'lifecycle') {
    if (!['started', 'heartbeat', 'completed', 'failed'].includes(value.state)) throw invalidActivity('lifecycle is invalid');
    return { kind, state: value.state, label: safeText(value.label, 'event.label', 256), exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null };
  }
  if (kind === 'message') return value.state === 'completed' ? { kind, state: 'completed', text: safeText(value.text, 'event.text', 8 * 1024) } : invalidActivity('message is invalid');
  if (kind === 'thinking') return ['started', 'completed'].includes(value.state) && value.text === null ? { kind, state: value.state, text: null } : invalidActivity('thinking is invalid');
  if (kind === 'command') return ['started', 'updated', 'completed', 'failed'].includes(value.state) ? { kind, itemId: nullableText(value.itemId, 256), state: value.state, command: nullableText(value.command, 4 * 1024), output: nullableText(value.output, 16 * 1024), exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null } : invalidActivity('command is invalid');
  if (kind === 'file') return ['started', 'completed', 'failed'].includes(value.state) && Array.isArray(value.paths) ? { kind, itemId: nullableText(value.itemId, 256), state: value.state, paths: value.paths.slice(0, 100).map((pathValue) => safeText(pathValue, 'event.path', 1024)), summary: nullableText(value.summary, 8 * 1024) } : invalidActivity('file is invalid');
  if (kind === 'tool') return ['started', 'completed', 'failed'].includes(value.state) ? { kind, itemId: nullableText(value.itemId, 256), state: value.state, tool: safeText(value.tool, 'event.tool', 4 * 1024), summary: nullableText(value.summary, 4 * 1024) } : invalidActivity('tool is invalid');
  throw invalidActivity('event is invalid');
}

function safeText(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw invalidActivity(`${field} is invalid`);
  return value.trim();
}
function nullableText(value, max) { return value === null || value === undefined ? null : safeText(value, 'event.text', max); }
function canonicalTimestamp(value, field) {
  if (typeof value !== 'string') throw invalidActivity(`${field} is invalid`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw invalidActivity(`${field} is invalid`);
  return value;
}
function invalidActivity(message) { const error = new Error('invalid_autopilot_activity'); error.data = { code: 'INVALID_AUTOPILOT_ACTIVITY', message }; return error; }
