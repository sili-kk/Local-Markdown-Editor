# Release 发布 / Releases

本次首次打包使用 `v0.1.0`，可用工具参数改为后续版本。默认一次构建以下平台：

| 系统 | 架构 | 压缩格式 |
| --- | --- | --- |
| Windows | amd64 / arm64 | ZIP |
| Linux | amd64 / arm64 | tar.gz |
| macOS (darwin) | amd64 / arm64 | tar.gz |

另附 `source.zip` 对应源码包和 `SHA256SUMS.txt`。每个程序包含版本程序、双语说明、原生配置示例、AGPLv3 正文、测试/安全文档及第三方许可证。不含运行配置、个人文档、日志、开发者绝对路径或旧二进制。

## 本机打包

在仓库根目录运行：

```sh
node scripts/test.mjs
go run ./tools/release -version v0.1.0
```

产物在 `dist/`（已被 Git 忽略），使用 Go 标准库打包，不依赖 zip/tar 外部程序。构建使用 `CGO_ENABLED=0`、`-trimpath` 和 `-buildvcs=false`。Windows/Linux/macOS 下载匹配系统和 CPU 的包，解压后按 README 启动。`md-editor -version` 可查看版本。

Windows 校验单个包：

```powershell
Get-FileHash .\dist\local-markdown-editor_v0.1.0_windows_amd64.zip -Algorithm SHA256
```

Linux 校验全部包：`cd dist && sha256sum -c SHA256SUMS.txt`。macOS：`cd dist && shasum -a 256 -c SHA256SUMS.txt`。

macOS/Windows 程序未做代码签名或公证，系统可能提示来源未知。跨平台构建成功不代表已在每个平台实机验证；实际测试范围见 [VALIDATION.md](VALIDATION.md)。

## GitHub 自动发布

上传此目录的**内容**到仓库根部。推送 `v0.1.0` 等标签会触发 `.github/workflows/release.yml`；也可在 Actions 手动填版本号执行。工作流先跑测试，再构建所有包并创建 GitHub Release，上传 6 个程序包、源码包和校验文件。确保版本标签对应待发布提交；不要给已有发布复用同一版本号。

本地生成的程序包使用 GitHub 的 Release 附件上传，通常不要提交到 Git 历史。提供二进制时应一并提供相同版本对应源码与构建说明，并遵守 AGPLv3。

## English

Run `go run ./tools/release -version v0.1.0` from the repository root. It builds Windows, Linux and macOS binaries for amd64 and arm64, packages documentation and licenses, includes a corresponding source archive, and writes SHA-256 checksums in `dist/`. The build uses Go's archive libraries and needs no external packaging tools.

Push a version tag or manually run the Release workflow to test, build and attach all artifacts to a GitHub Release. Upload the contents of this export directory as the repository root. Cross-compilation is not proof of native runtime compatibility. macOS and Windows binaries are unsigned. Retain the matching source archive and build instructions when distributing binaries under AGPLv3.
