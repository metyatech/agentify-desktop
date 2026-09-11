import { sanitizeQueryDiagnostics } from './http-api.mjs';

const IPC_ERROR_MESSAGE_MAX_LENGTH = 256;
const KNOWN_AUTOPILOT_PROPOSAL_CODES = new Set([
  'chrome_cdp_command_timeout',
  'agentify_query_unavailable',
  'autopilot_workflow_not_configured',
  'autopilot_production_tab_unavailable',
  'autopilot_production_tab_ambiguous',
  'autopilot_production_tab_not_chatgpt',
  'autopilot_query_already_active',
  'autopilot_production_tab_unusable',
  'autopilot_proposal_request_inflight',
  'autopilot_codex_selection_invalid',
  'autopilot_proposal_ticket_unresolved',
  'autopilot_proposal_intent_conversation_changed',
  'autopilot_proposal_intent_tail_unproven',
  'autopilot_proposal_generation_failed',
  'proposal_response_invalid',
  'autopilot_proposal_anchor_invalid'
]);

function boundedMessage(value) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return (text || 'autopilot_proposal_request_failed').slice(0, IPC_ERROR_MESSAGE_MAX_LENGTH);
}

function knownCode(value) {
  const text = String(value || '').trim();
  if (KNOWN_AUTOPILOT_PROPOSAL_CODES.has(text)) return text;
  for (const prefix of ['autopilot_proposal_generation_failed:', 'proposal_response_invalid:', 'autopilot_codex_selection_invalid:']) {
    if (text.startsWith(prefix)) return prefix.slice(0, -1);
  }
  if (text.startsWith('autopilot_proposal_anchor_')) return 'autopilot_proposal_anchor_invalid';
  return null;
}

function timeoutData(error) {
  const body = error?.data?.body;
  if (body?.error !== 'chrome_cdp_command_timeout') return null;
  return sanitizeQueryDiagnostics(body.data);
}

export function createAutopilotProposalIpcSuccess(value) {
  return { ok: true, value };
}

export function createAutopilotProposalIpcFailure(error) {
  const body = error?.data?.body;
  const code = knownCode(body?.error) || knownCode(error?.code) || knownCode(error?.message);
  return {
    ok: false,
    error: {
      message: boundedMessage(code),
      code,
      diagnostics: code === 'chrome_cdp_command_timeout' ? timeoutData(error) : null
    }
  };
}
