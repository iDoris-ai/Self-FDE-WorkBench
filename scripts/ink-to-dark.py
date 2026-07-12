#!/usr/bin/env python3
"""
把「白底黑线稿」转成「透明底 · 暗色模式墨迹」的 PNG。

为什么需要这一步：
  站点是暗底。原始插画是黑线稿 + 白背景。
  - 直接贴白底图 → 页面上一块刺眼的白方块。
  - 只把白色抠成透明 → 黑线落在黑底上，等于看不见。
  - 整体反色 → 小J 的红背带会变成青色，IP 最强的识别符号没了。

所以这里做的是「按色相分流」：
  * 灰阶像素（线稿、黑发、黑羽绒服）→ 换成纸白色，alpha = 原本的墨量
    （越黑 → 越不透明；纯白背景 → 完全透明）
  * 彩色像素（红背带、橙箭头）→ 保留原色相，只按墨量给 alpha
    这样红仍然是红，橙仍然是橙。

结果：一张透明 PNG，线条是纸白色，红/橙原样保留，直接浮在暗底上。

用法：
    python3 scripts/ink-to-dark.py 输入.png 输出.png [--max-width 1200]
"""
import sys
from PIL import Image

# 站点的纸白色（--paper），暗色模式下线条用它
PAPER = (232, 228, 220)

# 饱和度高于此值就当成「有意义的颜色」（红背带 / 橙箭头），保留原色
SAT_THRESHOLD = 60


def convert(src_path: str, dst_path: str, max_width: int = 1200) -> None:
    img = Image.open(src_path).convert("RGB")

    if img.width > max_width:
        h = round(img.height * max_width / img.width)
        img = img.resize((max_width, h), Image.LANCZOS)

    out = Image.new("RGBA", img.size)
    src = img.load()
    dst = out.load()

    for y in range(img.height):
        for x in range(img.width):
            r, g, b = src[x, y]
            hi, lo = max(r, g, b), min(r, g, b)
            sat = hi - lo

            # 墨量：离白色越远 = 墨越浓 = 越不透明。纯白 -> alpha 0（透明）。
            ink = 255 - hi

            if sat >= SAT_THRESHOLD:
                # 有色像素（红/橙）：保留原色，按「离白多远」给不透明度。
                # 用 255-lo 而不是 255-hi：亮红的 hi 很高，用 hi 会几乎全透明。
                dst[x, y] = (r, g, b, min(255, 255 - lo))
            else:
                # 灰阶像素：线稿/黑填充 -> 纸白色；白背景 -> 透明
                dst[x, y] = (*PAPER, ink)

    out.save(dst_path, "PNG", optimize=True)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    width = 1200
    if "--max-width" in sys.argv:
        width = int(sys.argv[sys.argv.index("--max-width") + 1])
    convert(sys.argv[1], sys.argv[2], width)
    print(f"✓ {sys.argv[2]}")
