import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from './state.mjs';

export const DRAFT_OWNERSHIP_SCHEMA_VERSION = 1;
export const DRAFT_OWNERSHIP_TTL_MS = 24 * 60 * 60 * 1000;

const OWNERSHIP_PHASES = new Set([
  'prepared',
  'attachments-owned',
  'prompt-owned',
  'dispatch-started',
  'send-confirmed',
  'cleanup-required',
  'cleared'
]);

function digest(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function normalizedBaseline(value) {
  const baseline = value && typeof value === 'object' ? value : {};
  return {
    count: Math.max(0, Number(baseline.count) || 0),
    lastId: String(baseline.lastId || '').slice(0, 256),
    lastTextDigest: /^[0-9a-f]{64}$/u.test(String(baseline.lastTextDigest || '').toLowerCase())
      ? String(baseline.lastTextDigest).toLowerCase()
      : ''
  };
}

function normalizedAttachment(value) {
  const attachment = value && typeof value === 'object' ? value : {};
  const transportName = attachment.transportName || attachment.name;
  const sha256 = String(attachment.sha256 || '').toLowerCase();
  return {
    transportName: path.basename(String(transportName || '')).slice(0, 256),
    logicalName: path.basename(String(attachment.logicalName || transportName || '')).slice(0, 256),
    size: Number.isSafeInteger(Number(attachment.size)) && Number(attachment.size) >= 0 ? Number(attachment.size) : -1,
    sha256: /^[0-9a-f]{64}$/u.test(sha256) ? sha256 : ''
  };
}

export function attachmentIdentityKey(value) {
  const attachment = normalizedAttachment(value);
  return `${attachment.transportName.toLocaleLowerCase()}\u0000${attachment.size}\u0000${attachment.sha256}`;
}

export function sameAttachmentIdentitySet(expected, actual) {
  const left = (Array.isArray(expected) ? expected : []).map(attachmentIdentityKey).sort();
  const right = (Array.isArray(actual) ? actual : []).map(attachmentIdentityKey).sort();
  return left.length > 0 && left.length === right.length && left.every((item, index) => item === right[index]);
}

function isCardAlias(sourceName, cardName) {
  const source = path.basename(String(sourceName || '')).trim();
  const card = path.basename(String(cardName || '')).trim();
  if (!source || !card) return false;
  if (source.toLocaleLowerCase() === card.toLocaleLowerCase()) return true;
  const dot = source.lastIndexOf('.');
  const stem = dot <= 0 ? source : source.slice(0, dot);
  const extension = dot <= 0 ? '' : source.slice(dot);
  const escaped = stem.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  const suffix = extension.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  const match = new RegExp(`^${escaped}\\(([0-9]+(?:-[0-9]+)*)\\)${suffix}$`, 'i').exec(card);
  return !!match && match[1].split('-').some((part) => (part.replace(/^0+/u, '') || '0') !== '0');
}

export function hasOnlyOwnedAttachmentCards(expectedAttachments, cardDisplayNames) {
  const expected = (Array.isArray(expectedAttachments) ? expectedAttachments : []).map((item) => ({
    aliases: [item?.transportName, item?.logicalName]
      .map((name) => path.basename(String(name || '')).trim())
      .filter(Boolean)
  }));
  const used = new Set();
  for (const cardName of Array.isArray(cardDisplayNames) ? cardDisplayNames : []) {
    const index = expected.findIndex((item, candidateIndex) => !used.has(candidateIndex) && item.aliases.some((name) => isCardAlias(name, cardName)));
    if (index < 0) return false;
    used.add(index);
  }
  return true;
}

export function canRecoverDraftLease({ lease, current, tabId, conversationDigest, activeOperationId, now = Date.now() } = {}) {
  if (!lease || lease.schemaVersion !== DRAFT_OWNERSHIP_SCHEMA_VERSION) return false;
  if (!tabId || lease.tabId !== tabId || !conversationDigest || lease.conversationDigest !== conversationDigest) return false;
  if (!lease.operationId || lease.operationId === activeOperationId) return false;
  if (lease.sendConfirmed === true || ['dispatch-started', 'send-confirmed', 'cleared'].includes(lease.phase)) return false;
  if (!OWNERSHIP_PHASES.has(lease.phase) || !['attachments-owned', 'prompt-owned', 'cleanup-required'].includes(lease.phase)) return false;
  const updatedAt = Date.parse(lease.updatedAt || '');
  if (!Number.isFinite(updatedAt) || now - updatedAt > DRAFT_OWNERSHIP_TTL_MS) return false;
  if (!current || current.composerInputCount !== 1 || current.pageInputCount !== 1) return false;
  if (lease.ownedPrompt === true) {
    if (current.promptDigest !== lease.promptDigest || current.promptLength !== lease.promptLength) return false;
  } else if (lease.ownedPrompt === false) {
    if (current.promptLength !== 0) return false;
  } else {
    return false;
  }
  if (!sameBaseline(lease.userTurnBaseline, current.userTurnBaseline)) return false;
  const expected = Array.isArray(lease.expectedAttachments) ? lease.expectedAttachments : [];
  const selected = Array.isArray(current.selectedFiles) ? current.selectedFiles : [];
  if (expected.length > 0) {
    if (!sameAttachmentIdentitySet(expected, selected)) return false;
    if (!hasOnlyOwnedAttachmentCards(expected, current.cardDisplayNames)) return false;
  } else if (selected.length > 0 || (current.cardDisplayNames || []).length > 0 || current.inputValuePresent === true) {
    return false;
  }
  return true;
}

export function sameBaseline(left, right) {
  const a = normalizedBaseline(left);
  const b = normalizedBaseline(right);
  return a.count === b.count && a.lastId === b.lastId && a.lastTextDigest === b.lastTextDigest;
}

export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = (await import('node:fs')).createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

export async function describeAttachmentFiles(files, logicalFileNames = files) {
  const paths = Array.isArray(files) ? files : [];
  const logical = Array.isArray(logicalFileNames) ? logicalFileNames : [];
  return await Promise.all(paths.map(async (filePath, index) => {
    const stat = await fs.stat(filePath);
    return normalizedAttachment({
      transportName: path.basename(filePath),
      logicalName: logical[index] || path.basename(filePath),
      size: stat.size,
      sha256: await sha256File(filePath)
    });
  }));
}

export class DraftOwnershipStore {
  constructor({ stateDir, tabId }) {
    this.stateDir = stateDir ? path.resolve(stateDir) : null;
    this.tabId = String(tabId || '').trim();
    this.filePath = this.stateDir && this.tabId
      ? path.join(this.stateDir, `chatgpt-draft-ownership-${digest(this.tabId).slice(0, 32)}.json`)
      : null;
  }

  get enabled() {
    return !!this.filePath;
  }

  async read() {
    if (!this.filePath) return null;
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return value && typeof value === 'object' ? value : null;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      return null;
    }
  }

  async write(value) {
    if (!this.filePath) return;
    await fs.mkdir(this.stateDir, { recursive: true });
    await atomicWriteFile(this.filePath, `${JSON.stringify(value)}\n`);
  }

  async clear() {
    if (!this.filePath) return;
    try { await fs.rm(this.filePath, { force: true }); } catch {}
  }
}

