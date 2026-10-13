import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { desktopConfig } from '../src/desktop.mjs';

test('desktop config replaces only route-related root fields and preserves tables', () => {
  const original = '# personal\nmodel = "personal-model"\nmodel_reasoning_effort = "high"\nservice_tier = "fast"\nnotify = ["existing-notify"]\n\n[features]\nmodel = "leave-this-table-key"\nfeature = true\n\n[projects."/company"]\ntrust_level = "trusted"\n';
  const rendered = desktopConfig(original, '[model_providers.kiro-desktop-experiment]\nname="Kiro"\n', '/tmp/catalog.json');
  const result = spawnSync('python3', ['-c', 'import json,tomllib,sys; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: rendered, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.model, 'auto');
  assert.equal(config.model_provider, 'kiro-desktop-experiment');
  assert.equal(config.model_reasoning_effort, undefined);
  assert.equal(config.service_tier, undefined);
  assert.deepEqual(config.notify, ['existing-notify']);
  assert.equal(config.features.model, 'leave-this-table-key');
  assert.equal(config.projects['/company'].trust_level, 'trusted');
  assert.ok(rendered.includes('# personal'));
});

const { restartGateway } = await import('../src/desktop.mjs');
const { resolve } = await import('node:path');
function lifecycle({ busy = false, foreign = false, absent = false, stuck = false, unauthorized = false } = {}) {
  const signals = [];
  let started = 0;
  return { signals, get started() { return started; }, runtime: {
    key: 'fixture-key',
    fetch: async (url) => {
      if (absent) throw Object.assign(new TypeError('connect failed'), { cause: { code: 'ECONNREFUSED' } });
      return { ok: !unauthorized, json: async () => ({ backend: 'kiro-cli-acp', active_requests: busy ? 1 : 0 }) };
    },
    spawnSync: (cmd) => ({ status: 0, stdout: cmd === 'lsof' ? '12345\n' : `/usr/local/bin/node ${foreign ? '/other/server.mjs' : resolve('src/server.mjs')}\n` }),
    kill: (pid, signal) => {
      assert.equal(pid, 12345);
      if (signal === 0 && !stuck) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      if (signal !== 0) signals.push(signal);
    },
    start: async () => { started++; }, pause: async () => {},
  } };
}
test('restart starts absent gateway and replaces active owned gateway only with force', async () => {
  const missing = lifecycle({ absent: true });
  await restartGateway(true, missing.runtime);
  assert.equal(missing.started, 1);
  const busy = lifecycle({ busy: true });
  await assert.rejects(restartGateway(false, busy.runtime), /运行中的请求/);
  assert.deepEqual(busy.signals, []);
  await restartGateway(true, busy.runtime);
  assert.deepEqual(busy.signals, ['SIGTERM']);
  assert.equal(busy.started, 1);
});
test('restart leaves foreign and unauthenticated processes untouched and avoids duplicate on timeout', async () => {
  for (const options of [{ foreign: true }, { unauthorized: true }]) {
    const fixture = lifecycle(options);
    await assert.rejects(restartGateway(true, fixture.runtime));
    assert.deepEqual(fixture.signals, []);
    assert.equal(fixture.started, 0);
  }
  const stuck = lifecycle({ stuck: true });
  await assert.rejects(restartGateway(true, stuck.runtime), /has not stopped/);
  assert.deepEqual(stuck.signals, ['SIGTERM']);
  assert.equal(stuck.started, 0);
});
