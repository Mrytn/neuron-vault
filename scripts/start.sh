#!/usr/bin/env bash
set -euo pipefail

CALLER_DIR="$PWD"
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
fail() { printf '启动失败：%s\n' "$1" >&2; exit 1; }
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--check' ) ]]; then
  printf '用法：%s [--check]\n--check 仅检查构建和参数，不启动服务器、不创建数据目录。\n' "$0" >&2
  exit 2
fi

JAVA_BIN="$(command -v java || true)"
if [[ -n "${JAVA_HOME:-}" ]]; then JAVA_BIN="$JAVA_HOME/bin/java"; fi
[[ -n "$JAVA_BIN" && -x "$JAVA_BIN" ]] || fail '未找到 Java。请安装 Java 17，或设置有效的 JAVA_HOME。'
JAVA_SPEC="$("$JAVA_BIN" -XshowSettings:properties -version 2>&1 | awk -F'= ' '/^[[:space:]]*java.specification.version = / {print $2; exit}')"
[[ "$JAVA_SPEC" =~ ^[0-9]+$ ]] && (( JAVA_SPEC >= 17 )) || fail '需要 Java 17 或更新版本；本项目使用 Java 17 验证。'

shopt -s nullglob
JAR_FILES=("$PROJECT_ROOT/backend/target"/neuron-vault-*.jar)
[[ ${#JAR_FILES[@]} -eq 1 ]] || fail '未找到唯一的后端 JAR。请先在项目根目录运行 ./scripts/build.sh。'
[[ -f "$PROJECT_ROOT/frontend/dist/index.html" ]] || fail '缺少前端构建。请先在项目根目录运行 ./scripts/build.sh。'
NEURON_PORT="${NEURON_PORT:-8787}"
[[ "$NEURON_PORT" =~ ^[0-9]{1,5}$ ]] || fail 'NEURON_PORT 必须是 1–65535 之间的端口号。'
(( 10#$NEURON_PORT >= 1 && 10#$NEURON_PORT <= 65535 )) || fail 'NEURON_PORT 必须是 1–65535 之间的端口号。'
NEURON_PORT="$((10#$NEURON_PORT))"
DATA_DIR="${VAULT_HOME:-$PROJECT_ROOT/data}"
if [[ "$DATA_DIR" != /* ]]; then DATA_DIR="$CALLER_DIR/$DATA_DIR"; fi

# Encode the absolute path as a file URI, including spaces, #, and UTF-8 bytes.
file_uri() {
  local LC_ALL=C input="$1" output='' char encoded i
  for ((i=0; i<${#input}; i++)); do
    char="${input:i:1}"
    case "$char" in
      [a-zA-Z0-9/._~-]) output+="$char" ;;
      *) printf -v encoded '%%%02X' "'$char"; output+="$encoded" ;;
    esac
  done
  printf 'file://%s/' "$output"
}
STATIC_URI="$(file_uri "$PROJECT_ROOT/frontend/dist")"
printf 'Neuron Vault · 仅本机访问\n界面：http://127.0.0.1:%s\n数据目录：%s\n静态资源：%s\n' "$NEURON_PORT" "$DATA_DIR" "$STATIC_URI"
if [[ "${1:-}" == '--check' ]]; then
  printf '检查通过；未启动服务器、未创建或修改数据。\n'
  exit 0
fi
printf '进程在当前终端前台运行。按 Ctrl+C 停止；停止前请在界面保存草稿。\n\n'
cd "$PROJECT_ROOT"
exec "$JAVA_BIN" -jar "${JAR_FILES[0]}" \
  --server.address=127.0.0.1 \
  "--server.port=$NEURON_PORT" \
  "--vault.home=$DATA_DIR" \
  "--spring.web.resources.static-locations=$STATIC_URI"
