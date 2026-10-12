// Opt-in live test: uses the actual desktop-bundled app-server and Kiro login.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { prepareDesktop, desktopHome } from '../src/desktop.mjs';

const { workspace, bundledCodex } = prepareDesktop();
const overrides = process.env.KIRO_SMOKE_OVERRIDES ? JSON.parse(readFileSync(process.env.KIRO_SMOKE_OVERRIDES, 'utf8')) : {};
const spawnArgs = ['app-server', '--stdio'];
function appendOverrides(values, prefix = '') {
  for (const [key, value] of Object.entries(values)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) appendOverrides(value, name);
    else spawnArgs.push('-c', `${name}=${JSON.stringify(value)}`);
  }
}
appendOverrides(overrides);
const child = spawn(bundledCodex, spawnArgs, {
  cwd: workspace, env: { ...process.env, CODEX_HOME: process.env.KIRO_DESKTOP_CONFIG_HOME || desktopHome }, stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let nextId = 1;
let turnResolve, turnReject;
let stderr = '';
const errors = [];
const toolTypes = [];
const messages = [];
const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}
child.stdin.on('error', () => {});
child.stderr.on('data', (bytes) => {
  stderr = (stderr + bytes).slice(-4000);
  for (const line of bytes.toString().split('\n')) {
    try {
      const entry = JSON.parse(line);
      if (entry.level === 'ERROR') errors.push({ target: entry.target,
        message: String(entry.fields?.message || '').replace(/https?:\/\/[^\s)"\\]+/g, '[URL]') });
    } catch {
      if (line.startsWith('Error')) errors.push({ message: line.slice(0, 250).replace(/https?:\/\/\S+/g, '[URL]') });
    }
  }
});
child.on('error', (error) => {
  for (const item of pending.values()) item.reject(error);
  turnReject?.(error);
});
child.on('exit', (code) => {
  for (const item of pending.values()) item.reject(new Error(`App-server exited: ${code}`));
  turnReject?.(new Error(`App-server exited: ${code}`));
});
createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method && msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: 'Interactive client approval not available in smoke test' } });
  } else if (msg.id !== undefined) {
    const item = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) item?.reject(new Error(JSON.stringify(msg.error)));
    else item?.resolve(msg.result);
  } else if (msg.method === 'item/completed') {
    const item = msg.params.item;
    if (item.type === 'agentMessage') messages.push(item.text);
    if (['commandExecution', 'fileChange'].includes(item.type)) toolTypes.push(item.type);
  } else if (msg.method === 'turn/completed') {
    const turn = msg.params.turn;
    if (turn.status !== 'completed') turnReject?.(new Error(JSON.stringify(turn.error || turn.status)));
    else turnResolve?.();
  }
});
const timeout = setTimeout(() => {
  const error = new Error('Desktop backend smoke test timed out');
  for (const item of pending.values()) item.reject(error);
  turnReject?.(error);
  child.kill('SIGTERM');
}, 240000);

async function turn(threadId, text) {
  const done = new Promise((resolve, reject) => { turnResolve = resolve; turnReject = reject; });
  await call('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  await done;
  turnResolve = null;
  turnReject = null;
}
try {
  const init = await call('initialize', { clientInfo: { name: 'kiro-desktop-smoke', title: 'Kiro Desktop Smoke', version: '0.1.0' }, capabilities: null });
  console.log('app-server:', init.userAgent || 'initialized');
  send({ method: 'initialized', params: {} });
  const provider = process.env.KIRO_SMOKE_PROVIDER || 'kiro-desktop-experiment';
  const model = process.env.KIRO_SMOKE_MODEL || 'auto';
  if (process.env.KIRO_SMOKE_PROVIDER) {
    const listing = await call('model/list', { includeHidden: true, limit: 100 });
    assert.ok(listing.data.some((entry) => entry.model === 'gpt-6.1-sol'));
    assert.ok(listing.data.some((entry) => entry.model === 'kiro/auto'));
    console.log(`Model picker catalogue: ${listing.data.length} models, OpenAI + Kiro present.`);
    const personal = await call('thread/start', { model: 'gpt-6.1-sol', modelProvider: 'openai',
      cwd: workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' });
    assert.equal(personal.modelProvider, 'openai');
    console.log('Personal thread provider preserved (no inference request sent).');
  }
  const thread = await call('thread/start', { cwd: workspace, ephemeral: true,
    ...(process.env.KIRO_SMOKE_PROVIDER ? { modelProvider: provider, model, config: { web_search: 'disabled' } } : {}),
    approvalPolicy: 'never', sandbox: 'workspace-write' });
  console.log(`provider=${thread.modelProvider} model=${thread.model}`);
  assert.equal(thread.modelProvider, provider);
  assert.equal(thread.model, model);
  await turn(thread.thread.id, '只回复 desktop-kiro-ok，不要调用工具。');
  assert.ok(messages.some((text) => /\bdesktop-kiro-ok\b/.test(text)), `Expected marker missing; received ${JSON.stringify(messages)}`);
  writeFileSync(join(workspace, 'backend-answer.txt'), 'before\n');
  await turn(thread.thread.id, '仅修改当前目录的 backend-answer.txt：使用 apply_patch 将 before 改成 desktop-kiro-edit-ok，然后执行 cat backend-answer.txt 验证。不要操作其他文件。');
  assert.equal(readFileSync(join(workspace, 'backend-answer.txt'), 'utf8'), 'desktop-kiro-edit-ok\n');
  assert.ok(toolTypes.includes('fileChange'), 'No fileChange event from desktop backend');
  assert.ok(toolTypes.includes('commandExecution'), 'No commandExecution event from desktop backend');
  console.log('PASS: 桌面内置 app-server → Kiro，文本、连续聊天、apply_patch、exec_command 均通过。');
  console.log(JSON.stringify({ toolTypes, finalMessage: messages.at(-1) }));
} catch (error) {
  console.error(error.message);
  console.error('App-server errors:', JSON.stringify(errors.slice(-10)));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
    await exited;
    clearTimeout(kill);
  }
}
