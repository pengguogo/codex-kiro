import { spawn, spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { discoverModels } from './models.mjs';

const command = process.argv[2];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.KIRO_GATEWAY_PORT || '8765';
const base = `http://127.0.0.1:${port}`;
const kiro = process.env.KIRO_CLI_PATH || 'kiro-cli';
const stateDir = join(homedir(), '.config', 'codex-kiro');
const keyFile = join(stateDir, 'gateway-key');
function loadKey() {
  if (process.env.KIRO_GATEWAY_KEY) return process.env.KIRO_GATEWAY_KEY;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  return readFileSync(keyFile, 'utf8').trim();
}
function check(binary, args) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 10000 });
  console.log(`${binary}: ${result.error ? result.error.message : (result.stdout || result.stderr).trim()}`);
  return result.status === 0;
}
async function health() {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    const result = await res.json();
    return result.backend === 'kiro-cli-acp' ? result : null;
  } catch { return null; }
}

if (command === 'models') {
  const models = await discoverModels(kiro);
  for (const model of models) console.log(`kiro/${model.id}\t${model.name}`);
} else if (command === 'doctor') {
  const installed = check(kiro, ['--version']);
  check(process.env.CODEX_BIN || 'codex', ['--version']);
  if (installed) check(kiro, ['whoami']);
  console.log(`gateway: ${JSON.stringify(await health())}`);
  console.log('登录命令: kiro-cli login\n健康接口仅代表网关存活；真实模型调用请执行 npm run codex -- exec "只回复 Kiro OK"');
} else if (command === 'serve') {
  const child = spawn(process.execPath, [join(root, 'src', 'server.mjs')], {
    stdio: 'inherit', env: { ...process.env, KIRO_GATEWAY_KEY: loadKey() },
  });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} else if (command === 'run') {
  const key = loadKey();
  let gateway;
  const cleanup = () => gateway?.kill('SIGTERM');
  try {
    if (!await health()) {
      gateway = spawn(process.execPath, [join(root, 'src', 'server.mjs')], {
        stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, KIRO_GATEWAY_KEY: key },
      });
      let ready = false;
      for (let i = 0; i < 50; i++) {
        if (gateway.exitCode !== null) throw new Error('Gateway failed to start.');
        if (await health()) { ready = true; break; }
        await new Promise((resolve_) => setTimeout(resolve_, 100));
      }
      if (!ready) throw new Error('Gateway startup timed out.');
    }
    const probe = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(65000) });
    if (!probe.ok) throw new Error('Gateway key mismatch. Use the same KIRO_GATEWAY_KEY for gateway and launcher.');
    const codexHome = process.env.KIRO_CODEX_HOME || join(stateDir, 'codex');
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const catalogFile = join(codexHome, 'kiro-models.json');
    const catalogue = await probe.json();
    writeFileSync(catalogFile, JSON.stringify({ models: catalogue.models }), { mode: 0o600 });
    const overrides = {
      model_provider: 'kiro', model: process.env.KIRO_MODEL ? (process.env.KIRO_MODEL.startsWith('kiro/') ? process.env.KIRO_MODEL : `kiro/${process.env.KIRO_MODEL}`) : 'kiro/auto',
      model_catalog_json: catalogFile,
      'model_providers.kiro.name': 'Company Kiro CLI',
      'model_providers.kiro.base_url': `${base}/v1`,
      'model_providers.kiro.wire_api': 'responses',
      'model_providers.kiro.env_key': 'KIRO_GATEWAY_KEY',
      'model_providers.kiro.requires_openai_auth': false,
      'model_providers.kiro.supports_websockets': false,
      'model_providers.kiro.request_max_retries': 0,
      'model_providers.kiro.stream_max_retries': 0,
      'features.responses_websockets': false,
      'features.responses_websockets_v2': false,
      web_search: 'disabled',
    };
    const args = process.argv.slice(3);
    // Appended config overrides win over ordinary user config and earlier flags.
    for (const [name, value] of Object.entries(overrides)) args.push('-c', `${name}=${JSON.stringify(value)}`);
    console.error(`模型路由: Codex → ${base}/v1/responses → Kiro CLI（无 OpenAI 回退）`);
    const codex = spawn(process.env.CODEX_BIN || 'codex', args, {
      stdio: 'inherit', env: { ...process.env, CODEX_HOME: codexHome, KIRO_GATEWAY_KEY: key },
    });
    codex.on('error', (error) => { console.error(error.message); cleanup(); process.exitCode = 1; });
    codex.on('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { codex.kill(signal); cleanup(); });
  } catch (error) {
    cleanup();
    console.error(error.message);
    process.exitCode = 1;
  }
} else {
  console.log('用法:\n  node src/cli.mjs doctor\n  node src/cli.mjs serve\n  node /绝对路径/codex-kiro/src/cli.mjs run [Codex 参数]\n\nrun 自动启动网关并在退出时关闭；不会修改 ~/.codex/config.toml。');
}
