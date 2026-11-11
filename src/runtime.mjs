import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
export function resolveProfilePath({ configPath, env = process.env } = {}) {
  const path = configPath ?? env.MAGPIE_CLAUDE_PROFILE_FILE ?? fileURLToPath(new URL('../runtime/profile.json', import.meta.url));
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('配置文件必须使用绝对路径');
  return path;
}
export function parseSetupArgs(args) {
  const result = { configPath: undefined, port: 0, open: true, help: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--config') {
      const path = args[++index];
      if (!path || path.startsWith('--') || !isAbsolute(path)) throw new Error('--config 必须填写绝对路径');
      result.configPath = path;
    } else if (argument === '--port') {
      const value = args[++index];
      if (!/^\d+$/.test(value ?? '') || Number(value) > 65535) throw new Error('--port 必须是 0 到 65535 的端口');
      result.port = Number(value);
    } else if (argument === '--no-open') result.open = false;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else throw new Error('未知参数，请运行 --help 查看用法');
  }
  return result;
}
export function openBrowser(url, { platform = process.platform, launch = spawn } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password) return Promise.reject(new Error('只允许打开当前回环配置页面'));
  const command = platform === 'win32' ? 'rundll32.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise(resolve => {
    try {
      const child = launch(command, args, { shell: false, detached: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch { resolve(false); }
  });
}
