# 参与贡献

欢迎提交可复现的问题、文档修正和范围清楚的改进。开始较大的功能之前，建议先在 Issue 中说明使用场景与预期行为，避免重复工作。

## 开发环境

使用 JDK 17、Node.js 22、Maven 3.6.3+ 和 Python 3.10+。从仓库根目录执行 `./scripts/build.sh` 后，可按[使用指南](docs/user-guide.md#开发模式)启动开发服务。

请使用虚构笔记或临时目录进行调试。`demo/vault/` 是可提交的合成样例；`data/`、`.demo-data/`、导入原件、截图中的个人内容和模型配置都不应进入提交。`.gitignore` 只能排除约定路径，不能替代提交前的检查。

## 提交改动

1. 让每个 PR 解决一个明确问题。描述触发条件、改动后的行为和验证结果。
2. 对数据保存、链接重写、导入、跨站访问、异步状态和图谱交互的变化增加针对性回归测试。
3. 保留 Markdown 可迁移性和已有笔记内容。迁移或破坏性格式变更必须说明兼容与恢复方式。
4. 修改行为时同步文档，不把计划功能写成已经实现。

PR 前运行：

```bash
(cd frontend && npm ci && npm test && npm run build)
mvn -B -ntp -f backend/pom.xml verify
python3 -m unittest discover -s scripts -p 'test_*.py' -v
```

这些测试不需要付费模型。UI 修改还应在浏览器中检查布局、键盘操作和缩放；Canvas 模拟测试并不等同于视觉验收。若某项检查未运行，在 PR 中说明原因。

## 报告问题

请附上操作系统、Java/Node 版本、复现步骤、预期与实际行为。尽量用一个最小的虚构 Markdown 示例复现。分享日志前删除密钥、笔记正文、本机用户名和私人路径。

涉及数据越界、脚本执行、凭据泄露或访问控制绕过的问题，请使用 [SECURITY.md](SECURITY.md) 中的私人报告渠道。

## 项目约定

- 前端使用 React、TypeScript、原生 Canvas；后端使用 Java 17 和 Spring Boot。
- 图谱节点和边必须来自真实的索引关系，不用装饰连线表达不存在的联系。
- AI 请求只使用有限检索片段；本地摘录、模型生成和错误状态必须明确区分。
- 不加入统计追踪、默认云凭据或自动上传笔记的功能。
- 默认 CI 权限为只读；不在 PR 测试中使用个人 API Key。

工作流使用 GitHub 官方的 [checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node)、[setup-java](https://github.com/actions/setup-java) 和 [setup-python](https://github.com/actions/setup-python)。调整版本时核对其运行器要求。

提交贡献即表示你有权提供这些内容，并同意将其按项目 [MIT 许可证](LICENSE) 分发。
