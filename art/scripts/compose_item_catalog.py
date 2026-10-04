"""将 Blender 实际渲染组成带中文标签的资产目录，不重新绘制模型。"""

import html
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BASE = Path(__file__).resolve().parents[2]
PREVIEWS = BASE / "art/previews/items"
GROUPS = {"items/equipment": ("角色能力装备", "EQUIPMENT", "#4266AC"),
          "items/industrial": ("工业流水线", "INDUSTRIAL", "#AC7950"),
          "items/magic": ("魔法与奇怪效果", "MAGIC POST", "#8C799D")}


def font(size):
    """优先选择系统中文字体，目录文本不依赖网络字体或外部图片。"""
    for path in ("/System/Library/Fonts/STHeiti Light.ttc", "/System/Library/Fonts/PingFang.ttc",
                 "C:/Windows/Fonts/msyh.ttc",
                 "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"):
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def card(canvas, entry, x, y, width, height, color):
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((x, y, x + width, y + height), 16, fill="#FFF9EF", outline="#D8D0C2", width=2)
    image = Image.open(BASE / entry["preview"]).convert("RGB")
    image.thumbnail((width - 20, height - 74), Image.Resampling.LANCZOS)
    canvas.paste(image, (x + (width - image.width) // 2, y + 8))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((x + 18, y + height - 57, x + 22, y + height - 20), fill=color)
    draw.text((x + 32, y + height - 58), entry["name_zh"], font=font(23), fill="#293240")
    draw.text((x + 32, y + height - 27), entry["id"], font=font(12), fill="#787066")


def make_board(groups, destination, title, columns):
    """每个类别一行或两行，统一展示大小仅用于目录，不改变GLB比例。"""
    width, card_width, card_height, gap, margin = columns * 326 + 56, 310, 360, 16, 28
    heights = [70 + ((len(entries) + columns - 1) // columns) * (card_height + gap) for _, entries in groups]
    canvas = Image.new("RGB", (width, 140 + sum(heights) + 28), "#EFE5D4")
    draw = ImageDraw.Draw(canvas)
    draw.text((margin, 25), title, font=font(38), fill="#293240")
    draw.text((margin, 80), "COURIER ISLAND  /  BLENDER ASSET LIBRARY  /  METERS · Z-UP SOURCE · Y-UP GLB",
              font=font(15), fill="#706454")
    y = 125
    for category, entries in groups:
        label, subtitle, color = GROUPS[category]
        draw.rounded_rectangle((margin, y + 4, margin + 8, y + 38), 4, fill=color)
        draw.text((margin + 21, y), label, font=font(27), fill="#293240")
        draw.text((margin + 240, y + 11), subtitle, font=font(14), fill=color)
        y += 55
        for index, entry in enumerate(entries):
            card(canvas, entry, margin + index % columns * (card_width + gap),
                 y + index // columns * (card_height + gap), card_width, card_height, color)
        y += ((len(entries) + columns - 1) // columns) * (card_height + gap) + 15
    canvas.save(destination)


def make_html(entries):
    """本地目录直接链接独立模型和源文件，适合交付时浏览或放大预览。"""
    sections = []
    for category, (name, subtitle, color) in GROUPS.items():
        cards = []
        for entry in entries:
            if entry["category"] != category:
                continue
            safe = {key: html.escape(str(entry[key]), quote=True) for key in ("id", "name_zh", "file", "variant")}
            dimensions = " × ".join(f"{value:.2f}" for value in entry["dimensions_m"])
            cards.append(f'<article><a href="{safe["id"]}.png"><img src="{safe["id"]}.png" alt="{safe["name_zh"]}"></a>'
                         f'<div><h3>{safe["name_zh"]}</h3><p class="id">{safe["id"]}</p>'
                         f'<p>{dimensions} m · {entry["triangles"]:,} triangles</p>'
                         f'<p><a href="../../../{safe["file"]}">独立 GLB</a> · {safe["variant"]}</p></div></article>')
        sections.append(f'<section style="--accent:{color}"><h2>{name}<small>{subtitle}</small></h2><div class="grid">{"".join(cards)}</div></section>')
    page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Courier Island · 道具美术资产</title><style>
*{box-sizing:border-box}body{margin:0;background:#efe5d4;color:#293240;font:16px system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:42px 28px}h1{font-size:38px;margin:0 0 12px}header p{max-width:800px;line-height:1.7}nav{display:flex;flex-wrap:wrap;gap:20px;margin:22px 0 40px}a{color:#4266ac}h2{border-left:7px solid var(--accent);padding-left:16px;margin-top:42px}small{font-size:13px;font-weight:400;color:var(--accent);margin-left:20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}article{overflow:hidden;border:1px solid #d8d0c2;border-radius:14px;background:#fff9ef}img{display:block;width:100%;height:auto}article>div{padding:4px 18px 15px}h3{margin:8px 0}.id{font-size:12px;color:#777;overflow-wrap:anywhere}article p{font-size:13px}footer{margin-top:40px;color:#706454;font-size:14px}</style><main>
<header><h1>小岛快递 · 道具美术资产</h1><p>18 件道具与配套结构变体。预览来自 Blender 实际模型渲染；独立 GLB 保留米制比例、原点与命名接口。点击图片查看原尺寸。</p></header>
<nav><a href="../../blender/courier_items.blend">Blender 源库</a><a href="../../items/README.md">资产说明</a><a href="overview.png">总览图</a><a href="equipment_fit_front.png">穿戴正面</a><a href="equipment_fit.png">穿戴背面</a><a href="../../items/asset_manifest.json">资产清单</a></nav>
''' + "".join(sections) + '<footer>这些是美术资产；装备效果、工业模拟与魔法玩法尚未接入游戏。源模型不包含碰撞或角色蒙皮适配。</footer></main></html>'
    (PREVIEWS / "catalog.html").write_text(page, encoding="utf-8")


def main():
    manifest = json.loads((BASE / "art/items/asset_manifest.json").read_text(encoding="utf-8"))
    entries = manifest["assets"]
    groups = [(category, [entry for entry in entries if entry["category"] == category and entry["variant"] == "default"])
              for category in GROUPS]
    make_board(groups, PREVIEWS / "overview.png", "小岛快递 · 18 件道具", 6)
    for category, group in groups:
        make_board([(category, group)], PREVIEWS / (category.rsplit("/", 1)[-1] + ".png"), GROUPS[category][0], 3)
    variants = [(category, [entry for entry in entries if entry["category"] == category and entry["variant"] != "default"])
                for category in GROUPS]
    make_board([(category, group) for category, group in variants if group], PREVIEWS / "variants.png", "配套结构变体", 3)
    make_html(entries)
    print(json.dumps({"status": "composed", "main_items": sum(len(group) for _, group in groups), "assets": len(entries)}))


if __name__ == "__main__":
    main()
