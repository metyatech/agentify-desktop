import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTOPILOT_PROPOSAL_TICKET_FILE,
  AUTOPILOT_PROPOSAL_TICKETS_DIR,
  autopilotProposalTicketDir,
  autopilotProposalTicketPath,
  autopilotProposalTicketJsonPath,
  autopilotProposalTicketStatePath,
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
    schemaVersion: 2,
    proposalId: proposal.proposalId,
    taskId: proposal.contract.id,
    tabKey: 'autopilot-production',
    tabId: 'tab-1',
    vendorId: 'chatgpt',
    conversationUrl: 'https://chatgpt.com/c/ticket',
    assistantTurnId: 'assistant-1',
    assistantTurnIdentityProvenance: 'provider-message-id',
    proposal,
    approvalCode: proposal.approvalCode,
    contract: proposal.contract,
    contractHash: proposalContractHash(proposal.contract),
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
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
    taskId: replacementProposal.contract.id,
    assistantTurnId: 'assistant-2',
    proposal: replacementProposal,
    approvalCode: replacementProposal.approvalCode,
    contract: replacementProposal.contract,
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
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.proposalId, proposal.proposalId);
  assert.equal(saved.taskId, proposal.contract.id);
  assert.equal(saved.contract.implementation.prompt, proposal.contract.implementation.prompt);
  assert.equal(saved.state, 'pending');
  assert.equal(saved.updatedAt, proposal.createdAt);
  assert.equal(saved.proposal, undefined);
  assert.equal((await store.get()).contract.implementation.prompt, proposal.contract.implementation.prompt);
  assert.equal(path.basename(autopilotProposalTicketPath(stateDir)), AUTOPILOT_PROPOSAL_TICKET_FILE);
  assert.equal(path.basename(path.dirname(autopilotProposalTicketJsonPath(proposal.proposalId, stateDir))), proposal.proposalId);
  assert.equal(path.basename(path.dirname(autopilotProposalTicketStatePath(proposal.proposalId, stateDir))), proposal.proposalId);
  const restored = await createAutopilotProposalTicketStore({ stateDir, now: () => new Date('2026-08-10T01:00:00.000Z') });
  assert.deepEqual(await restored.get(), saved);
  await restored.update({ proposalId: proposal.proposalId, state: 'acknowledged' });
  await restored.update({ proposalId: proposal.proposalId, state: 'consumed' });
  await assert.rejects(() => restored.create(ticket()), /exists/u);
  await fs.rm(stateDir, { recursive: true, force: false });
});

test('clarification or invalid proposal cannot be represented as a ticket', () => {
  assert.throws(() => validateAutopilotProposalTicket(ticket({ contract: null, proposal: null })), /contract_invalid/u);
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

test('legacy single ticket file remains readable but is not writable by the V2 store', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ticket-legacy-'));
  const legacy = {
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
    state: 'consumed',
    updatedAt: proposal.createdAt,
  };
  await fs.writeFile(autopilotProposalTicketPath(stateDir), `${JSON.stringify(legacy)}\n`);
  const store = await createAutopilotProposalTicketStore({ stateDir, now: () => new Date('2026-08-10T01:00:00.000Z') });
  assert.equal((await store.get()).proposalId, proposal.proposalId);
  await assert.rejects(() => store.update({ proposalId: proposal.proposalId, state: 'acknowledged' }), /legacy_read_only/u);
  await fs.rm(stateDir, { recursive: true, force: false });
});

test('legacy pending and acknowledged tickets never block new V2 creation or change legacy bytes', async () => {
  for (const state of ['pending', 'acknowledged']) {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `agentify-ticket-legacy-${state}-`));
    const legacy = {
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
      state,
      updatedAt: proposal.createdAt,
    };
    const legacyPath = autopilotProposalTicketPath(stateDir);
    await fs.writeFile(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);
    const before = await fs.readFile(legacyPath);
    const store = await createAutopilotProposalTicketStore({ stateDir, now: () => new Date('2026-08-10T01:00:00.000Z') });
    const saved = await store.create(replacementTicket());
    assert.equal(saved.schemaVersion, 2);
    assert.deepEqual(await fs.readFile(legacyPath), before);
    await fs.rm(stateDir, { recursive: true, force: false });
  }
});

