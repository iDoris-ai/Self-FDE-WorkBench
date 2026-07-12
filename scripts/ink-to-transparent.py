#!/usr/bin/env python3
"""
把「白底手绘线稿」转成「透明底 PNG」，墨色原样保留。

为什么不做成「暗色墨迹」：
  试过了，不行。小J 的形象大面积依赖黑色填充（头发、黑羽绒服）。
  任何「让黑线在暗底上可见」的变换，都会把这些黑填充一并翻成亮色 ——
  羽绒服变白、脸变成黑洞，图底反转，IP 直接毁掉。
  黑填充的画，物理上就不能直接浮在黑底上。

所以这里只做一件事：把白色背景抠成透明，墨色一律不动。
产出的 PNG 需要落在浅色面板上才能读；好处是人物可以溢出面板边缘，
不再是一个硬邦邦的白方块。

抠图规则（不是简单的阈值二值化，否则线条边缘会出现锯齿）：
  alpha = 255 - min(r,g,b)
  - 纯白背景 (255,255,255) -> alpha 0，完全透明
  - 黑线 (0,0,0)           -> alpha 255，完全不透明
  - 抗锯齿的灰边           -> 中间 alpha，边缘保持平滑
  - 红背带 / 橙箭头        -> min 通道很低 -> alpha 高，颜色完整保留

用 min 而不是亮度：亮度会让饱和的红色（255,40,40）算出很高的亮度，
从而被误判成「接近白色」而变透明。min 通道对彩色墨迹是稳的。

用法：
    python3 scripts/ink-to-transparent.py 输入.png 输出.png [--max-width 1000]
"""
import sys
from PIL import Image


def convert(src_path: str, dst_path: str, max_width: int = 1000) -> None:
    img = Image.open(src_path).convert("RGB")

    if img.width > max_width:
        h = round(img.height * max_width / img.width)
        img = img.resize((max_width, h), Image.LANCZOS)

    rgb = img.load()
    out = Image.new("RGBA", img.size)
    dst = out.load()

    for y in range(img.height):
        for x in range(img.width):
            r, g, b = rgb[x, y]
            alpha = 255 - min(r, g, b)
            # 近白的杂点直接清掉，避免透明底上浮一层脏灰
            if alpha < 12:
                dst[x, y] = (0, 0, 0, 0)
            else:
                dst[x, y] = (r, g, b, alpha)

    out.save(dst_path, "PNG", optimize=True)
    print(f"✓ {dst_path}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    width = 1000
    if "--max-width" in sys.argv:
        width = int(sys.argv[sys.argv.index("--max-width") + 1])
    convert(sys.argv[1], sys.argv[2], width)
