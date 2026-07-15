#!/usr/bin/env bash
# 生成插画 pack 的本地后端：FLUX 出图 → 抠透明底 → 量化到体积闸内。
# 输入经环境变量：INPUT_PROMPT（必填）、INPUT_OUT（可选，默认 out/illustration.png）
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"        # capability-packs 根
REPO="$(cd "$HERE/.." && pwd)"                    # 仓库根（有 scripts/ink-to-transparent.py）
PROMPT="${INPUT_PROMPT:-}"
OUT="${INPUT_OUT:-$HERE/out/illustration.png}"
[ -n "$PROMPT" ] || { echo "缺 INPUT_PROMPT"; exit 2; }
mkdir -p "$(dirname "$OUT")"

VENV="${ML_VENV:-$HOME/venvs/ml}"
MODEL="${FLUX_MODEL:-$HOME/.omlx/models/FLUX.2-klein-4B-mflux-4bit}"
[ -d "$MODEL" ] || { echo "FLUX 模型缺失：$MODEL（先下载模型）"; exit 3; }
# shellcheck disable=SC1091
source "$VENV/bin/activate" 2>/dev/null || { echo "缺 ML venv：$VENV"; exit 3; }

RAW="$(mktemp -t flux_raw_XXXX).png"
echo "▸ FLUX 生成中…"
mflux-generate-flux2 --model "$MODEL" --base-model flux2-klein-4b \
  --prompt "$PROMPT" --steps "${STEPS:-16}" --seed "${SEED:-7}" \
  --width "${WIDTH:-1024}" --height "${HEIGHT:-640}" --low-ram --output "$RAW" >/dev/null 2>&1

# 抠透明底（若仓库有该脚本）+ 调色板量化到 <200KB
TP="$(mktemp -t flux_tp_XXXX).png"
if [ -f "$REPO/scripts/ink-to-transparent.py" ]; then
  python3 "$REPO/scripts/ink-to-transparent.py" "$RAW" "$TP" --max-width 860 >/dev/null 2>&1
else
  cp "$RAW" "$TP"
fi
python3 - "$TP" "$OUT" <<'PY'
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
img = Image.open(src).convert("RGBA")
img.quantize(colors=128, method=Image.FASTOCTREE).save(dst, optimize=True)
PY
rm -f "$RAW" "$TP"
KB=$(( $(wc -c < "$OUT") / 1024 ))
echo "✓ 已生成：$OUT (${KB}KB)"
