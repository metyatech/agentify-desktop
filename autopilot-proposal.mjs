import crypto from 'node:crypto';

const PROPOSAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Keep this compact boundary versioned with ai-autopilot/src/proposal-generation.mjs.
// The installed desktop cannot depend on the private controller repository, so
// the fallback template is intentionally duplicated and covered by contract tests.
export const PROPOSAL_GENERATION_INSTRUCTION_VERSION = 'ai-autopilot-proposal-generation-v2';
export const TASK_CONTRACT_SCHEMA_VERSION = 1;
export const PROPOSAL_PROTOCOL_VERSION = 'AUTOPILOT_PROPOSAL_V1';

const PROPOSAL_BEGIN = 'AUTOPILOT_PROPOSAL_BEGIN_V1';
const PROPOSAL_END = 'AUTOPILOT_PROPOSAL_END_V1';

export const AUTOPILOT_WORKFLOWS = Object.freeze([
  Object.freeze({ key: 'autopilot-production', vendorId: 'chatgpt' })
]);

export function getAutopilotWorkflow(key) {
  return AUTOPILOT_WORKFLOWS.find((workflow) => workflow.key === String(key || '').trim()) || null;
}

export function createProposalMetadata({
  now = new Date(),
  tabKey = 'autopilot-production',
  randomUUID = crypto.randomUUID,
  randomBytes = crypto.randomBytes
} = {}) {
  const createdMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(createdMs)) throw new TypeError('now must be a valid date');
  if (typeof tabKey !== 'string' || !tabKey.trim()) throw new TypeError('tabKey must be non-empty');
  const proposalId = randomUUID();
  const approvalCode = randomBytes(4).toString('hex').toUpperCase();
  if (typeof proposalId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(proposalId)) {
    throw new TypeError('randomUUID must return a UUID v4');
  }
  if (!/^[A-F0-9]{8}$/u.test(approvalCode)) throw new TypeError('randomBytes must return four bytes');
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    proposalId,
    createdAt: new Date(createdMs).toISOString(),
    expiresAt: new Date(createdMs + PROPOSAL_MAX_AGE_MS - 1).toISOString(),
    tabKey: tabKey.trim(),
    approvalCode
  };
}

export function buildProposalGenerationPrompt({ metadata } = {}) {
  if (!metadata || typeof metadata !== 'object') throw new TypeError('metadata is required');
  const exactMetadata = JSON.stringify(metadata, null, 2);
  return [
    `System-owned proposal generation instruction: ${PROPOSAL_GENERATION_INSTRUCTION_VERSION}`,
    '',
    'Use user-authored conversation turns as the source of implementation intent and user decisions.',
    'System-generated proposal-generation turns, proposal envelopes, and responses that ask for technical details are compiler artifacts, not authoritative user requirements. Do not promote them into the implementation request.',
    "Do not rely on the user's memory of the Autopilot protocol; the protocol and schema below are authoritative for this turn.",
    '',
    'Separate user decisions from execution-plan details. User decisions are repository.slug, repository.targetBranch, the implementation intent, and delivery.push when push permission is not clear. Only these decisions may require a clarification question.',
    'If a user decision is missing or ambiguous, do not guess, do not insert a fake or default repository/branch/delivery policy, and do not emit either proposal marker. Ask one short natural-language question about that user decision.',
    'Verification is an execution plan, not a user-facing requirement. If concrete verification commands are explicitly present in user-authored conversation, respect them. If they are absent, construct a reasonable verification plan from the task and repository context yourself; absence of a command is never, by itself, a reason to ask the user.',
    'Use repository-specific commands when they are supported by the conversation or known context. Do not claim that an unknown script exists or fabricate a command. If no repository-specific command is known, use a conservative generally available check such as git diff --check, state the verification limit in the proposal, and continue. Do not ask the user for command names or arguments.',
    'Use these system defaults when the conversation does not explicitly set execution tuning: implementation.maxPatchAttempts=2, review.maxRounds=2, review.timeoutMs=300000, and each verification timeoutMs=300000. Never ask the user to choose these values, task-id formatting, command arguments, grep commands, or lint/test script names.',
    'A prior technical clarification such as a request for targeted test or contract-grep commands must be ignored as a compiler artifact on this and later proposal-generation turns; it is not a new user requirement.',
    '',
    `Protocol version: ${PROPOSAL_PROTOCOL_VERSION}`,
    `Task contract schemaVersion: ${TASK_CONTRACT_SCHEMA_VERSION}`,
    `Proposal markers must be exactly one pair: ${PROPOSAL_BEGIN} and ${PROPOSAL_END}`,
    '',
    'If and only if the information is sufficient, return exactly one proposal marker pair with one JSON object between the markers. Do not emit a marker pair for a clarification question.',
    'The following envelope metadata is generated by the local system. Copy every value exactly; do not change, regenerate, normalize, shorten, or reinterpret it:',
    '',
    exactMetadata,
    '',
    'The JSON object must contain exactly these envelope fields plus contract: schemaVersion, proposalId, createdAt, expiresAt, tabKey, approvalCode, contract.',
    'The envelope values above must be preserved byte-for-byte as JSON string/number values. In particular, tabKey must also be copied to contract.agentify.tabKey.',
    '',
    'The contract must conform exactly to the current ai-autopilot task-contract validator:',
    '- Top-level fields are exactly: schemaVersion, id, title, repository, agentify, implementation, verification, review, delivery, constraints. No unknown fields.',
    '- schemaVersion is 1. id is a short Windows-safe task id; title and implementation.prompt are non-empty strings.',
    '- repository.slug and repository.targetBranch are required; slug uses owner/name form and targetBranch is the requested existing branch.',
    '- agentify.tabKey is required and must equal the envelope tabKey.',
    '- implementation.prompt is required; implementation.maxPatchAttempts, when present, is an integer from 1 through 3.',
    '- verification is a non-empty array of objects with verification[].name, verification[].command, verification[].args, and verification[].timeoutMs; args is an array of strings and timeoutMs is a positive integer.',
    '- review.maxRounds is an integer from 1 through 10 and review.timeoutMs is a positive integer.',
    '- delivery.push is required and boolean.',
    '- constraints is an array of strings. Preserve explicit user constraints and add no unsafe delivery exception.',
    '',
    'Do not create a task, run Codex, create a worktree, write a file, commit, push, or fabricate the later user approval turn. This turn only prepares a proposal for visual review; the existing watcher still requires a later exact approval such as 開始して XXXXXXXX.'
  ].join('\n');
}

