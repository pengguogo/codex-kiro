# Shared prerequisites for Finder and terminal launchers.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
export NO_PROXY="${NO_PROXY:+${NO_PROXY},}127.0.0.1,localhost,::1"
export no_proxy="${no_proxy:+${no_proxy},}127.0.0.1,localhost,::1"
[[ "$(uname -s)" == Darwin ]] || { echo '桌面接入只支持 macOS。'; exit 1; }
if [[ "${KIRO_ROLLBACK:-0}" != 1 ]]; then
command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || { echo '请先安装 Node.js 20+（brew install node）。'; exit 1; }
fi
if [[ -z "$KIRO_PYTHON" ]]; then
  for kiro_python_candidate in python3 python3.14 python3.13 python3.12 python3.11; do
    if command -v "$kiro_python_candidate" >/dev/null && "$kiro_python_candidate" -c 'import tomllib' 2>/dev/null; then
      export KIRO_PYTHON="$(command -v "$kiro_python_candidate")"
      break
    fi
  done
fi
[[ -n "$KIRO_PYTHON" ]] && "$KIRO_PYTHON" -c 'import tomllib' || { echo '请先安装 Python 3.11+（brew install python@3.11）。'; exit 1; }
if [[ "${KIRO_ROLLBACK:-0}" != 1 ]]; then
export KIRO_CLI_PATH="${KIRO_CLI_PATH:-$(command -v kiro-cli)}"
[[ -x "$KIRO_CLI_PATH" ]] || { echo '未找到 kiro-cli，请安装或设置 KIRO_CLI_PATH。'; exit 1; }
fi
