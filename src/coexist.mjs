import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { discoverModels, modelEnvelope } from './models.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const state = join(homedir(), '.config', 'codex-kiro', 'coexist');
const codex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const mainConfig = join(homedir(), '.codex', 'config.toml');
mkdirSync(state, { recursive: true, mode: 0o700 });
const refresh = process.argv.includes('--refresh');
const original = readFileSync(mainConfig, 'utf8');
const config = spawnSync('python3', ['-c', 'import json,tomllib,sys; d=tomllib.loads(sys.stdin.read()); print(json.dumps({"provider":d.get("model_provider","openai"),"catalog":d.get("model_catalog_json"),"hasKiro":"kiro" in d.get("model_providers",{})}))'], { input: original, encoding: 'utf8' });
if (config.status !== 0) throw new Error('Cannot parse personal config');
const settings = JSON.parse(config.stdout);
if (!refresh && (settings.provider !== 'openai' || settings.hasKiro)) throw new Error('Expected restored personal configuration with no kiro provider.');
const exported = spawnSync(codex, ['debug', 'models', '--bundled'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (exported.status !== 0) throw new Error('Cannot export bundled model catalogue');
const bundled = settings.catalog ? JSON.parse(readFileSync(settings.catalog, 'utf8')) : JSON.parse(exported.stdout);
if (refresh) bundled.models = bundled.models.filter((model) => !model.slug.startsWith('kiro/'));
const kiro = await discoverModels(process.env.KIRO_CLI_PATH || join(homedir(), '.local', 'bin', 'kiro-cli'));
const extra = modelEnvelope(kiro).models;
const existingIds = new Set(bundled.models.map((model) => model.slug));
if (extra.some((model) => existingIds.has(model.slug))) throw new Error('Model ID collision');
const catalog = join(state, 'all-models.json');
writeFileSync(catalog, JSON.stringify({ ...bundled, models: [...bundled.models, ...extra] }, null, 2), { mode: 0o600 });
const mapping = { version: 1, default_provider: 'openai', providers: [
  { id: 'openai', label: 'ChatGPT / OpenAI', description: '个人账号' },
  { id: 'kiro', label: 'Company Kiro', description: '公司 Kiro CLI 账号' },
], model_providers: Object.fromEntries(extra.map((model) => [model.slug, 'kiro'])) };
writeFileSync(join(state, 'desktop-model-providers.json'), JSON.stringify(mapping, null, 2), { mode: 0o600 });
if (refresh) {
  console.log(`Refreshed ${bundled.models.length} original models + ${kiro.length} Kiro entries. Restart desktop to reload the catalogue.`);
  process.exit(0);
}
// Add only a catalogue root field and a new provider table. Never switch model/provider defaults.
let inTable = false;
const kept = original.split('\n').filter((line) => {
  if (/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line)) inTable = true;
  return inTable || !/^\s*model_catalog_json\s*=/.test(line);
}).join('\n').trimEnd();
const addition = `[model_providers.kiro]\nname = "Company Kiro"\nbase_url = "http://127.0.0.1:8765/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n\n[model_providers.kiro.auth]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(root, 'src', 'gateway-token.mjs'))}]\ntimeout_ms = 5000\nrefresh_interval_ms = 300000\n`;
const candidate = `model_catalog_json = ${JSON.stringify(catalog)}\n${kept}\n\n# codex-kiro coexist provider\n${addition}`;
writeFileSync(join(state, 'config-original.toml'), original, { mode: 0o600 });
writeFileSync(join(state, 'config-candidate.toml'), candidate, { mode: 0o600 });
writeFileSync(join(state, 'prepare.json'), JSON.stringify({ configHash: createHash('sha256').update(original).digest('hex'),
  originalModels: bundled.models.length, kiroModels: kiro.length, modelIds: kiro.map((model) => model.id), catalogue: catalog }, null, 2), { mode: 0o600 });
const check = spawnSync('python3', ['-c', 'import tomllib,sys;from pathlib import Path; a=tomllib.loads(Path(sys.argv[1]).read_text());b=tomllib.loads(Path(sys.argv[2]).read_text());assert a.get("model")==b.get("model");assert a.get("model_provider")==b.get("model_provider"); b.pop("model_catalog_json",None);a.pop("model_catalog_json",None);b["model_providers"].pop("kiro");b.pop("model_providers") if not b["model_providers"] else None;assert a==b', join(state, 'config-original.toml'), join(state, 'config-candidate.toml')], { encoding: 'utf8' });
if (check.status !== 0) throw new Error(`Candidate changes unrelated settings: ${check.stderr}`);
console.log(`Prepared ${bundled.models.length} original models + ${kiro.length} Kiro entries. Personal defaults preserved. Main config NOT changed.`);
console.log(state);
