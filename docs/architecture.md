# 架构与数据边界

[返回 README](../README.md)

## 进程与模块

```text
Browser · React / TypeScript
  ├─ Markdown editor, folders, search, source navigation
  ├─ 3D Canvas + 2D Canvas
  └─ same-origin /api requests
             │
Java 17 · Spring Boot · 127.0.0.1
  ├─ LocalRequestFilter / ApiController
  ├─ VaultService: Markdown, metadata, revision, search, relations
  ├─ AssetService: bounded local attachments
  ├─ SettingsService: local model configuration
  └─ AiService: local excerpts or optional provider request
             │                         │
     Local filesystem          User-configured model API
```

`frontend/` 使用 React、TypeScript、Vite 和原生 Canvas。构建后的静态资源由启动脚本交给 Spring Boot 同源提供。`backend/` 使用 Java 17、Spring Boot 与 CommonMark。`scripts/` 提供构建、启动和基于 Python 标准库的导入工具；核心功能不需要外部数据库或向量服务。

## 文件是正文的来源

数据根目录由 `VAULT_HOME` 或 `vault.home` 指定。启动脚本默认使用仓库根目录的 `data/`。

| 位置 | 职责 |
| --- | --- |
| `vault/**/*.md` | 活动笔记正文；可由普通编辑器读取。 |
| `vault/assets/` | 可迁移的本地附件。 |
| `.metadata/index.json` | 稳定 ID、笔记路径、来源信息、回收状态等应用元数据。 |
| `.trash/` | 已删除笔记的正文，恢复时保留 ID。 |
| `.config/settings.json` | 可选模型连接参数及密钥。 |

应用不会把每次保存转换成专有正文格式。索引和元数据仍对完整恢复有意义，因此“Markdown 可迁移”和“完整应用备份”是两种不同操作。

`VaultService` 在读取时扫描文件状态，缓存未变化的内容和派生关系。文件大小、时间与文件身份参与变化检测；支持的平台上也检查变更时间。缓存用于减少重复解析，不把磁盘外部修改当作不存在。写操作使用临时文件和替换，保存时校验基于内容的 revision，避免旧草稿静默覆盖新内容。

应用内移动文件会重定位指向原目标的相对链接，保留其查询和片段部分，并跳过代码示例。遇到无法安全处理的移动应报错；外部工具改名或移动仍需要调用方维护链接。

## 搜索、关系与图谱

搜索是确定性的关键词匹配：标题加权，正文按行计分，中文查询会拆出连续词和相邻字组合。返回匹配片段、路径和真实行号。它没有语义嵌入、重排模型或 OCR。

关系来自可解析的 wikilink、Markdown 笔记链接和共享标签。标题歧义不会被随意指派到某一篇笔记。代码块和行内代码不应产生标签或链接关系。

图谱前端先筛选节点和边，再生成展示位置。三维布局保留空间坐标，Canvas 负责透视、深度排序和命中测试；二维视图使用力导向布局与平移缩放。边只来自后端关系，空间距离不构成语义推断。标签按预算和屏幕碰撞网格显示。大图中的边可能按明确的界面规则收敛到选中邻域，不能把“未画出”解释为“关系已删除”。

画布静止时按需重绘；三维自动旋转采用节流，并在页面隐藏或暂停时停止循环。用户交互保留相机状态，系统减少动态效果偏好由视图层处理。

## 问答路径

1. 校验问题，执行本地关键词检索。
2. 排除 `missing_body` 和 `encrypted` 等不完整来源。
3. 选择最多 5 个片段，每段不超过 600 字符。
4. 无可用模型配置时，直接返回本地原文摘录和来源。
5. 有配置时，将问题、标题、行号和片段发到指定模型服务；不上传整库或附件。
6. 校验响应能否读取、是否包含来源编号，以及编号是否属于本次来源。失败返回明确错误。

OpenAI 分支使用 Responses API；兼容分支使用 Chat Completions。请求设置 `store: false`，但这不等于对第三方提供商的数据保留行为作保证。模型没有文件、网络浏览或命令执行工具。引用校验只验证编号合法性，不证明每条回答与证据一致。

## HTTP 与安全范围

所有业务路由位于 `/api`：笔记 CRUD、搜索、图谱、问答、设置、导入、导出、回收站与附件读取。主服务仅监听回环地址。过滤器检查本机 Host/Origin，拒绝跨站 API 请求；从其他网页打开首页的顶层导航保留必要入口。

文件访问拒绝路径越界和符号链接；密钥配置使用 POSIX 私有权限。Markdown 预览跳过原始 HTML，附件按类型决定可否内联显示，远程图片需主动点击后才加载。

这是一套本机单用户边界，不提供多人认证、租户隔离或公网服务的防护能力。详见 [SECURITY.md](../SECURITY.md)。

## 验证策略

前端测试覆盖异步状态、链接与来源交互、图谱筛选、投影和指针行为；Canvas 测试记录绘图指令，不使用真实笔记。Java 测试覆盖存储、冲突、链接移动、来源过滤、模型错误和请求/附件边界。Python 测试使用临时合成导出，核对转换、幂等、回滚和校验行为。

CI 分别执行这些测试及前后端构建；它不连接付费模型、不访问个人知识库，也不声称替代浏览器视觉验收或生产数据备份。
