# 测试 / Testing

需要 Go 1.24+（允许下载 `go.mod` 指定的工具链）和 Node.js 22+。从发布目录根部运行：

```sh
node scripts/test.mjs
```

脚本按顺序执行 `go test ./...`、`go vet ./...`、构建 `bin/md-editor`（Windows 为 `.exe`），然后运行 `tests/` 内全部 `*.test.cjs` 与 `*.http.cjs`。不依赖 shell 的通配符展开，Windows、Linux、macOS 使用同一入口。

HTTP 测试**必须使用当前源码构建的程序**。直接运行时，可通过 `EDITOR_TEST_BINARY` 指定绝对程序路径；默认查找项目根部的 `md-editor.exe`（Windows）或 `md-editor`（其他系统）。前端资源嵌入程序，旧程序不能用来验证新前端。

| 领域 | 覆盖 |
| --- | --- |
| 编辑 | 行号、宽度调整、跳转、文字搜索与高亮、表格、文末续写 |
| 工作区 | 标签关闭、排序、侧栏、目录权限列表、失败恢复 |
| 接口 | 超时、配置版本、文件操作、变更通知、访问权限 |
| 资源 | HTML/Markdown 预览、图片嵌入、路径隐私、沙箱、过期响应 |
| 在线状态 | 跨文档合计、同 IP 多标签、文档详情、权限过滤、并发及过期 |

测试使用合成数据、临时目录、临时端口和自有进程；不使用个人实际文档、配置或运行服务。测试中的 `D:/notes`、`D:/private`、`@root`、`192.0.2.*`、回环 IP 等均为演示数据，路径处理测试保留了这些输入以覆盖 Windows 盘符与隐私过滤。断言里的 `secret`、`token` 不是实际凭据。

`tests/*.browser.js` 是手动浏览器辅助脚本，不属于 Node 自动回归；本次验证结果见 [VALIDATION.md](VALIDATION.md)。GitHub Actions 配置了 Windows/Linux 回归；工作流执行结果以实际 Actions 日志为准。

压测工具在 `tools/loadcheck`，只应指向独立测试服务。`tools/resourcecheck.ps1` 为 Windows 专用资源采样脚本，生成结果不随发布包上传；历史容量数据未作为本次版本的保证。

**本软件未在公网环境下进行安全评估测试，不建议公网使用。** 测试通过仅证明被覆盖用例，不代表完成渗透测试、生产验收或公网安全评估。

## English

Run `node scripts/test.mjs` with Go and Node.js 22+. It executes Go tests and vet, builds the current application, then runs all Node/HTTP tests. HTTP tests use isolated temporary files, ports and processes. Example drive paths, documentation IP ranges, loopback addresses and mock tokens are synthetic fixtures, not developer data or credentials.

Browser helper scripts are manual tools and are not part of the Node suite. Resource measurements and historical load figures are not guarantees for this version. Passing tests do not establish suitability for public Internet deployment; this software has not undergone that assessment.
