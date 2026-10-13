#!/usr/bin/env python3
"""Install/restore the already-verified staged app after the user quits it."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import struct
import subprocess
import tempfile
import tomllib

STATE = Path.home()/'.config/codex-kiro/coexist'
APP = Path('/Applications/ChatGPT.app')
CONFIG = Path.home()/'.codex/config.toml'
MANIFEST = STATE/'installation.json'
CATALOG = STATE/'all-models.json'

def run(args):
    subprocess.run(args, check=True)

def atomic_write(path, data, mode=0o600):
    fd, name = tempfile.mkstemp(prefix='.kiro-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(data if isinstance(data, bytes) else data.encode())
            file.flush(); os.fsync(file.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):os.unlink(name)

def header_hash(app):
    with (app/'Contents/Resources/app.asar').open('rb') as file:
        _, size = struct.unpack('<II', file.read(8))
        header = file.read(size); _, length = struct.unpack('<II', header[:8])
        return hashlib.sha256(header[8:8+length]).hexdigest()

def root_settings(text):
    result = {}
    for line in text.splitlines():
        if re.match(r'^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$', line):break
        match = re.match(r'^\s*(model|model_provider|model_catalog_json)\s*=', line)
        if match:result[match[1]]=line
    return result

def change_roots(text, changes):
    in_table = False; lines = []
    for line in text.splitlines():
        if re.match(r'^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$', line):in_table=True
        match = re.match(r'^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=', line)
        if not in_table and match and match[1] in changes:continue
        lines.append(line)
    new = [value for value in changes.values() if value is not None]
    return '\n'.join(new+lines)+'\n'

def add_config(original, candidate, catalog):
    parsed = tomllib.loads(original)
    if parsed.get('model_provider','openai')!='openai':raise RuntimeError('Personal default provider must remain OpenAI.')
    if 'kiro' in parsed.get('model_providers',{}):raise RuntimeError('A kiro provider already exists; refusing to overwrite it.')
    provider = candidate[candidate.index('[model_providers.kiro]'):]
    result = change_roots(original, {'model_catalog_json':f'model_catalog_json = {json.dumps(str(catalog))}'})
    result += '\n# codex-kiro coexist provider\n'+provider
    installed = tomllib.loads(result)
    check = dict(installed); check.pop('model_catalog_json',None)
    check['model_providers']=dict(check['model_providers']);check['model_providers'].pop('kiro')
    if not check['model_providers']:check.pop('model_providers')
    before=dict(parsed);before.pop('model_catalog_json',None)
    if before!=check:raise RuntimeError('Unrelated settings would change.')
    return result

def restore_config(current, original, catalog):
    parsed = tomllib.loads(current); saved = root_settings(original)
    changes = {}
    if parsed.get('model_catalog_json') == str(catalog):changes['model_catalog_json']=saved.get('model_catalog_json')
    if str(parsed.get('model','')).startswith('kiro/'):changes['model']=saved.get('model')
    if parsed.get('model_provider') == 'kiro':changes['model_provider']=saved.get('model_provider')
    lines=[]; skipping=False
    for line in current.splitlines():
        table=re.match(r'^\s*\[([^\]]+)\]\s*(?:#.*)?$',line)
        if table:skipping=table[1].strip() in ['model_providers.kiro','model_providers.kiro.auth']
        if not skipping and line!='# codex-kiro coexist provider':lines.append(line)
    result=change_roots('\n'.join(lines)+'\n',changes)
    tomllib.loads(result)
    return result

def require_app_closed():
    process = subprocess.run(['ps','-axo','pid=,command='],capture_output=True,text=True,check=True)
    running=[line.strip().split(' ',1)[0] for line in process.stdout.splitlines()
             if str(APP/'Contents')+'/' in line and 'manage-desktop.py' not in line]
    if running:raise RuntimeError('请先用 ⌘Q 完全退出桌面应用再运行；仍在运行的进程 PID: '+', '.join(running))

def install():
    require_app_closed()
    if MANIFEST.exists():raise RuntimeError('已有安装记录，请先 restore。')
    stage=json.loads((STATE/'patch-stage.json').read_text()); staged=Path(stage['stagedApp'])
    if header_hash(APP)!=stage['originalHeaderHash']:raise RuntimeError('应用已更新或变化，需重新准备补丁。')
    if header_hash(staged)!=stage['patchedHeaderHash']:raise RuntimeError('候选归档发生变化。')
    run(['python3',str(Path(__file__).with_name('local-sign.py')),str(staged),'--check'])
    run(['/usr/bin/codesign','--verify','--deep','--strict',str(staged)])
    original=CONFIG.read_bytes(); candidate=(STATE/'config-candidate.toml').read_text()
    old_settings=tomllib.loads(original.decode())
    prepared_original=tomllib.loads((STATE/'config-original.toml').read_text())
    if old_settings.get('model_catalog_json')!=prepared_original.get('model_catalog_json'):
        raise RuntimeError('原模型目录已变化，请重新运行 node src/coexist.mjs。')
    updated=add_config(original.decode(),candidate,CATALOG)
    backup=STATE/'backups'/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup.mkdir(parents=True,mode=0o700)
    atomic_write(backup/'config.toml',original)
    temporary=APP.with_name(f'.ChatGPT-kiro-install-{os.getpid()}.app')
    if temporary.exists():raise RuntimeError('临时安装目录已存在。')
    run(['/usr/bin/ditto',str(staged),str(temporary)])
    run(['/usr/bin/codesign','--verify','--deep','--strict',str(temporary)])
    manifest={**stage,'backup':str(backup),'status':'installing'}
    atomic_write(MANIFEST,json.dumps(manifest,indent=2))
    moved=False
    try:
        os.replace(APP,backup/'ChatGPT.app');moved=True
        os.replace(temporary,APP)
        if CONFIG.read_bytes()!=original:raise RuntimeError('安装期间配置发生变化。')
        atomic_write(CONFIG,updated,CONFIG.stat().st_mode&0o777)
        run(['/usr/bin/codesign','--verify','--deep','--strict',str(APP)])
        manifest['status']='installed';atomic_write(MANIFEST,json.dumps(manifest,indent=2))
    except Exception:
        if moved:
            if APP.exists():os.replace(APP,backup/'ChatGPT-failed.app')
            os.replace(backup/'ChatGPT.app',APP)
        if CONFIG.read_text()==updated:atomic_write(CONFIG,original)
        manifest['status']='installation_failed_restored';atomic_write(MANIFEST,json.dumps(manifest,indent=2))
        raise
    print('安装成功。个人默认模型/provider 保留；打开桌面应用，新建本地聊天选择 Kiro · 模型。')
    print('原应用和原配置备份：',backup)

def personal_defaults(current, original):
    parsed=tomllib.loads(current)
    if parsed.get('model_provider','openai')!='openai' or not str(parsed.get('model','')).startswith('kiro/'):
        return current
    saved=tomllib.loads(original)
    if str(saved.get('model','')).startswith('kiro/'):
        raise RuntimeError('原始默认模型也为 Kiro，无法自动修复。')
    changes={key:f'{key} = {json.dumps(saved[key])}' if key in saved else None
        for key in ['model','model_reasoning_effort']}
    return change_roots(current,changes)

def upgrade():
    require_app_closed()
    if not MANIFEST.exists():raise RuntimeError('尚未安装，请使用 install。')
    manifest=json.loads(MANIFEST.read_text())
    stage=json.loads((STATE/'patch-stage.json').read_text());staged=Path(stage['stagedApp'])
    if header_hash(APP)!=stage['originalHeaderHash']:raise RuntimeError('当前应用已变化，请重新准备候选。')
    if header_hash(staged)!=stage['patchedHeaderHash']:raise RuntimeError('候选归档发生变化。')
    run(['python3',str(Path(__file__).with_name('local-sign.py')),str(staged),'--check'])
    run(['/usr/bin/codesign','--verify','--deep','--strict',str(staged)])
    original=CONFIG.read_bytes()
    saved=(Path(manifest['backup'])/'config.toml').read_text()
    updated=personal_defaults(original.decode(),saved)
    backup=STATE/'upgrades'/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup.mkdir(parents=True,mode=0o700)
    atomic_write(backup/'config.toml',original)
    atomic_write(backup/'installation.json',json.dumps(manifest,indent=2))
    temporary=APP.with_name(f'.ChatGPT-kiro-upgrade-{os.getpid()}.app')
    if temporary.exists():raise RuntimeError('临时升级目录已存在。')
    run(['/usr/bin/ditto',str(staged),str(temporary)])
    run(['/usr/bin/codesign','--verify','--deep','--strict',str(temporary)])
    moved=False
    try:
        if CONFIG.read_bytes()!=original:raise RuntimeError('升级期间配置发生变化。')
        os.replace(APP,backup/'ChatGPT.app');moved=True
        os.replace(temporary,APP)
        atomic_write(CONFIG,updated,CONFIG.stat().st_mode&0o777)
        run(['/usr/bin/codesign','--verify','--deep','--strict',str(APP)])
        manifest['patchedHeaderHash']=stage['patchedHeaderHash']
        manifest['lastUpgradeBackup']=str(backup)
        atomic_write(MANIFEST,json.dumps(manifest,indent=2))
    except Exception:
        if moved:
            if APP.exists():os.replace(APP,backup/'ChatGPT-failed.app')
            os.replace(backup/'ChatGPT.app',APP)
        if CONFIG.read_text()==updated:atomic_write(CONFIG,original)
        raise
    print('补丁已升级；Kiro 选择不再覆盖个人默认模型。原始 restore 回滚仍可用。')
    print('升级前副本：',backup)

def restore():
    if not MANIFEST.exists():
        print('没有本次安装记录；无需回滚。');return
    require_app_closed()
    manifest=json.loads(MANIFEST.read_text());backup=Path(manifest['backup'])
    current=CONFIG.read_text();original=(backup/'config.toml').read_text()
    restored=restore_config(current,original,CATALOG)
    atomic_write(backup/'config-before-restore.toml',current)
    if (backup/'ChatGPT.app').exists() and header_hash(APP)==manifest['patchedHeaderHash']:
        run(['/usr/bin/codesign','--verify','--deep','--strict',str(backup/'ChatGPT.app')])
        os.replace(APP,backup/'ChatGPT-patched-restored.app')
        os.replace(backup/'ChatGPT.app',APP)
        print('原应用已恢复。')
    elif header_hash(APP)==manifest['originalHeaderHash']:
        print('应用已是原版。')
    else:
        print('当前应用归档已变化，保留当前应用；仅撤回本次配置，原应用备份仍保留。')
    atomic_write(CONFIG,restored,CONFIG.stat().st_mode&0o777)
    manifest['status']='restored';atomic_write(backup/'restore-record.json',json.dumps(manifest,indent=2))
    MANIFEST.unlink()
    print('已撤回 Kiro provider 和本次模型目录；其他设置改动保留。无需退出登录或删除聊天。')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['install','upgrade','restore','status']);args=parser.parse_args()
    if args.action=='install':install()
    elif args.action=='upgrade':upgrade()
    elif args.action=='restore':restore()
    else:print('安装状态：',json.loads(MANIFEST.read_text())['status'] if MANIFEST.exists() else 'not installed')

if __name__=='__main__':
    try:main()
    except Exception as error:raise SystemExit(str(error))
