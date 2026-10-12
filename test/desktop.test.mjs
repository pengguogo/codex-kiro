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
