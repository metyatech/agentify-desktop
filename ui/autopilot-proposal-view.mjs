const ACTIVE_WATCH_STATES = new Set(['observed', 'approved', 'launch-prepared', 'launch-started', 'running']);

export function autopilotProposalViewModel({ proposal = null, watchStatus = null, taskStatus = null } = {}) {
  if (!proposal) return { key: 'ready', label: '準備可能', detail: 'クリックするとChatGPTへproposal生成を依頼します。返答後に内容を目視確認してください。', disableRequest: false, command: null };
  const observed = watchStatus?.proposal?.proposalId === proposal.proposalId;
  const runningTask = taskStatus?.status === 'running' && taskStatus?.taskId === proposal.taskId;
  if (runningTask) return { key: 'running', label: '実行中', detail: 'task progressを表示しています。', disableRequest: true, command: null };
  if (watchStatus?.status === 'error') {
    const code = watchStatus.lastError?.code || 'WATCH_ERROR';
    return { key: 'error', label: 'watcherエラー', detail: `watcherが確認できません。${code}。しばらく待ってから再試行できます。`, disableRequest: false, command: null, errorCode: code };
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
      detail: 'watcher確認済みです。ChatGPT上のproposal内容を確認し、問題なければ次の承認文を送信してください。',
      disableRequest: true,
      command: `開始して ${proposal.approvalCode}`,
    };
  }
  if (state === 'approved') return { key: 'approved', label: '承認済み・開始準備中', detail: '承認をwatcherが検出しました。task起動の準備中です。', disableRequest: true, command: null };
  if (state === 'launch-prepared' || state === 'launch-started') return { key: 'launching', label: 'task起動中', detail: 'task controllerの起動を準備しています。', disableRequest: true, command: null };
  return { key: 'running', label: '実行中', detail: 'task progressを表示しています。', disableRequest: true, command: null };
}

export function isActiveAutopilotProposal(proposal, watchStatus, taskStatus = null) {
  const view = autopilotProposalViewModel({ proposal, watchStatus, taskStatus });
  return view.disableRequest && view.key !== 'error';
}
