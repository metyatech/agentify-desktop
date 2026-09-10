import { execFile } from 'node:child_process';

export function isCodexThreadId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(value || '').trim());
}

export async function detectCodexDeepLink({ platform = process.platform, execFileImpl = execFile } = {}) {
  if (platform !== 'win32') return false;
  return await new Promise((resolve) => {
    execFileImpl('reg.exe', ['query', 'HKCR\\codex\\shell\\open\\command'], { windowsHide: true }, (error, stdout) => {
      resolve(!error && /codex|openai/iu.test(String(stdout || '')));
    });
  });
}
