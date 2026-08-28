import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canRecoverDraftLease,
  createDraftLease,
  DraftOwnershipStore,
  hasOnlyOwnedAttachmentCards,
  sameAttachmentIdentitySet,
  textDigest
} from '../chatgpt-draft-ownership.mjs';

const baseline = { count: 3, lastId: 'turn-3', lastTextDigest: textDigest('last user turn') };
const expectedAttachments = [
  { transportName: 'task-contract.json', logicalName: 'task-contract.json', size: 4, sha256: textDigest('json') },
  { transportName: 'repository-state.json', logicalName: 'repository-state.json', size: 5, sha256: textDigest('state') }
];

function lease(overrides = {}) {
  return createDraftLease({
    operationId: 'operation-1',
    tabId: 'tab-1',
    conversationDigest: textDigest('conversation-1'),
    userTurnBaseline: baseline,
    expectedAttachments,
    promptDigest: textDigest('review prompt'),
    promptLength: 13,
    ownedPrompt: true,
    ownedPromptDigest: textDigest('review prompt'),
    ownedPromptLength: 13,
    phase: 'cleanup-required',
    updatedAt: new Date().toISOString(),
    ...overrides
  });
}

function current(overrides = {}) {
  return {
    inputValuePresent: false,
    composerInputCount: 1,
    pageInputCount: 1,
    promptDigest: textDigest('review prompt'),
    promptLength: 13,
    userTurnBaseline: baseline,
    selectedFiles: expectedAttachments,
    cardDisplayNames: ['task-contract.json', 'repository-state.json'],
    ...overrides
  };
}

test('draft ownership: no lease blocks an unknown user attachment', () => {
  assert.equal(canRecoverDraftLease({ lease: null, current: current(), tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), false);
});

test('draft ownership: same filename without matching lease is never enough', () => {
  assert.equal(canRecoverDraftLease({ lease: null, current: current(), tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), false);
  assert.equal(hasOnlyOwnedAttachmentCards([], ['task-contract.json']), false);
});

test('draft ownership: exact bytes and metadata are required', () => {
  assert.equal(sameAttachmentIdentitySet(expectedAttachments, current().selectedFiles), true);
  assert.equal(sameAttachmentIdentitySet(expectedAttachments, [{ ...expectedAttachments[0], sha256: textDigest('different') }, expectedAttachments[1]]), false);
  assert.equal(canRecoverDraftLease({ lease: lease(), current: current({ selectedFiles: [{ ...expectedAttachments[0], size: 999 }, expectedAttachments[1]] }), tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), false);
});

test('draft ownership: browser preflight name shape normalizes to transport identity', () => {
  assert.equal(sameAttachmentIdentitySet(expectedAttachments, expectedAttachments.map(({ transportName, size, sha256 }) => ({ name: transportName, size, sha256 }))), true);
});

test('draft ownership: prepared lease never claims ownership of a matching-looking draft', () => {
  assert.equal(canRecoverDraftLease({ lease: lease({ phase: 'prepared', ownedPrompt: false }), current: current(), tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), false);
});

test('draft ownership: attachment-owned lease accepts empty prompt and normal file input value', () => {
  const attachmentLease = lease({ phase: 'attachments-owned', promptDigest: '', promptLength: 0, ownedPrompt: false });
  const emptyPrompt = current({ promptDigest: '', promptLength: 0, inputValuePresent: true });
  assert.equal(canRecoverDraftLease({ lease: attachmentLease, current: emptyPrompt, tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), true);
  assert.equal(canRecoverDraftLease({ lease: attachmentLease, current: { ...emptyPrompt, promptDigest: textDigest('user typed') }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), false);
});

test('draft ownership: same tab and conversation recover an owned partial card set', () => {
  assert.equal(canRecoverDraftLease({
    lease: lease(),
    current: current({ cardDisplayNames: ['task-contract.json'] }),
    tabId: 'tab-1',
    conversationDigest: textDigest('conversation-1')
  }), true);
});

test('draft ownership: restart can reload the bounded lease', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ownership-test-'));
  try {
    const first = new DraftOwnershipStore({ stateDir, tabId: 'tab-1' });
    await first.write(lease());
    const afterRestart = new DraftOwnershipStore({ stateDir, tabId: 'tab-1' });
    const loaded = await afterRestart.read();
    assert.equal(loaded.operationId, 'operation-1');
    assert.equal(JSON.stringify(loaded).includes('review prompt'), false);
    assert.equal(JSON.stringify(loaded).includes('C:\\'), false);
    assert.equal(canRecoverDraftLease({ lease: loaded, current: current(), tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), true);
    await afterRestart.clear();
    assert.equal(await afterRestart.read(), null);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test('draft ownership: conversation or tab changes block cleanup', () => {
  assert.equal(canRecoverDraftLease({ lease: lease(), current: current(), tabId: 'tab-2', conversationDigest: textDigest('conversation-1') }), false);
  assert.equal(canRecoverDraftLease({ lease: lease(), current: current(), tabId: 'tab-1', conversationDigest: textDigest('conversation-2') }), false);
});

test('draft ownership: user turn changes block cleanup', () => {
  assert.equal(canRecoverDraftLease({
    lease: lease(),
    current: current({ userTurnBaseline: { ...baseline, count: 4 } }),
    tabId: 'tab-1',
    conversationDigest: textDigest('conversation-1')
  }), false);
});

test('draft ownership: unexpected extra attachment or card blocks cleanup', () => {
  assert.equal(canRecoverDraftLease({
    lease: lease(),
    current: current({ selectedFiles: [...expectedAttachments, { transportName: 'unknown.txt', logicalName: 'unknown.txt', size: 1, sha256: textDigest('x') }] }),
    tabId: 'tab-1',
    conversationDigest: textDigest('conversation-1')
  }), false);
  assert.equal(hasOnlyOwnedAttachmentCards(expectedAttachments, ['task-contract.json', 'unknown.txt']), false);
});

test('draft ownership: prompt changes block cleanup', () => {
  assert.equal(canRecoverDraftLease({ lease: lease(), current: current({ promptDigest: textDigest('user changed') }), tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), false);
});

test('draft ownership: send-confirmed and dispatch-started leases are not recoverable', () => {
  assert.equal(canRecoverDraftLease({ lease: lease({ phase: 'send-confirmed', sendConfirmed: true }), current: current(), tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), false);
  assert.equal(canRecoverDraftLease({ lease: lease({ phase: 'dispatch-started' }), current: current(), tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), false);
});

test('draft ownership: expired leases fail closed', () => {
  assert.equal(canRecoverDraftLease({ lease: lease({ updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }), current: current(), tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), false);
});

test('draft ownership: production-like nine-file evidence is one exact owned set', () => {
  const names = ['task-contract.json', 'repository-state.json', 'repository-diff.txt', 'changed-files.json', 'binary-files.json', 'commits.txt', 'verification.json', 'execution-log.json', 'execution-summary.txt'];
  const attachments = names.map((name, index) => ({ transportName: name, logicalName: name, size: index, sha256: textDigest(`${name}-${index}`) }));
  assert.equal(sameAttachmentIdentitySet(attachments, attachments.map((item) => ({ ...item }))), true);
  assert.equal(hasOnlyOwnedAttachmentCards(attachments, ['task-contract(20260828-053945).json', 'repository-state(20260828-053946).json']), true);
  assert.equal(hasOnlyOwnedAttachmentCards(attachments, ['task-contract.json', 'unrelated.json']), false);
});
