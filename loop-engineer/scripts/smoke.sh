#!/usr/bin/env bash
# 无 key 冒烟测试：用 mock 供应商跑通「拆解→编码→闸→评审→合并」编排闭环。
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE="${SMOKE_DIR:-/tmp/loop-engineer-smoke}"
REPO="$SMOKE/target-repo"
JOB="$SMOKE/job"

echo "▸ 准备冒烟环境：$SMOKE"
rm -rf "$SMOKE"
mkdir -p "$REPO" "$JOB"

# 1. 目标 repo（一个最小 git 仓库）
git init -q -b main "$REPO"
cat > "$REPO/package.json" <<'JSON'
{ "name": "smoke-target", "version": "0.0.0", "private": true }
JSON
git -C "$REPO" add -A
git -C "$REPO" -c user.email=smoke@test -c user.name=smoke commit -q -m "init target repo"

# 2. job manifest（verify 命令：确认 worker 确实在 worktree 里产出了 feature 文件）
cat > "$JOB/loop.json" <<JSON
{
  "id": "smoke",
  "repo": "$REPO",
  "baseBranch": "main",
  "integrationBranch": "loop/integration",
  "verify": {
    "commands": ["node -e \\"if(!require('fs').readdirSync('.').some(f=>f.startsWith('feature_')))process.exit(1)\\""]
  },
  "tasks": [
    { "id": "T1", "title": "任务一", "spec": "实现 A", "acceptance": ["A 可用"], "dependsOn": [] },
    { "id": "T2", "title": "任务二", "spec": "实现 B", "acceptance": ["B 可用"], "dependsOn": ["T1"] }
  ]
}
JSON

# 3. 用 mock 供应商 drain 跑完
echo "▸ 运行编排（mock coder/reviewer）"
cd "$HERE"
LOOP_WATCH_DIRS="$JOB" LOOP_CODER=mock LOOP_REVIEWER=mock \
  pnpm exec tsx src/cli.ts run --drain

echo
echo "▸ 结果校验"
STATUSES=$(node -e "const j=require('$JOB/loop.json');console.log(j.tasks.map(t=>t.id+':'+t.status).join(' '))")
echo "  任务状态：$STATUSES"
echo "  集成分支提交历史："
git -C "$REPO" log --oneline loop/integration | sed 's/^/    /'

if [ "$STATUSES" = "T1:done T2:done" ]; then
  MERGES=$(git -C "$REPO" log --oneline --merges loop/integration | wc -l | tr -d ' ')
  if [ "$MERGES" -ge 2 ]; then
    echo "✓ 冒烟通过：两任务均 done，且各自 --no-ff 合并进集成分支"
    exit 0
  fi
fi
echo "✗ 冒烟失败"
exit 1
