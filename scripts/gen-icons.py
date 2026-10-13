"""Data Maskit 图标生成：蓝色渐变圆角方底 + 白色盾牌 + 打码条。

用法：python scripts/gen-icons.py export（不带参数时只输出预览到 .tmp-shots/）
"""
import os
import sys
from PIL import Image, ImageDraw


def bez(p0, p1, p2, p3, n=48):
    out = []
    for i in range(n + 1):
        t = i / n
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
        out.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return out


def shield(cx, top, w, h):
    # 外凸平顶（中间略高），两侧下行后收成尖底
    l, r, b = cx - w / 2, cx + w / 2, top + h
    pts = []
    pts += bez((l, top + h * 0.10), (l + w * 0.28, top + h * 0.0), (r - w * 0.28, top + h * 0.0), (r, top + h * 0.10))
    pts += bez((r, top + h * 0.10), (r, top + h * 0.55), (cx + w * 0.30, top + h * 0.86), (cx, b))
    pts += bez((cx, b), (cx - w * 0.30, top + h * 0.86), (l, top + h * 0.55), (l, top + h * 0.10))
    return pts


def render(S, background=True, inset=0.0):
    k = 4
    N = S * k
    img = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    if background:
        m = int(N * inset)
        inner = N - 2 * m
        # 对角渐变 #4F7BFF → #2340C8（用两张纯色图按渐变蒙版混合，比逐像素快）
        v = Image.linear_gradient('L')
        ramp = Image.blend(v, v.rotate(90), 0.5).transpose(Image.FLIP_LEFT_RIGHT).resize((N, N), Image.BILINEAR)
        grad = Image.composite(Image.new('RGBA', (N, N), (35, 64, 200, 255)),
                               Image.new('RGBA', (N, N), (79, 123, 255, 255)), ramp)
        mask = Image.new('L', (N, N), 0)
        ImageDraw.Draw(mask).rounded_rectangle([m, m, N - 1 - m, N - 1 - m], radius=int(inner * 0.225), fill=255)
        img.paste(grad, (0, 0), mask)
        fg, bar = (255, 255, 255, 255), (47, 86, 230, 255)
        sw, sh = inner * 0.56, inner * 0.66
        stop = m + inner * 0.17
    else:
        # 托盘图：无底，蓝色盾牌 + 白色打码条
        fg, bar = (59, 108, 246, 255), (255, 255, 255, 255)
        sw, sh, stop = N * 0.84, N * 0.96, N * 0.02
    d = ImageDraw.Draw(img)
    d.polygon(shield(N / 2, stop, sw, sh), fill=fg)
    # 小尺寸（≤32px）圆点会糊成一片：只画加粗的打码条
    small = S <= 32
    bw, bh = sw * (0.66 if small else 0.62), sh * (0.24 if small else 0.19)
    bx0, by0 = N / 2 - bw / 2, stop + sh * 0.38
    d.rounded_rectangle([bx0, by0, bx0 + bw, by0 + bh], radius=bh / 2, fill=bar)
    r = bh * 0.2
    for i in (() if small else (-1, 0, 1)):
        cx, cy = N / 2 + i * bw * 0.24, by0 + bh / 2
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fg)
    return img.resize((S, S), Image.LANCZOS)


def preview(base):
    os.makedirs(base + '.tmp-shots', exist_ok=True)
    render(1024).save(base + '.tmp-shots/icon-preview.png')
    sizes = (16, 32, 48, 128)
    row = Image.new('RGBA', (sum(sizes) + 10 * len(sizes), 128), (240, 240, 240, 255))
    x = 0
    for sz in sizes:
        im = render(sz)
        row.paste(im, (x, 128 - sz), im)
        x += sz + 10
    row.resize((row.width * 2, 256), Image.NEAREST).save(base + '.tmp-shots/sizes-preview.png')


def export(base):
    icons = base + 'build/icons/'
    for sz in (16, 32, 48, 64, 128, 256, 512):
        render(sz).save(f'{icons}{sz}x{sz}.png')
    render(1024).save(icons + 'icon.png')
    # ICO 每个尺寸单独渲染（小尺寸用简化画法），而不是从大图缩小
    ico_sizes = (16, 24, 32, 48, 64, 128, 256)
    render(256).save(icons + 'icon.ico', sizes=[(s, s) for s in ico_sizes],
                     append_images=[render(s) for s in ico_sizes[:-1]])
    # macOS 按系统规范四周留约 10% 边距
    render(1024, inset=0.1).save(icons + 'icon.icns')
    render(32).save(base + 'public/images/logo-32.png')
    render(512).save(base + 'public/images/logo.png')
    render(16, background=False).save(base + 'public/images/tray.png')
    for sz in (16, 32, 48, 128):
        render(sz).save(f'{base}extension/icons/icon{sz}.png')


if __name__ == '__main__':
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__))).replace(os.sep, '/') + '/'
    (export if 'export' in sys.argv else preview)(base)
    print('ok')
