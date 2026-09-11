const { contextBridge, ipcRenderer } = require('electron');

const IPC_ERROR_MESSAGE_MAX_LENGTH = 256;
const IPC_DISPATCH_STATES = new Set(['pending', 'claimed', 'dispatching', 'dispatched', 'cancelled', 'unknown']);
const IPC_OWNERSHIP_PHASES = new Set(['prepared', 'attachments-owned', 'prompt-owned', 'dispatch-started', 'send-confirmed', 'cleanup-required', 'cleared']);

function boundedIpcId(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(text) ? text : null;
}

function boundedIpcMethod(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z][A-Za-z0-9_.]{0,79}$/u.test(text) ? text : null;
}

function boundedIpcPhase(value) {
  const text = String(value || '').trim();
  return /^[a-z][a-z0-9_-]{0,63}$/u.test(text) ? text : null;
}

function sanitizeIpcDiagnostics(value) {
  const source = value && typeof value === 'object' ? value : {};
  const diagnostics = {
    errorCode: source.errorCode === 'chrome_cdp_command_timeout' ? source.errorCode : null,
    method: boundedIpcMethod(source.method),
    targetId: boundedIpcId(source.targetId),
    operationId: boundedIpcId(source.operationId),
    phase: boundedIpcPhase(source.phase),
    queryPhase: boundedIpcPhase(source.queryPhase),
    ownershipPhase: IPC_OWNERSHIP_PHASES.has(source.ownershipPhase) ? source.ownershipPhase : null,
    promptTyped: source.promptTyped === true,
    messageDispatchStarted: source.messageDispatchStarted === true,
    dispatchState: IPC_DISPATCH_STATES.has(source.dispatchState) ? source.dispatchState : null,
    dispatchStateUnknown: source.dispatchStateUnknown === true,
    sendAttemptCompleted: source.sendAttemptCompleted === true,
    sendConfirmed: source.sendConfirmed === true,
    messageDispatchState: ['not-dispatched', 'unknown', 'confirmed'].includes(source.messageDispatchState)
      ? source.messageDispatchState
      : null
  };
  return diagnostics;
}

function unwrapAutopilotProposalResult(result) {
  if (result?.ok === true && Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
  if (result?.ok !== false || !result.error || typeof result.error !== 'object') return result;
  const rawMessage = String(result.error.message || 'autopilot_proposal_request_failed')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const error = new Error((rawMessage || 'autopilot_proposal_request_failed').slice(0, IPC_ERROR_MESSAGE_MAX_LENGTH));
  const code = typeof result.error.code === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(result.error.code)
    ? result.error.code
    : null;
  if (code) error.code = code;
  error.data = { diagnostics: result.error.diagnostics ? sanitizeIpcDiagnostics(result.error.diagnostics) : null };
  throw error;
}

contextBridge.exposeInMainWorld('agentifyDesktop', {
  getState: () => ipcRenderer.invoke('agentify:getState'),
  getSettings: () => ipcRenderer.invoke('agentify:getSettings'),
  setSettings: (args) => ipcRenderer.invoke('agentify:setSettings', args || {}),
  createTab: (args) => ipcRenderer.invoke('agentify:createTab', args || {}),
  showTab: (args) => ipcRenderer.invoke('agentify:showTab', args || {}),
  hideTab: (args) => ipcRenderer.invoke('agentify:hideTab', args || {}),
  setTabsVisible: (args) => ipcRenderer.invoke('agentify:setTabsVisible', args || {}),
  showAllTabs: () => ipcRenderer.invoke('agentify:showAllTabs'),
  hideAllTabs: () => ipcRenderer.invoke('agentify:hideAllTabs'),
  closeTab: (args) => ipcRenderer.invoke('agentify:closeTab', args || {}),
  stopQuery: (args) => ipcRenderer.invoke('agentify:stopQuery', args || {}),
  requestAutopilotProposal: async () => unwrapAutopilotProposalResult(await ipcRenderer.invoke('agentify:requestAutopilotProposal')),
  openCodexThread: (args) => ipcRenderer.invoke('agentify:openCodexThread', args || {}),
  restartAutopilotWatcher: () => ipcRenderer.invoke('agentify:restartAutopilotWatcher'),
  clearAutopilotStatus: () => ipcRenderer.invoke('agentify:clearAutopilotStatus'),
  openStateDir: () => ipcRenderer.invoke('agentify:openStateDir'),
  openArtifactsDir: () => ipcRenderer.invoke('agentify:openArtifactsDir'),
  openWatchFolder: (args) => ipcRenderer.invoke('agentify:openWatchFolder', args || {}),
  listWatchFolders: () => ipcRenderer.invoke('agentify:listWatchFolders'),
  addWatchFolder: (args) => ipcRenderer.invoke('agentify:addWatchFolder', args || {}),
  removeWatchFolder: (args) => ipcRenderer.invoke('agentify:removeWatchFolder', args || {}),
  pickWatchFolder: () => ipcRenderer.invoke('agentify:pickWatchFolder'),
  scanWatchFolders: () => ipcRenderer.invoke('agentify:scanWatchFolders'),
  onTabsChanged: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = () => cb();
    ipcRenderer.on('agentify:tabsChanged', handler);
    return () => {
      try {
        ipcRenderer.removeListener('agentify:tabsChanged', handler);
      } catch {}
    };
  }
});
