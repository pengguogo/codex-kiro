#!/bin/zsh
set -e
kiro_project_root="$(cd -- "${0:A:h}/.." && pwd)"
source "$kiro_project_root/scripts/desktop-env.sh"
"$KIRO_PYTHON" "$kiro_project_root/scripts/manage-desktop.py" check-closed
"$KIRO_PYTHON" -c 'import plistlib; from pathlib import Path; p=Path("/Applications/ChatGPT.app/Contents/Info.plist"); v=plistlib.loads(p.read_bytes())["CFBundleShortVersionString"]; assert v=="26.1007.30912", "暂不支持此桌面版本: "+v'
cd "$kiro_project_root"
npm ci --ignore-scripts
"$KIRO_PYTHON" -c 'import os; from pathlib import Path; p=Path.home()/".codex/config.toml"; p.parent.mkdir(parents=True,exist_ok=True); p.touch(mode=0o600,exist_ok=True)'
node src/desktop.mjs prepare
if [[ -f "$HOME/.config/codex-kiro/coexist/installation.json" ]]; then
  node src/coexist.mjs --refresh
  kiro_install_action=upgrade
else
  node src/coexist.mjs
  kiro_install_action=install
fi
"$KIRO_PYTHON" scripts/prepare-desktop-patch.py
"$KIRO_PYTHON" scripts/manage-desktop.py "$kiro_install_action"
echo '安装完成。日常双击 scripts/launch-desktop.command；回滚双击 scripts/rollback-desktop.command。'
exec "$kiro_project_root/scripts/launch-desktop.command"
