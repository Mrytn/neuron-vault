#!/usr/bin/env python3
"""Render a labeled feature animation from synthetic demo notes and real graph layout.

This is deliberately not a screen recording. No browser, user vault, model API,
external image, or network download is used. Requires Pillow and local ffmpeg.
"""
from __future__ import annotations

import argparse
from functools import lru_cache
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "demo" / "vault"
WIDTH, HEIGHT = 1280, 720
BG = (55, 62, 75)
TEXT = (171, 178, 191)
WHITE = (237, 243, 252)
BLUE = (29, 113, 246)
MUTED = (131, 144, 164)
DEFAULT_FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"


def plain_file(path: Path) -> Path:
    path = path.absolute()
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError(f"拒绝符号链接：{part}")
    if not path.is_file():
        raise ValueError(f"文件不存在：{path}")
    return path


def load_material(graph_path: Path):
    notes = []
    for path in sorted(SEED.rglob("*.md")):
        plain_file(path)
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        title = next((line[2:].strip() for line in lines if line.startswith("# ")), path.stem)
        notes.append({"title": title, "path": path.relative_to(SEED).as_posix(), "lines": lines})
    if not notes:
        raise ValueError("demo/vault 没有 Markdown 合成样例；不会读取其他知识库。")
    graph = json.loads(plain_file(graph_path).read_text(encoding="utf-8"))
    titles = {note["title"] for note in notes}
    points = graph.get("points", [])
    if not points:
        raise ValueError("图谱布局 points 为空；请先从独立演示服务生成实际布局 JSON。")
    ids = set()
    for point in points:
        node = point.get("node", {})
        if node.get("title") not in titles or not isinstance(node.get("id"), str) or node["id"] in ids:
            raise ValueError("图谱节点必须唯一，且标题必须来自 demo/vault 的虚构笔记。")
        if not all(isinstance(point.get(axis), (int, float)) and math.isfinite(point[axis]) for axis in ("x", "y", "z")):
            raise ValueError("图谱坐标必须是有限数字。")
        ids.add(node["id"])
    edges = graph.get("edges", [])
    if any(edge.get("source") not in ids or edge.get("target") not in ids for edge in edges):
        raise ValueError("关系边含未提供的节点；不会自动补造节点或关系。")
    chosen = next((note for note in notes if note["title"] == "幂等收件箱"), notes[0])
    query = "幂等" if "幂等" in chosen["title"] else chosen["title"][:4]
    candidates = [(number, line.strip()) for number, line in enumerate(chosen["lines"], 1)
                  if query in line and not line.startswith(("#", ">", "tags:")) and "[[" not in line]
    if not candidates:
        candidates = [(number, line.strip()) for number, line in enumerate(chosen["lines"], 1) if query in line]
    line, excerpt = candidates[0]
    return notes, graph, chosen, query, line, excerpt


