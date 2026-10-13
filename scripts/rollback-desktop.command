#!/bin/zsh
set -e
kiro_project_root="$(cd -- "${0:A:h}/.." && pwd)"
export KIRO_ROLLBACK=1
source "$kiro_project_root/scripts/desktop-env.sh"
"$KIRO_PYTHON" "$kiro_project_root/scripts/manage-desktop.py" restore
open /Applications/ChatGPT.app
