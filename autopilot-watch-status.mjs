import path from 'node:path';
import fs from 'node:fs/promises';

import { atomicWriteFile, defaultStateDir } from './state.mjs';

export const AUTOPILOT_WATCH_STATUS_SCHEMA_VERSION = 1;
export const AUTOPILOT_WATCH_STATUS_FILE = 'autopilot-watch-status.json';
export const AUTOPILOT_WATCH_STATUS_STALE_AFTER_MS = 15_000;

const STATUSES = new Set(['healthy', 'error']);
const PROPOSAL_STATES = new Set([
  'observed',
  'approved',
  'launch-prepared',
  'launch-started',
  'running',
  'completed',
  'blocked',
]);
const ALLOWED_KEYS = new Set(['schemaVersion', 'tabKey', 'status', 'lastPollAt', 'lastError', 'proposal', 'updatedAt']);
const PROPOSAL_KEYS = new Set(['proposalId', 'taskId', 'approvalCode', 'state', 'updatedAt']);

export function autopilotWatchStatusPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, AUTOPILOT_WATCH_STATUS_FILE);
}

export function validateAutopilotWatchStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidWatchStatus('snapshot must be an object');
  if (Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) throw invalidWatchStatus('unknown field');
  if (value.schemaVersion !== AUTOPILOT_WATCH_STATUS_SCHEMA_VERSION) throw invalidWatchStatus('unsupported schemaVersion');
  const tabKey = safeText(value.tabKey, 'tabKey', 128);
  if (!STATUSES.has(value.status)) throw invalidWatchStatus('status is invalid');
  const lastPollAt = canonicalTimestamp(value.lastPollAt, 'lastPollAt', { nullable: true });
  const updatedAt = canonicalTimestamp(value.updatedAt, 'updatedAt');
  const lastError = value.lastError === null ? null : validateError(value.lastError);
  const proposal = value.proposal === null ? null : validateProposal(value.proposal);
  return { schemaVersion: 1, tabKey, status: value.status, lastPollAt, lastError, proposal, updatedAt };
}

export async function createAutopilotWatchStatusStore({
  stateDir = defaultStateDir(),
  staleAfterMs = AUTOPILOT_WATCH_STATUS_STALE_AFTER_MS,
  now = () => Date.now(),
} = {}) {
  let current = await readPersistedWatchStatus(stateDir);
  const view = () => {
    if (!current) return null;
    const pollMs = current.lastPollAt ? Date.parse(current.lastPollAt) : NaN;
    const ageMs = Number.isFinite(pollMs) ? Math.max(0, now() - pollMs) : Number.POSITIVE_INFINITY;
    return { ...current, stale: ageMs > staleAfterMs, ageMs };
  };
  return {
    get: view,
    async update(value) {
      const next = validateAutopilotWatchStatus(value);
      if (current && Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
        const error = new Error('stale_autopilot_watch_status');
        error.data = { code: 'STALE_AUTOPILOT_WATCH_STATUS' };
        throw error;
      }
      await fs.mkdir(stateDir, { recursive: true });
      await atomicWriteFile(autopilotWatchStatusPath(stateDir), `${JSON.stringify(next, null, 2)}\n`);
      current = next;
      return view();
    },
    async clear() {
      try {
        await fs.unlink(autopilotWatchStatusPath(stateDir));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      current = null;
      return null;
    },
  };
}

async function readPersistedWatchStatus(stateDir) {
  try {
    return validateAutopilotWatchStatus(JSON.parse(await fs.readFile(autopilotWatchStatusPath(stateDir), 'utf8')));
  } catch {
    return null;
  }
}

function validateProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !PROPOSAL_KEYS.has(key))) {
    throw invalidWatchStatus('proposal is invalid');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(safeText(value.proposalId, 'proposal.proposalId', 64))) throw invalidWatchStatus('proposal.proposalId is invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(safeText(value.taskId, 'proposal.taskId', 128))) throw invalidWatchStatus('proposal.taskId is invalid');
  if (!/^[A-F0-9]{8}$/u.test(safeText(value.approvalCode, 'proposal.approvalCode', 8))) throw invalidWatchStatus('proposal.approvalCode is invalid');
  if (!PROPOSAL_STATES.has(value.state)) throw invalidWatchStatus('proposal.state is invalid');
  return {
    proposalId: value.proposalId,
    taskId: value.taskId,
    approvalCode: value.approvalCode,
    state: value.state,
    updatedAt: canonicalTimestamp(value.updatedAt, 'proposal.updatedAt'),
  };
}

function validateError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['code', 'message'].includes(key))) throw invalidWatchStatus('lastError is invalid');
  const code = safeText(value.code, 'lastError.code', 64);
  if (!/^[A-Z][A-Z0-9_]{1,63}$/u.test(code)) throw invalidWatchStatus('lastError.code is invalid');
  return { code, message: safeText(value.message, 'lastError.message', 160) };
}

function canonicalTimestamp(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw invalidWatchStatus(`${field} must be a timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw invalidWatchStatus(`${field} must be canonical ISO-8601`);
  return value;
}

function safeText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) throw invalidWatchStatus(`${field} is invalid`);
  return value.trim();
}

function invalidWatchStatus(message) {
  const error = new Error('invalid_autopilot_watch_status');
  error.data = { code: 'INVALID_AUTOPILOT_WATCH_STATUS', message };
  return error;
}
