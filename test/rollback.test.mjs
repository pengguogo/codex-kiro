import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('coexist rollback preserves settings changed by desktop after install', () => {
  const script = `
import importlib.util,tomllib,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('installer',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original='model = "gpt-6.1-sol"\\nmodel_reasoning_effort = "high"\\n[desktop]\\nfont_size = 12\\n[mcp_servers.original]\\ncommand = "original"\\n'
candidate='[model_providers.kiro]\\nname = "Company Kiro"\\n[model_providers.kiro.auth]\\ncommand = "node"\\n'
installed=m.add_config(original,candidate,Path('/tmp/all-models.json'))
updated=installed.replace('font_size = 12','font_size = 18').replace('model = "gpt-6.1-sol"','model = "kiro/auto"')
restored=tomllib.loads(m.restore_config(updated,original,Path('/tmp/all-models.json')))
assert restored['model']=='gpt-6.1-sol'
assert restored['desktop']['font_size']==18
assert restored['model_reasoning_effort']=='high'
assert restored['mcp_servers']['original']['command']=='original'
assert 'kiro' not in restored.get('model_providers',{})
assert 'model_catalog_json' not in restored
assert 'model_provider' not in restored
repaired=tomllib.loads(m.personal_defaults(updated.replace('model_reasoning_effort = "high"','model_reasoning_effort = "none"'),original))
assert repaired['model']=='gpt-6.1-sol'
assert repaired['model_reasoning_effort']=='high'
assert repaired['desktop']['font_size']==18
assert 'kiro' in repaired['model_providers']
assert repaired['model_catalog_json']=='/tmp/all-models.json'
assert m.personal_defaults(original,original)==original
print('rollback passed')
`;
  const result=spawnSync('python3',['-c',script,resolve('scripts/manage-desktop.py')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/rollback passed/);
});

test('desktop preflight rejects both installed and candidate app before mutation', () => {
  const script = `
import importlib.util,sys
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('installer',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
for app in [m.APP,m.STATE/'ChatGPT-Kiro-staged.app']:
    m.subprocess.run=lambda *a,**k:SimpleNamespace(stdout='123 '+str(app/'Contents/MacOS/ChatGPT')+'\\n')
    try:m.require_app_closed()
    except RuntimeError as error:assert '⌘Q' in str(error)
    else:raise AssertionError('running app not detected')
m.subprocess.run=lambda *a,**k:SimpleNamespace(stdout='456 /usr/local/bin/node /other/server.mjs\\n')
m.require_app_closed()
`;
  const result = spawnSync('python3', ['-c', script, resolve('scripts/manage-desktop.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
