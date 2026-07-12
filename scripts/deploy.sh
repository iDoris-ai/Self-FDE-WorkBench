#!/usr/bin/env bash
#
# Self-FDE WorkBench — 发布到 Cloudflare Pages
#
#   ./scripts/deploy.sh              发布
#   ./scripts/deploy.sh --check      只做本地检查，不发布（dry run）
#
# 流程：本地链接自检 → 推到 Cloudflare → 校验线上每个页面返回 200
#
set -euo pipefail

PROJECT="self-fde-workbench"
DIST="site"
PROD_URL="https://${PROJECT}.pages.dev"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
ok()   { echo "${GRN}✓${OFF} $1"; }
warn() { echo "${YEL}!${OFF} $1"; }
die()  { echo "${RED}✗ $1${OFF}" >&2; exit 1; }

# 站点里所有需要存在的页面（新增页面时加到这里）
PAGES=(
  "/"
  "/vision.html"
  "/os.html"
  "/roles/expresser.html"
  "/roles/innovator.html"
  "/roles/builder.html"
)

# ─────────────────────────────────────────────
# 1. 本地自检
# ─────────────────────────────────────────────
echo "${DIM}── 本地自检 ──${OFF}"

[ -d "$DIST" ] || die "找不到 $DIST/ 目录"
[ -f "$DIST/index.html" ] || die "缺少 $DIST/index.html"

# 每个声明的页面都必须真实存在
for p in "${PAGES[@]}"; do
  f="$DIST${p}"
  [ "$p" = "/" ] && f="$DIST/index.html"
  [ -f "$f" ] || die "页面缺失：$f（PAGES 里声明了但文件不在）"
done
ok "${#PAGES[@]} 个页面文件齐全"

# 站内引用自检：href 和 src 都要查。
# src 尤其重要 —— assets/i18n.js 是硬依赖，它缺失/改名不会让页面报错，
# 只会让中英切换静默失效。只查 href 的话，这种断裂根本拦不住。
broken=0
while IFS= read -r link; do
  target="$DIST${link}"
  [ "$link" = "/" ] && target="$DIST/index.html"
  if [ ! -e "$target" ]; then
    echo "  ${RED}断链${OFF} $link"
    broken=$((broken + 1))
  fi
done < <(grep -rhoE '(href|src)="/[^"#]*"' "$DIST" --include='*.html' \
         | sed -E 's/^(href|src)="([^"]*)"$/\2/' | sort -u)

[ "$broken" -eq 0 ] || die "发现 $broken 条站内断链，已中止发布"
ok "站内引用（href + src）无断链"

# 双语硬依赖：每个页面都必须真的引入 i18n.js，否则切换按钮点了没反应。
# 用 lang-btn 而不是 class="lang" 作为探针：后者是精确串匹配，容器一旦
# 变成 class="lang xxx" 就会静默失配，检查悄悄变成死代码。
# lang-btn 是 i18n.js 直接依赖的选择器 —— 它在，脚本就必须在。
missing_i18n=0
for f in $(find "$DIST" -name '*.html'); do
  if grep -q 'lang-btn' "$f" && ! grep -q 'assets/i18n.js' "$f"; then
    echo "  ${RED}缺 i18n.js${OFF} ${f#$DIST}（有切换按钮却没引入脚本）"
    missing_i18n=$((missing_i18n + 1))
  fi
done
[ "$missing_i18n" -eq 0 ] || die "发现 $missing_i18n 个页面的语言切换会失效，已中止发布"
ok "双语脚本引入完整"

# 资源体积提醒（Pages 单文件上限 25MB）
big=$(find "$DIST" -type f -size +20M | head -1)
[ -z "$big" ] || die "文件过大，超出 Cloudflare Pages 限制：$big"
ok "资源体积正常（$(du -sh "$DIST" | cut -f1)）"

if [ "${1:-}" = "--check" ]; then
  echo "${GRN}本地检查通过${OFF}（--check 模式，未发布）"
  exit 0
fi

# ─────────────────────────────────────────────
# 2. 发布
# ─────────────────────────────────────────────
echo
echo "${DIM}── 发布到 Cloudflare Pages ──${OFF}"
npx wrangler pages deploy "$DIST" \
  --project-name="$PROJECT" \
  --branch=main \
  --commit-dirty=true

# ─────────────────────────────────────────────
# 3. 线上校验
# ─────────────────────────────────────────────
echo
echo "${DIM}── 线上校验（边缘节点可能有几十秒延迟）──${OFF}"

failed=0
for p in "${PAGES[@]}"; do
  code=""
  # 边缘冷启动时会短暂返回 5xx，重试几次再判失败
  for _ in 1 2 3 4 5 6; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -L "${PROD_URL}${p}" || echo 000)
    [ "$code" = "200" ] && break
    sleep 5
  done

  if [ "$code" = "200" ]; then
    ok "$(printf '%-24s' "$p") 200"
  else
    echo "${RED}✗${OFF} $(printf '%-24s' "$p") $code"
    failed=$((failed + 1))
  fi
done

echo
if [ "$failed" -eq 0 ]; then
  echo "${GRN}发布完成${OFF} → ${PROD_URL}"
else
  warn "$failed 个页面未返回 200。若刚发布，可能只是边缘还没同步——稍等再访问一次；持续异常就去 Cloudflare 面板看构建日志。"
  exit 1
fi
