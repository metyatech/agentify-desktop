import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAutopilotProposalApproval } from '../autopilot-approval.mjs';
import { startHttpApi } from '../http-api.mjs';
import { createAutopilotProposalTicketStore, proposalContractHash } from '../autopilot-proposal-ticket.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

test('duplicate exact approvals are idempotent and keep the first approval identity', async () => {
  const result = await resolve([anchor(), user('approval-1', '開始して AB12CD34'), user('approval-2', '開始して AB12CD34')]);
  assert.equal(result.result.status, 'approved');
  assert.equal(result.result.approvalTurnId, 'approval-1');
});

test('twenty duplicate exact approvals remain one deterministic authorization', async () => {
  const turns = [anchor(), ...Array.from({ length: 20 }, (_, index) => user(`approval-${index + 1}`, '開始して AB12CD34'))];
  const result = await resolve(turns);
  assert.equal(result.result.status, 'approved');
  assert.equal(result.result.approvalTurnId, 'approval-1');
});

test('metadata explicitly marked non-user-authored cannot approve', async () => {
  const result = await resolve([anchor(), { ...user('generated', '開始して AB12CD34'), userAuthored: false }]);
  assert.equal(result.result.status, 'pending');
  const alternate = await resolve([anchor(), { ...user('generated-2', '開始して AB12CD34'), isUserAuthored: false }]);
  assert.equal(alternate.result.status, 'pending');
});

test('assistant and proposal-generation approval-like text is ignored', async () => {
  const result = await resolve([anchor(), { id: 'assistant-approval', index: 2, role: 'assistant', source: 'assistant', text: '開始して AB12CD34' }, user('generated', '開始して AB12CD34', 'proposal-generation')]);
  assert.equal(result.result.status, 'pending');
});

test('agentify-sourced approval-like user turns are not approval authority', async () => {
  const result = await resolve([anchor(), user('agentify-approval', '開始して AB12CD34', 'agentify')]);
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

test('real V2 ticket store, approval resolver, and HTTP API complete 100 isolated cycles', async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ticket-100-cycle-'));
  const store = await createAutopilotProposalTicketStore({ stateDir, now: () => new Date('2026-08-10T01:00:00.000Z') });
  let current = null;
  const tabs = {
    listTabs: () => current ? [{ key: current.tabKey, id: current.tabId, vendorId: 'chatgpt' }] : [],
    getControllerById: () => ({
      getUrl: async () => current.conversationUrl,
      readConversationTurns: async () => ({
        url: current.conversationUrl,
        tabId: current.tabId,
        turns: current.turns,
        history: { mode: 'tail', scopeComplete: true, fullHistoryComplete: false, tailProven: true, scrollRestored: true },
      }),
    }),
  };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    stateDir,
    tabs,
    defaultTabId: null,
    getAutopilotProposalTickets: async ({ tabKey }) => (await store.listUnresolved()).filter((ticket) => ticket.tabKey === tabKey),
    resolveAutopilotProposalApproval: async ({ proposalId }) => await resolveAutopilotProposalApproval({ ticketStore: store, tabs, proposalId, now: new Date('2026-08-10T01:00:00.000Z') }),
    onAutopilotProposalTicket: async ({ proposalId, state }) => await store.update({ proposalId, state }),
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(stateDir, { recursive: true, force: false });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let approved = 0;
  for (let index = 1; index <= 100; index += 1) {
    const proposalId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const tabId = `tab-${index}`;
    const conversationUrl = `https://chatgpt.com/c/ticket-cycle-${index}`;
    const approvalCode = index.toString(16).padStart(8, '0').toUpperCase();
    const contract = {
      schemaVersion: 1,
      id: `task-${proposalId}`,
      title: 'Cycle task',
      repository: null,
      agentify: { tabKey: 'autopilot-production' },
      implementation: { prompt: 'safe' },
      verification: [],
      review: { maxRounds: 1, timeoutMs: 1000 },
      delivery: { push: false },
      constraints: [],
    };
    current = {
      proposalId,
      tabKey: 'autopilot-production',
      tabId,
      conversationUrl,
      turns: [
        { id: `anchor-${index}`, index: 1, role: 'assistant', identityProvenance: 'provider-message-id', text: 'validated proposal anchor' },
        { id: `noise-${index}`, index: 2, role: 'user', source: 'user', text: 'AUTOPILOT_PROPOSAL_BEGIN_V1{bad json AUTOPILOT_PROPOSAL_END_V1' },
        { id: `approval-${index}-1`, index: 3, role: 'user', source: 'user', text: `開始して ${approvalCode}` },
        ...(index % 10 === 0 ? [{ id: `approval-${index}-2`, index: 4, role: 'user', source: 'user', text: `開始して ${approvalCode}` }] : []),
      ],
    };
    const ticketValue = {
      schemaVersion: 2,
      proposalId,
      taskId: contract.id,
      tabKey: current.tabKey,
      tabId,
      vendorId: 'chatgpt',
      conversationUrl,
      assistantTurnId: `anchor-${index}`,
      assistantTurnIdentityProvenance: 'provider-message-id',
      approvalCode,
      contract,
      contractHash: proposalContractHash(contract),
      createdAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T23:59:59.999Z',
    };
    await store.create(ticketValue);
    const listed = await fetch(`${base}/autopilot/proposal-tickets?tabKey=${encodeURIComponent(current.tabKey)}`, { headers: { Authorization: 'Bearer secret' } });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).tickets.length, 1);
    const approval = await fetch(`${base}/autopilot/proposal-ticket/approval?proposalId=${proposalId}`, { headers: { Authorization: 'Bearer secret' } });
    assert.equal(approval.status, 200);
    const approvalBody = await approval.json();
    assert.equal(approvalBody.status, 'approved');
    assert.equal(approvalBody.approvalTurnId, `approval-${index}-1`);
    approved += 1;
    for (const state of ['acknowledged', 'consumed']) {
      const updated = await fetch(`${base}/autopilot/proposal-ticket`, {
        method: 'POST',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId, state }),
      });
      assert.equal(updated.status, 200);
    }
  }
  assert.equal(approved, 100);
  assert.equal((await store.listUnresolved()).length, 0);
});
