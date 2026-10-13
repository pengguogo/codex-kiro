#!/usr/bin/env python3
"""Stage a narrow, version-checked desktop patch without touching the installed app.

Design reference: Keksuccino/Better-Codex-App-Custom-Provider-Support (Unlicense).
This implementation routes kiro/* model IDs on LOCAL thread creation; no auth spoofing.
"""
import copy
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess

APP = Path('/Applications/ChatGPT.app')
STATE = Path.home() / '.config/codex-kiro/coexist'
STATE.mkdir(parents=True, exist_ok=True)

def run(args):
    subprocess.run(args, check=True)

def read_header(path):
    with path.open('rb') as file:
        payload, size = struct.unpack('<II', file.read(8))
        if payload != 4:
            raise RuntimeError('Unsupported ASAR header')
        header = file.read(size)
        _, length = struct.unpack('<II', header[:8])
        raw = header[8:8+length]
        return json.loads(raw), 8+size, hashlib.sha256(raw).hexdigest()

def entries(tree, prefix=''):
    for name, info in tree['files'].items():
        path = prefix + name
        if 'files' in info:
            yield from entries(info, path + '/')
        elif 'offset' in info and not info.get('unpacked'):
            yield path, info

def once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError(f'Unsupported source layout for: {old[:90]}')
    return source.replace(old, new, 1)

info = plistlib.loads((APP/'Contents/Info.plist').read_bytes())
if info['CFBundleShortVersionString'] != '26.1007.30912':
    raise RuntimeError('This patch is validated only for 26.1007.30912; recheck after updates.')
original = APP/'Contents/Resources/app.asar'
header, offset, header_hash = read_header(original)
if header_hash != info['ElectronAsarIntegrity']['Resources/app.asar']['hash']:
    raise RuntimeError('Original ASAR integrity mismatch')
work = STATE/'patch-work'
work.mkdir(exist_ok=True)
targets = {}
with original.open('rb') as file:
    for path, item in entries(header):
        if not path.startswith('webview/assets/') or not path.endswith('.js'):
            continue
        file.seek(offset+int(item['offset']))
        source = file.read(item['size']).decode()
        if 'async prewarmThreadStart(' in source and 'async sendConfigReadRequest(' in source:
            if 'central' in targets:
                raise RuntimeError('Ambiguous request client')
            targets['central'] = path
            (work/'central.js').write_text(source)
        if 'composer.intelligenceDropdown.tooltip' in source and 'modelOptionsDisabled' in source:
            if 'picker' in targets:
                raise RuntimeError('Ambiguous model picker')
            targets['picker'] = path
            (work/'picker.js').write_text(source)
if set(targets) != {'central', 'picker'}:
    raise RuntimeError('Missing required patch targets')
run(['npx', '--yes', 'prettier@3.6.2', '--write', str(work/'central.js'), str(work/'picker.js')])
central = (work/'central.js').read_text()
helper = '''
// codexKiroCoexistV1: select provider per new LOCAL task, without changing global defaults.
function codexKiroRoute(method, params, host) {
  if (host !== "local" || !params || typeof params !== "object") return params;
  if (method === "thread/list" && params.modelProviders == null)
    return {...params, modelProviders: []};
  if (method === "thread/start" && typeof params.model === "string" && params.model.startsWith("kiro/"))
    return {...params, modelProvider: "kiro", serviceTier: "default",
      config: {...params.config, web_search: "disabled"}};
  return params;
}
'''
if 'codexKiroCoexistV1' not in central:
    central += '\n' + helper
    central = once(central, '          return e === `config/read`\n            ? this.sendConfigReadRequest(t, n)',
        '          t = codexKiroRoute(e, t, this.hostId);\n          return e === `config/read`\n            ? this.sendConfigReadRequest(t, n)')
    central = once(central, '        async prewarmThreadStart(e, t) {',
        '        async prewarmThreadStart(e, t) {\n          e = codexKiroRoute("thread/start", e, this.hostId);')
# Keep Kiro selections in the renderer's existing per-context override, rather
# than saving a Kiro model under the global OpenAI provider.
if 'codexKiroDefaultGuard' not in central:
    central = once(central, '        setDefaultModelConfig(e, t, n) {',
        '        setDefaultModelConfig(e, t, n) {\n          // codexKiroDefaultGuard\n          if (typeof e === "string" && e.startsWith("kiro/")) return Promise.resolve({status:"okOverridden"});')
(work/'central.js').write_text(central)
picker = (work/'picker.js').read_text()
if 'codex-kiro-provider-boundary' not in picker:
    picker = once(picker, '    sn = function (e, t, n) {\n      let r = () => {', '''    codexKiroConversationId = r,
        sn = function (e, t, n) {
          if (typeof e === "string" && typeof je === "string" &&
              s.get(no, codexKiroConversationId) != null && (s.get(_r, codexKiroConversationId) ?? 0) > 0 &&
              e.startsWith("kiro/") !== je.startsWith("kiro/")) {
            s.get(ll).info("OpenAI 与 Kiro 需在新聊天中切换；当前聊天继续使用原 provider。", {id: "codex-kiro-provider-boundary"});
            return;
          }
          let r = () => {''')
(work/'picker.js').write_text(picker)
run(['npx', '--yes', 'prettier@3.6.2', '--write', str(work/'central.js'), str(work/'picker.js')])
for path in [work/'central.js', work/'picker.js']:
    subprocess.run(['node', '--input-type=module', '--check'], input=path.read_text(), text=True, check=True)
