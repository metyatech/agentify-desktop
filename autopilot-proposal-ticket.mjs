import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile, defaultStateDir, ensureStateDir } from './state.mjs';

export const AUTOPILOT_PROPOSAL_TICKET_SCHEMA_VERSION = 1;
export const AUTOPILOT_PROPOSAL_TICKET_FILE = 'autopilot-proposal-ticket.json';
export const AUTOPILOT_PROPOSAL_TICKET_MAX_BYTES = 512 * 1024;
export const AUTOPILOT_PROPOSAL_TICKET_STATES = Object.freeze(['pending', 'acknowledged', 'consumed']);

const TICKET_KEYS = Object.freeze([
  'schemaVersion', 'proposalId', 'tabKey', 'tabId', 'vendorId', 'conversationUrl',
  'assistantTurnId', 'assistantTurnIdentityProvenance', 'proposal', 'contractHash', 'createdAt', 'expiresAt', 'state', 'updatedAt'
]);

export const AUTOPILOT_PROPOSAL_TICKET_IDENTITY_PROVENANCES = Object.freeze([
  'provider-message-id',
  'provider-turn-id',
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

function validateProposal(proposal) {
  if (!isRecord(proposal)) throw new Error('autopilot_proposal_ticket_proposal_invalid');
  if (proposalId(proposal.proposalId) !== proposal.proposalId) throw new Error('autopilot_proposal_ticket_proposal_invalid');
  if (!isRecord(proposal.contract)) throw new Error('autopilot_proposal_ticket_proposal_invalid');
  const serialized = JSON.stringify(proposal);
  if (Buffer.byteLength(serialized, 'utf8') > AUTOPILOT_PROPOSAL_TICKET_MAX_BYTES) throw new Error('autopilot_proposal_ticket_too_large');
  return proposal;
}

export function validateAutopilotProposalTicket(value, { now = null, allowExpired = true } = {}) {
  if (!isRecord(value) || Object.keys(value).some((key) => !TICKET_KEYS.includes(key)) || Object.keys(value).length !== TICKET_KEYS.length) {
    throw new Error('autopilot_proposal_ticket_schema_invalid');
  }
  if (value.schemaVersion !== AUTOPILOT_PROPOSAL_TICKET_SCHEMA_VERSION) throw new Error('autopilot_proposal_ticket_schema_version_invalid');
  const id = proposalId(value.proposalId);
  const tabKey = safeText(value.tabKey, 'tabKey', 128);
  const tabId = safeText(value.tabId, 'tabId', 256);
  const vendorId = safeText(value.vendorId, 'vendorId', 64);
  if (vendorId !== 'chatgpt') throw new Error('autopilot_proposal_ticket_vendor_invalid');
  const conversationUrl = safeText(value.conversationUrl, 'conversationUrl', 2_000);
  let parsedUrl;
  try { parsedUrl = new URL(conversationUrl); } catch { throw new Error('autopilot_proposal_ticket_url_invalid'); }
  if (parsedUrl.protocol !== 'https:' || (parsedUrl.hostname !== 'chatgpt.com' && !parsedUrl.hostname.endsWith('.chatgpt.com'))) throw new Error('autopilot_proposal_ticket_url_invalid');
  const assistantTurnId = safeText(value.assistantTurnId, 'assistantTurnId', 512);
  const assistantTurnIdentityProvenance = safeText(value.assistantTurnIdentityProvenance, 'assistantTurnIdentityProvenance', 64);
  if (!AUTOPILOT_PROPOSAL_TICKET_IDENTITY_PROVENANCES.includes(assistantTurnIdentityProvenance)) {
    throw new Error('autopilot_proposal_ticket_assistantTurnIdentityProvenance_invalid');
  }
  const proposal = validateProposal(value.proposal);
  if (proposal.proposalId !== id) throw new Error('autopilot_proposal_ticket_proposal_mismatch');
  const contractHash = safeText(value.contractHash, 'contractHash', 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(contractHash) || proposalContractHash(proposal.contract) !== contractHash) throw new Error('autopilot_proposal_ticket_contract_hash_invalid');
  const createdAt = canonicalTimestamp(value.createdAt, 'createdAt');
  const expiresAt = canonicalTimestamp(value.expiresAt, 'expiresAt');
  const updatedAt = canonicalTimestamp(value.updatedAt, 'updatedAt');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error('autopilot_proposal_ticket_time_invalid');
  if (!AUTOPILOT_PROPOSAL_TICKET_STATES.includes(value.state)) throw new Error('autopilot_proposal_ticket_state_invalid');
  if (now !== null && !allowExpired && Date.parse(expiresAt) <= (now instanceof Date ? now.getTime() : Date.parse(now))) throw new Error('autopilot_proposal_ticket_expired');
  return {
    schemaVersion: AUTOPILOT_PROPOSAL_TICKET_SCHEMA_VERSION,
    proposalId: id,
    tabKey,
    tabId,
    vendorId,
    conversationUrl,
    assistantTurnId,
    assistantTurnIdentityProvenance,
    proposal,
    contractHash,
    createdAt,
    expiresAt,
    state: value.state,
    updatedAt,
  };
}

export function autopilotProposalTicketPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, AUTOPILOT_PROPOSAL_TICKET_FILE);
}

export async function createAutopilotProposalTicketStore({ stateDir = defaultStateDir(), now = () => new Date() } = {}) {
  await ensureStateDir(stateDir);
  let current = await readPersistedTicket(stateDir);
  const get = async () => current ? structuredClone(current) : null;
  return {
    get,
    async create(ticket) {
      const currentNow = now();
      const next = validateAutopilotProposalTicket(ticket, { now: currentNow, allowExpired: false });
      const unresolved = current && (
        (current.state === 'pending' && Date.parse(current.expiresAt) > currentNow.getTime())
        || current.state === 'acknowledged'
      );
      if (unresolved && current.proposalId !== next.proposalId) {
        throw new Error('autopilot_proposal_ticket_unresolved');
      }
      await atomicWriteFile(autopilotProposalTicketPath(stateDir), `${JSON.stringify(next, null, 2)}\n`);
      current = next;
      return await get();
    },
    async update({ proposalId: requestedProposalId, state } = {}) {
      if (!current || current.proposalId !== requestedProposalId) throw new Error('autopilot_proposal_ticket_not_found');
      if (!AUTOPILOT_PROPOSAL_TICKET_STATES.includes(state)) throw new Error('autopilot_proposal_ticket_state_invalid');
      const allowed = current.state === 'pending' ? ['pending', 'acknowledged'] : current.state === 'acknowledged' ? ['acknowledged', 'consumed'] : ['consumed'];
      if (!allowed.includes(state)) throw new Error('autopilot_proposal_ticket_transition_invalid');
      const next = validateAutopilotProposalTicket({ ...current, state, updatedAt: now().toISOString() }, { now: now(), allowExpired: true });
      await atomicWriteFile(autopilotProposalTicketPath(stateDir), `${JSON.stringify(next, null, 2)}\n`);
      current = next;
      return await get();
    },
  };
}

async function readPersistedTicket(stateDir) {
  try {
    const raw = await fs.readFile(autopilotProposalTicketPath(stateDir), 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > AUTOPILOT_PROPOSAL_TICKET_MAX_BYTES) throw new Error('autopilot_proposal_ticket_too_large');
    return validateAutopilotProposalTicket(JSON.parse(raw));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