export function createDraftLease({ operationId, tabId, conversationDigest, userTurnBaseline, expectedAttachments = [], promptDigest = '', promptLength = 0, ownedPrompt = false, ownedPromptDigest = promptDigest, ownedPromptLength = promptLength, phase = 'prepared', sendConfirmed = false, updatedAt = new Date().toISOString() }) {
  const promptIsOwned = ownedPrompt === true && phase !== 'prepared' && phase !== 'attachments-owned';
  return {
    schemaVersion: DRAFT_OWNERSHIP_SCHEMA_VERSION,
    operationId: String(operationId || ''),
    tabId: String(tabId || ''),
    conversationDigest: String(conversationDigest || ''),
    userTurnBaseline: normalizedBaseline(userTurnBaseline),
    expectedAttachments: (Array.isArray(expectedAttachments) ? expectedAttachments : []).map(normalizedAttachment),
    ownedPrompt: promptIsOwned,
    promptDigest: promptIsOwned ? String(ownedPromptDigest || '') : '',
    promptLength: promptIsOwned ? Math.max(0, Number(ownedPromptLength) || 0) : 0,
    phase: OWNERSHIP_PHASES.has(phase) ? phase : 'prepared',
    sendConfirmed: sendConfirmed === true,
    updatedAt: new Date(updatedAt).toISOString()
  };
}

export function textDigest(value) {
  return digest(value);
}
