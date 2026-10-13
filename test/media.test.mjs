import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/server.mjs';
import { acpPrompt } from '../src/media.mjs';
import { structuredFormat } from '../src/structured.mjs';

const image = { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' };
async function gateway(t, args = []) {
  const server = createGateway({ key: 'test', command: process.execPath,
    args: [fileURLToPath(new URL('./fake-kiro.mjs', import.meta.url)), ...args], timeoutMs: 3000 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.shutdown());
  return (body) => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('user images and tool-result images reach ACP as actual image blocks', async (t) => {
  const post = await gateway(t);
  for (const item of [
    { role: 'user', content: [{ type: 'input_text', text: 'MEDIA_FIXTURE' }, image] },
    { type: 'function_call_output', call_id: 'call-1', output: [{ type: 'input_text', text: 'MEDIA_FIXTURE' }, image] },
    { type: 'custom_tool_call_output', call_id: 'call-2', output: [{ type: 'input_text', text: 'MEDIA_FIXTURE' }, image] },
  ]) {
    const response = await post({ input: [item] });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).output[0].content[0].text, 'Received 1 image blocks: image/png');
  }
});

test('image capability is checked before prompting upstream', async (t) => {
  const post = await gateway(t, ['--no-images']);
  const response = await post({ input: [{ role: 'user', content: [image] }] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /does not support image input/);
});

test('image role and order are preserved without embedding bytes in transcript', () => {
  const prompt = acpPrompt({ input: [{ role: 'user', content: [image, { type: 'input_text', text: 'compare' }, image] }] });
  assert.ok(!prompt[0].text.includes('aW1hZ2U='));
  assert.match(prompt[0].text, /Attached image 1.*compare.*Attached image 2/);
  assert.deepEqual(prompt.slice(1).map((part) => part.type), ['text', 'image', 'text', 'image']);
  assert.throws(() => acpPrompt({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'http://127.0.0.1/private' }] }] }), /embedded base64/);
});

test('client tool search emits a native call and loads returned namespaced tool schemas', async (t) => {
  const post = await gateway(t);
  const first = await (await post({ input: 'SEARCH_FIXTURE', stream: true,
    tools: [{ type: 'tool_search', execution: 'client' }] })).text();
  const events = first.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  const call = events.at(-1).response.output.find((item) => item.type === 'tool_search_call');
  assert.equal(call.execution, 'client');
  assert.deepEqual(call.arguments, { query: 'image generation', limit: 2 });
  const next = await (await post({ input: [{ role: 'user', content: 'SEARCH_FIXTURE' }, call,
    { type: 'tool_search_output', execution: 'client', status: 'completed', call_id: call.call_id,
      tools: [{ type: 'namespace', name: 'image_gen', tools: [{ type: 'function', name: 'imagegen',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }] }] }],
  })).json();
  const loaded = next.output.find((item) => item.type === 'function_call');
  assert.equal(loaded.namespace, 'image_gen');
  assert.equal(loaded.name, 'imagegen');
});

test('hosted image generation is rejected with an actionable service limitation', async (t) => {
  const post = await gateway(t);
  const response = await post({ input: 'image', tools: [{ type: 'image_generation' }] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /OpenAI-hosted/);
});

const reviewFormat = { type: 'json_schema', name: 'review', strict: true, schema: {
  type: 'object', properties: { decision: { enum: ['allow', 'deny'] } }, required: ['decision'], additionalProperties: false,
} };
test('schema output preserves the actual decision and rejects invalid JSON/schema', async (t) => {
  const post = await gateway(t);
  const valid = await post({ input: 'STRUCTURED_FIXTURE', text: { format: reviewFormat } });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).output[0].content[0].text, '{"decision":"deny"}');
  for (const input of ['STRUCTURED_FIXTURE INVALID_JSON', 'STRUCTURED_FIXTURE WRONG_SCHEMA']) {
    const response = await post({ input, text: { format: reviewFormat } });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'invalid_structured_output');
  }
});

test('invalid structured streaming output never leaks a successful text delta', async (t) => {
  const post = await gateway(t);
  const response = await post({ input: 'STRUCTURED_FIXTURE WRONG_SCHEMA', stream: true, text: { format: reviewFormat } });
  const text = await response.text();
  assert.match(text, /response.failed/);
  assert.ok(!text.includes('response.output_text.delta'));
  assert.ok(!text.includes('response.completed'));
});

test('unknown schema constraints fail closed; validation never coerces decisions or removes fields', () => {
  assert.throws(() => structuredFormat({ text: { format: { ...reviewFormat, schema: { type: 'object', unknown_constraint: true } } } }), /Unsupported or invalid/);
  const format = structuredFormat({ text: { format: reviewFormat } });
  assert.throws(() => format.validateText('{"decision":true}'), /does not match/);
  assert.throws(() => format.validateText('{"decision":"allow","extra":1}'), /does not match/);
});
