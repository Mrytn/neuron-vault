# 使用指南

[返回 README](../README.md)

## 启动与停止

在仓库根目录运行：

```bash
./scripts/build.sh
./scripts/start.sh
```

浏览器打开 `http://127.0.0.1:8787`。服务在终端前台运行；停止前保存草稿，再按 `Ctrl+C`。只检查构建和启动参数，可运行 `./scripts/start.sh --check`。

`NEURON_PORT` 修改端口，`VAULT_HOME` 指定数据根目录。相对的 `VAULT_HOME` 按启动命令所在目录解释，建议使用绝对路径：

```bash
VAULT_HOME="$PWD/my-vault-data" NEURON_PORT=8788 ./scripts/start.sh
```

不要同时让两个服务写入同一个数据根目录。演示使用 `./scripts/demo.sh`，地址为 `http://127.0.0.1:8790`，数据保存在 `.demo-data/`，来源是 `demo/vault/` 中的虚构样例。首次创建后，再次启动使用 `./scripts/demo.sh --reuse`；它要求有效的演示标记，并保留练习修改。`--prepare-only` 只准备副本；使用 `NEURON_DEMO_PORT` 可换演示端口（不能使用 8787）。已设置 `VAULT_HOME` 时脚本会拒绝运行，可用 `env -u VAULT_HOME ./scripts/demo.sh` 明确进入演示模式。

## 写笔记与建立联系

在界面中新建 Markdown 笔记，选择文件夹，编辑并保存。可使用常见标题、列表、代码块、表格与本地图片。

```markdown
# 索引设计

关联资料：[[缓存策略]]
相对笔记链接：[发布检查](../交付/发布检查.md)

#系统设计 #实践
```

双链标题需要能唯一对应目标笔记。同名标题可能无法自动消歧，优先使用明确的相对 `.md` 路径。标签支持文首 `tags` 字段和正文中的行内标签；代码示例中的文字不应被当作真实关系。

将附件放在 `vault/assets/` 内，图片路径按当前笔记目录计算。例如 `vault/技术/索引设计.md` 可使用 `![图](../assets/示意图.png)`。在应用内移动笔记会调整相对链接；使用外部工具移动文件时，应自行核对链接。

删除笔记会送入回收站，还原后保留稳定 ID。直接编辑磁盘文件后，使用界面刷新读取最新内容；保存时出现冲突，请先对照新旧正文，不要用旧草稿覆盖外部修改。

## 搜索与图谱

搜索按关键词匹配标题和正文，支持中文查询并展示命中的原文行。可以尝试笔记中出现的术语；它不执行语义嵌入检索，也不会识别图片上的文字。

图谱默认使用三维视图。拖动旋转，滚轮缩放，单击选择节点并固定信息卡，双击打开笔记。操作会暂停自动旋转；也可用按钮手动暂停或恢复。系统开启“减少动态效果”时默认不自动旋转。

切换到二维关系网后，可拖空白平移、拖节点调整显示位置。筛选文件夹、搜索节点、查看相邻笔记不会改动原文件。节点列表提供键盘可用的打开入口。

连线来自笔记链接或共同标签；节点的空间位置和距离是可视化布局，不表示模型推断的语义相似度。大图会限制标签数量，密集关系场景会按界面提示只显示选中或悬停节点的边，仍保留筛选范围内的节点。

## 模型与来源

不配置模型即可使用本地检索。问答返回原文摘录和可打开的来源，明确标为本地模式。

要启用生成式回答，在“工作空间设置”中填写：

- 接口类型：OpenAI Responses 或 Chat Completions 兼容接口。
- Base URL：服务商的接口根地址，不含 `/responses` 或 `/chat/completions`。
- 模型名称：服务商提供且你的账号可以调用的标识。
- API Key：你自己的密钥；没有默认凭据。

后端发送当前问题、命中文档标题、行号和最多 5 个片段，每段上限 600 字符；不发送整库或附件。没有命中片段时不会调用模型。来源缺失或加密的导入占位记录仍可搜索，但不会作为完整问答证据。

远程接口需 HTTPS；仅回环地址允许 HTTP。兼容接口也需要填写非空 Key 与模型名称才能启用。超时、接口失败、缺失引用或无效来源编号会显示错误，不会伪装成成功回答。

清空模型名称并保存可停止云问答。密钥输入留空表示保留原密钥；它不会删除已保存配置。密钥文件在数据根目录 `.config/settings.json`，不是浏览器存储。来源引用请打开原文核对上下文。

## 导入已有笔记

普通 Markdown 可复制到 `vault/` 内，再刷新界面。请避免符号链接，附件统一放入 `vault/assets/`。直接复制内容不保留另一个应用的身份、历史或来源元数据。

仓库提供本地有道导入脚本。它们处理已经导出的文件，不登录账号、不爬取云笔记，也不解锁加密内容。不同来源的导出格式可能不同，先运行 `--help` 和 dry-run，检查报告后再导入。

