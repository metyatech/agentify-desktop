const ACTIVE_WATCH_STATES = new Set(['observed', 'approved', 'launch-prepared', 'launch-started', 'running', 'reviewing', 'fixing', 'delivery']);

export function deriveAutopilotProposalAuthority({ proposalTicket = null, watchStatus = null, taskStatus = null } = {}) {
  if (proposalTicket?.schemaVersion === 2 && ['pending', 'acknowledged'].includes(proposalTicket.state)) {
    return {
      proposalId: proposalTicket.proposalId,
      taskId: proposalTicket.taskId,
      approvalCode: proposalTicket.approvalCode,
    };
  }
  const watchedProposal = watchStatus?.proposal;
  const activeWatch = watchedProposal
    && ACTIVE_WATCH_STATES.has(watchedProposal.state)
    && watchedProposal.state !== 'observed'
    && watchStatus?.status === 'healthy'
    && watchStatus?.stale !== true
    && (!taskStatus || (taskStatus.status === 'running' && taskStatus.taskId === watchedProposal.taskId));
  if (activeWatch) {
    return {
      proposalId: watchedProposal.proposalId,
      taskId: watchedProposal.taskId,
      approvalCode: watchedProposal.approvalCode,
    };
  }
  if (taskStatus?.status === 'running' && taskStatus.taskId) {
    const matchingWatchProposal = watchedProposal?.taskId === taskStatus.taskId ? watchedProposal : null;
    return {
      proposalId: matchingWatchProposal?.proposalId || null,
      taskId: taskStatus.taskId,
      approvalCode: matchingWatchProposal?.approvalCode || null,
    };
  }
  return null;
}

export function isAutopilotProposalRequestDisabled({ proposalView = null, runtimeReady = false, requestInFlight = false, ticketError = null } = {}) {
  return requestInFlight || !runtimeReady || !!ticketError || !!proposalView?.disableRequest;
}

export function autopilotProposalViewModel({ proposal = null, proposalTicket = null, watchStatus = null, taskStatus = null } = {}) {
  if (!proposal && proposalTicket && ['pending', 'acknowledged'].includes(proposalTicket.state)) {
    proposal = {
      proposalId: proposalTicket.proposalId,
      taskId: proposalTicket.taskId || proposalTicket.proposal?.contract?.id || null,
      approvalCode: proposalTicket.approvalCode || proposalTicket.proposal?.approvalCode || null,
    };
  }
  if (!proposal) return { key: 'ready', label: '準備可能', detail: 'クリックするとChatGPTへproposal生成を依頼します。生成後は承認コードで開始できます。', disableRequest: false, command: null };
  const observed = watchStatus?.proposal?.proposalId === proposal.proposalId;
  const runningTask = taskStatus?.status === 'running' && taskStatus?.taskId === proposal.taskId;
  const matchingTask = taskStatus?.taskId === proposal.taskId;
  if (matchingTask && taskStatus.status === 'completed') return { key: 'completed', label: '完了', detail: 'このtaskはreviewとdeliveryを完了しました。', disableRequest: false, command: null };
  if (matchingTask && taskStatus.status === 'blocked') {
    const code = taskStatus.lastError?.code || taskStatus.errorCode || 'TASK_BLOCKED';
    return { key: 'error', label: 'エラー停止', detail: `taskが停止しました。${code}。`, disableRequest: false, command: null, errorCode: code };
  }
  if (matchingTask && ['reviewing', 'fixing', 'delivery'].includes(taskStatus.phase)) {
    const phase = taskStatus.phase;
    if (phase === 'reviewing') return { key: 'reviewing', label: 'ChatGPTレビュー中', detail: 'ChatGPTのreview結果を待っています。', disableRequest: true, command: null };
    if (phase === 'fixing') return { key: 'fixing', label: `修正中 ${taskStatus.reviewRound || 0}/${taskStatus.reviewMaxRounds || '?'}`, detail: 'review結果に基づくCodex修正を実行しています。', disableRequest: true, command: null };
    return { key: 'delivery', label: 'Delivery中', detail: 'PASS済み結果をdeliveryしています。', disableRequest: true, command: null };
  }
  if (runningTask) return { key: 'running', label: 'Codex実行中', detail: 'Codexの実行状態を表示しています。', disableRequest: true, command: null };
  if (watchStatus?.status === 'error') {
    const code = watchStatus.lastError?.code || 'WATCH_ERROR';
    return { key: 'error', label: 'エラー停止', detail: `${code}。再承認・再送せず、エラーを確認してください。`, disableRequest: true, command: null, errorCode: code };
  }
  if (watchStatus?.stale && Number.isFinite(watchStatus.ageMs)) {
    return { key: 'stale', label: 'Watcher offline / stale', detail: 'watcherのheartbeatが更新されていません。watcherが再開するまで承認は待機してください。', disableRequest: true, command: null };
  }
  if (!observed || !ACTIVE_WATCH_STATES.has(watchStatus.proposal.state)) {
    if (observed && ['completed', 'blocked'].includes(watchStatus.proposal.state)) {
      return { key: watchStatus.proposal.state, label: watchStatus.proposal.state === 'completed' ? 'Completed' : 'Blocked', detail: 'このproposalのtaskは終了しています。新しい相談を実行できます。', disableRequest: false, command: null };
    }
    return { key: 'watching', label: 'watcher確認中', detail: '生成したproposalをwatcherが確認しています。確認されるまで承認は送信しないでください。', disableRequest: true, command: null };
  }
  const state = watchStatus.proposal.state;
  if (state === 'observed') {
    return {
      key: 'approval-waiting',
      label: '承認待ち',
      detail: '承認コードを確認し、問題なければ次の開始文を送信してください。',
      disableRequest: true,
      command: `開始して ${proposal.approvalCode}`,
    };
  }
  if (state === 'approved' || state === 'launch-prepared') return { key: 'approved', label: '承認済み — 実行準備中', detail: '承認済みです。controllerの起動を準備しています。', disableRequest: true, command: null };
  if (state === 'launch-started' || state === 'running') return { key: 'running', label: 'Codex実行中', detail: 'Codexの実行状態を表示しています。', disableRequest: true, command: null };
}

export function isActiveAutopilotProposal(proposal, watchStatus, taskStatus = null) {
  const view = autopilotProposalViewModel({ proposal, watchStatus, taskStatus });
  return view.disableRequest && view.key !== 'error';
}
