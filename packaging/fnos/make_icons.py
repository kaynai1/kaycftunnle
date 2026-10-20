"""生成 Kay-cftunnle 应用图标（纯标准库，无第三方依赖）。

设计：深色圆角底 + Cloudflare 橙渐变隧道洞口 + 穿透的光带，
      表达「cloudflared 隧道把外部流量引入内网」。
输出：packaging/fnos/ICON.PNG (64x64)、ICON_256.PNG (256x256)
     以及 app/ui/images/icon_64.png、icon_256.png
"""

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(3))


def rounded_rect_alpha(x, y, size, radius):
    """圆角矩形的抗锯齿覆盖率 0..1。"""
    cx, cy = x - size / 2 + 0.5, y - size / 2 + 0.5
    half = size / 2
    inner = half - radius
    dx = abs(cx) - inner
    dy = abs(cy) - inner
    if dx <= 0 and dy <= 0:
        return 1.0
    # 距离圆角中心的距离
    d = math.hypot(max(dx, 0), max(dy, 0))
    return max(0.0, min(1.0, radius - d + 0.5))


def tunnel_mask(x, y, size):
    """隧道形状：纵向半拱（拱顶 + 两条腿），中间镂空成洞口。"""
    cx = size / 2
    nx = (x - cx) / size
    ny = (y - size / 2) / size

    half_w = 0.275          # 外半径
    top_center_y = -0.165   # 拱心偏上，让整体居中
    bottom_y = 0.315        # 腿底

    if ny > bottom_y:
        return 0.0
    ax = abs(nx)
    if ny < top_center_y:
        d = math.hypot(nx, ny - top_center_y)
        if d > half_w + 0.012:
            return 0.0
        outer = 1.0 if d < half_w - 0.006 else max(0.0, (half_w + 0.012 - d) / 0.018)
    else:
        if ax > half_w + 0.012:
            return 0.0
        outer = 1.0 if ax < half_w - 0.006 else max(0.0, (half_w + 0.012 - ax) / 0.018)
    if outer <= 0:
        return 0.0

    # 洞口（内轮廓）
    half_i = 0.158
    top_i = -0.115
    if ny < top_i:
        inner = math.hypot(nx, ny - top_i) < half_i
    else:
        inner = ax < half_i
    return 0.0 if inner else outer


def vignette_light(x, y, size):
    """洞口向外的暖色光晕。"""
    nx = (x - size / 2) / size
    ny = (y - size / 2) / size
    d = math.hypot(nx, ny + 0.06)
    return max(0.0, 1.0 - d / 0.72) ** 2.2


def render(size):
    px = bytearray()
    BG_TOP = (30, 34, 45)
    BG_BOTTOM = (13, 15, 22)
    ORANGE_HI = (255, 205, 110)   # 拱顶受光
    ORANGE_MID = (249, 130, 30)   # Cloudflare 橙
    ORANGE_LO = (222, 82, 10)     # 腿底暗部
    radius = size * 0.225

    for y in range(size):
        px.append(0)
        for x in range(size):
            t_bg = y / max(1, size - 1)
            r, g, b = mix(BG_TOP, BG_BOTTOM, t_bg)

            glow = vignette_light(x, y, size)
            if glow > 0:
                r = int(lerp(r, ORANGE_MID[0], glow * 0.55))
                g = int(lerp(g, ORANGE_MID[1], glow * 0.55))
                b = int(lerp(b, ORANGE_MID[2], glow * 0.55))

            tm = tunnel_mask(x, y, size)
            if tm > 0:
                # 拱顶亮 -> 中部标准橙 -> 腿底暗，营造立体感
                t = (y / size - 0.06) / 0.72
                if t < 0.45:
                    ring = mix(ORANGE_HI, ORANGE_MID, max(0.0, t) / 0.45)
                else:
                    ring = mix(ORANGE_MID, ORANGE_LO, min(1.0, (t - 0.45) / 0.55))
                r = int(lerp(r, ring[0], tm))
                g = int(lerp(g, ring[1], tm))
                b = int(lerp(b, ring[2], tm))

            a = rounded_rect_alpha(x, y, size, radius)
            px.extend((r, g, b, int(round(255 * a))))
    return bytes(px)


def write_png(path, size, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    compressed = zlib.compress(raw, 9)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", compressed)
           + chunk(b"IEND", b""))
    path.write_bytes(png)
    return len(png)


def main():
    targets = [
        (OUT / "ICON.PNG", 64),
        (OUT / "ICON_256.PNG", 256),
        (OUT / "app" / "ui" / "images" / "icon_64.png", 64),
        (OUT / "app" / "ui" / "images" / "icon_256.png", 256),
    ]
    cache = {}
    for path, size in targets:
        if size not in cache:
            cache[size] = render(size)
        path.parent.mkdir(parents=True, exist_ok=True)
        n = write_png(path, size, cache[size])
        print(f"  {path.relative_to(OUT)}  {size}x{size}  {n} bytes")


if __name__ == "__main__":
    main()
