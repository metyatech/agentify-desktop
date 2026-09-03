import assert from 'node:assert/strict';
import test from 'node:test';

import { startHttpApi } from '../http-api.mjs';
import { proposalContractHash } from '../autopilot-proposal-ticket.mjs';

const ticket = {
  schemaVersion: 1,
  proposalId: '123e4567-e89b-42d3-a456-426614174000',
  tabKey: 'autopilot-production',
  tabId: 'tab-1',
  vendorId: 'chatgpt',
  conversationUrl: 'https://chatgpt.com/c/ticket-api',
  assistantTurnId: 'assistant-1',
  assistantTurnIdentityProvenance: 'provider-message-id',
  proposal: {
    schemaVersion: 1,
    proposalId: '123e4567-e89b-42d3-a456-426614174000',
    createdAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-10T23:59:59.999Z',
    tabKey: 'autopilot-production',
    approvalCode: 'AB12CD34',
    contract: { schemaVersion: 1, id: 'api-task', title: 'API task', repository: null, agentify: { tabKey: 'autopilot-production' }, implementation: { prompt: 'safe' }, verification: [], review: { maxRounds: 1, timeoutMs: 1000 }, delivery: { push: false }, constraints: [] }
  },
  contractHash: '4'.repeat(64),
  createdAt: '2026-08-10T00:00:00.000Z',
  expiresAt: '2026-08-10T23:59:59.999Z',
  state: 'pending',
  updatedAt: '2026-08-10T00:00:00.000Z'
};
ticket.contractHash = proposalContractHash(ticket.proposal.contract);

test('proposal ticket API is authenticated, bounded, and exposes lifecycle updates', async (t) => {
  let current = { ...ticket };
  const server = await startHttpApi({
    port: 0,
    token: 'secret',
    stateDir: 'D:/state',
    tabs: { listTabs: () => [], getControllerById: () => ({}) },
    defaultTabId: null,
    getAutopilotProposalTicket: async () => current,
    onAutopilotProposalTicket: async ({ proposalId, state }) => { assert.equal(proposalId, ticket.proposalId); current = { ...current, state, updatedAt: '2026-08-10T01:00:00.000Z' }; return current; }
  });
  t.after(() => server.close());
  const port = server.address().port;
  const unauthorized = await fetch(`http://127.0.0.1:${port}/autopilot/proposal-ticket`);
  assert.equal(unauthorized.status, 401);
  const response = await fetch(`http://127.0.0.1:${port}/autopilot/proposal-ticket`, { headers: { Authorization: 'Bearer secret' } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).ticket, ticket);
  const update = await fetch(`http://127.0.0.1:${port}/autopilot/proposal-ticket`, { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ proposalId: ticket.proposalId, state: 'acknowledged' }) });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).ticket.state, 'acknowledged');
});
