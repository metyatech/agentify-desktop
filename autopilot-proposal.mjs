import crypto from 'node:crypto';

const PROPOSAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Keep this compact boundary versioned with ai-autopilot/src/proposal-generation.mjs.
// The installed desktop cannot depend on the private controller repository, so
// the fallback template is intentionally duplicated and covered by contract tests.
export const PROPOSAL_GENERATION_INSTRUCTION_VERSION = 'ai-autopilot-proposal-generation-v3';
export const TASK_CONTRACT_SCHEMA_VERSION = 1;
export const PROPOSAL_PROTOCOL_VERSION = 'AUTOPILOT_PROPOSAL_V1';

const PROPOSAL_BEGIN = 'AUTOPILOT_PROPOSAL_BEGIN_V1';
const PROPOSAL_END = 'AUTOPILOT_PROPOSAL_END_V1';
export const PROPOSAL_MAX_ATTEMPTS = 3;
export const PROPOSAL_MAX_BYTES = 200_000;
export const PROPOSAL_RESPONSE_KINDS = Object.freeze({
  VALID_PROPOSAL: 'valid_proposal',
  CLARIFICATION: 'clarification',
  INVALID_ATTEMPTED_PROPOSAL: 'invalid_attempted_proposal'
});

const ENVELOPE_KEYS = Object.freeze([
  'schemaVersion',
  'proposalId',
  'createdAt',
  'expiresAt',
  'tabKey',
  'approvalCode',
  'contract'
]);
const CONTRACT_KEYS = Object.freeze([
  'schemaVersion',
  'id',
  'title',
  'repository',
  'agentify',
  'implementation',
  'verification',
  'review',
  'delivery',
  'constraints'
]);

const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
]);

