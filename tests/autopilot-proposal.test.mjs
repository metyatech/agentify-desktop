import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  PROPOSAL_GENERATION_INSTRUCTION_VERSION,
  PROPOSAL_MAX_ATTEMPTS,
  PROPOSAL_PROTOCOL_VERSION,
  TASK_CONTRACT_SCHEMA_VERSION,
  buildProposalGenerationPrompt,
  createAutopilotProposalService,
  createProposalMetadata,
  parseValidateProposalResponse
} from '../autopilot-proposal.mjs';

const PROPOSAL_BEGIN = 'AUTOPILOT_PROPOSAL_BEGIN_V1';
const PROPOSAL_END = 'AUTOPILOT_PROPOSAL_END_V1';
const FIXED_METADATA = Object.freeze({
  schemaVersion: 1,
  proposalId: '123e4567-e89b-42d3-a456-426614174000',
  createdAt: '2026-08-10T00:00:00.000Z',
  expiresAt: '2026-08-10T23:59:59.999Z',
  tabKey: 'autopilot-production',
  approvalCode: 'AB12CD34'
});

function validContract(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'proposal-validation-test',
    title: 'Proposal validation test',
    repository: null,
    agentify: { tabKey: FIXED_METADATA.tabKey },
    implementation: {
      prompt: 'Implement the requested change. Path D:\\ghws\\RuntimeUnicodeTextSample, quoted "text", and a newline\nare intentional.'
    },
    verification: [],
    review: { maxRounds: 10, timeoutMs: 300000 },
    delivery: { push: false },
    constraints: [],
    ...overrides
  };
}

function validProposalText(metadata = FIXED_METADATA, { contract = {}, envelope = {} } = {}) {
  return `${PROPOSAL_BEGIN}\n${JSON.stringify({ ...metadata, ...envelope, contract: validContract(contract) }, null, 2)}\n${PROPOSAL_END}`;
}

function makeTabs({ rows = [{ id: 'tab-1', key: 'autopilot-production', vendorId: 'chatgpt' }], url = 'https://chatgpt.com/' } = {}) {
  const controllers = new Map(rows.map((row) => [row.id, { getUrl: async () => url }]));
  return {
    listTabs: () => rows,
    getControllerById: (id) => {
      const controller = controllers.get(id);
      if (!controller) throw new Error('tab_not_found');
      return controller;
    }
  };
}

function makeService(options = {}) {
  const calls = [];
  let release;
  const requestQuery = options.requestQuery || (async (body) => {
    calls.push(body);
    if (release) await release;
    return { result: { text: validProposalText() } };
  });
  const service = createAutopilotProposalService({
    tabs: options.tabs || makeTabs(),
    getRuntimeState: options.getRuntimeState || (() => ({ inflightQueries: 0, activeQueries: [] })),
    requestQuery,
    now: () => new Date('2026-08-10T00:00:00.000Z'),
    randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
    randomBytes: () => Buffer.from([0xab, 0x12, 0xcd, 0x34])
  });
  return { service, calls, setRelease: (fn) => { release = fn; } };
}

test('control center workflow is production-only and metadata is local', async () => {
  const { service, calls } = makeService();
  const result = await service.request();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'autopilot-production');
  assert.equal(calls[0].createIfMissing, false);
  assert.equal(result.metadata.schemaVersion, 1);
  assert.match(result.metadata.proposalId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.match(result.metadata.approvalCode, /^[A-F0-9]{8}$/u);
  assert.equal(result.metadata.tabKey, 'autopilot-production');
  assert.equal(result.status, 'proposal_response_received');
});