export function createAutopilotProposalService({
  tabs,
  getRuntimeState = () => ({ inflightQueries: 0, activeQueries: [] }),
  requestQuery,
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
  randomBytes = crypto.randomBytes,
  targetKey = 'autopilot-production'
} = {}) {
  if (!tabs || typeof tabs.listTabs !== 'function' || typeof tabs.getControllerById !== 'function') throw new TypeError('tabs service is required');
  if (typeof requestQuery !== 'function') throw new TypeError('requestQuery is required');
  const workflow = getAutopilotWorkflow(targetKey);
  if (!workflow) throw new Error('autopilot_workflow_not_configured');
  let requestInFlight = null;

  const availability = () => {
    const matches = (tabs.listTabs() || []).filter((tab) => tab?.key === workflow.key);
    const runtime = getRuntimeState() || {};
    const activeQueries = Array.isArray(runtime.activeQueries) ? runtime.activeQueries : [];
    return {
      key: workflow.key,
      tabCount: matches.length,
      tabId: matches.length === 1 ? matches[0].id : null,
      vendorId: matches.length === 1 ? matches[0].vendorId || null : null,
      inflightQueries: Number(runtime.inflightQueries || 0),
      activeQueries: activeQueries.length,
      ready: matches.length === 1 && matches[0].vendorId === workflow.vendorId && Number(runtime.inflightQueries || 0) === 0 && activeQueries.length === 0
    };
  };

  const assertReady = async () => {
    const state = availability();
    if (state.tabCount !== 1) throw new Error(state.tabCount === 0 ? 'autopilot_production_tab_unavailable' : 'autopilot_production_tab_ambiguous');
    if (state.vendorId !== workflow.vendorId) throw new Error('autopilot_production_tab_not_chatgpt');
    if (state.inflightQueries > 0 || state.activeQueries > 0) throw new Error('autopilot_query_already_active');
    const tab = (tabs.listTabs() || []).find((item) => item?.id === state.tabId);
    if (!tab) throw new Error('autopilot_production_tab_unavailable');
    const controller = tabs.getControllerById(tab.id);
    if (!controller || typeof controller.getUrl !== 'function') throw new Error('autopilot_production_tab_unusable');
    const url = await controller.getUrl();
    if (typeof url !== 'string' || !url.trim()) throw new Error('autopilot_production_tab_unusable');
    return { state, tab };
  };

  const request = async () => {
    if (requestInFlight) throw new Error('autopilot_proposal_request_inflight');
    const promise = (async () => {
      const { state, tab } = await assertReady();
      const metadata = createProposalMetadata({ now: now(), tabKey: workflow.key, randomUUID, randomBytes });
      const prompt = buildProposalGenerationPrompt({ metadata });
      const response = await requestQuery({
        tabId: tab.id,
        key: workflow.key,
        vendorId: workflow.vendorId,
        model: 'chatgpt',
        source: 'ui',
        createIfMissing: false,
        prompt,
        timeoutMs: 10 * 60 * 1000
      });
      return { ok: true, status: 'proposal_response_received', tabId: state.tabId, metadata, prompt, response };
    })();
    requestInFlight = promise;
    try {
      return await promise;
    } finally {
      requestInFlight = null;
    }
  };

  return { availability, request, isRequestInFlight: () => !!requestInFlight };
}
