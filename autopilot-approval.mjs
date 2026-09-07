import { validateAutopilotProposalTicket } from './autopilot-proposal-ticket.mjs';

const MAX_TURNS = 200;
const MAX_CHARS_PER_TURN = 200_000;
const MAX_TOTAL_CHARS = 2_000_000;
const IGNORED_TURN_SOURCES = new Set(['assistant', 'system', 'proposal-generation', 'autopilot']);

export const AUTOPILOT_APPROVAL_RESULTS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
});

export async function resolveAutopilotProposalApproval({
  ticketStore,
  tabs,
  proposalId,
  now = new Date(),
} = {}) {
  if (!ticketStore || typeof ticketStore.get !== 'function') throw approvalError('ticket_invalid');
  const ticket = await ticketStore.get(proposalId);
  if (!ticket || ticket.proposalId !== proposalId) throw approvalError('ticket_invalid');
  const validated = validateAutopilotProposalTicket(ticket, { now, allowExpired: true });
  if (validated.schemaVersion === 1) return resolveLegacyTicket({ ticket: validated, tabs, now });
  if (validated.state !== 'pending') return { status: validated.state === 'acknowledged' || validated.state === 'consumed' ? AUTOPILOT_APPROVAL_RESULTS.APPROVED : AUTOPILOT_APPROVAL_RESULTS.PENDING, ticket: validated, approvalTurnId: null };
  if (Date.parse(validated.expiresAt) <= now.getTime()) return { status: AUTOPILOT_APPROVAL_RESULTS.PENDING, reason: 'ticket_expired', ticket: validated, approvalTurnId: null };

  const matchingTabs = (tabs?.listTabs?.() || []).filter((tab) => tab?.key === validated.tabKey);
  if (matchingTabs.length !== 1) throw approvalError(matchingTabs.length === 0 ? 'tab_invalid' : 'tab_ambiguous');
  const tab = matchingTabs[0];
  if (tab.id !== validated.tabId || tab.vendorId !== validated.vendorId) throw approvalError('tab_invalid');
  const controller = tabs.getControllerById(tab.id);
  if (!controller || typeof controller.getUrl !== 'function' || typeof controller.readConversationTurns !== 'function') throw approvalError('tab_invalid');
  const currentUrl = await controller.getUrl();
  if (String(currentUrl || '').trim() !== validated.conversationUrl) throw approvalError('conversation_changed');
  const conversation = await controller.readConversationTurns({
    maxTurns: MAX_TURNS,
    maxCharsPerTurn: MAX_CHARS_PER_TURN,
    maxTotalChars: MAX_TOTAL_CHARS,
    historyMode: 'tail',
  });
  if (String(conversation?.url || '').trim() !== validated.conversationUrl) throw approvalError('conversation_changed');
  if (conversation?.tabId && conversation.tabId !== validated.tabId) throw approvalError('tab_invalid');
  if (!conversation?.history || conversation.history.mode !== 'tail' || conversation.history.scopeComplete !== true || conversation.history.fullHistoryComplete === true || conversation.history.tailProven !== true || conversation.history.scrollRestored !== true) throw approvalError('tail_unproven');
  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const anchorPosition = turns.findIndex((turn) => isStoredAssistantAnchor(turn, validated));
  if (anchorPosition < 0) throw approvalError('anchor_missing');
  const approvals = turns.filter((turn, position) => position > anchorPosition && isUserAuthoredTurn(turn) && normalizeApproval(turn.text) === `開始して ${validated.approvalCode}` && isAfter(turns[anchorPosition], turn));
  if (approvals.length === 0) return { status: AUTOPILOT_APPROVAL_RESULTS.PENDING, reason: 'approval_missing', ticket: validated, approvalTurnId: null };
  // Repeated identical approval commands are an idempotent user action. The
  // first valid turn is the canonical identity so polling/restart is stable.
  const approval = approvals[0];
  return { status: AUTOPILOT_APPROVAL_RESULTS.APPROVED, ticket: validated, approvalTurnId: approvalTurnId(approval), conversation: { tabId: validated.tabId, vendorId: validated.vendorId, url: validated.conversationUrl } };
}

function resolveLegacyTicket({ ticket, tabs }) {
  throw approvalError('ticket_invalid');
}

function isStoredAssistantAnchor(turn, ticket) {
  if (turn?.role !== 'assistant' || turn.id !== ticket.assistantTurnId) return false;
  return turn.identityProvenance === ticket.assistantTurnIdentityProvenance;
}

function isUserAuthoredTurn(turn) {
  if (turn?.role !== 'user' || IGNORED_TURN_SOURCES.has(String(turn.source || '').trim().toLowerCase()) || turn.author === 'assistant' || turn.author === 'system') return false;
  if (turn?.userAuthored === false || turn?.isUserAuthored === false) return false;
  return true;
}

function normalizeApproval(value) {
  return String(value || '').replace(/\r\n?/gu, '\n').trim();
}

function isAfter(anchor, turn) {
  return !(Number.isInteger(anchor?.index) && Number.isInteger(turn?.index)) || turn.index > anchor.index;
}

function approvalTurnId(turn) {
  if (typeof turn?.id !== 'string' || !turn.id.trim()) throw approvalError('approval_identity_invalid');
  return turn.id;
}

function approvalError(reason) {
  const error = new Error(`autopilot_approval_${reason}`);
  error.code = `AUTOPILOT_APPROVAL_${String(reason).toUpperCase()}`;
  error.reason = reason;
  return error;
}
