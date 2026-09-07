import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAutopilotProposalApproval } from '../autopilot-approval.mjs';
import { proposalContractHash } from '../autopilot-proposal-ticket.mjs';

const contract = {
  schemaVersion: 1,
  id: 'task-123e4567-e89b-42d3-a456-426614174000',
  title: 'Ticket task',
  repository: null,
  agentify: { tabKey: 'autopilot-production' },
  implementation: { prompt: 'safe' },
  verification: [],
  review: { maxRounds: 1, timeoutMs: 1000 },
  delivery: { push: false },
  constraints: [],
};

const ticket = {
  schemaVersion: 2,
  proposalId: '123e4567-e89b-42d3-a456-426614174000',
  taskId: contract.id,
  tabKey: 'autopilot-production',
  tabId: 'tab-1',
  vendorId: 'chatgpt',
  conversationUrl: 'https://chatgpt.com/c/ticket-approval',
  assistantTurnId: 'assistant-anchor',
  assistantTurnIdentityProvenance: 'provider-message-id',
  approvalCode: 'AB12CD34',
  contract,
  contractHash: proposalContractHash(contract),
  createdAt: '2026-08-10T00:00:00.000Z',
  expiresAt: '2026-08-10T23:59:59.999Z',
  state: 'pending',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

function fixture(turns, overrides = {}) {
  let reads = 0;
  const controller = {
    async getUrl() { return ticket.conversationUrl; },
    async readConversationTurns() { reads += 1; return { url: ticket.conversationUrl, tabId: ticket.tabId, turns, history: { mode: 'tail', scopeComplete: true, fullHistoryComplete: false, tailProven: true, scrollRestored: true } }; },
  };
  const result = { ticket: { ...ticket, ...overrides }, tabs: { listTabs: () => [{ key: ticket.tabKey, id: ticket.tabId, vendorId: ticket.vendorId }], getControllerById: () => controller } };
  return { ...result, get reads() { return reads; } };
}

function anchor() {
  return { id: ticket.assistantTurnId, index: 1, role: 'assistant', identityProvenance: ticket.assistantTurnIdentityProvenance, text: 'proposal marker noise is irrelevant' };
}

function user(id, text, source = 'user') { return { id, index: 2, role: 'user', source, text }; }

async function resolve(turns, overrides = {}) {
  const state = fixture(turns, overrides);
  const result = await resolveAutopilotProposalApproval({ ticketStore: { get: async () => state.ticket }, tabs: state.tabs, proposalId: ticket.proposalId, now: new Date('2026-08-10T01:00:00.000Z') });
  return { result, reads: state.reads };
}

test('approval before anchor and wrong approval remain pending', async () => {
  const before = await resolve([user('before', '開始して AB12CD34'), anchor(), user('wrong', '開始して DEADBEEF')]);
  assert.equal(before.result.status, 'pending');
  assert.equal(before.result.reason, 'approval_missing');
});

test('exact user-authored approval after the stored anchor is approved', async () => {
  const result = await resolve([anchor(), user('approval', ' \r\n開始して AB12CD34\r\n ')]);
  assert.equal(result.result.status, 'approved');
  assert.equal(result.result.approvalTurnId, 'approval');
});

test('assistant and proposal-generation approval-like text is ignored', async () => {
  const result = await resolve([anchor(), { id: 'assistant-approval', index: 2, role: 'assistant', source: 'assistant', text: '開始して AB12CD34' }, user('generated', '開始して AB12CD34', 'proposal-generation')]);
  assert.equal(result.result.status, 'pending');
});

test('malformed proposal marker noise is never parsed by approval resolution', async () => {
  const result = await resolve([anchor(), user('noise', 'AUTOPILOT_PROPOSAL_BEGIN_V1{not json}AUTOPILOT_PROPOSAL_END_V1'), user('approval', '開始して AB12CD34')]);
  assert.equal(result.result.status, 'approved');
});

test('missing anchor, changed URL, and ambiguous tabs fail closed', async () => {
  await assert.rejects(() => resolve([user('approval', '開始して AB12CD34')]), /autopilot_approval_anchor_missing/u);
  const state = fixture([anchor(), user('approval', '開始して AB12CD34')]);
  state.tabs = { ...state.tabs, getControllerById: () => ({ getUrl: async () => 'https://chatgpt.com/c/other', readConversationTurns: async () => { throw new Error('must not read'); } }) };
  await assert.rejects(() => resolveAutopilotProposalApproval({ ticketStore: { get: async () => state.ticket }, tabs: state.tabs, proposalId: ticket.proposalId, now: new Date('2026-08-10T01:00:00.000Z') }), /autopilot_approval_conversation_changed/u);
  state.tabs = { ...state.tabs, listTabs: () => [{ key: ticket.tabKey, id: ticket.tabId, vendorId: ticket.vendorId }, { key: ticket.tabKey, id: 'tab-2', vendorId: ticket.vendorId }] };
  await assert.rejects(() => resolveAutopilotProposalApproval({ ticketStore: { get: async () => state.ticket }, tabs: state.tabs, proposalId: ticket.proposalId, now: new Date('2026-08-10T01:00:00.000Z') }), /autopilot_approval_tab_ambiguous/u);
});

test('non-pending tickets do not read conversation', async () => {
  const result = await resolve([], { state: 'acknowledged' });
  assert.equal(result.result.status, 'approved');
  assert.equal(result.reads, 0);
});