### 已下载的 DOCX

为每个文件准备清单记录，字段如下；路径均为你自己的本地文件：

```json
[
  {
    "title": "虚构导入示例",
    "folder": "导入示例",
    "sourceUrl": "https://example.invalid/note/demo",
    "sourceId": "demo-note-001",
    "downloadPath": "/absolute/path/to/example.docx"
  }
]
```

```bash
python3 scripts/import_youdao.py --manifest /absolute/path/to/manifest.json --dry-run
python3 scripts/import_youdao.py --manifest /absolute/path/to/manifest.json --base-url http://127.0.0.1:8787
```

正式 DOCX 导入要求本地服务已启动。脚本保留可解析的文字、表格、代码、链接与内嵌图片，备份原 DOCX 并记录摘要；它不是 Word 排版引擎。外部图片资源不会自动下载，受保护或导出失败的条目会跳过。

### 可阅读导出目录

`import_youdao_export.py` 需要带 `导出清单.json`、可阅读 Markdown/HTML 和附件目录的约定导出结构；它不是任意 HTML 目录转换器。

先停止服务，确保数据根目录已存在。以自己的路径替换下面变量：

```bash
python3 scripts/import_youdao_export.py \
  --source /absolute/path/to/readable-export \
  --vault-home "$PWD/data" \
  --archive-name my-import \
  --report /tmp/neuron-import-preview.json \
  --dry-run
```

确认报告后，用 `--apply` 替换 `--dry-run`，并给正式报告另选文件名。自定义应用端口时，额外传入对应的 `--server-port`。离线导入采用暂存、提交和备份流程；重复导入会检查来源状态，并保护导入后已有的本地编辑。源目录保持只读，不读取加密正文或原始数据库。导入报告、备份和原始文件同样可能含私人信息，请妥善保存。

### 独立核验导入

`verify_youdao_export.py` 仅读取源导出、实际知识库、导入前备份和预先保存的源文件 SHA-256 基线，单独核对正文、附件、HTML 副本、链接及来源状态。它不会联网或修改这些输入，报告必须写到输入目录之外。

```bash
python3 scripts/verify_youdao_export.py \
  --source /absolute/path/to/readable-export \
  --vault-home "$PWD/data" \
  --backup-home /absolute/path/to/original-data \
  --baseline /absolute/path/to/source-baseline.json \
  --archive-name my-import \
  --report /tmp/neuron-import-audit.json
```

`--backup-home` 指向正式导入保留的原数据备份；`--baseline` 必须是操作前建立的源文件校验清单，不能在事后重新生成并据此声称源未改变。基线格式与合成示例见 [校验测试](../scripts/test_verify_youdao_export.py)。

可选 `--expected-counts` 接受独立已知数量的 JSON；没有它时仍按清单、备份和基线逐项核对，不使用固定的个人库数量。`--import-report` 只用于比较解析统计，不取代完整性检查。若曾显式替换旧来源，校验时通过可重复的 `--replaced-legacy-source SOURCE_ID` 列出这些来源；默认要求保留所有原有笔记。

## 导出与备份

界面 ZIP 导出包含活动笔记和可导出的附件，排除回收站、应用元数据、隐藏配置和常见密钥文件。适合迁移 Markdown 内容，不用于完整恢复应用状态。

完整备份应先停服务，再复制整个 `VAULT_HOME`（默认 `data/`）。恢复时也应停服务，并恢复完整目录，避免只替换索引或只替换部分笔记。备份中的模型配置可能含密钥；不要把它提交到公开仓库。

## 开发模式

完成首次构建后，用两个终端分别运行：

```bash
# 终端一：后端与已构建界面，8787
./scripts/start.sh
```

```bash
# 终端二：Vite，5173；/api 代理至 8787
cd frontend
npm run dev
```

打开 `http://127.0.0.1:5173`。修改 Java 代码后需要重新构建并重启后端。当前开发代理固定到 8787，改变后端端口时需要同步调整 Vite 配置。

## 常见问题

- **端口被占用**：使用 `NEURON_PORT=8788 ./scripts/start.sh`，并打开脚本打印的地址。
- **403“仅允许本机受信页面访问”**：使用 `http://127.0.0.1:端口/`，不要使用局域网 IP 或未经支持的代理域名。
- **依赖下载失败**：检查 npm/Maven 的软件源和网络。可通过 `MAVEN_SETTINGS=/absolute/path/settings.xml ./scripts/build.sh` 指定独立 Maven 配置；仓库不会替你改写全局设置。
- **没有云回答**：检查模型名称、Key 和服务地址是否完整，以及本地是否检索到了相关片段。模型费用、账号权限与服务可用性由供应商决定。
- **图片不可预览**：检查相对路径和 `assets/` 文件是否存在；不支持内联的格式可下载原件。纯图片笔记不会自动产生可检索的 OCR 文本。
