# 演示媒体与复现

`demo.mp4` 是 **功能演示动画（虚构数据，非实机录屏）**，`poster.png` 是它的静态封面。每一帧持续显示“虚构数据 · 功能演示动画”和“非实机录屏”。它没有浏览器窗口或模拟点击光标，也不声称展示实际云模型输出。

动画只读取仓库 `demo/vault/` 的虚构笔记，以及 `demo-graph.json` 中从演示后端与实际 `layoutGraph` 生成的坐标和关系。文字节选与来源行从示例 Markdown 读取；三维段使用这些坐标做透视和旋转。内容布局是动画设计，不是应用界面的截图。

## 生成视频

需要 Python 3.10+、[Pillow](https://pillow.readthedocs.io/)、本机 `ffmpeg`（含 libx264 编码器）和支持中文的字体。依赖与字体不随仓库打包，也不会由脚本自动下载。

从仓库根目录运行：

```bash
python3 scripts/render_demo.py
```

默认生成 `1280 × 720`、20 fps、34 秒的无声 MP4，以及第 22 秒对应的封面。输出会覆盖同名媒体文件。默认中文字体路径适用于安装了 Noto CJK 的 Linux；其他系统传入自己的字体文件：

```bash
python3 scripts/render_demo.py --font /absolute/path/to/CJK-font.ttf
```

只生成封面用于视觉检查：

```bash
python3 scripts/render_demo.py --poster-only
```

可使用 `--graph`、`--output`、`--poster`、`--duration`、`--fps` 指定参数。脚本验证节点标题来自虚构种子、ID 唯一、坐标有限且所有边的端点存在；不读取 `data/`、模型配置或任何私人导出文件，不发出网络请求。

## 图谱输入

输入 JSON 格式如下；示意结构中的坐标不用于正式媒体：

```json
{
  "points": [
    {
      "node": {"id": "demo-id", "title": "示例标题", "group": "示例文件夹", "tags": []},
      "x": 0, "y": 0, "z": 0, "color": "#1D71F6", "degree": 0
    }
  ],
  "edges": []
}
```

正式输入必须来自独立演示服务的 `/api/graph`，再经过 `frontend/src/graph-model.ts` 导出的 `layoutGraph`。请使用 `.demo-data/` 和演示端口 8790，不使用日常知识库，也不要用手编坐标冒充应用布局。`edges` 保留同一次图谱响应中的实际关系；动画不会补造连线。

脚本中的标题卡和原文卡仅用于讲解功能；它不代替真实浏览器的视觉验收、性能测试或交互测试。更新媒体时应同时检查封面、若干章节帧和编码信息，避免裁切、文字溢出或去掉持续免责声明。