class Renderer:
    def __init__(self, graph_path: Path, font_path: Path):
        self.notes, self.graph, self.note, self.query, self.line, self.excerpt = load_material(graph_path)
        self.font_path = str(plain_file(font_path))
        self.radius = max(110.0, *(math.sqrt(sum(point[axis] ** 2 for axis in ("x", "y", "z"))) for point in self.graph["points"]))
        self.backdrop = Image.new("RGB", (WIDTH, HEIGHT), BG)
        draw = ImageDraw.Draw(self.backdrop)
        # Subtle typographic framing, never decoration that looks like graph data.
        draw.line((56, 87, WIDTH - 56, 87), fill=(77, 88, 105), width=1)
        draw.line((56, HEIGHT - 57, WIDTH - 56, HEIGHT - 57), fill=(77, 88, 105), width=1)

    @lru_cache(maxsize=24)
    def font(self, size):
        return ImageFont.truetype(self.font_path, size)

    def text(self, image, xy, text, size=24, color=TEXT, anchor=None):
        ImageDraw.Draw(image).text(xy, text, font=self.font(size), fill=color, anchor=anchor)

    def wrap(self, text, size, width):
        font = self.font(size)
        output, line = [], ""
        for char in text:
            if char == "\n":
                output.append(line)
                line = ""
            elif font.getlength(line + char) > width and line:
                output.append(line)
                line = char
            else:
                line += char
        if line:
            output.append(line)
        return output

    def paragraph(self, image, xy, text, size=23, width=450, leading=38, max_lines=6, color=TEXT):
        x, y = xy
        lines = self.wrap(text, size, width)
        if len(lines) > max_lines:
            lines = lines[:max_lines]
            lines[-1] = lines[-1].rstrip("。，； ") + "…"
        for index, line in enumerate(lines):
            self.text(image, (x, y + index * leading), line, size, color)
        return y + len(lines) * leading

    @lru_cache(maxsize=200)
    def sphere(self, radius, level, emphasis):
        """Pre-render true node sprites; no invented graph dots or orbit lines."""
        r = max(2, radius)
        pad = r * 3
        size = pad * 2 + 1
        sprite = Image.new("RGBA", (size, size))
        glow = Image.new("RGBA", (size, size))
        bright = (.30 + .70 * level / 12)
        tint = BLUE if emphasis else (155, 192, 242)
        draw = ImageDraw.Draw(glow)
        draw.ellipse((pad-r*1.5, pad-r*1.5, pad+r*1.5, pad+r*1.5), fill=(*tint, round(42 * bright)))
        sprite.alpha_composite(glow.filter(ImageFilter.GaussianBlur(max(1, r * .55))))
        draw = ImageDraw.Draw(sprite)
        for step in range(r, 0, -1):
            offset = 1 - step / r
            color = tuple(round((tint[i] * (.58 + offset * .36) + 35 * offset) * (.57 + .43 * bright)) for i in range(3))
            center = pad - offset * r * .22
            draw.ellipse((center-step, center-step, center+step, center+step), fill=(*color, round(255 * bright)))
        hi = max(1, r * .19)
        draw.ellipse((pad-r*.25-hi, pad-r*.3-hi, pad-r*.25+hi, pad-r*.3+hi), fill=(234, 244, 255, round(230 * bright)))
        return sprite

    def graph_frame(self, image, time, center=(850, 360), extent=270, opacity=1.0, labels=True):
        rx = -.22 + math.sin(time * .21) * .12
        ry = .3 + time * .17
        ca, sa, cb, sb = math.cos(ry), math.sin(ry), math.cos(rx), math.sin(rx)
        camera = max(440, self.radius * 1.7)
        silhouette = self.radius * camera / math.sqrt(camera ** 2 - self.radius ** 2)
        world = extent / silhouette
        pixels = []
        for point in self.graph["points"]:
            x = point["x"] * ca + point["z"] * sa
            z0 = -point["x"] * sa + point["z"] * ca
            y, z = point["y"] * cb - z0 * sb, point["y"] * sb + z0 * cb
            perspective = camera / (camera - z)
            light = max(0, min(1, (z / self.radius + 1) / 2))
            radius = max(2, min(12, (3.7 + math.log2(max(0, point.get("degree", 0)) + 1) * .7) * perspective * world))
            pixels.append({"point": point, "x": center[0] + x * perspective * world,
                           "y": center[1] + y * perspective * world, "depth": z,
                           "light": light, "radius": radius})
        pixels.sort(key=lambda p: p["depth"])
        by_id = {p["point"]["node"]["id"]: p for p in pixels}
        layer = Image.new("RGBA", (WIDTH, HEIGHT))
        draw = ImageDraw.Draw(layer)
        for edge in self.graph["edges"]:
            a, b = by_id[edge["source"]], by_id[edge["target"]]
            alpha = round((18 + (a["light"] + b["light"]) * 27) * opacity)
            draw.line((a["x"], a["y"], b["x"], b["y"]), fill=(142, 174, 217, alpha), width=1)
        for pixel in pixels:
            sprite = self.sphere(round(pixel["radius"]), round(pixel["light"] * 12), pixel["point"]["node"]["title"] == self.note["title"]).copy()
            if opacity < 1:
                sprite.putalpha(sprite.getchannel("A").point(lambda value: round(value * opacity)))
            layer.alpha_composite(sprite, (round(pixel["x"] - sprite.width / 2), round(pixel["y"] - sprite.height / 2)))
        if labels:
            boxes, count = [], 0
            candidates = sorted(pixels, key=lambda p: (p["point"]["node"]["title"] == self.note["title"], p["light"], p["point"].get("degree", 0)), reverse=True)
            font = self.font(16)
            for pixel in candidates:
                if count >= 6:
                    break
                title = pixel["point"]["node"]["title"]
                if len(title) > 13:
                    title = title[:12] + "…"
                width = font.getlength(title)
                x, y = pixel["x"] - width / 2, pixel["y"] + pixel["radius"] + 8
                box = (x-5, y-2, x+width+5, y+24)
                if box[0] < 430 or box[2] > 1220 or box[1] < 110 or box[3] > 630:
                    continue
                if any(box[0] < b[2] and box[2] > b[0] and box[1] < b[3] and box[3] > b[1] for b in boxes):
                    continue
                boxes.append(box)
                draw.rounded_rectangle(box, radius=4, fill=(*BG, round(224 * opacity)))
                draw.text((x, y), title, font=font, fill=(*TEXT, round(255 * opacity)))
                count += 1
        image.paste(Image.alpha_composite(image.convert("RGBA"), layer).convert("RGB"))

    def panel(self, image, box):
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle(box, radius=20, fill=(43, 50, 63), outline=(85, 101, 126), width=1)

    def stage(self, index, time):
        image = self.backdrop.copy()
        if index == 0:
            self.graph_frame(image, time, (960, 350), 220, .58, False)
            self.text(image, (64, 135), "NEURON VAULT", 21, (129, 176, 250))
            self.text(image, (60, 195), "笔记在本机。", 67, WHITE)
            self.text(image, (60, 288), "知识有连接。", 67, WHITE)
            self.text(image, (64, 405), "Markdown · 来源 · 三维关系", 26)
            for offset, text in enumerate(("本地保存", "无需默认密钥", "文件可迁移")):
                x = 66 + offset * 198
                ImageDraw.Draw(image).line((x, 512, x + 30, 512), fill=BLUE, width=3)
                self.text(image, (x, 536), text, 21)
        elif index == 1:
            self.graph_frame(image, time, (1020, 400), 200, .18, False)
            self.text(image, (64, 126), "01 / MARKDOWN", 19, (129, 176, 250))
            self.text(image, (64, 170), "正文就是普通文件", 40, WHITE)
            self.paragraph(image, (66, 242), "编辑、链接、移动与恢复。\n用自己的工具继续读写。", 24, 390, 42)
            self.text(image, (66, 520), ".md  /  本地附件  /  ZIP 导出", 20)
            self.panel(image, (514, 136, 1215, 598))
            self.text(image, (544, 161), "虚构样例 · Markdown 原文节选", 17, MUTED)
            self.text(image, (544, 205), "# " + self.note["title"], 30, WHITE)
            body = next((line for line in self.note["lines"] if line and not line.startswith(("---", "tags:", "#", ">", "[["))), "")
            self.paragraph(image, (546, 275), body, 22, 620, 37, 3)
            links = next((line for line in self.note["lines"] if line.startswith("[[")), "")
            if links:
                self.text(image, (546, 438), "关联笔记", 17, MUTED)
                self.paragraph(image, (546, 474), links, 20, 615, 34, 2, (129, 176, 250))
        elif index == 2:
            self.text(image, (64, 126), "02 / SOURCES", 19, (129, 176, 250))
            self.text(image, (64, 170), "先找到原文，再理解", 40, WHITE)
            self.paragraph(image, (66, 246), "关键词检索\n片段、笔记、来源行\n随时返回上下文", 25, 370, 49)
            self.text(image, (66, 537), "本地摘录 ≠ 模型生成", 23, (129, 176, 250))
            self.panel(image, (514, 136, 1215, 598))
            self.text(image, (544, 162), "示例检索词  /  " + self.query, 21, WHITE)
            ImageDraw.Draw(image).line((545, 215, 1185, 215), fill=(77, 91, 114), width=1)
            self.text(image, (545, 244), "[1] " + self.note["title"], 27, (129, 176, 250))
            self.paragraph(image, (546, 303), self.excerpt, 23, 610, 40, 4)
            self.text(image, (546, 495), f"原文第 {self.line} 行 · 虚构资料摘录", 19, MUTED)
            self.paragraph(image, (546, 536), self.note["path"], 16, 610, 25, 2)
        elif index == 3:
            self.graph_frame(image, time, (865, 355), 262, 1, True)
            self.text(image, (64, 126), "03 / SPATIAL GRAPH", 19, (129, 176, 250))
            self.text(image, (64, 174), "关系进入三维", 42, WHITE)
            self.paragraph(image, (66, 255), "真实布局坐标\n透视、深度与旋转视差", 25, 365, 48)
            self.paragraph(image, (66, 394), "拖动旋转 · 滚轮缩放\n单击选择 · 双击打开\n也可切换二维关系网", 21, 360, 41)
            self.text(image, (66, 553), "连线来自样例笔记的实际关系", 17, MUTED)
        else:
            self.graph_frame(image, time, (1010, 350), 220, .3, False)
            self.text(image, (64, 143), "NEURON VAULT", 22, (129, 176, 250))
            self.text(image, (60, 215), "从一篇笔记开始。", 60, WHITE)
            self.text(image, (66, 332), "本地 Markdown 知识库 · 开源 MIT", 25)
            self.text(image, (66, 432), "github.com/Mrytn/neuron-vault", 29, (129, 176, 250))
            self.text(image, (66, 492), "hankukedong@gmail.com", 23)
            self.text(image, (66, 572), "运行演示：./scripts/demo.sh", 20, MUTED)
        return image

    def frame(self, seconds, duration):
        # Timeline reserves the largest single segment for the actual 3D layout.
        time = seconds * 34 / duration
        starts = [0, 5, 11, 17, 29]
        index = max(i for i, start in enumerate(starts) if time >= start)
        image = self.stage(index, time)
        if index and time - starts[index] < .45:
            blend = (time - starts[index]) / .45
            blend = blend * blend * (3 - 2 * blend)
            image = Image.blend(self.stage(index - 1, time), image, blend)
        # This disclosure is persistent, including every transition and poster.
        self.text(image, (57, 27), "NEURON VAULT", 18, WHITE)
        self.text(image, (1223, 27), "虚构数据 · 功能演示动画", 20, (167, 198, 246), anchor="ra")
        self.text(image, (57, 677), "非实机录屏  /  无云模型调用", 16, TEXT)
        self.text(image, (1223, 677), "LOCAL FILES. REAL CONNECTIONS.", 14, MUTED, anchor="ra")
        return image


