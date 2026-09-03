import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTOPILOT_PROPOSAL_TICKET_FILE,
  autopilotProposalTicketPath,
  createAutopilotProposalTicketStore,
  proposalContractHash,
  validateAutopilotProposalTicket,
} from '../autopilot-proposal-ticket.mjs';

const proposal = {
  schemaVersion: 1,
  proposalId: '123e4567-e89b-42d3-a456-426614174000',
  createdAt: '2026-08-10T00:00:00.000Z',
  expiresAt: '2026-08-10T23:59:59.999Z',
  tabKey: 'autopilot-production',
  approvalCode: 'AB12CD34',
  contract: {
    schemaVersion: 1,
    id: 'ticket-task',
    title: 'Ticket task',
    repository: null,
    agentify: { tabKey: 'autopilot-production' },
    implementation: { prompt: 'Do the safe thing.' },
    verification: [],
    review: { maxRounds: 1, timeoutMs: 1000 },
    delivery: { push: false },
    constraints: [],
  },
};

function ticket(overrides = {}) {
  return {
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    tabKey: 'autopilot-production',
    tabId: 'tab-1',
    vendorId: 'chatgpt',
    conversationUrl: 'https://chatgpt.com/c/ticket',
    assistantTurnId: 'assistant-1',
    assistantTurnIdentityProvenance: 'provider-message-id',
    proposal,
    contractHash: proposalContractHash(proposal.contract),
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    state: 'pending',
    updatedAt: proposal.createdAt,
    ...overrides,
  };
}

const replacementProposal = {
  ...proposal,
  proposalId: '423e4567-e89b-42d3-a456-426614174000',
  createdAt: '2026-08-11T00:00:00.000Z',
  expiresAt: '2026-08-11T23:59:59.999Z',
};

function replacementTicket(overrides = {}) {
  return ticket({
    proposalId: replacementProposal.proposalId,
    assistantTurnId: 'assistant-2',
    proposal: replacementProposal,
    contractHash: proposalContractHash(replacementProposal.contract),
    createdAt: replacementProposal.createdAt,
    expiresAt: replacementProposal.expiresAt,
    ...overrides,
  });
}

test('proposal ticket persists the exact validated proposal atomically and survives store recreation', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ticket-'));
  const store = await createAutopilotProposalTicketStore({ stateDir, now: () => new Date('2026-08-10T01:00:00.000Z') });
  const saved = await store.create(ticket());
  assert.deepEqual(saved, ticket());
  assert.equal((await store.get()).proposal.contract.implementation.prompt, proposal.contract.implementation.prompt);
  assert.equal(path.basename(autopilotProposalTicketPath(stateDir)), AUTOPILOT_PROPOSAL_TICKET_FILE);
  const restored = await createAutopilotProposalTicketStore({ stateDir, now: () => new Date('2026-08-10T01:00:00.000Z') });
  assert.deepEqual(await restored.get(), saved);
  await fs.rm(stateDir, { recursive: true, force: false });
});

test('clarification or invalid proposal cannot be represented as a ticket', () => {
  assert.throws(() => validateAutopilotProposalTicket(ticket({ proposal: null })), /proposal_invalid/u);
  assert.throws(() => validateAutopilotProposalTicket(ticket({ contractHash: '0'.repeat(64) })), /contract_hash_invalid/u);
});

test('unresolved ticket blocks a second proposal and lifecycle acknowledgement is monotonic', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ticket-'));
  const store = await createAutopilotProposalTicketStore({ stateDir, now: () => new Date('2026-08-10T01:00:00.000Z') });
  await store.create(ticket());
  await assert.rejects(() => store.create(ticket({ proposalId: '423e4567-e89b-42d3-a456-426614174000', proposal: { ...proposal, proposalId: '423e4567-e89b-42d3-a456-426614174000' } })), /unresolved/u);
  assert.equal((await store.update({ proposalId: proposal.proposalId, state: 'acknowledged' })).state, 'acknowledged');
  assert.equal((await store.update({ proposalId: proposal.proposalId, state: 'consumed' })).state, 'consumed');
  await assert.rejects(() => store.update({ proposalId: proposal.proposalId, state: 'pending' }), /transition_invalid/u);
  await fs.rm(stateDir, { recursive: true, force: false });
});

test('ticket lifecycle replaces only expired pending tickets and never expired acknowledged tickets', async () => {
  let currentNow = new Date('2026-08-10T01:00:00.000Z');
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ticket-lifecycle-'));
  const store = await createAutopilotProposalTicketStore({ stateDir, now: () => currentNow });
  await store.create(ticket());
  await assert.rejects(() => store.create(replacementTicket()), /unresolved/u);
  currentNow = new Date('2026-08-11T00:00:00.000Z');
  const replaced = await store.create(replacementTicket());
  assert.equal(replaced.proposalId, replacementProposal.proposalId);
  await store.update({ proposalId: replacementProposal.proposalId, state: 'acknowledged' });
  currentNow = new Date('2026-08-12T00:00:00.000Z');
  const laterProposal = { ...replacementProposal, proposalId: '523e4567-e89b-42d3-a456-426614174000', createdAt: '2026-08-12T00:00:00.000Z', expiresAt: '2026-08-12T23:59:59.999Z' };
  await assert.rejects(() => store.create(replacementTicket({ proposalId: laterProposal.proposalId, proposal: laterProposal, assistantTurnId: 'assistant-3', createdAt: laterProposal.createdAt, expiresAt: laterProposal.expiresAt, contractHash: proposalContractHash(laterProposal.contract) })), /unresolved/u);
  await assert.rejects(() => store.update({ proposalId: replacementProposal.proposalId, state: 'pending' }), /transition_invalid/u);
  assert.equal((await store.update({ proposalId: replacementProposal.proposalId, state: 'consumed' })).state, 'consumed');
  const consumedReplacement = await store.create(replacementTicket({ proposalId: laterProposal.proposalId, proposal: laterProposal, assistantTurnId: 'assistant-3', createdAt: laterProposal.createdAt, expiresAt: laterProposal.expiresAt, contractHash: proposalContractHash(laterProposal.contract) }));
  assert.equal(consumedReplacement.proposalId, laterProposal.proposalId);
  await fs.rm(stateDir, { recursive: true, force: false });
});