# Test the exact routing helper used in the staged application.
test = helper + '''
const assert = require('node:assert/strict');
const gpt = {model:'gpt-6.1-sol', modelProvider:null};
assert.equal(codexKiroRoute('thread/start',gpt,'local'),gpt);
assert.equal(codexKiroRoute('turn/start',{model:'kiro/auto'},'local').modelProvider,undefined);
assert.equal(codexKiroRoute('thread/start',{model:'kiro/auto'},'cloud').modelProvider,undefined);
const kiro=codexKiroRoute('thread/start',{model:'kiro/claude-test',config:{other:true}},'local');
assert.equal(kiro.modelProvider,'kiro');assert.equal(kiro.model,'kiro/claude-test');assert.equal(kiro.config.other,true);
assert.equal(kiro.config.web_search,'disabled');
console.log('PASS: OpenAI route preserved; Kiro route selected only for new local tasks.');
'''
run(['node', '-e', test])
# Run the actual persistence guard, including its unchanged OpenAI path.
start = central.index('        setDefaultModelConfig(e, t, n) {')
end = central.index('\n        onNotification(', start)
guard_test = 'const assert=require("node:assert/strict");let writes=0;class Client {'+central[start:end]+'};const c=new Client();c.defaultTurnConfig={writeModel:()=>{writes++;return Promise.resolve({status:"ok"});}};Promise.resolve().then(async()=>{assert.equal((await c.setDefaultModelConfig("kiro/auto","none")).status,"okOverridden");assert.equal(writes,0);await c.setDefaultModelConfig("gpt-6.1-sol","high");assert.equal(writes,1);console.log("PASS: Kiro selection never persists an OpenAI global default.");});'
run(['node', '-e', guard_test])
# Execute the actual guarded picker callback; syntax checks alone cannot detect TDZ errors.
picker = (work/'picker.js').read_text()
start = picker.index('    codexKiroConversationId = r,')
end = picker.index('\n  function cn(e)', start)
callback_test = 'const r="thread-1",je="gpt-6.1-sol",no="id",_r="count",ll="toast";let shown=0;const s={get:(key,id)=>{if(key===ll)return {info:()=>shown++};if(id!==r)throw Error("wrong conversation");return key===no?r:1;}};let '+picker[start:end].strip()+'\nsn("kiro/auto");require("node:assert/strict").equal(shown,1);console.log("PASS: actual provider boundary callback.");'
run(['node', '-e', callback_test])
replacement = {targets[role]: (work/f'{role}.js').read_bytes() for role in targets}
new_header = copy.deepcopy(header)
items = sorted(entries(new_header), key=lambda pair: int(pair[1]['offset']))
old_offsets = {}
data_offset = 0
for path, meta in items:
    old_offsets[path] = int(meta['offset'])
    meta['offset'] = str(data_offset)
    if path in replacement:
        content = replacement[path]
        meta['size'] = len(content)
        block = meta.get('integrity', {}).get('blockSize', 4194304)
        meta['integrity'] = {'algorithm': 'SHA256', 'hash': hashlib.sha256(content).hexdigest(), 'blockSize': block,
            'blocks': [hashlib.sha256(content[i:i+block]).hexdigest() for i in range(0, len(content), block)]}
    data_offset += meta['size']
raw = json.dumps(new_header, separators=(',', ':'), ensure_ascii=False).encode()
payload_size = (4+len(raw)+3)//4*4
header_pickle = struct.pack('<II', payload_size, len(raw))+raw+bytes(payload_size-4-len(raw))
patched = STATE/'app-patched.asar'
with original.open('rb') as src, patched.open('wb') as dst:
    dst.write(struct.pack('<II',4,len(header_pickle))+header_pickle)
    for path, meta in items:
        if path in replacement:
            dst.write(replacement[path])
        else:
            src.seek(offset+old_offsets[path]); remaining=meta['size']
            while remaining:
                data=src.read(min(4194304,remaining))
                if not data:raise RuntimeError('Truncated original archive')
                dst.write(data);remaining-=len(data)
# Verify every unchanged packed file's bytes, all metadata and all unpacked/symlink entries.
verified, new_offset, new_hash = read_header(patched)
original_entries = dict(entries(header))
with original.open('rb') as src, patched.open('rb') as dst:
    for path, meta in entries(verified):
        old=original_entries[path]
        expected=replacement.get(path)
        if expected is not None:
            dst.seek(new_offset+int(meta['offset']));assert dst.read(meta['size'])==expected
        else:
            assert {k:v for k,v in old.items() if k!='offset'}=={k:v for k,v in meta.items() if k!='offset'}
            src.seek(offset+int(old['offset']));dst.seek(new_offset+int(meta['offset']));remaining=meta['size']
            while remaining:
                count=min(4194304,remaining);assert src.read(count)==dst.read(count);remaining-=count
info['ElectronAsarIntegrity']['Resources/app.asar']['hash']=new_hash
with (STATE/'Info-patched.plist').open('wb') as file:plistlib.dump(info,file,sort_keys=False)
staged=STATE/'ChatGPT-Kiro-staged.app'
if not staged.exists():run(['/usr/bin/ditto',str(APP),str(staged)])
shutil.copyfile(patched,staged/'Contents/Resources/app.asar')
shutil.copyfile(STATE/'Info-patched.plist',staged/'Contents/Info.plist')
run(['python3',str(Path(__file__).with_name('local-sign.py')),str(staged)])
run(['/usr/bin/codesign','--verify','--deep','--strict',str(staged)])
_, _, new_hash = read_header(staged/'Contents/Resources/app.asar')
manifest={'version':info['CFBundleShortVersionString'],'originalHeaderHash':header_hash,'patchedHeaderHash':new_hash,
    'targets':targets,'stagedApp':str(staged),'installedApp':str(APP)}
(STATE/'patch-stage.json').write_text(json.dumps(manifest,indent=2))
print('STAGED AND VERIFIED. Installed application and personal configuration were NOT changed.')
print(staged)
