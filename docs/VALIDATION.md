# 发布目录验证 / Export validation

日期：2026-10-27。此文件记录独立 GitHub 发布目录的验证范围；历史项目日志、业务示例、内网地址与开发机绝对路径未纳入导出。

| 项目 | 范围 |
| --- | --- |
| 原生环境 | Windows amd64，Go 1.26.10，Node.js 24 |
| 自动回归 | `node scripts/test.mjs` 通过：Go 测试、vet、当前程序构建，以及 103 项 Node/HTTP 测试全部通过 |
| Release | Windows、Linux、macOS 的 amd64/arm64 六种交叉构建成功，另附对应源码包与 SHA-256 清单 |
| 产物检查 | 7 个压缩包 SHA-256 均匹配；PE/ELF/Mach-O 文件头与标注架构一致；源码包逐文件比对当前导出源码一致；许可证、说明、示例及第三方许可齐全 |
| 原生程序实跑 | Windows amd64 Release 中的 `-version` 返回 `v0.1.0`；使用原生示例配置、自建临时目录和端口成功启动，HTTP 文档列表读取成功 |
| 配置语法 | 原生/容器配置、Compose 和两份 Actions 工作流通过 YAML 解析及关键字段检查 |
| Docker | 提供 Dockerfile、Compose、非 root 用户与初始化配置；当前验证环境没有 Docker 命令，未声称完成镜像构建或容器实跑 |
| 实机限制 | 其他 OS/CPU 组合只交叉构建，未实机启动；GitHub Actions 将在上传后执行，其结果以实际日志为准 |

回归仅访问测试自建的临时文档、配置、日志及端口，不修改实际运行服务。手动浏览器辅助脚本不包含在自动测试数量中。压测容量、CPU/内存上限和公网安全性不作为本次版本的测试结论。

发布文件使用 `-trimpath`、`-buildvcs=false`，不打包真实 `config.yaml`、日志、个人文档、原始测试结果、缓存或旧二进制。Windows 示例盘符、文档保留 IP、合成文档名和模拟令牌是测试输入，予以保留。

**不建议在公网使用。本软件未在公网环境下进行安全评估测试，请酌情配置。**

## English

This export is validated on Windows amd64 with Go 1.26.10 and Node.js 24. Other binaries are cross-compiled; native execution on those platforms has not been verified. Docker is not available in the validation environment, so image/container execution is not claimed. Uploaded GitHub Actions workflows will provide separate CI results.

Only synthetic fixtures are used. Personal configuration, documents, logs, raw historical results and local machine paths are excluded. Passing regression tests or a cross-build is not a public Internet security assessment.
