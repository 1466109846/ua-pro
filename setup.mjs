import { createProfileStore } from './src/store.mjs';
import { startSetupServer } from './src/setup-server.mjs';
import { resolveProfilePath, parseSetupArgs, openBrowser } from './src/runtime.mjs';
import { createAccountManager } from './src/accounts.mjs';
import { dirname, join } from 'node:path';
import { createUAStore } from './src/ua-store.mjs';
import { createUAService } from './src/ua-service.mjs';

async function main() {
  const args = parseSetupArgs(process.argv.slice(2));
  if (args.help) {
    console.log('UA PRO 设置\n\nnode setup.mjs [--config <绝对路径>] [--port <端口>] [--no-open]\n\n默认只监听 127.0.0.1，端口随机。MAGPIE_CLAUDE_PROFILE_FILE 可指定配置文件。\n远程宿主请使用 SSH 隧道。启动和保存配置不会访问上游；点击“检查连接”会读取模型列表，不发送聊天请求；账号页的刷新与签到会请求你填写的站点。');
    return;
  }
  const store = createProfileStore(resolveProfilePath({ configPath: args.configPath }));
  const accountManager = createAccountManager({ path: join(dirname(store.path), 'accounts.json') });
  const uaStore = createUAStore(process.env.UA_PRO_FILE || join(dirname(store.path), 'ua-pro.json'));
  const uaService = createUAService({ store: uaStore, legacyStore: store, accountManager });
  const session = await startSetupServer({ store, accountManager, uaService, port: args.port, finishOnSave: false });
  console.log(`配置页面：${session.url}\n账号管理：${new URL('accounts', session.url).href}\n配置文件：${store.path}\n页面链接仅本次有效，请勿分享。`);
  if (args.open && !await openBrowser(session.url)) console.log('未找到可用的浏览器，请手动打开上面的本地链接。');
  const stop = () => { void session.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const result = await session.finished;
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (result.status === 'saved') console.log('配置已保存。上游地址、协议或模型列表改变后，请在 Magpie 重载插件。');
  else if (result.status === 'managed') console.log('账号管理已完成，账号与额度记录已保存。');
  else if (result.status === 'timeout') console.log('配置页面已超时；此前已保存的配置与账号记录保留。');
  else console.log('配置已关闭；未提交的更改不保存，已保存的配置与账号记录保留。');
  await new Promise((resolve) => setTimeout(resolve, 500));
  await session.close();
}

main().catch(() => {
  console.error('无法启动配置页面，请检查参数、配置文件格式与目录权限。运行 --help 查看用法。');
  process.exitCode = 1;
});
