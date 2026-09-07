export const AUTOPILOT_PRODUCTION_TAB_KEY = 'autopilot-production';
export const CURRENT_AUTOPILOT_TICKET_STATES = Object.freeze(['pending', 'acknowledged']);

export function selectCurrentAutopilotProposalTicket(tickets, { tabKey = AUTOPILOT_PRODUCTION_TAB_KEY } = {}) {
  if (!Array.isArray(tickets)) {
    return {
      ticket: null,
      error: { code: 'AUTOPILOT_PROPOSAL_TICKET_UNAVAILABLE', message: 'ticket list is invalid' },
    };
  }
  const candidates = tickets.filter((ticket) => (
    ticket?.schemaVersion === 2
    && ticket?.tabKey === tabKey
    && CURRENT_AUTOPILOT_TICKET_STATES.includes(ticket.state)
  ));
  if (candidates.length > 1) {
    return {
      ticket: null,
      error: {
        code: 'AUTOPILOT_PROPOSAL_TICKET_CONFLICT',
        message: `${candidates.length} unresolved V2 tickets match ${tabKey}`,
      },
    };
  }
  return { ticket: candidates[0] || null, error: null };
}
