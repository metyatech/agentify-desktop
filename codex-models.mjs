import { spawn } from 'node:child_process';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function parseCodexModelListResponse(response) {
  const models = Array.isArray(response?.models) ? response.models : Array.isArray(response?.data) ? response.data : [];
  return models.map((model) => ({
    id: String(model?.id || model?.model || '').trim(),
    displayName: String(model?.displayName || model?.display_name || model?.name || model?.id || '').trim(),
    description: String(model?.description || '').trim() || null,
    supportedReasoningEfforts: (model?.supportedReasoningEfforts || model?.supported_reasoning_efforts || []).map((value) => String(value?.reasoningEffort || value?.reasoning_effort || value || '').trim()).filter(Boolean),
    defaultReasoningEffort: String(model?.defaultReasoningEffort || model?.default_reasoning_effort || '').trim() || null,
    isDefault: model?.isDefault === true || model?.is_default === true || model?.default === true,
    hidden: model?.hidden === true,
    available: model?.available !== false,
  })).filter((model) => SAFE_ID.test(model.id));
}

export function validateCodexSelection(selection, models) {
  if (!selection || !SAFE_ID.test(String(selection.model || '')) || !SAFE_ID.test(String(selection.reasoningEffort || ''))) throw new Error('codex_selection_invalid');
  const model = (models || []).find((item) => item.id === selection.model);
  if (!model || model.hidden || model.available === false) throw new Error('codex_model_unavailable');
  if (!model.supportedReasoningEfforts.includes(selection.reasoningEffort)) throw new Error('codex_reasoning_effort_unsupported');
  return { model: selection.model, reasoningEffort: selection.reasoningEffort };
}

export async function listCodexModels({ timeoutMs = 15_000, env = process.env, spawnImpl = spawn } = {}) {
  const command = process.platform === 'win32' ? (env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : 'codex';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'call codex app-server --stdio'] : ['app-server', '--stdio'];
  const child = spawnImpl(command, args, { env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  return await new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(new Error('codex_model_list_timeout')); }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      for (const line of buffer.split(/\r?\n/u).slice(0, -1)) {
        try {
          const message = JSON.parse(line);
          if (message.id === 2) {
            finish(message.error ? new Error('codex_model_list_error') : null, parseCodexModelListResponse(message.result));
            try { child.kill(); } catch { /* the catalog result is already authoritative */ }
          }
        } catch { /* malformed diagnostics are unrelated to the catalog */ }
      }
      buffer = buffer.split(/\r?\n/u).at(-1) || '';
    });
    child.once?.('error', (error) => finish(error));
    child.once?.('close', (code) => { if (!settled && code !== 0) finish(new Error('codex_model_list_exit')); });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'agentify-desktop', version: '0.2.4' }, capabilities: { experimentalApi: true } } })}\n`);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'model/list', params: { cursor: null, limit: 100, includeHidden: true } })}\n`);
  });
}

export function defaultCodexSelection(models) {
  const model = (models || []).find((item) => item.available !== false && !item.hidden && item.isDefault) || (models || []).find((item) => item.available !== false && !item.hidden);
  if (!model) return null;
  const reasoningEffort = model.defaultReasoningEffort && model.supportedReasoningEfforts.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort : model.supportedReasoningEfforts[0];
  return reasoningEffort ? { model: model.id, reasoningEffort } : null;
}
