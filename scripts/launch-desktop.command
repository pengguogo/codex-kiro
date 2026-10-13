#!/bin/zsh
set -e
kiro_project_root="$(cd -- "${0:A:h}/.." && pwd)"
source "$kiro_project_root/scripts/desktop-env.sh"
"$KIRO_PYTHON" "$kiro_project_root/scripts/manage-desktop.py" check-closed
node "$kiro_project_root/src/desktop.mjs" restart --force
exec /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
