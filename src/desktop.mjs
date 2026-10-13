import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, chmodSync, statSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { modelInfo } from './protocol.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = join(homedir(), '.config', 'codex-kiro');
export const desktopHome = join(state, 'desktop');
const mainConfig = join(homedir(), '.codex', 'config.toml');
const manifestFile = join(desktopHome, 'experiment.json');
const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const provider = 'kiro-desktop-experiment';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Only root scalar settings are replaced. Preserve every unrelated table/comment.
export function desktopConfig(original, providerConfig, catalog) {
  const overrides = new Set(['model', 'model_provider', 'model_catalog_json', 'web_search', 'model_reasoning_effort', 'service_tier']);
  let inTable = false;
  const lines = original.split('\n').filter((line) => {
    if (/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line)) inTable = true;
    const key = /^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=/.exec(line)?.[1];
    return inTable || !overrides.has(key);
  });
  return `model = "auto"\nmodel_provider = "${provider}"\nmodel_catalog_json = ${JSON.stringify(catalog)}\nweb_search = "disabled"\n`
    + lines.join('\n').trimEnd() + '\n\n' + providerConfig;
}

function providerToml() {
  return `[model_providers.${provider}]\nname = "Company Kiro (Desktop Experiment)"\n`
    + `base_url = "http://127.0.0.1:8765/v1"\nwire_api = "responses"\nsupports_websockets = false\n`
    + `request_max_retries = 0\nstream_max_retries = 0\n\n`
    + `[model_providers.${provider}.auth]\ncommand = ${JSON.stringify(process.execPath)}\n`
    + `args = [${JSON.stringify(join(root, 'src', 'gateway-token.mjs'))}]\ntimeout_ms = 5000\nrefresh_interval_ms = 300000\n`;
}
function validateToml(path) {
  const result = spawnSync(process.env.KIRO_PYTHON || 'python3', ['-c', 'import pathlib,tomllib,sys; tomllib.loads(pathlib.Path(sys.argv[1]).read_text())', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Invalid TOML: ${result.stderr}`);
}
function replaceMainConfig(content) {
  const temp = `${mainConfig}.kiro-experiment-${process.pid}.tmp`;
  writeFileSync(temp, content, { flag: 'wx', mode: statSync(mainConfig).mode & 0o777 });
  renameSync(temp, mainConfig);
}
export function prepareDesktop() {
  mkdirSync(desktopHome, { recursive: true, mode: 0o700 });
  const keyFile = join(state, 'gateway-key');
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  const catalog = join(desktopHome, 'kiro-models.json');
  writeFileSync(catalog, JSON.stringify({ models: [modelInfo('auto')] }), { mode: 0o600 });
  const configFile = join(desktopHome, 'config.toml');
  writeFileSync(configFile, desktopConfig('', providerToml(), catalog), { mode: 0o600 });
  validateToml(configFile);
  const workspace = join(desktopHome, 'workspace');
  mkdirSync(workspace, { recursive: true });
  if (!existsSync(join(workspace, 'AGENTS.md'))) writeFileSync(join(workspace, 'AGENTS.md'),
    '# Kiro 桌面验证\n只操作当前测试目录，默认用中文回答。禁止操作此目录之外的文件。\n');
  if (!existsSync(join(workspace, 'answer.txt'))) writeFileSync(join(workspace, 'answer.txt'), 'before\n');
  return { configFile, catalog, workspace, bundledCodex };
}

async function startGateway() {
  const key = readFileSync(join(state, 'gateway-key'), 'utf8').trim();
  try {
    const res = await fetch('http://127.0.0.1:8765/v1/status', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(1000) });
    if (!res.ok) throw new Error('Port 8765 is occupied or gateway key does not match.');
    const models = await res.json();
    if (models.backend !== 'kiro-cli-acp' || models.version !== '0.2.0') throw new Error('Restart the old gateway before continuing.');
    return;
  } catch (error) {
    if (!['TypeError', 'TimeoutError'].includes(error.name)) throw error;
  }
  const { openSync, closeSync } = await import('node:fs');
  const log = openSync(join(desktopHome, 'gateway.log'), 'a', 0o600);
  const child = spawn(process.execPath, [join(root, 'src', 'server.mjs')], {
    detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, KIRO_GATEWAY_KEY: key, KIRO_GATEWAY_PORT: '8765', KIRO_MODEL: 'auto',
      KIRO_CLI_PATH: process.env.KIRO_CLI_PATH || join(homedir(), '.local', 'bin', 'kiro-cli') },
  });
  closeSync(log);
  child.unref();
  writeFileSync(join(desktopHome, 'gateway.pid'), String(child.pid), { mode: 0o600 });
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve_) => setTimeout(resolve_, 100));
    try {
      const res = await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(500) });
      if (res.ok && (await res.json()).backend === 'kiro-cli-acp') return;
    } catch {}
  }
  throw new Error('Gateway startup failed. Check desktop/gateway.log.');
}

export async function restartGateway(force = false, runtime = {}) {
  const request = runtime.fetch || fetch;
  const inspect = runtime.spawnSync || spawnSync;
  const kill = runtime.kill || process.kill.bind(process);
  const start = runtime.start || startGateway;
  const pause = runtime.pause || (() => new Promise((resolve_) => setTimeout(resolve_, 100)));
  const key = runtime.key ?? readFileSync(join(state, 'gateway-key'), 'utf8').trim();
  let health;
  try {
    health = await request('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(3000) }).then((res) => res.json());
  } catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED') throw error;
    await start();
    return;
  }
  if (health.backend !== 'kiro-cli-acp' || (!force && health.active_requests !== 0)) throw new Error('网关仍有运行中的请求；请先停止 Kiro 聊天，再运行 restart。');
  const status = await request('http://127.0.0.1:8765/v1/status', { headers: { Authorization: `Bearer ${key}` } });
  if (!status.ok) throw new Error('Gateway authentication failed; refusing restart.');
  const found = inspect('lsof', ['-t', '-iTCP:8765', '-sTCP:LISTEN'], { encoding: 'utf8' });
  const pid = Number(found.stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Cannot identify a unique gateway process.');
  const inspected = inspect('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  const command = inspected.stdout.trim();
  const expected = join(root, 'src', 'server.mjs');
  if (inspected.status !== 0 || !/^\S*node /.test(command) || command.slice(command.indexOf(' ') + 1) !== expected) {
    throw new Error('Port 8765 belongs to another process; refusing restart.');
  }
  kill(pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    try { kill(pid, 0); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      await start();
      return;
    }
    await pause();
  }
  throw new Error('Gateway has not stopped; no replacement process started.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const action = process.argv[2] || 'prepare';
    if (action === 'prepare') {
      const files = prepareDesktop();
      await startGateway();
      console.log(JSON.stringify(files, null, 2));
    } else if (action === 'restart') {
      prepareDesktop();
      await restartGateway(process.argv.includes('--force'));
      console.log('网关已安全重启。');
    } else if (action === 'enable') {
      throw new Error('Global provider switching is retired. Use scripts/manage-desktop.py install for coexistence.');
    } else if (action === 'restore') {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      if (hash(readFileSync(mainConfig)) !== manifest.activeHash) throw new Error('Config changed after enabling. Refusing to overwrite new changes; merge with the saved backup.');
      const backup = readFileSync(manifest.backup);
      if (hash(backup) !== manifest.originalHash) throw new Error('Backup hash mismatch.');
      replaceMainConfig(backup);
      renameSync(manifestFile, join(desktopHome, `restored-${Date.now()}.json`));
      console.log('Original configuration restored byte-for-byte. Restart the app.');
    } else if (action === 'status') {
      const res = await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(1000) });
      console.log(JSON.stringify(await res.json()));
      console.log(`Desktop config applied: ${existsSync(manifestFile)}\nLog: ${join(desktopHome, 'gateway.log')}`);
    } else throw new Error('Use: prepare | restart | restore | status');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