for (const [name, tabs, runtime] of [
  ['missing production tab', makeTabs({ rows: [] }), undefined],
  ['duplicate production tabs', makeTabs({ rows: [{ id: 'a', key: 'autopilot-production', vendorId: 'chatgpt' }, { id: 'b', key: 'autopilot-production', vendorId: 'chatgpt' }] }), undefined],
  ['non-ChatGPT production tab', makeTabs({ rows: [{ id: 'a', key: 'autopilot-production', vendorId: 'claude' }] }), undefined],
  ['active query', makeTabs(), { inflightQueries: 0, activeQueries: [{ tabId: 'tab-1' }] }],
  ['inflight query', makeTabs(), { inflightQueries: 1, activeQueries: [] }]
]) {
  test(`proposal request does not send when ${name}`, async () => {
    let calls = 0;
    const service = createAutopilotProposalService({
      tabs,
      getRuntimeState: () => runtime || ({ inflightQueries: 0, activeQueries: [] }),
      requestQuery: async () => { calls += 1; }
    });
    await assert.rejects(service.request());
    assert.equal(calls, 0);
  });
}

test('double click while request is pending sends one query and disables the second request', async () => {
  let resolve;
  const { service, calls } = makeService({ requestQuery: async (body) => {
    calls.push(body);
    await new Promise((r) => { resolve = r; });
    return { result: { text: validProposalText() } };
  }});
  const first = service.request();
  await new Promise((r) => setImmediate(r));
  await assert.rejects(service.request(), /autopilot_proposal_request_inflight/u);
  assert.equal(calls.length, 1);
  resolve();
  await first;
});

test('request error clears inflight state so the button is reusable', async () => {
  let calls = 0;
  const service = createAutopilotProposalService({
    tabs: makeTabs(),
    requestQuery: async () => {
      calls += 1;
      if (calls === 1) throw new Error('query_error');
      return { result: { text: validProposalText() } };
    },
    now: () => new Date('2026-08-10T00:00:00.000Z'),
    randomUUID: () => FIXED_METADATA.proposalId,
    randomBytes: () => Buffer.from([0xab, 0x12, 0xcd, 0x34])
  });
  await assert.rejects(service.request(), /query_error/u);
  await service.request();
  assert.equal(calls, 2);
});

test('malformed Windows path is rejected and a valid retry keeps the original metadata', async () => {
  const malformed = validProposalText().replace('\\\\', '\\');
  const responses = [malformed, validProposalText()];
  const calls = [];
  const { service } = makeService({ requestQuery: async (body) => {
    calls.push(body);
    return { result: { text: responses.shift() } };
  }});

  const result = await service.request();
  assert.equal(calls.length, 2);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.metadata, FIXED_METADATA);
  assert.match(calls[1].prompt, /previous proposal output was invalid/u);
  assert.match(calls[1].prompt, /same implementation intent and user decisions/u);
  assert.match(calls[1].prompt, /byte-for-byte/u);
  assert.match(calls[1].prompt, /backslash, double quote, newline/u);
  assert.match(calls[1].prompt, /Do not include a code fence/u);
});

test('unescaped embedded quote is rejected and a valid retry succeeds', async () => {
  const malformed = validProposalText().replace(String.raw`\"text\"`, '"text"');
  const responses = [malformed, validProposalText()];
  let calls = 0;
  const { service } = makeService({ requestQuery: async () => ({ result: { text: responses[calls++] } }) });

  const result = await service.request();
  assert.equal(calls, 2);
  assert.equal(result.status, 'proposal_response_received');
});

for (const [name, response] of [
  ['marker missing', validProposalText().replace(PROPOSAL_BEGIN, 'MISSING_BEGIN')],
  ['marker duplicate', `${validProposalText()}\n${PROPOSAL_BEGIN}`]
]) {
  test(`${name} is rejected without being executable`, async () => {
    let calls = 0;
    const { service } = makeService({ requestQuery: async () => {
      calls += 1;
      return { result: { text: response } };
    }});
    await assert.rejects(service.request(), /autopilot_proposal_generation_failed:marker_count_invalid/u);
    assert.equal(calls, PROPOSAL_MAX_ATTEMPTS);
  });
}

test('metadata mismatch is rejected even when JSON is valid', async () => {
  const response = validProposalText(FIXED_METADATA, { envelope: { approvalCode: 'DEADBEEF' } });
  assert.throws(() => parseValidateProposalResponse(response, { metadata: FIXED_METADATA }), /metadata_mismatch_approvalCode/u);
});