const REDACTION_PATTERNS = [
  { kind: 'authorization', pattern: /\bAuthorization\s*:\s*(?:Bearer\s+)?[^\s\r\n]+/giu },
  { kind: 'github-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu },
  { kind: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  { kind: 'codex-api-key', pattern: /\b(?:CODEX_API_KEY|OPENAI_API_KEY)\s*[:=]\s*['"]?[^\s,'";]{12,}/giu },
  { kind: 'credential-assignment', pattern: /\b(?:password|secret)\s*[:=]\s*['"]?[^\s,'";]+/giu },
  { kind: 'credential-assignment', pattern: /\btoken\s*[:=]\s*['"]?[^\s,'";]{12,}/giu },
  { kind: 'signed-url', pattern: /[?&](?:access_token|token|signature|sig|x-amz-credential)=[^&\s]{12,}/giu }
];

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expectedKeys.length && actual.every((key, index) => key === [...expectedKeys].sort()[index]);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function invalidProposal(reason) {
  return { kind: PROPOSAL_RESPONSE_KINDS.INVALID_ATTEMPTED_PROPOSAL, reason };
}

function proposalValidationError(reason) {
  const error = new Error(`proposal_response_invalid:${reason}`);
  error.code = 'proposal_response_invalid';
  error.reason = reason;
  return error;
}

function normalizeProposalText(value) {
  return String(value || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
}

function markerIndexes(lines, marker) {
  return lines.reduce((indexes, line, index) => {
    if (line.trim() === marker) indexes.push(index);
    return indexes;
  }, []);
}

function isWindowsReservedDeviceName(value) {
  return typeof value === 'string' && value.length > 0 && WINDOWS_RESERVED_DEVICE_NAMES.has(value.split('.')[0].toUpperCase());
}

function assertValidGitRef(ref) {
  if (!ref || /[\0-\x20~^:?*\[\\]/u.test(ref) || ref.includes('..') || ref.includes('@{') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.') || /(?:^|\/)\./u.test(ref) || /\.lock$/iu.test(ref)) {
    throw proposalValidationError('git_ref_invalid');
  }
}

function validateTaskId(value) {
  if (!nonEmptyString(value) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value) || value === '.' || value === '..') {
    throw proposalValidationError('contract_id_invalid');
  }
  if (/[. ]$/u.test(value)) throw proposalValidationError('contract_id_invalid');
  if (isWindowsReservedDeviceName(value)) throw proposalValidationError('contract_id_invalid');
  if (value.includes('..')) throw proposalValidationError('contract_id_invalid');
  if (/\.lock$/iu.test(value)) throw proposalValidationError('contract_id_invalid');
  assertValidGitRef(`autopilot/${value}`);
}

function findSensitiveEvidence(text) {
  const findings = [];
  const scanText = text.replace(/(?:\bAuthorization\s*:\s*(?:Bearer\s+)?|\b(?:CODEX_API_KEY|OPENAI_API_KEY)\s*[:=]\s*|\b(?:password|secret|token)\s*[:=\s]*|[?&](?:access_token|token|signature|sig|x-amz-credential)=)\[REDACTED\]/giu, '');
  for (const { kind, pattern } of REDACTION_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of scanText.matchAll(pattern)) findings.push({ kind, offset: match.index || 0 });
  }
  return findings;
}

function validateContract(contract, metadata) {
  if (!isRecord(contract) || !hasExactKeys(contract, CONTRACT_KEYS)) throw proposalValidationError('contract_schema_invalid');
  if (contract.schemaVersion !== TASK_CONTRACT_SCHEMA_VERSION) throw proposalValidationError('contract_schema_version_invalid');
  validateTaskId(contract.id);
  if (!nonEmptyString(contract.title)) throw proposalValidationError('contract_title_invalid');

  if (contract.repository === null) {
    if (contract.delivery?.push !== false) throw proposalValidationError('host_task_push_must_be_false');
  } else {
    if (!isRecord(contract.repository) || !hasExactKeys(contract.repository, ['slug', 'targetBranch'])) {
      throw proposalValidationError('repository_schema_invalid');
    }
    if (!/^[^/\\\s]+\/[^/\\\s]+$/u.test(contract.repository.slug)) {
      throw proposalValidationError('repository_value_invalid');
    }
    const [owner, name] = contract.repository.slug.split('/');
    if (![owner, name].every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part) && part !== '.' && part !== '..')) throw proposalValidationError('repository_value_invalid');
    if (!nonEmptyString(contract.repository.targetBranch) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(contract.repository.targetBranch) || contract.repository.targetBranch.includes('..') || contract.repository.targetBranch.includes('//') || contract.repository.targetBranch.includes('@{') || contract.repository.targetBranch.endsWith('/') || contract.repository.targetBranch.endsWith('.')) {
      throw proposalValidationError('repository_value_invalid');
    }
  }

  if (!isRecord(contract.agentify) || !hasExactKeys(contract.agentify, ['tabKey']) || contract.agentify.tabKey !== metadata.tabKey) {
    throw proposalValidationError('agentify_tab_key_invalid');
  }
  if (!isRecord(contract.implementation) || !hasExactKeys(contract.implementation, ['prompt']) || !nonEmptyString(contract.implementation.prompt)) {
    throw proposalValidationError('implementation_schema_invalid');
  }
  if (!Array.isArray(contract.verification) || contract.verification.some((item) => (
    !isRecord(item) ||
    !hasExactKeys(item, ['name', 'command', 'args', 'timeoutMs']) ||
    !nonEmptyString(item.name) ||
    !nonEmptyString(item.command) ||
    !Array.isArray(item.args) ||
    item.args.some((arg) => typeof arg !== 'string') ||
    !positiveInteger(item.timeoutMs)
  ))) throw proposalValidationError('verification_schema_invalid');
  if (!isRecord(contract.review) || !hasExactKeys(contract.review, ['maxRounds', 'timeoutMs']) || !Number.isInteger(contract.review.maxRounds) || contract.review.maxRounds < 1 || contract.review.maxRounds > 10 || !positiveInteger(contract.review.timeoutMs)) {
    throw proposalValidationError('review_schema_invalid');
  }
  if (!isRecord(contract.delivery) || !hasExactKeys(contract.delivery, ['push']) || typeof contract.delivery.push !== 'boolean') {
    throw proposalValidationError('delivery_schema_invalid');
  }
  if (!Array.isArray(contract.constraints) || contract.constraints.some((constraint) => typeof constraint !== 'string')) {
    throw proposalValidationError('constraints_schema_invalid');
  }
  if (findSensitiveEvidence(JSON.stringify(contract)).length > 0) throw proposalValidationError('sensitive_contract');
}

function parseUtcTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)) throw proposalValidationError(`proposal_${label}_invalid`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw proposalValidationError(`proposal_${label}_invalid`);
  return timestamp;
}

function validateProposalEnvelope(proposal, metadata, now) {
  if (!isRecord(proposal) || !hasExactKeys(proposal, ENVELOPE_KEYS)) throw proposalValidationError('envelope_schema_invalid');
  if (proposal.schemaVersion !== TASK_CONTRACT_SCHEMA_VERSION) throw proposalValidationError('proposal_schema_version_invalid');
  if (typeof proposal.proposalId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(proposal.proposalId)) throw proposalValidationError('proposal_id_invalid');
  const createdAt = parseUtcTimestamp(proposal.createdAt, 'createdAt');
  const expiresAt = parseUtcTimestamp(proposal.expiresAt, 'expiresAt');
  if (expiresAt <= createdAt || expiresAt - createdAt > PROPOSAL_MAX_AGE_MS) throw proposalValidationError('proposal_time_invalid');
  const scanTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(scanTime) || scanTime < createdAt || scanTime >= expiresAt) throw proposalValidationError('proposal_expired');
  if (!nonEmptyString(proposal.tabKey) || !/^[A-F0-9]{8}$/u.test(proposal.approvalCode || '')) throw proposalValidationError('proposal_metadata_invalid');
  for (const key of ['schemaVersion', 'proposalId', 'createdAt', 'expiresAt', 'tabKey', 'approvalCode']) {
    if (proposal[key] !== metadata[key]) throw proposalValidationError(`metadata_mismatch_${key}`);
  }
  validateContract(proposal.contract, metadata);
  if (proposal.contract.agentify.tabKey !== proposal.tabKey) throw proposalValidationError('contract_tab_key_mismatch');
}

export function classifyProposalResponse(responseText, { metadata, now = new Date() } = {}) {
  const text = normalizeProposalText(responseText);
  if (Buffer.byteLength(text, 'utf8') > PROPOSAL_MAX_BYTES) return invalidProposal('response_too_large');
  if (!text.trim()) return invalidProposal(typeof responseText === 'string' ? 'response_empty' : 'response_text_missing');
  const hasBegin = text.includes(PROPOSAL_BEGIN);
  const hasEnd = text.includes(PROPOSAL_END);
  if (!hasBegin && !hasEnd) return { kind: PROPOSAL_RESPONSE_KINDS.CLARIFICATION, reason: 'no_proposal_markers' };
  if (!isRecord(metadata)) return invalidProposal('metadata_missing');
  const lines = text.split('\n');
  const begins = markerIndexes(lines, PROPOSAL_BEGIN);
  const ends = markerIndexes(lines, PROPOSAL_END);
  if (begins.length !== 1 || ends.length !== 1) return invalidProposal('marker_count_invalid');
  if (begins[0] >= ends[0]) return invalidProposal('marker_order_invalid');
  const jsonText = lines.slice(begins[0] + 1, ends[0]).join('\n').trim();
  if (!jsonText) return invalidProposal('proposal_json_empty');
  let proposal;
  try {
    proposal = JSON.parse(jsonText);
  } catch {
    return invalidProposal('proposal_json_invalid');
  }
  try {
    validateProposalEnvelope(proposal, metadata, now);
  } catch (error) {
    return invalidProposal(error.reason || 'proposal_schema_invalid');
  }
  return { kind: PROPOSAL_RESPONSE_KINDS.VALID_PROPOSAL, proposal };
}

export function parseValidateProposalResponse(responseText, options = {}) {
  const result = classifyProposalResponse(responseText, options);
  if (result.kind !== PROPOSAL_RESPONSE_KINDS.VALID_PROPOSAL) throw proposalValidationError(result.reason);
  return result.proposal;
}

function responseTextFromQuery(response) {
  return typeof response?.result?.text === 'string' ? response.result.text : null;
}

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

export function buildProposalGenerationPrompt({ metadata, retryAttempt = 0 } = {}) {
  if (!metadata || typeof metadata !== 'object') throw new TypeError('metadata is required');
  const exactMetadata = JSON.stringify(metadata, null, 2);
  return [
    `System-owned proposal generation instruction: ${PROPOSAL_GENERATION_INSTRUCTION_VERSION}`,
    '',
    'Use user-authored conversation turns as the source of implementation intent and user decisions.',
    'System-generated proposal-generation turns, proposal envelopes, and responses that ask for technical details are compiler artifacts, not authoritative user requirements. Do not promote them into the implementation request.',
    "Do not rely on the user's memory of the Autopilot protocol; the protocol and schema below are authoritative for this turn.",
    '',
    'Separate user decisions from execution-plan details. User decisions are the implementation intent, repository/branch when the task is repository-scoped, and delivery.push when push permission is not clear. A repository is optional: host/local tasks may use repository:null, and repository:null requires delivery.push:false.',
    'If a required user decision is missing or ambiguous, do not guess and do not emit either proposal marker. Ask one short natural-language question about that user decision. Do not ask for a repository when the request is clearly a host/local task.',
    'Verification is an execution plan, not a user-facing requirement. If concrete verification commands are explicitly present in user-authored conversation, respect them. If they are absent, choose guidance based on the task type; absence of a command is never, by itself, a reason to ask the user.',
    'For repository tasks, use known repository-specific commands. If the repository commands are unknown, a conservative check such as git diff --check is allowed when it is reasonable for the task. Do not claim that an unknown script exists or fabricate a command. For host/local tasks, do not insert Git verification. If no clear host verification command can be constructed, use verification: [] so Codex execution evidence and ChatGPT review judge the outcome. Do not ask the user for command names or arguments.',
    'Use these system defaults when the conversation does not explicitly set execution tuning: review.maxRounds=10 and review.timeoutMs=300000. Verification may be an empty array for tasks whose result is reviewed through execution evidence. Never ask the user to choose execution tuning, command arguments, grep commands, or lint/test script names.',
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
    'Serialize the output JSON exactly as JSON.stringify would. Every string, including Windows paths, quotation marks, backslashes, and newlines, must use valid JSON escaping.',
    '',
    'The contract must conform exactly to the current ai-autopilot task-contract validator:',
    '- Top-level fields are exactly: schemaVersion, id, title, repository, agentify, implementation, verification, review, delivery, constraints. No unknown fields.',
    '- schemaVersion is 1. id is a short Windows-safe task id; title and implementation.prompt are non-empty strings.',
    '- repository is either null for host/local tasks or an object with slug and targetBranch; a repository object uses owner/name form and targetBranch is the requested existing branch.',
    '- agentify.tabKey is required and must equal the envelope tabKey.',
    '- implementation.prompt is required; implementation has no patch-attempt setting.',
    '- verification is an array, possibly empty, of objects with verification[].name, verification[].command, verification[].args, and verification[].timeoutMs; args is an array of strings and timeoutMs is a positive integer.',
    '- review.maxRounds is an integer from 1 through 10 and review.timeoutMs is a positive integer.',
    '- delivery.push is required and boolean; it must be false when repository is null.',
    '- constraints is an array of strings. Preserve explicit user constraints and add no unsafe delivery exception.',
    '',
    'Do not create a task, run Codex, create a worktree, write a file, commit, push, or fabricate the later user approval turn. This turn only prepares a proposal for visual review; the existing watcher still requires a later exact approval such as 開始して XXXXXXXX.',
    ...(retryAttempt > 0 ? [
      '',
      `System/compiler artifact correction for retry attempt ${retryAttempt}: the previous proposal output was invalid.`,
      'Keep the same implementation intent and user decisions. Keep the same supplied envelope metadata byte-for-byte; do not regenerate proposalId, timestamps, tabKey, or approvalCode.',
      'Return a valid JSON proposal. Apply strict JSON string escaping to every backslash, double quote, newline, and other control character; do not repair the previous text mechanically.',
      'Do not include a code fence. Return exactly one AUTOPILOT_PROPOSAL_BEGIN_V1 and one AUTOPILOT_PROPOSAL_END_V1 marker pair.'
    ] : [])
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
      const proposalNow = now();
      const metadata = createProposalMetadata({ now: proposalNow, tabKey: workflow.key, randomUUID, randomBytes });
      const attempts = [];
      for (let attempt = 1; attempt <= PROPOSAL_MAX_ATTEMPTS; attempt += 1) {
        const prompt = buildProposalGenerationPrompt({ metadata, retryAttempt: attempt > 1 ? attempt : 0 });
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
        const classification = classifyProposalResponse(responseTextFromQuery(response), { metadata, now: proposalNow });
        if (classification.kind === PROPOSAL_RESPONSE_KINDS.CLARIFICATION) {
          return {
            ok: false,
            status: 'clarification_response_received',
            tabId: state.tabId,
            metadata,
            prompt,
            response,
            clarification: classification,
            attempts: attempt
          };
        }
        if (classification.kind === PROPOSAL_RESPONSE_KINDS.VALID_PROPOSAL) {
          return { ok: true, status: 'proposal_response_received', tabId: state.tabId, metadata, prompt, response, proposal: classification.proposal, attempts: attempt };
        }
        attempts.push({ attempt, reason: classification.reason });
        if (attempt === PROPOSAL_MAX_ATTEMPTS) {
          const failure = new Error(`autopilot_proposal_generation_failed:${classification.reason}`);
          failure.code = 'autopilot_proposal_generation_failed';
          failure.reason = classification.reason;
          failure.data = { attempts };
          throw failure;
        }
      }
      throw new Error('autopilot_proposal_generation_failed:retry_exhausted');
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
