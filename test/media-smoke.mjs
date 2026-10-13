// Opt-in real-model check. Set KIRO_SMOKE_IMAGE to a PNG/JPEG/WebP/GIF file.
// Uses an isolated ephemeral gateway; no desktop configuration is changed.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import assert from 'node:assert/strict';
import { createGateway } from '../src/server.mjs';

const file = process.env.KIRO_SMOKE_IMAGE;
if (!file) throw new Error('Set KIRO_SMOKE_IMAGE to a known test image and KIRO_SMOKE_EXPECT to its expected visible content.');
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extname(file).toLowerCase()];
assert.ok(mime, 'Unsupported image extension');
assert.ok(process.env.KIRO_SMOKE_EXPECT, 'Set KIRO_SMOKE_EXPECT to an expected visible description');
const server = createGateway({ key: 'isolated-smoke', command: process.env.KIRO_CLI_PATH || `${process.env.HOME}/.local/bin/kiro-cli`, timeoutMs: 120000 });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const image = { type: 'input_image', image_url: `data:${mime};base64,${readFileSync(file).toString('base64')}` };
  for (const kind of ['user', 'tool-result']) {
    const content = [{ type: 'input_text', text: 'Describe only what is visibly shown in the attached image. Do not call tools. Answer briefly in English.' }, image];
    const input = kind === 'user' ? [{ role: 'user', content }] : [
      { role: 'user', content: 'Describe the image returned by view_image in a few English words.' },
      { type: 'function_call', call_id: 'image-smoke', name: 'view_image', arguments: '{"path":"fixture.png"}' },
      { type: 'function_call_output', call_id: 'image-smoke', output: content },
    ];
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
      method: 'POST', headers: { Authorization: 'Bearer isolated-smoke', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.KIRO_SMOKE_MODEL || 'kiro/gpt-5.6-sol', input, tool_choice: 'none' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body.error));
    const text = body.output.flatMap((item) => item.content || []).map((part) => part.text || '').join(' ');
    assert.ok(text.toLowerCase().includes(process.env.KIRO_SMOKE_EXPECT.toLowerCase()), `Unexpected ${kind} description: ${text}`);
    console.log(`PASS ${kind} image: ${text}`);
  }
} finally { await server.shutdown(); }