test('metadata mismatch causes bounded retry and never returns the old proposal', async () => {
  const invalid = validProposalText(FIXED_METADATA, { envelope: { proposalId: '423e4567-e89b-42d3-a456-426614174000' } });
  let calls = 0;
  const { service } = makeService({ requestQuery: async () => {
    calls += 1;
    return { result: { text: invalid } };
  }});
  await assert.rejects(service.request(), /autopilot_proposal_generation_failed:metadata_mismatch_proposalId/u);
  assert.equal(calls, PROPOSAL_MAX_ATTEMPTS);
});

test('v3 contract boundary rejects implementation patch settings', async () => {
  const response = validProposalText(FIXED_METADATA, {
    contract: { implementation: { prompt: 'Implement this', maxPatchAttempts: 3 } }
  });
  assert.throws(() => parseValidateProposalResponse(response, { metadata: FIXED_METADATA }), /implementation_schema_invalid/u);
});

test('three invalid attempts fail without success state or fabricated approval', async () => {
  let calls = 0;
  const { service } = makeService({ requestQuery: async () => {
    calls += 1;
    return { result: { text: 'not a proposal' } };
  }});
  await assert.rejects(service.request(), (error) => {
    assert.equal(error.code, 'autopilot_proposal_generation_failed');
    assert.equal(error.reason, 'marker_count_invalid');
    assert.equal(error.data.attempts.length, PROPOSAL_MAX_ATTEMPTS);
    return true;
  });
  assert.equal(calls, PROPOSAL_MAX_ATTEMPTS);
  assert.equal(service.isRequestInFlight(), false);
});

