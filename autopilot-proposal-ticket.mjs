import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile, defaultStateDir, ensureStateDir } from './state.mjs';

export const AUTOPILOT_PROPOSAL_TICKET_SCHEMA_VERSION = 2;
export const AUTOPILOT_PROPOSAL_TICKET_LEGACY_SCHEMA_VERSION = 1;
export const AUTOPILOT_PROPOSAL_TICKET_FILE = 'autopilot-proposal-ticket.json';
export const AUTOPILOT_PROPOSAL_TICKETS_DIR = 'autopilot-tickets';
export const AUTOPILOT_PROPOSAL_TICKET_MAX_BYTES = 512 * 1024;
export const AUTOPILOT_PROPOSAL_TICKET_STATES = Object.freeze(['pending', 'acknowledged', 'consumed', 'abandoned']);
export const AUTOPILOT_PROPOSAL_TICKET_IDENTITY_PROVENANCES = Object.freeze([
  'provider-message-id',
  'provider-turn-id',
]);

const LEGACY_KEYS = Object.freeze([
  'schemaVersion', 'proposalId', 'tabKey', 'tabId', 'vendorId', 'conversationUrl',
  'assistantTurnId', 'assistantTurnIdentityProvenance', 'proposal', 'contractHash', 'createdAt', 'expiresAt', 'state', 'updatedAt'
]);
const V2_KEYS = Object.freeze([
  'schemaVersion', 'proposalId', 'taskId', 'tabKey', 'tabId', 'vendorId', 'conversationUrl',
  'assistantTurnId', 'assistantTurnIdentityProvenance', 'approvalCode', 'contract', 'contractHash', 'createdAt', 'expiresAt', 'proposal'
]);

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`autopilot_proposal_ticket_${field}_invalid`);
  }
  return value.trim();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

export function proposalContractHash(contract) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(contract)), 'utf8').digest('hex');
}

function canonicalTimestamp(value, field) {
  const text = safeText(value, field, 32);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) throw new Error(`autopilot_proposal_ticket_${field}_invalid`);
  return text;
}

function proposalId(value) {
  const text = safeText(value, 'proposalId', 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text)) throw new Error('autopilot_proposal_ticket_proposalId_invalid');
  return text;
}

function validateContract(contract) {
  if (!isRecord(contract)) throw new Error('autopilot_proposal_ticket_contract_invalid');
  if (Buffer.byteLength(JSON.stringify(contract), 'utf8') > AUTOPILOT_PROPOSAL_TICKET_MAX_BYTES) throw new Error('autopilot_proposal_ticket_too_large');
  return contract;
}

function validateConversationIdentity(value) {
  const conversationUrl = safeText(value.conversationUrl, 'conversationUrl', 2_000);
  let parsedUrl;
  try { parsedUrl = new URL(conversationUrl); } catch { throw new Error('autopilot_proposal_ticket_url_invalid'); }
  if (parsedUrl.protocol !== 'https:' || (parsedUrl.hostname !== 'chatgpt.com' && !parsedUrl.hostname.endsWith('.chatgpt.com'))) throw new Error('autopilot_proposal_ticket_url_invalid');
  const provenance = safeText(value.assistantTurnIdentityProvenance, 'assistantTurnIdentityProvenance', 64);
  if (!AUTOPILOT_PROPOSAL_TICKET_IDENTITY_PROVENANCES.includes(provenance)) throw new Error('autopilot_proposal_ticket_assistantTurnIdentityProvenance_invalid');
  return { conversationUrl, provenance };
}