def output_path(path):
    path = path.absolute()
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError(f"输出路径不能是符号链接：{part}")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--graph", type=Path, default=ROOT / "docs/media/demo-graph.json")
    parser.add_argument("--font", type=Path, default=Path(DEFAULT_FONT))
    parser.add_argument("--output", type=Path, default=ROOT / "docs/media/demo.mp4")
    parser.add_argument("--poster", type=Path, default=ROOT / "docs/media/poster.png")
    parser.add_argument("--duration", type=float, default=34)
    parser.add_argument("--fps", type=int, default=20)
    parser.add_argument("--poster-only", action="store_true")
    args = parser.parse_args()
    if not 5 <= args.duration <= 120 or not 1 <= args.fps <= 60:
        parser.error("duration 需为 5–120 秒，fps 需为 1–60。")
    for target in (args.output, args.poster):
        destination = target.absolute()
        if destination in (args.graph.absolute(), args.font.absolute()) or destination.is_relative_to(SEED):
            raise ValueError("媒体输出不能覆盖图谱、字体或 demo/vault 种子。")
    if args.output.absolute() == args.poster.absolute():
        raise ValueError("视频和 poster 必须使用不同输出路径。")
    renderer = Renderer(args.graph, args.font)
    poster = output_path(args.poster)
    renderer.frame(args.duration * 22 / 34, args.duration).save(poster)
    print(f"poster: {poster}", flush=True)
    if args.poster_only:
        return
    executable = shutil.which("ffmpeg")
    if not executable:
        raise ValueError("未找到 ffmpeg；已生成 poster，可安装 ffmpeg 后重新运行。")
    output = output_path(args.output)
    if output == poster or output == args.graph.absolute():
        raise ValueError("视频输出不能覆盖输入图谱或 poster。")
    command = [executable, "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
               "-s", f"{WIDTH}x{HEIGHT}", "-r", str(args.fps), "-i", "-", "-an", "-c:v", "libx264",
               "-preset", "medium", "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    count = round(args.duration * args.fps)
    try:
        for frame in range(count):
            process.stdin.write(renderer.frame(frame / args.fps, args.duration).tobytes())
            if frame % (args.fps * 5) == 0:
                print(f"render: {frame}/{count} frames", flush=True)
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError("ffmpeg 编码失败。")
    except BaseException:
        process.kill()
        process.wait()
        raise
    print(f"video: {output} ({WIDTH}x{HEIGHT}, {args.fps} fps, {count / args.fps:.1f} s, no audio)", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError) as error:
        print(f"render failed: {error}", file=sys.stderr)
        raise SystemExit(1)
