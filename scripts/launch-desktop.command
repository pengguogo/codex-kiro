#!/bin/zsh
# Preserve external proxy settings; bypass proxies for this local gateway only.
kiro_bypass='127.0.0.1,localhost,::1'
export NO_PROXY="${NO_PROXY:+${NO_PROXY},}${kiro_bypass}"
export no_proxy="${no_proxy:+${no_proxy},}${kiro_bypass}"
kiro_project_root="$(cd -- "${0:A:h}/.." && pwd)"
node "$kiro_project_root/src/desktop.mjs" prepare || exit $?
exec /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