export function validateAutopilotProposalTicket(value, { now = null, allowExpired = true, state = undefined } = {}) {
  if (!isRecord(value)) throw new Error('autopilot_proposal_ticket_schema_invalid');
  if (value.schemaVersion === AUTOPILOT_PROPOSAL_TICKET_LEGACY_SCHEMA_VERSION) return validateLegacyTicket(value, { now, allowExpired });
  const requiredV2Keys = new Set(V2_KEYS);
  requiredV2Keys.delete('proposal');
  const v2WithLifecycleKeys = new Set([...V2_KEYS, 'state', 'updatedAt']);
  if (value.schemaVersion !== AUTOPILOT_PROPOSAL_TICKET_SCHEMA_VERSION || Object.keys(value).some((key) => !v2WithLifecycleKeys.has(key)) || Object.keys(value).some((key) => requiredV2Keys.has(key) === false && !['state', 'updatedAt', 'proposal'].includes(key))) throw new Error('autopilot_proposal_ticket_schema_invalid');
  const id = proposalId(value.proposalId);
  const taskId = safeText(value.taskId, 'taskId', 128);
  const tabKey = safeText(value.tabKey, 'tabKey', 128);
  const tabId = safeText(value.tabId, 'tabId', 256);
  const vendorId = safeText(value.vendorId, 'vendorId', 64);
  if (vendorId !== 'chatgpt') throw new Error('autopilot_proposal_ticket_vendor_invalid');
  const identity = validateConversationIdentity(value);
  const assistantTurnId = safeText(value.assistantTurnId, 'assistantTurnId', 512);
  const approvalCode = safeText(value.approvalCode, 'approvalCode', 8).toUpperCase();
  if (!/^[A-F0-9]{8}$/u.test(approvalCode)) throw new Error('autopilot_proposal_ticket_approvalCode_invalid');
  const contract = validateContract(value.contract);
  if (contract.id !== taskId) throw new Error('autopilot_proposal_ticket_task_mismatch');
  if (value.proposal !== undefined && (!isRecord(value.proposal) || value.proposal.proposalId !== id || value.proposal.approvalCode !== approvalCode || !isRecord(value.proposal.contract) || proposalContractHash(value.proposal.contract) !== proposalContractHash(contract))) throw new Error('autopilot_proposal_ticket_proposal_mismatch');
  const hash = safeText(value.contractHash, 'contractHash', 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(hash) || proposalContractHash(contract) !== hash) throw new Error('autopilot_proposal_ticket_contract_hash_invalid');
  const createdAt = canonicalTimestamp(value.createdAt, 'createdAt');
  const expiresAt = canonicalTimestamp(value.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error('autopilot_proposal_ticket_time_invalid');
  if (now !== null && !allowExpired && Date.parse(expiresAt) <= (now instanceof Date ? now.getTime() : Date.parse(now))) throw new Error('autopilot_proposal_ticket_expired');
  const lifecycleState = state === undefined ? (value.state === undefined ? undefined : validateTicketState(value.state)) : validateTicketState(state);
  const updatedAt = value.updatedAt === undefined ? undefined : canonicalTimestamp(value.updatedAt, 'updatedAt');
  return {
    schemaVersion: AUTOPILOT_PROPOSAL_TICKET_SCHEMA_VERSION,
    proposalId: id,
    taskId,
    tabKey,
    tabId,
    vendorId,
    conversationUrl: identity.conversationUrl,
    assistantTurnId,
    assistantTurnIdentityProvenance: identity.provenance,
    approvalCode,
    contract,
    contractHash: hash,
    createdAt,
    expiresAt,
    ...(lifecycleState === undefined ? {} : { state: lifecycleState }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

function validateLegacyTicket(value, { now, allowExpired }) {
  if (Object.keys(value).some((key) => !LEGACY_KEYS.includes(key)) || Object.keys(value).length !== LEGACY_KEYS.length) throw new Error('autopilot_proposal_ticket_schema_invalid');
  if (value.schemaVersion !== AUTOPILOT_PROPOSAL_TICKET_LEGACY_SCHEMA_VERSION) throw new Error('autopilot_proposal_ticket_schema_version_invalid');
  const id = proposalId(value.proposalId);
  const identity = validateConversationIdentity(value);
  if (!isRecord(value.proposal) || value.proposal.proposalId !== id || !isRecord(value.proposal.contract)) throw new Error('autopilot_proposal_ticket_proposal_invalid');
  if (Buffer.byteLength(JSON.stringify(value.proposal), 'utf8') > AUTOPILOT_PROPOSAL_TICKET_MAX_BYTES) throw new Error('autopilot_proposal_ticket_too_large');
  const hash = safeText(value.contractHash, 'contractHash', 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(hash) || proposalContractHash(value.proposal.contract) !== hash) throw new Error('autopilot_proposal_ticket_contract_hash_invalid');
  const createdAt = canonicalTimestamp(value.createdAt, 'createdAt');
  const expiresAt = canonicalTimestamp(value.expiresAt, 'expiresAt');
  const updatedAt = canonicalTimestamp(value.updatedAt, 'updatedAt');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error('autopilot_proposal_ticket_time_invalid');
  if (!AUTOPILOT_PROPOSAL_TICKET_STATES.includes(value.state)) throw new Error('autopilot_proposal_ticket_state_invalid');
  if (now !== null && !allowExpired && Date.parse(expiresAt) <= (now instanceof Date ? now.getTime() : Date.parse(now))) throw new Error('autopilot_proposal_ticket_expired');
  return {
    ...value,
    tabKey: safeText(value.tabKey, 'tabKey', 128),
    tabId: safeText(value.tabId, 'tabId', 256),
    vendorId: 'chatgpt',
    conversationUrl: identity.conversationUrl,
    assistantTurnId: safeText(value.assistantTurnId, 'assistantTurnId', 512),
    assistantTurnIdentityProvenance: identity.provenance,
    contractHash: hash,
    createdAt,
    expiresAt,
    updatedAt,
  };
}

function validateTicketState(value) {
  if (!AUTOPILOT_PROPOSAL_TICKET_STATES.includes(value)) throw new Error('autopilot_proposal_ticket_state_invalid');
  return value;
}

export function autopilotProposalTicketPath(stateDir = defaultStateDir()) { return path.join(stateDir, AUTOPILOT_PROPOSAL_TICKET_FILE); }
export function autopilotProposalTicketsRoot(stateDir = defaultStateDir()) { return path.join(stateDir, AUTOPILOT_PROPOSAL_TICKETS_DIR); }
export function autopilotProposalTicketDir(proposalIdValue, stateDir = defaultStateDir()) { return path.join(autopilotProposalTicketsRoot(stateDir), proposalIdValue); }
export function autopilotProposalTicketJsonPath(proposalIdValue, stateDir = defaultStateDir()) { return path.join(autopilotProposalTicketDir(proposalIdValue, stateDir), 'ticket.json'); }
export function autopilotProposalTicketStatePath(proposalIdValue, stateDir = defaultStateDir()) { return path.join(autopilotProposalTicketDir(proposalIdValue, stateDir), 'state.json'); }

export async function createAutopilotProposalTicketStore({ stateDir = defaultStateDir(), now = () => new Date(), onCreatePhase = null } = {}) {
  await ensureStateDir(stateDir);
  await fs.mkdir(autopilotProposalTicketsRoot(stateDir), { recursive: true });
  const readAll = async () => await listTickets(stateDir);
  const readV2 = async () => await listTickets(stateDir, { includeLegacy: false });
  const get = async (requestedProposalId = null) => {
    const tickets = await readAll();
    if (requestedProposalId) return tickets.find((ticket) => ticket.proposalId === requestedProposalId) || null;
    const unresolved = tickets.filter((ticket) => isUnresolved(ticket, now()));
    return unresolved.at(-1) || tickets.at(-1) || null;
  };
  return {
    get,
    list: readAll,
    async listUnresolved() { return (await readV2()).filter((ticket) => isUnresolved(ticket, now())); },
    async create(ticket) {
      if (ticket?.schemaVersion === AUTOPILOT_PROPOSAL_TICKET_LEGACY_SCHEMA_VERSION) throw new Error('autopilot_proposal_ticket_legacy_read_only');
      const currentNow = now();
      const next = validateAutopilotProposalTicket(ticket, { now: currentNow, allowExpired: false });
      if ((await readV2()).some((item) => isUnresolved(item, currentNow))) throw new Error('autopilot_proposal_ticket_unresolved');
      const root = autopilotProposalTicketsRoot(stateDir);
      const finalDir = autopilotProposalTicketDir(next.proposalId, stateDir);
      const stagingDir = path.join(root, `.${next.proposalId}.${crypto.randomBytes(8).toString('hex')}.tmp`);
      try {
        try {
          await fs.lstat(finalDir);
          throw new Error('autopilot_proposal_ticket_exists');
        } catch (error) {
          if (error?.message === 'autopilot_proposal_ticket_exists') throw error;
          if (error?.code !== 'ENOENT') throw error;
        }
        await fs.mkdir(stagingDir, { recursive: false });
        await atomicWriteFile(path.join(stagingDir, 'ticket.json'), `${JSON.stringify(next, null, 2)}\n`);
        await onCreatePhase?.({ phase: 'ticket-written', proposalId: next.proposalId, stagingDir });
        await atomicWriteFile(path.join(stagingDir, 'state.json'), `${JSON.stringify({ schemaVersion: 2, proposalId: next.proposalId, state: 'pending', updatedAt: next.createdAt }, null, 2)}\n`);
        await onCreatePhase?.({ phase: 'state-written', proposalId: next.proposalId, stagingDir });
        await onCreatePhase?.({ phase: 'before-rename', proposalId: next.proposalId, stagingDir, finalDir });
        await fs.rename(stagingDir, finalDir);
        try {
          const rootHandle = await fs.open(root, 'r');
          try { await rootHandle.sync(); } finally { await rootHandle.close(); }
        } catch {}
      } catch (error) {
        try { await fs.rm(stagingDir, { recursive: true, force: true }); } catch {}
        if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') throw new Error('autopilot_proposal_ticket_exists');
        if (error.code === 'EPERM') {
          try {
            await fs.lstat(finalDir);
            throw new Error('autopilot_proposal_ticket_exists');
          } catch (destinationError) {
            if (destinationError?.message === 'autopilot_proposal_ticket_exists') throw destinationError;
            if (destinationError?.code !== 'ENOENT') throw error;
          }
        }
        throw error;
      }
      return { ...next, state: 'pending', updatedAt: next.createdAt };
    },
    async update({ proposalId: requestedProposalId, state } = {}) {
      const id = proposalId(requestedProposalId);
      const current = await get(id);
      if (!current) throw new Error('autopilot_proposal_ticket_not_found');
      if (current.schemaVersion !== AUTOPILOT_PROPOSAL_TICKET_SCHEMA_VERSION) throw new Error('autopilot_proposal_ticket_legacy_read_only');
      const nextState = validateTicketState(state);
      const allowed = current.state === 'pending' ? ['pending', 'acknowledged', 'abandoned'] : current.state === 'acknowledged' ? ['acknowledged', 'consumed'] : current.state === 'consumed' ? ['consumed'] : ['abandoned'];
      if (!allowed.includes(nextState)) throw new Error('autopilot_proposal_ticket_transition_invalid');
      const updatedAt = now().toISOString();
      await atomicWriteFile(autopilotProposalTicketStatePath(id, stateDir), `${JSON.stringify({ schemaVersion: 2, proposalId: id, state: nextState, updatedAt }, null, 2)}\n`);
      return { ...current, state: nextState, updatedAt };
    },
  };
}

async function listTickets(stateDir, { includeLegacy = true } = {}) {
  const result = [];
  try {
    const entries = await fs.readdir(autopilotProposalTicketsRoot(stateDir), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (id.startsWith('.')) continue;
      const ticket = validateAutopilotProposalTicket(JSON.parse(await fs.readFile(autopilotProposalTicketJsonPath(id, stateDir), 'utf8')));
      const lifecycle = JSON.parse(await fs.readFile(autopilotProposalTicketStatePath(id, stateDir), 'utf8'));
      if (lifecycle.schemaVersion !== 2 || lifecycle.proposalId !== ticket.proposalId) throw new Error('autopilot_proposal_ticket_state_invalid');
      result.push({ ...ticket, state: validateTicketState(lifecycle.state), updatedAt: canonicalTimestamp(lifecycle.updatedAt, 'updatedAt') });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (includeLegacy) {
    try {
      result.push(validateLegacyTicket(JSON.parse(await fs.readFile(autopilotProposalTicketPath(stateDir), 'utf8')), { now: null, allowExpired: true }));
    } catch (error) {
      if (error.code !== 'ENOENT' && !String(error?.message || '').includes('ENOENT')) throw error;
    }
  }
  return result.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

function isUnresolved(ticket, currentNow) {
  return ticket?.state === 'acknowledged' || (ticket?.state === 'pending' && Date.parse(ticket.expiresAt) > currentNow.getTime());
}
