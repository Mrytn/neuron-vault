#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$PROJECT_ROOT"

fail() { printf '构建失败：%s\n' "$1" >&2; exit 1; }
command -v mvn >/dev/null 2>&1 || fail '未找到 Maven。请安装 Maven 3.6.3+ 后重试。'
command -v node >/dev/null 2>&1 || fail '未找到 Node.js。建议安装 Node.js 22。'
command -v npm >/dev/null 2>&1 || fail '未找到 npm。请检查 Node.js 安装。'

JAVA_BIN="$(command -v java || true)"
if [[ -n "${JAVA_HOME:-}" ]]; then
  [[ -x "$JAVA_HOME/bin/java" ]] || fail 'JAVA_HOME 未指向有效的 JDK。'
  JAVA_BIN="$JAVA_HOME/bin/java"
fi
[[ -n "$JAVA_BIN" && -x "$JAVA_BIN" ]] || fail '未找到 Java。请安装 JDK 17 并设置 PATH（或 JAVA_HOME）。'
JAVA_SPEC="$("$JAVA_BIN" -XshowSettings:properties -version 2>&1 | awk -F'= ' '/^[[:space:]]*java.specification.version = / {print $2; exit}')"
[[ "$JAVA_SPEC" =~ ^[0-9]+$ ]] && (( JAVA_SPEC >= 17 )) || fail '需要 Java 17 或更新版本；本项目使用 Java 17 验证。'
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || fail '请使用 Node.js 20+；建议 Node.js 22。'

MAVEN_ARGS=(-B -f "$PROJECT_ROOT/backend/pom.xml")
if [[ -n "${MAVEN_SETTINGS:-}" ]]; then
  [[ -f "$MAVEN_SETTINGS" ]] || fail 'MAVEN_SETTINGS 指定的文件不存在。'
  MAVEN_ARGS+=(-s "$MAVEN_SETTINGS")
fi
if [[ "${MAVEN_OFFLINE:-0}" == '1' ]]; then MAVEN_ARGS+=(-o); fi

printf '构建前端：React / TypeScript / Vite\n'
(
  cd "$PROJECT_ROOT/frontend"
  if [[ "${NEURON_SKIP_INSTALL:-0}" == '1' ]]; then
    [[ -x node_modules/.bin/vite && -x node_modules/.bin/tsc ]] || fail '跳过依赖安装前，需要已有完整 frontend/node_modules。'
  else
    npm ci --no-audit --no-fund
  fi
  npm run build
)

printf '\n构建后端并运行单元测试：Java / Spring Boot\n'
mvn "${MAVEN_ARGS[@]}" clean verify
printf '\n构建完成。运行 ./scripts/start.sh，浏览器打开 http://127.0.0.1:8787\n'
