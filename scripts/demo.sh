#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEMO_HOME="$PROJECT_ROOT/.demo-data"
DEMO_PORT="${NEURON_DEMO_PORT:-8790}"
PREPARE_ONLY=0
REUSE=0
fail() { printf '演示启动失败：%s\n' "$1" >&2; exit 1; }
usage() {
  cat <<'HELP'
用法：./scripts/demo.sh [--prepare-only] [--reuse]

首次启动前先运行 ./scripts/build.sh。
默认把完全虚构的 demo/vault 复制到独立 .demo-data，再启动真实后端。
默认地址：http://127.0.0.1:8790；前台运行，Ctrl+C 停止。

  --prepare-only  只准备演示副本，不启动服务器，不要求已完成构建
  --reuse         只复用有匹配演示标记的现有副本，保留练习修改
  --help          显示帮助

不会覆盖已有 .demo-data，不会清空任何目录，不读取个人数据或 API Key。
已设置 VAULT_HOME 时拒绝运行；可使用 env -u VAULT_HOME ./scripts/demo.sh。
可用 NEURON_DEMO_PORT 指定其它端口；禁止使用常规默认端口 8787。
HELP
}
for arg in "$@"; do
  case "$arg" in
    --prepare-only) PREPARE_ONLY=1 ;;
    --reuse) REUSE=1 ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ -z "${VAULT_HOME:-}" ]] || fail '检测到 VAULT_HOME；请使用 env -u VAULT_HOME ./scripts/demo.sh，避免混用个人库。'
[[ "$DEMO_PORT" =~ ^[0-9]{1,5}$ ]] || fail 'NEURON_DEMO_PORT 必须是 1–65535 之间的端口号。'
(( 10#$DEMO_PORT >= 1 && 10#$DEMO_PORT <= 65535 )) || fail 'NEURON_DEMO_PORT 必须是 1–65535 之间的端口号。'
DEMO_PORT="$((10#$DEMO_PORT))"
[[ "$DEMO_PORT" != '8787' ]] || fail '演示端口不能使用 8787；默认 8790 可避免与常规实例冲突。'
command -v python3 >/dev/null 2>&1 || fail '需要 Python 3 准备合成演示资料。'

if (( PREPARE_ONLY == 0 )); then
  # start.sh --check does not create data. Catch missing builds before creating
  # the demo home, while explicitly replacing any inherited server port.
  VAULT_HOME="$DEMO_HOME" NEURON_PORT="$DEMO_PORT" "$PROJECT_ROOT/scripts/start.sh" --check >/dev/null
fi
PREPARE_ARGS=()
if (( REUSE )); then PREPARE_ARGS+=(--reuse); fi
python3 "$PROJECT_ROOT/scripts/prepare_demo.py" "${PREPARE_ARGS[@]}"
if (( PREPARE_ONLY )); then
  printf '未启动服务器。完成构建后，运行 ./scripts/demo.sh --reuse。\n'
  exit 0
fi
printf '\n合成演示模式 · 使用真实本地后端 · 无需 API Key\n'
printf '建议先打开“开始这里”，再进入三维图谱和“问答练习”。\n\n'
exec env VAULT_HOME="$DEMO_HOME" NEURON_PORT="$DEMO_PORT" "$PROJECT_ROOT/scripts/start.sh"
