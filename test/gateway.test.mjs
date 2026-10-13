import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/server.mjs';
import { AcpClient } from '../src/acp.mjs';
import { mapTools, transcript, validateRequest } from '../src/protocol.mjs';

const fake = fileURLToPath(new URL('./fake-kiro.mjs', import.meta.url));
async function gateway(t, options = {}) {
  const server = createGateway({ key: 'test-key', command: process.execPath, args: [fake], timeoutMs: 3000, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.shutdown());
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, post: async (body) => fetch(`${url}/v1/responses`, { method: 'POST',
    headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
}
const execTool = { type: 'function', name: 'exec_command', description: 'Run command via Codex',
  parameters: { type: 'object', properties: { cmd: { type: 'string' }, max_output_tokens: { type: 'number' } }, required: ['cmd'] } };

test('authenticated text response and gateway health', async (t) => {
  const { url, post } = await gateway(t);
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/v1/models`)).status, 401);
  const models = await (await fetch(`${url}/v1/models`, { headers: { Authorization: 'Bearer test-key' } })).json();
  assert.equal(models.models[0].slug, 'kiro/auto');
  assert.deepEqual(models.data.map((model) => model.id), ['kiro/auto', 'kiro/claude-test', 'kiro/gpt-test']);
  assert.equal(models.models[0].supports_parallel_tool_calls, false);
  const response = await post({ model: 'auto', input: 'hello', store: false });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'completed');
  assert.equal(body.output[0].content[0].text, 'Kiro OK');
  assert.equal(body.usage, null);
});

test('namespaced Kiro models select the original upstream ID', async (t) => {
  const { post } = await gateway(t);
  const response = await post({ model: 'kiro/claude-test', input: 'hello' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, 'kiro/claude-test');
});

test('top-level union schemas are nested for Kiro and unwrapped for Codex', async (t) => {
  const { post } = await gateway(t);
  const tool = { type: 'function', name: 'union_tool', parameters: {
    anyOf: [{ type: 'object', properties: { action: { const: 'list' } }, required: ['action'] },
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }],
  } };
  const mapped = mapTools([tool]).get('union_tool');
  assert.equal(mapped.inputSchema.anyOf, undefined);
  assert.deepEqual(mapped.inputSchema.properties.arguments.anyOf, tool.parameters.anyOf);
  const body = await (await post({ input: 'list', tools: [tool] })).json();
  const call = body.output.find((item) => item.type === 'function_call');
  assert.deepEqual(JSON.parse(call.arguments), { action: 'list' });
});

test('union wrapping preserves definitions and redirects other root references', () => {
  const tool = mapTools([{ type: 'function', name: 'union_tool', parameters: {
    $defs: { value: { type: 'string' } }, properties: { value: { $ref: '#/$defs/value' } },
    oneOf: [{ $ref: '#/properties/value' }],
  } }]).get('union_tool');
  assert.equal(tool.inputSchema.$defs.value.type, 'string');
  assert.equal(tool.inputSchema.properties.arguments.properties.value.$ref, '#/$defs/value');
  assert.equal(tool.inputSchema.properties.arguments.oneOf[0].$ref, '#/properties/arguments/properties/value');
});

test('Responses SSE event lifecycle and final text match', async (t) => {
  const { post } = await gateway(t);
  const response = await post({ input: 'hello', stream: true });
  const events = (await response.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  assert.equal(events[0].type, 'response.created');
  assert.equal(events.at(-1).type, 'response.completed');
  assert.deepEqual(events.map((e) => e.sequence_number), events.map((_, i) => i));
  assert.equal(events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join(''), 'Kiro OK');
});

test('MCP tools return a real Codex function_call; next turn carries execution output', async (t) => {
  const { post } = await gateway(t);
  const first = await (await post({ input: 'run a tool', tools: [execTool] })).json();
  const call = first.output.find((item) => item.type === 'function_call');
  assert.equal(call.name, 'exec_command');
  assert.equal(JSON.parse(call.arguments).cmd, 'printf kiro-tool-ok');
  assert.equal(first.output[0].phase, 'commentary');
  const next = await (await post({ tools: [execTool], input: [
    { role: 'user', content: 'run a tool' }, ...first.output,
    { type: 'function_call_output', call_id: call.call_id, output: 'kiro-tool-ok' },
  ] })).json();
  assert.equal(next.output[0].content[0].text, '工具结果已收到：kiro-tool-ok');
});

test('custom apply_patch input is preserved with custom_tool_call events', async (t) => {
  const { post } = await gateway(t);
  const response = await post({ input: 'patch', stream: true, tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }] });
  const events = (await response.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  const call = events.at(-1).response.output.find((item) => item.type === 'custom_tool_call');
  assert.equal(call.name, 'apply_patch');
  assert.equal(call.input, '*** Begin Patch\n*** End Patch');
  assert.ok(events.some((e) => e.type === 'response.custom_tool_call_input.done'));
});

test('tool_choice none suppresses MCP tool exposure', async (t) => {
  const { post } = await gateway(t);
  const body = await (await post({ input: 'hello', tool_choice: 'none', tools: [execTool] })).json();
  assert.equal(body.output.length, 1);
  assert.equal(body.output[0].type, 'message');
});

test('unknown model fails; never silently changes upstream model', async (t) => {
  const { post } = await gateway(t);
  const response = await post({ model: 'bad-model', input: 'hello' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /Unknown model/);
});

test('timeout emits failed response and terminates ACP process', async (t) => {
  const { post, server } = await gateway(t, { timeoutMs: 200 });
  const response = await post({ input: 'HANG', stream: true });
  assert.match(await response.text(), /response.failed/);
  for (let i = 0; i < 30; i++) {
    const state = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
    if (state.active_requests === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('ACP request leaked after timeout');
});

test('unsupported image, previous response and tool types fail before upstream call', async (t) => {
  const { post } = await gateway(t);
  for (const body of [
    { input: 'x', previous_response_id: 'resp_old' },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }] },
    { input: 'x', tools: [{ type: 'web_search' }] },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'unsupported_feature');
  }
});

test('namespace tool names map back; encrypted reasoning is omitted', () => {
  const tools = mapTools([{ type: 'namespace', name: 'functions', tools: [execTool] }]);
  assert.equal(tools.get('functions__exec_command').originalName, 'exec_command');
  const text = transcript({ input: [{ type: 'reasoning', encrypted_content: 'secret' }, { role: 'user', content: 'hi' }] });
  assert.ok(!text.includes('secret'));
  assert.throws(() => validateRequest({ input: 'x', store: true }), /stateless/);
});

test('native ACP tool permission is rejected', async (t) => {
  const client = new AcpClient(process.execPath, [fake], () => {});
  t.after(() => client.stop());
  const writes = [];
  client.send = (msg) => writes.push(msg);
  client.handleRequest({ id: 42, method: 'session/request_permission', params: {
    toolCall: { title: 'shell' }, options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }],
  } });
  assert.equal(writes[0].result.outcome.optionId, 'no');
});

test('client disconnect cancels and cleans up ACP request', async (t) => {
  const { post, url } = await gateway(t);
  const response = await post({ input: 'HANG', stream: true });
  await response.body.cancel();
  for (let i = 0; i < 50; i++) {
    const state = await (await fetch(`${url}/health`)).json();
    if (state.active_requests === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('ACP request leaked after disconnect');
});

test('missing CLI returns actionable error and completes cleanup', async (t) => {
  const { post } = await gateway(t, { command: '/nonexistent/codex-kiro-test-binary', args: [] });
  const response = await post({ input: 'hello' });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /kiro-cli not found/);
});

test('request cancellation during startup does not spawn an orphan process', async () => {
  const client = new AcpClient(process.execPath, [fake], () => {});
  const start = client.start().catch((error) => error);
  await client.stop();
  assert.equal((await start).code, 'cancelled');
  assert.equal(client.process, undefined);
});


test('history includes exact MCP routing for namespaced tools and failure recovery guidance', () => {
  const tools = mapTools([{ type: 'namespace', name: 'computer', tools: [
    { type: 'function', name: 'inspect', parameters: { type: 'object', properties: {} } },
  ] }]);
  const text = transcript({ input: 'Inspect the available surface' }, tools);
  assert.match(text, /"client":"inspect","namespace":"computer","mcp":"computer__inspect"/);
  assert.match(text, /do not repeat the same failed call/);
});


test('MCP namespaces retain separate Codex name and namespace', () => {
  const tools = mapTools([{ type: 'namespace', name: 'mcp__cua_repl', tools: [
    { type: 'function', name: 'js', parameters: { type: 'object', properties: {} } },
  ] }]);
  const tool = tools.get('mcp__cua_repl__js');
  assert.equal(tool.originalName, 'js');
  assert.equal(tool.namespace, 'mcp__cua_repl');
  assert.notEqual(tool.originalName, 'mcp__cua_repl.js');
});


test('Responses function calls emit namespace separately for Codex routing', async (t) => {
  const { post } = await gateway(t);
  const response = await post({input:'tool please',tools:[{type:'namespace',name:'functions',tools:[execTool]}]});
  const body = await response.json();
  const call = body.output.find((item) => item.type === 'function_call');
  assert.ok(call, JSON.stringify(body));
  assert.equal(call.name, 'exec_command');
  assert.equal(call.namespace, 'functions');
});


test('local workspace guidance distinguishes actual restrictions from historical assistant claims', () => {
  const text = transcript({ input: 'Inspect the local workspace' });
  assert.match(text, /Missing MCP resource entries do not imply a local directory is inaccessible/);
  assert.match(text, /Honor real user\/developer restrictions/);
  assert.match(text, /never invent a shell prohibition/);
});
