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