test('retry creates metadata exactly once and preserves it in every prompt', async () => {
  let uuidCalls = 0;
  let randomBytesCalls = 0;
  const calls = [];
  const service = createAutopilotProposalService({
    tabs: makeTabs(),
    requestQuery: async (body) => {
      calls.push(body);
      return { result: { text: calls.length < 3 ? 'invalid' : validProposalText() } };
    },
    now: () => new Date('2026-08-10T00:00:00.000Z'),
    randomUUID: () => { uuidCalls += 1; return FIXED_METADATA.proposalId; },
    randomBytes: () => { randomBytesCalls += 1; return Buffer.from([0xab, 0x12, 0xcd, 0x34]); }
  });

  const result = await service.request();
  assert.equal(calls.length, 3);
  assert.equal(uuidCalls, 1);
  assert.equal(randomBytesCalls, 1);
  const serializedMetadata = JSON.stringify(FIXED_METADATA, null, 2);
  for (const call of calls) assert.match(call.prompt, new RegExp(serializedMetadata.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.deepEqual(result.metadata, FIXED_METADATA);
});

test('valid JSON accepts implementation prompt backslashes, quotes, and newlines', () => {
  const proposal = parseValidateProposalResponse(validProposalText(), { metadata: FIXED_METADATA });
  assert.match(proposal.contract.implementation.prompt, /D:\\ghws\\RuntimeUnicodeTextSample/u);
  assert.match(proposal.contract.implementation.prompt, /quoted "text"/u);
  assert.match(proposal.contract.implementation.prompt, /newline\nare intentional/u);
});

test('proposal prompt pins current schema, metadata, and clarification safety', async () => {
  const metadata = createProposalMetadata({
    now: new Date('2026-08-10T00:00:00.000Z'),
    randomUUID: crypto.randomUUID,
    randomBytes: () => Buffer.from([0xab, 0x12, 0xcd, 0x34])
  });
  const prompt = buildProposalGenerationPrompt({ metadata });
  assert.match(prompt, new RegExp(PROPOSAL_GENERATION_INSTRUCTION_VERSION, 'u'));
  assert.equal(PROPOSAL_GENERATION_INSTRUCTION_VERSION, 'ai-autopilot-proposal-generation-v3');
  assert.match(prompt, new RegExp(PROPOSAL_PROTOCOL_VERSION, 'u'));
  assert.match(prompt, new RegExp(`Task contract schemaVersion: ${TASK_CONTRACT_SCHEMA_VERSION}`, 'u'));
  assert.match(prompt, /repository\/branch when the task is repository-scoped/u);
  assert.match(prompt, /repository is either null for host\/local tasks/u);
  assert.doesNotMatch(prompt, /maxPatchAttempts/u);
  assert.match(prompt, /implementation\.prompt is required; implementation has no patch-attempt setting/u);
  assert.match(prompt, /verification/u);
  assert.match(prompt, /review/u);
  assert.match(prompt, /delivery/u);
  assert.match(prompt, /constraints/u);
  assert.match(prompt, /do not guess/u);
  assert.match(prompt, /Do not ask for a repository when the request is clearly a host\/local task/u);
  assert.match(prompt, /Copy every value exactly/u);
  assert.match(prompt, /JSON.stringify would/u);
  assert.match(prompt, /Windows paths.*quotation marks.*backslashes.*newlines/u);
  assert.match(prompt, /AUTOPILOT_PROPOSAL_BEGIN_V1/u);
  assert.match(prompt, /開始して XXXXXXXX/u);
});

test('proposal prompt owns technical verification planning and ignores generated clarifications', async () => {
  const prompt = buildProposalGenerationPrompt({
    metadata: {
      schemaVersion: 1,
      proposalId: crypto.randomUUID(),
      createdAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T23:59:59.999Z',
      tabKey: 'autopilot-production',
      approvalCode: 'AB12CD34'
    }
  });
  assert.equal(PROPOSAL_GENERATION_INSTRUCTION_VERSION, 'ai-autopilot-proposal-generation-v3');
  assert.match(prompt, /System-generated proposal-generation turns.*not authoritative user requirements/u);
  assert.match(prompt, /If a required user decision is missing or ambiguous/u);
  assert.match(prompt, /Verification is an execution plan, not a user-facing requirement/u);
  assert.match(prompt, /If concrete verification commands are explicitly present.*respect them/u);
  assert.match(prompt, /absence of a command is never, by itself, a reason to ask the user/u);
  assert.match(prompt, /Do not claim that an unknown script exists or fabricate a command/u);
  assert.match(prompt, /Do not ask the user for command names or arguments/u);
  assert.doesNotMatch(prompt, /maxPatchAttempts/u);
  assert.match(prompt, /review\.maxRounds=10/u);
  assert.match(prompt, /review\.timeoutMs=300000/u);
  assert.match(prompt, /repository:null.*delivery\.push:false/u);
  assert.match(prompt, /Verification may be an empty array/u);
  assert.match(prompt, /For host\/local tasks, do not insert Git verification/u);
  assert.match(prompt, /Never ask the user to choose execution tuning/u);
  assert.match(prompt, /prior technical clarification.*compiler artifact/u);
});

test('proposal prompt encodes v3 host/local and empty-verification contract', () => {
  const prompt = buildProposalGenerationPrompt({
    metadata: {
      schemaVersion: 1,
      proposalId: crypto.randomUUID(),
      createdAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-10T23:59:59.999Z',
      tabKey: 'autopilot-production',
      approvalCode: 'AB12CD34'
    }
  });

  assert.match(prompt, /repository is either null for host\/local tasks/u);
  assert.match(prompt, /verification is an array, possibly empty/u);
  assert.match(prompt, /delivery\.push is required and boolean; it must be false when repository is null/u);
  assert.match(prompt, /implementation has no patch-attempt setting/u);
  assert.doesNotMatch(prompt, /maxPatchAttempts/u);
});

test('control center exposes the production action', async () => {
  const html = await fs.readFile(path.join(import.meta.dirname, '..', 'ui', 'control-center.html'), 'utf8');
  assert.match(html, /この内容を実行/u);
  assert.match(html, /autopilot-production/u);
  assert.match(html, /まだ変更は開始しません/u);
});
