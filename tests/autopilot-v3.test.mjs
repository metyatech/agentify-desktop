import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAutopilotProposalTicketStore, proposalContractHash, validateAutopilotProposalTicket } from '../autopilot-proposal-ticket.mjs';
import { resolveAutopilotProposalApproval, AUTOPILOT_APPROVAL_RESULTS } from '../autopilot-approval.mjs';
import { parseCodexModelListResponse, validateCodexSelection } from '../codex-models.mjs';

const contract = { schemaVersion: 1, id: 'v3-task', title: 'V3 task', repository: null, agentify: { tabKey: 'autopilot-production' }, implementation: { prompt: 'Do work.' }, verification: [], review: { maxRounds: 1, timeoutMs: 1000 }, delivery: { push: false }, constraints: [] };

function makeTicket() {
  return { schemaVersion: 3, proposalId: '123e4567-e89b-42d3-a456-426614174001', taskId: contract.id, tabKey: 'autopilot-production', tabId: 'tab-1', vendorId: 'chatgpt', conversationUrl: 'https://chatgpt.com/c/v3', assistantTurnId: 'assistant-1', assistantTurnIdentityProvenance: 'provider-message-id', contract, contractHash: proposalContractHash(contract), createdAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T23:59:59.999Z', authorization: { authorizationId: '123e4567-e89b-42d3-a456-426614174002', clickedAt: '2026-08-10T00:00:00.000Z', tabId: 'tab-1', tabKey: 'autopilot-production', conversationUrl: 'https://chatgpt.com/c/v3', intentDigest: 'a'.repeat(64) }, execution: { model: 'gpt-5.6-sol', reasoningEffort: 'high' } };
}

test('V3 ticket is atomically already-authorized and approval resolution never reads ChatGPT', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-v3-'));
  const store = await createAutopilotProposalTicketStore({ stateDir, now: () => new Date('2026-08-10T01:00:00.000Z') });
  const saved = await store.create(makeTicket());
  assert.equal(saved.state, 'authorized');
  assert.equal(saved.approvalCode, undefined);
  let reads = 0;
  const resolved = await resolveAutopilotProposalApproval({ ticketStore: store, proposalId: saved.proposalId, tabs: { listTabs: () => { reads += 1; return []; } } });
  assert.equal(resolved.status, AUTOPILOT_APPROVAL_RESULTS.APPROVED);
  assert.equal(reads, 0);
  await fs.rm(stateDir, { recursive: true, force: true });
});

test('model picker uses dynamic catalog metadata and selected effort', () => {
  const models = parseCodexModelListResponse({ data: [{ id: 'm1', displayName: 'M1', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] });
  assert.deepEqual(validateCodexSelection({ model: 'm1', reasoningEffort: 'high' }, models), { model: 'm1', reasoningEffort: 'high' });
  assert.throws(() => validateCodexSelection({ model: 'm1', reasoningEffort: 'max' }, models), /unsupported/u);
});