test('V2 unresolved scans ignore malformed terminal and expired historical ticket files', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ticket-isolation-'));
  const store = await createAutopilotProposalTicketStore({ stateDir, now: () => new Date('2026-08-10T01:00:00.000Z') });
  await store.create(ticket());
  const current = await store.get(proposal.proposalId);
  await store.update({ proposalId: proposal.proposalId, state: 'acknowledged' });
  await store.update({ proposalId: proposal.proposalId, state: 'consumed' });

  const historicalId = '623e4567-e89b-42d3-a456-426614174000';
  const historical = replacementTicket({ proposalId: historicalId, proposal: { ...replacementProposal, proposalId: historicalId } });
  const historicalDir = autopilotProposalTicketDir(historicalId, stateDir);
  await fs.mkdir(historicalDir, { recursive: true });
  await fs.writeFile(autopilotProposalTicketJsonPath(historicalId, stateDir), '{broken\n');
  await fs.writeFile(autopilotProposalTicketStatePath(historicalId, stateDir), `${JSON.stringify({ schemaVersion: 2, proposalId: historicalId, state: 'consumed', updatedAt: historical.createdAt, expiresAt: historical.expiresAt })}\n`);

  const expiredId = '723e4567-e89b-42d3-a456-426614174000';
  const expired = replacementTicket({ proposalId: expiredId, proposal: { ...replacementProposal, proposalId: expiredId }, expiresAt: '2026-08-09T23:59:59.999Z' });
  const expiredDir = autopilotProposalTicketDir(expiredId, stateDir);
  await fs.mkdir(expiredDir, { recursive: true });
  await fs.writeFile(autopilotProposalTicketJsonPath(expiredId, stateDir), '{broken\n');
  await fs.writeFile(autopilotProposalTicketStatePath(expiredId, stateDir), `${JSON.stringify({ schemaVersion: 2, proposalId: expiredId, state: 'pending', updatedAt: expired.createdAt, expiresAt: expired.expiresAt })}\n`);

  await fs.writeFile(autopilotProposalTicketPath(stateDir), '{legacy broken\n');
  const replacement = await createAutopilotProposalTicketStore({ stateDir, now: () => new Date('2026-08-10T01:00:00.000Z') });
  assert.deepEqual(await replacement.listUnresolved(), []);
  assert.equal((await replacement.get(proposal.proposalId)).proposalId, current.proposalId);
  await fs.rm(stateDir, { recursive: true, force: false });
});

test('active V2 ticket corruption fails closed without being masked by historical corruption', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ticket-active-corrupt-'));
  const store = await createAutopilotProposalTicketStore({ stateDir, now: () => new Date('2026-08-10T01:00:00.000Z') });
  await store.create(ticket());
  await fs.writeFile(autopilotProposalTicketJsonPath(proposal.proposalId, stateDir), '{broken\n');
  await assert.rejects(() => store.listUnresolved(), /JSON|Unexpected/u);
  await fs.rm(stateDir, { recursive: true, force: false });
});

test('explicit V2 get and update ignore malformed legacy ticket bytes', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ticket-explicit-v2-'));
  const store = await createAutopilotProposalTicketStore({ stateDir, now: () => new Date('2026-08-10T01:00:00.000Z') });
  await store.create(ticket());
  await fs.writeFile(autopilotProposalTicketPath(stateDir), '{legacy broken\n');
  assert.equal((await store.get(proposal.proposalId)).proposalId, proposal.proposalId);
  assert.equal((await store.update({ proposalId: proposal.proposalId, state: 'acknowledged' })).state, 'acknowledged');
  await fs.rm(stateDir, { recursive: true, force: false });
});

test('V2 ticket creation exposes no final directory after staged write failure', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ticket-atomic-'));
  const store = await createAutopilotProposalTicketStore({
    stateDir,
    now: () => new Date('2026-08-10T01:00:00.000Z'),
    onCreatePhase: async ({ phase }) => {
      if (phase === 'ticket-written') throw new Error('injected_ticket_write_failure');
    },
  });
  await assert.rejects(() => store.create(ticket()), /injected_ticket_write_failure/u);
  await assert.rejects(() => fs.access(autopilotProposalTicketDir(proposal.proposalId, stateDir)), /ENOENT/u);
  assert.deepEqual(await store.listUnresolved(), []);
  await fs.rm(stateDir, { recursive: true, force: false });
});

test('V2 ticket creation hides staged state until atomic directory rename', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ticket-rename-'));
  const store = await createAutopilotProposalTicketStore({
    stateDir,
    now: () => new Date('2026-08-10T01:00:00.000Z'),
    onCreatePhase: async ({ phase, finalDir }) => {
      if (phase === 'before-rename') {
        await assert.rejects(() => fs.access(finalDir), /ENOENT/u);
        throw new Error('injected_rename_failure');
      }
    },
  });
  await assert.rejects(() => store.create(ticket()), /injected_rename_failure/u);
  assert.deepEqual(await store.listUnresolved(), []);
  await fs.rm(stateDir, { recursive: true, force: false });
});

test('pending tickets may be abandoned once and abandoned tickets are replaceable', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ticket-abandon-'));
  const store = await createAutopilotProposalTicketStore({ stateDir, now: () => new Date('2026-08-10T01:00:00.000Z') });
  await store.create(ticket());
  assert.equal((await store.update({ proposalId: proposal.proposalId, state: 'abandoned' })).state, 'abandoned');
  for (const state of ['acknowledged', 'consumed', 'pending']) {
    await assert.rejects(() => store.update({ proposalId: proposal.proposalId, state }), /transition_invalid/u);
  }
  const replacement = await store.create(replacementTicket());
  assert.equal(replacement.proposalId, replacementProposal.proposalId);
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
