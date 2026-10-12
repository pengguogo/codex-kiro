#!/usr/bin/env python3
"""Sign only a staged app with local-safe entitlements; never the installed app."""
import hashlib
import json
import shutil
import struct
import plistlib
from pathlib import Path
import subprocess
import sys
import tempfile

RESTRICTED = {'com.apple.application-identifier', 'application-identifier',
              'com.apple.security.application-groups', 'keychain-access-groups'}

def restricted(key):
    return key in RESTRICTED or key.startswith('com.apple.developer.')

def entitlements(path):
    result = subprocess.run(['/usr/bin/codesign','-d','--entitlements',':-',str(path)],capture_output=True)
    if result.returncode: return None
    return plistlib.loads(result.stdout) if result.stdout.strip() else {}

def targets(app):
    found=[]
    for path in app.rglob('*'):
        if path.is_symlink():continue
        if path.is_dir() and path.suffix in {'.app','.framework','.xpc','.appex'}:
            found.append(path)
        elif path.is_file():
            with path.open('rb') as file:magic=file.read(4)
            if magic in {b'\xcf\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xca\xfe\xba\xbe',b'\xbe\xba\xfe\xca'}:
                found.append(path)
    return sorted(found,key=lambda p:len(p.parts),reverse=True)+[app]

def check(app):
    dictionary=plistlib.loads((app/'Contents/Info.plist').read_bytes())['ElectronAsarIntegrity']
    expected=hashlib.sha256(''.join(key+dictionary[key]['algorithm']+dictionary[key]['hash']
        for key in sorted(dictionary)).encode()).digest()
    binary=(app/'Contents/Frameworks/Codex Framework.framework/Codex Framework').read_bytes()
    sentinel=b'AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A'
    if binary.count(sentinel)!=1:raise RuntimeError('Unknown Electron digest layout')
    position=binary.index(sentinel)
    if binary[position+32:position+66]!=bytes([1,1])+expected:
        raise RuntimeError('Electron embedded integrity dictionary digest mismatch')
    for path in targets(app):
        values=entitlements(path)
        if values and any(restricted(key) for key in values):
            raise RuntimeError(f'Restricted entitlements remain: {path.name}')

def refresh_unpacked_integrity(app):
    archive=app/'Contents/Resources/app.asar'
    with archive.open('rb') as file:
        _,size=struct.unpack('<II',file.read(8));header=file.read(size)
        _,length=struct.unpack('<II',header[:8]);tree=json.loads(header[8:8+length])
    changed=[]
    def visit(node,prefix=''):
        for name,meta in node.get('files',{}).items():
            path=prefix+name
            if 'files' in meta:visit(meta,path+'/');continue
            if not meta.get('unpacked') or 'integrity' not in meta:continue
            content=Path(str(archive)+'.unpacked',path).read_bytes()
            block=meta['integrity']['blockSize']
            digest=hashlib.sha256(content).hexdigest()
            if digest==meta['integrity']['hash']:continue
            meta['size']=len(content)
            meta['integrity']={'algorithm':'SHA256','hash':digest,'blockSize':block,
                'blocks':[hashlib.sha256(content[k:k+block]).hexdigest() for k in range(0,len(content),block)]}
            changed.append(path)
    visit(tree)
    raw=json.dumps(tree,separators=(',',':'),ensure_ascii=False).encode()
    payload=(4+len(raw)+3)//4*4
    pickle=struct.pack('<II',payload,len(raw))+raw+bytes(payload-4-len(raw))
    temporary=archive.with_suffix('.refresh')
    with archive.open('rb') as src,temporary.open('wb') as dst:
        dst.write(struct.pack('<II',4,len(pickle))+pickle)
        src.seek(8+size);shutil.copyfileobj(src,dst)
    temporary.replace(archive)
    digest=hashlib.sha256(raw).hexdigest()
    info_path=app/'Contents/Info.plist';info=plistlib.loads(info_path.read_bytes())
    info['ElectronAsarIntegrity']['Resources/app.asar']['hash']=digest
    info_path.write_bytes(plistlib.dumps(info,sort_keys=False))
    # Electron now validates this dictionary against a digest embedded in its framework.
    dictionary=info['ElectronAsarIntegrity']
    embedded=hashlib.sha256(''.join(key+dictionary[key]['algorithm']+dictionary[key]['hash']
        for key in sorted(dictionary)).encode()).digest()
    framework=app/'Contents/Frameworks/Codex Framework.framework'
    binary=(framework/'Codex Framework').resolve()
    data=binary.read_bytes();sentinel=b'AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A'
    if data.count(sentinel)!=1:raise RuntimeError('Unknown Electron integrity digest layout')
    position=data.index(sentinel)
    if data[position+32:position+34]!=bytes([1,1]):raise RuntimeError('Unsupported Electron digest slot')
    data=data[:position+34]+embedded+data[position+66:]
    binary.write_bytes(data)
    subprocess.run(['/usr/bin/codesign','--force','--sign','-',
        '--preserve-metadata=flags,runtime',str(framework)],check=True)
    print(f'Refreshed unpacked native module hashes: {len(changed)}')
    return digest

if __name__=='__main__':
    app=Path(sys.argv[1]).resolve()
    if app==Path('/Applications/ChatGPT.app'):raise SystemExit('Refusing to sign installed application')
    if len(sys.argv)>2 and sys.argv[2]=='--check':
        check(app);print('Local entitlement check passed');sys.exit(0)
    with tempfile.TemporaryDirectory() as directory:
        for path in targets(app):
            if path==app:
                digest=refresh_unpacked_integrity(app)
            values=entitlements(path)
            if values is None:continue
            safe={key:value for key,value in values.items() if not restricted(key)}
            # Adhoc executable/framework signatures have no developer Team ID.
            # Scope the loading exception to executables in this staged app only.
            if path.suffix in {'.app','.xpc','.appex'} or path.parent.name == 'MacOS':
                safe['com.apple.security.cs.disable-library-validation'] = True
            file=Path(directory)/'entitlements.plist';file.write_bytes(plistlib.dumps(safe))
            subprocess.run(['/usr/bin/codesign','--force','--sign','-',
                '--preserve-metadata=flags,runtime','--entitlements',str(file),str(path)],check=True)
    check(app)
    subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(app)],check=True)
    manifest=app.parent/'patch-stage.json'
    if manifest.exists():
        record=json.loads(manifest.read_text());record['patchedHeaderHash']=digest
        manifest.write_text(json.dumps(record,indent=2))
    print('Staged local signature and entitlements verified; launch not yet tested.')
