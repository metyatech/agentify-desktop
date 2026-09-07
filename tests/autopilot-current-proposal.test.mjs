import assert from 'node:assert/strict';
import test from 'node:test';

import { selectCurrentAutopilotProposalTicket } from '../autopilot-current-proposal.mjs';

const ticket = (overrides = {}) => ({
  schemaVersion: 2,
  proposalId: '123e4567-e89b-42d3-a456-426614174000',
  tabKey: 'autopilot-production',
  state: 'pending',
  ...overrides,
});

test('current proposal selection excludes legacy, terminal, expired-filtered, and other-tab tickets', () => {
  const selected = selectCurrentAutopilotProposalTicket([
    { ...ticket(), schemaVersion: 1 },
    ticket({ state: 'consumed', proposalId: '223e4567-e89b-42d3-a456-426614174000' }),
    ticket({ state: 'abandoned', proposalId: '323e4567-e89b-42d3-a456-426614174000' }),
    ticket({ tabKey: 'other-tab', proposalId: '423e4567-e89b-42d3-a456-426614174000' }),
    ticket(),
  ]);
  assert.equal(selected.error, null);
  assert.equal(selected.ticket.proposalId, '123e4567-e89b-42d3-a456-426614174000');
});

test('no unresolved V2 ticket returns null even when historical tickets exist', () => {
  const selected = selectCurrentAutopilotProposalTicket([
    ticket({ state: 'consumed' }),
    ticket({ state: 'abandoned', proposalId: '223e4567-e89b-42d3-a456-426614174000' }),
  ]);
  assert.equal(selected.ticket, null);
  assert.equal(selected.error, null);
});

test('multiple unresolved V2 tickets fail closed instead of selecting one', () => {
  const selected = selectCurrentAutopilotProposalTicket([
    ticket(),
    ticket({ proposalId: '223e4567-e89b-42d3-a456-426614174000', state: 'acknowledged' }),
  ]);
  assert.equal(selected.ticket, null);
  assert.equal(selected.error.code, 'AUTOPILOT_PROPOSAL_TICKET_CONFLICT');
});
