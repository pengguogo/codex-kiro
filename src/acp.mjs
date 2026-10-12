import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayError } from './protocol.mjs';

export class AcpClient {
  constructor(command, args, onUpdate, toolNames = [], instructions = '') {
    this.command = command;
    this.args = args;
    this.onUpdate = onUpdate;
    this.toolNames = toolNames;
    this.instructions = instructions;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
  }
  async start() {
    this.setup = this.spawnProcess();
    await this.setup;
    if (this.stopped) throw new GatewayError('ACP request cancelled.', 499, 'cancelled');
    return this.call('initialize', { protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'codex-kiro', version: '0.1.0' } });
  }
  async spawnProcess() {
    this.cwd = await mkdtemp(join(tmpdir(), 'codex-kiro-'));
    await mkdir(join(this.cwd, '.kiro', 'agents'), { recursive: true });
    await writeFile(join(this.cwd, '.kiro', 'agents', 'codex-bridge.json'), JSON.stringify({
      name: 'codex-bridge', description: 'Codex model backend; tools executed by Codex only.',
      prompt: `${this.instructions}\nUse only the codex MCP tools. Never execute native shell or filesystem tools.`,
      tools: ['@codex'], allowedTools: ['@codex'], resources: [],
      includeMcpJson: false, mcpServers: {},
    }));
    if (this.stopped) return;
    this.process = spawn(this.command, this.args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stdin.on('error', () => {});
    this.process.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4096); });
    this.process.on('error', (error) => this.rejectAll(new GatewayError(
      error.code === 'ENOENT' ? 'kiro-cli not found. Install it and run kiro-cli login first.' : `Cannot start Kiro CLI: ${error.code}`,
    )));
    this.process.on('exit', (code) => this.rejectAll(new GatewayError(
      `Kiro CLI exited (${code}). Check kiro-cli login and acp flags.`, 502, 'kiro_process_exit',
    )));
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.method && msg.id !== undefined) this.handleRequest(msg);
      else if (msg.method) this.onUpdate(msg);
      else {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new GatewayError(`ACP ${pending.method}: ${msg.error.message}`, 502, 'acp_error'));
        else pending.resolve(msg.result);
      }
    });
  }
  handleRequest(msg) {
    if (msg.method === 'session/request_permission') {
      const params = msg.params || {};
      const title = String(params.toolCall?.title || '');
      // Approve only this request's explicitly exposed MCP tools. Native tools fail closed.
      const allowed = this.toolNames.some((name) => title === `@codex/${name}` || title === `codex___${name}`);
      const option = (params.options || []).find((o) => o.kind === (allowed ? 'allow_once' : 'reject_once'));
      this.send({ jsonrpc: '2.0', id: msg.id, result: {
        outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' },
      } });
    } else {
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Client method unsupported' } });
    }
  }
  send(msg) {
    if (!this.process?.stdin.destroyed) this.process.stdin.write(JSON.stringify(msg) + '\n');
  }
  call(method, params) {
    return new Promise((resolve, reject) => {
      const requestId = this.nextId++;
      this.pending.set(requestId, { resolve, reject, method });
      this.send({ jsonrpc: '2.0', id: requestId, method, params });
    });
  }
  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  stop() {
    this.stopped = true;
    this.stopping ??= this.cleanup();
    return this.stopping;
  }
  async cleanup() {
    await this.setup?.catch(() => {});
    this.rejectAll(new GatewayError('ACP request cancelled.', 499, 'cancelled'));
    this.lines?.close();
    if (this.process && this.process.exitCode === null && !this.process.killed) {
      const exited = new Promise((resolve) => this.process.once('exit', resolve));
      this.process.kill('SIGTERM');
      const kill = setTimeout(() => this.process.kill('SIGKILL'), 1000);
      await exited;
      clearTimeout(kill);
    }
    if (this.cwd) await rm(this.cwd, { recursive: true, force: true });
  }
}
