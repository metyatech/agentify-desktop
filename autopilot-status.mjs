import path from 'node:path';
import fs from 'node:fs/promises';

import { atomicWriteFile, defaultStateDir } from './state.mjs';

export const AUTOPILOT_STATUS_SCHEMA_VERSION = 1;
export const AUTOPILOT_STATUS_FILE = 'autopilot-status.json';
export const AUTOPILOT_STATUS_STALE_AFTER_MS = 10 * 60 * 1000;

const ALLOWED_KEYS = new Set([
  'schemaVersion', 'taskId', 'title', 'repository', 'targetBranch', 'status', 'phase',
  'round', 'maxRounds', 'latestVerdict', 'verification', 'error', 'updatedAt'
]);
const VERDICTS = new Set(['PASS', 'FIX_REQUIRED', 'USER_ACTION_REQUIRED']);
const PHASES = new Set(['preparing', 'executing', 'verifying', 'reviewing', 'delivering', 'cleaning', 'completed', 'blocked']);

export function autopilotStatusPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, AUTOPILOT_STATUS_FILE);
}

export function validateAutopilotStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidStatus('snapshot must be an object');
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) throw invalidStatus(`unknown field: ${key}`);
  }
  if (value.schemaVersion !== AUTOPILOT_STATUS_SCHEMA_VERSION) throw invalidStatus('unsupported schemaVersion');
  const taskId = safeText(value.taskId, 'taskId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(taskId)) throw invalidStatus('taskId is not Windows-safe');
  const title = safeText(value.title, 'title', 240);
  const repository = value.repository === null ? null : safeText(value.repository, 'repository', 240);
  if (repository !== null && !/^[^/\\:\s]+\/[^/\\:\s]+$/u.test(repository)) throw invalidStatus('repository must use owner/name form');
  const targetBranch = value.targetBranch === null ? null : safeText(value.targetBranch, 'targetBranch', 240);
  if ((repository === null) !== (targetBranch === null)) throw invalidStatus('repository and targetBranch must be both null or both present');
  if (!['running', 'completed', 'blocked'].includes(value.status)) throw invalidStatus('status is invalid');
  if (!PHASES.has(value.phase)) throw invalidStatus('phase is invalid');
  if (value.status === 'completed' && value.phase !== 'completed') throw invalidStatus('completed status requires completed phase');
  if (value.status === 'blocked' && value.phase !== 'blocked') throw invalidStatus('blocked status requires blocked phase');
  if (value.status === 'running' && (value.phase === 'completed' || value.phase === 'blocked')) throw invalidStatus('running status cannot use terminal phase');
  if (!Number.isInteger(value.round) || value.round < 1 || value.round > 10) throw invalidStatus('round is invalid');
  if (!Number.isInteger(value.maxRounds) || value.maxRounds < 1 || value.maxRounds > 10 || value.round > value.maxRounds) throw invalidStatus('maxRounds is invalid');
  if (value.latestVerdict !== null && !VERDICTS.has(value.latestVerdict)) throw invalidStatus('latestVerdict is invalid');
  if (!value.verification || typeof value.verification !== 'object' || Array.isArray(value.verification)) throw invalidStatus('verification is invalid');
  const verificationKeys = Object.keys(value.verification);
  if (verificationKeys.some((key) => !['completed', 'total', 'failed'].includes(key))) throw invalidStatus('verification contains unknown fields');
  for (const key of ['completed', 'total', 'failed']) {
    if (!Number.isInteger(value.verification[key]) || value.verification[key] < 0 || value.verification[key] > 500) throw invalidStatus(`verification.${key} is invalid`);
  }
  if (value.verification.completed > value.verification.total || value.verification.failed > value.verification.completed) throw invalidStatus('verification counts are inconsistent');
  if (value.error !== null) {
    if (!value.error || typeof value.error !== 'object' || Array.isArray(value.error) || Object.keys(value.error).some((key) => !['code', 'message'].includes(key))) throw invalidStatus('error is invalid');
    if (!/^[A-Z][A-Z0-9_]{1,63}$/u.test(safeText(value.error.code, 'error.code', 64))) throw invalidStatus('error.code is invalid');
    safeText(value.error.message, 'error.message', 240);
  }
  if (typeof value.updatedAt !== 'string') throw invalidStatus('updatedAt must be canonical ISO-8601');
  const updatedAt = new Date(value.updatedAt);
  if (!Number.isFinite(updatedAt.getTime()) || updatedAt.toISOString() !== value.updatedAt) throw invalidStatus('updatedAt must be canonical ISO-8601');
  return {
    schemaVersion: AUTOPILOT_STATUS_SCHEMA_VERSION,
    taskId,
    title,
    repository,
    targetBranch,
    status: value.status,
    phase: value.phase,
    round: value.round,
    maxRounds: value.maxRounds,
    latestVerdict: value.latestVerdict,
    verification: { ...value.verification },
    error: value.error === null ? null : { code: value.error.code, message: value.error.message },
    updatedAt: value.updatedAt,
  };
}

export async function createAutopilotStatusStore({
  stateDir = defaultStateDir(),
  staleAfterMs = AUTOPILOT_STATUS_STALE_AFTER_MS,
  now = () => Date.now(),
} = {}) {
  let current = await readPersistedStatus(stateDir);
  const view = () => {
    if (!current) return null;
    const ageMs = Math.max(0, now() - Date.parse(current.updatedAt));
    return {
      ...current,
      stale: current.status === 'running' && ageMs > staleAfterMs,
      ageMs,
    };
  };
  return {
    get: view,
    async update(value) {
      const next = validateAutopilotStatus(value);
      if (current && Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
        const error = new Error('stale_autopilot_status');
        error.data = { code: 'STALE_AUTOPILOT_STATUS' };
        throw error;
      }
      await fs.mkdir(stateDir, { recursive: true });
      await atomicWriteFile(autopilotStatusPath(stateDir), `${JSON.stringify(next, null, 2)}\n`);
      current = next;
      return view();
    },
    async clear() {
      try {
        await fs.unlink(autopilotStatusPath(stateDir));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      current = null;
      return null;
    },
  };
}

async function readPersistedStatus(stateDir) {
  try {
    return validateAutopilotStatus(JSON.parse(await fs.readFile(autopilotStatusPath(stateDir), 'utf8')));
  } catch {
    return null;
  }
}

function safeText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) throw invalidStatus(`${field} is invalid`);
  return value.trim();
}

function invalidStatus(message) {
  const error = new Error('invalid_autopilot_status');
  error.data = { code: 'INVALID_AUTOPILOT_STATUS', message };
  return error;
}
