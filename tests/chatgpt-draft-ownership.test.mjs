import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canRecoverDraftLease,
  canSettlePostSendDraft,
  createDraftLease,
  createPostSendTombstone,
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
  const emptyPrompt = current({ promptDigest: textDigest(''), promptLength: 0, inputValuePresent: true });
  assert.equal(canRecoverDraftLease({ lease: attachmentLease, current: emptyPrompt, tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), true);
  assert.equal(canRecoverDraftLease({ lease: attachmentLease, current: { ...emptyPrompt, promptDigest: textDigest('user typed'), promptLength: 10 }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), false);
});

test('draft ownership: leases persist ownedPrompt and enforce prompt rules by ownership', () => {
  const attachmentLease = createDraftLease({ ...lease({ phase: 'attachments-owned', ownedPrompt: false }), phase: 'attachments-owned', ownedPrompt: false });
  const promptLease = createDraftLease({ ...lease({ phase: 'prompt-owned', ownedPrompt: true }), phase: 'prompt-owned', ownedPrompt: true });
  assert.equal(attachmentLease.ownedPrompt, false);
  assert.equal(promptLease.ownedPrompt, true);
  assert.equal(canRecoverDraftLease({ lease: attachmentLease, current: current({ promptDigest: textDigest(''), promptLength: 0 }), tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), true);
  assert.equal(canRecoverDraftLease({ lease: promptLease, current: current(), tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), true);
  assert.equal(canRecoverDraftLease({ lease: promptLease, current: current({ promptDigest: textDigest('changed') }), tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), false);
  assert.equal(canRecoverDraftLease({ lease: promptLease, current: current({ promptLength: 12 }), tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }), false);
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

test('draft ownership: restart preserves attachment-only prompt ownership for actual empty preflight digest', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ownership-empty-prompt-'));
  try {
    const beforeRestart = new DraftOwnershipStore({ stateDir, tabId: 'tab-1' });
    await beforeRestart.write(createDraftLease({
      operationId: 'operation-empty-prompt',
      tabId: 'tab-1',
      conversationDigest: textDigest('conversation-1'),
      userTurnBaseline: baseline,
      expectedAttachments,
      ownedPrompt: false,
      phase: 'cleanup-required'
    }));
    const afterRestart = new DraftOwnershipStore({ stateDir, tabId: 'tab-1' });
    const loaded = await afterRestart.read();
    assert.equal(loaded.ownedPrompt, false);
    assert.equal(loaded.promptDigest, '');
    assert.equal(loaded.promptLength, 0);
    assert.equal(canRecoverDraftLease({
      lease: loaded,
      current: current({ promptDigest: textDigest(''), promptLength: 0, inputValuePresent: true }),
      tabId: 'tab-1',
      conversationDigest: textDigest('conversation-1')
    }), true);
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

test('draft ownership: card aliases are one-to-one per expected attachment', () => {
  const one = [{ transportName: 'task-contract.json', logicalName: 'task-contract.json', size: 4, sha256: textDigest('one') }];
  assert.equal(hasOnlyOwnedAttachmentCards(one, ['task-contract.json']), true);
  assert.equal(hasOnlyOwnedAttachmentCards(one, ['task-contract(2).json']), true);
  assert.equal(hasOnlyOwnedAttachmentCards(one, ['task-contract.json', 'task-contract(2).json']), false);
  assert.equal(hasOnlyOwnedAttachmentCards(one, ['task-contract(2).json', 'task-contract(3).json']), false);

  const staged = [
    { transportName: 'task-contract.json', logicalName: 'task-contract.json', size: 4, sha256: textDigest('one') },
    { transportName: 'task-contract(1).json', logicalName: 'task-contract.json', size: 5, sha256: textDigest('two') }
  ];
  assert.equal(hasOnlyOwnedAttachmentCards(staged, ['task-contract(2).json', 'task-contract(1).json']), true);
  assert.equal(hasOnlyOwnedAttachmentCards(staged, ['task-contract(2).json', 'task-contract(3).json', 'task-contract(4).json']), false);
});

test('post-send settling requires the newly sent turn and accepts clean or exact owned residue', () => {
  const expected = [{ transportName: 'evidence.txt', logicalName: 'evidence.txt', size: 3, sha256: 'a'.repeat(64) }];
  const lease = createDraftLease({
    operationId: 'send-operation',
    tabId: 'tab-1',
    conversationDigest: textDigest('conversation-1'),
    userTurnBaseline: { count: 2, lastId: 'old', lastTextDigest: textDigest('old') },
    expectedAttachments: expected,
    ownedPrompt: true,
    ownedPromptDigest: textDigest('review prompt'),
    ownedPromptLength: 13,
    phase: 'send-confirmed',
    sendConfirmed: true
  });
  const base = {
    composerInputCount: 1,
    pageInputCount: 1,
    promptLength: 0,
    promptDigest: textDigest(''),
    inputValuePresent: false,
    userTurnBaseline: { count: 3, lastId: 'new', lastTextDigest: textDigest('review prompt') }
  };
  assert.equal(canSettlePostSendDraft({ lease, current: { ...base, selectedFiles: [], cardDisplayNames: [] }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }).clean, true);
  assert.equal(canSettlePostSendDraft({ lease, current: { ...base, selectedFiles: expected, cardDisplayNames: [] }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }).cleanupAllowed, true);
  assert.equal(canSettlePostSendDraft({ lease, current: { ...base, selectedFiles: expected, cardDisplayNames: ['evidence(1).txt'] }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }).cleanupAllowed, true);
  assert.equal(canSettlePostSendDraft({ lease, current: { ...base, selectedFiles: [{ ...expected[0], sha256: 'b'.repeat(64) }], cardDisplayNames: [] }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }).safe, false);
  assert.equal(canSettlePostSendDraft({ lease, current: { ...base, selectedFiles: expected, cardDisplayNames: ['foreign.txt'] }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }).safe, false);
  assert.equal(canSettlePostSendDraft({ lease, current: { ...base, userTurnBaseline: { ...base.userTurnBaseline, lastTextDigest: textDigest('other') } }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1') }).safe, false);
});

test('post-send tombstone preserves exact ownership across a clean-to-resurrection window', () => {
  const expected = [{ transportName: 'evidence.txt', logicalName: 'evidence.txt', size: 3, sha256: 'a'.repeat(64) }];
  const sentUserTurnProof = { count: 3, lastId: 'sent', lastTextDigest: textDigest('rendered attachment turn') };
  const tombstone = createPostSendTombstone({
    operationId: 'send-operation',
    tabId: 'tab-1',
    conversationDigest: textDigest('conversation-1'),
    sentUserTurnProof,
    expectedAttachments: expected,
    clearedAt: '2026-09-03T00:00:00.000Z',
    graceMs: 5_000
  });
  const postSendLease = createDraftLease({
    operationId: 'send-operation',
    tabId: 'tab-1',
    conversationDigest: textDigest('conversation-1'),
    userTurnBaseline: { count: 2, lastId: 'old', lastTextDigest: textDigest('old') },
    sentUserTurnProof,
    expectedAttachments: expected,
    ownedPrompt: true,
    ownedPromptDigest: textDigest('typed prompt'),
    ownedPromptLength: 12,
    phase: 'post-send-tombstone',
    sendConfirmed: true,
    postSendTombstone: tombstone,
    updatedAt: '2026-09-03T00:00:00.000Z'
  });
  const base = {
    composerInputCount: 1,
    pageInputCount: 1,
    promptLength: 0,
    promptDigest: textDigest(''),
    inputValuePresent: false,
    userTurnBaseline: sentUserTurnProof
  };
  assert.equal(canSettlePostSendDraft({ lease: postSendLease, current: { ...base, selectedFiles: [], cardDisplayNames: [] }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1'), now: Date.parse('2026-09-03T00:00:01.000Z') }).clean, true);
  assert.equal(canSettlePostSendDraft({ lease: postSendLease, current: { ...base, selectedFiles: expected, cardDisplayNames: ['evidence.txt'], inputValuePresent: true }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1'), now: Date.parse('2026-09-03T00:00:02.000Z') }).cleanupAllowed, true);
  assert.equal(canSettlePostSendDraft({ lease: postSendLease, current: { ...base, selectedFiles: [{ ...expected[0], sha256: 'b'.repeat(64) }], cardDisplayNames: ['evidence.txt'], inputValuePresent: true }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1'), now: Date.parse('2026-09-03T00:00:02.000Z') }).safe, false);
  assert.equal(canSettlePostSendDraft({ lease: postSendLease, current: { ...base, selectedFiles: expected, cardDisplayNames: ['foreign.txt'], inputValuePresent: true }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1'), now: Date.parse('2026-09-03T00:00:02.000Z') }).safe, false);
  assert.equal(canSettlePostSendDraft({ lease: postSendLease, current: { ...base, selectedFiles: expected, cardDisplayNames: ['evidence.txt'], inputValuePresent: true, userTurnBaseline: { ...sentUserTurnProof, count: 4 } }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1'), now: Date.parse('2026-09-03T00:00:02.000Z') }).safe, false);
  assert.equal(canSettlePostSendDraft({ lease: postSendLease, current: { ...base, selectedFiles: expected, cardDisplayNames: ['evidence.txt'], inputValuePresent: true }, tabId: 'other-tab', conversationDigest: textDigest('conversation-1'), now: Date.parse('2026-09-03T00:00:02.000Z') }).safe, false);
  assert.equal(canSettlePostSendDraft({ lease: postSendLease, current: { ...base, selectedFiles: [], cardDisplayNames: [] }, tabId: 'tab-1', conversationDigest: textDigest('conversation-1'), now: Date.parse('2026-09-03T00:00:06.000Z') }).safe, false);
});

test('post-send lease survives a runtime tab-id change when the logical conversation is proven', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-post-send-restart-'));
  try {
    const oldStore = new DraftOwnershipStore({ stateDir, tabId: 'old-runtime-tab' });
    const lease = createDraftLease({
      operationId: 'sent-operation',
      tabId: 'old-runtime-tab',
      conversationDigest: textDigest('conversation-1'),
      userTurnBaseline: { count: 1, lastId: 'old', lastTextDigest: textDigest('old') },
      expectedAttachments: [],
      ownedPrompt: true,
      ownedPromptDigest: textDigest('sent prompt'),
      ownedPromptLength: 11,
      phase: 'cleanup-required',
      sendConfirmed: true
    });
    await oldStore.write(lease);
    const restarted = new DraftOwnershipStore({ stateDir, tabId: 'new-runtime-tab' });
    const loaded = await restarted.read();
    assert.equal(restarted.wasFallbackRead, true);
    const proof = canSettlePostSendDraft({
      lease: loaded,
      current: { composerInputCount: 1, pageInputCount: 1, promptLength: 0, promptDigest: textDigest(''), selectedFiles: [], cardDisplayNames: [], inputValuePresent: false, userTurnBaseline: { count: 2, lastId: 'new', lastTextDigest: textDigest('sent prompt') } },
      tabId: 'new-runtime-tab',
      conversationDigest: textDigest('conversation-1'),
      allowRuntimeTabRebind: true
    });
    assert.equal(proof.safe, true);
    await restarted.clear();
    assert.equal(await oldStore.read(), null);
  } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
});
