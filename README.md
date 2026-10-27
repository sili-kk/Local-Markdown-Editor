# 屿墨笺 · Local Markdown Editor

[English](README.en.md) · [原生运行](#原生运行) · [Docker](#docker-compose) · [测试](docs/TESTING.md) · [Release](docs/RELEASING.md)

一个使用 Go 构建的本地 Markdown 编辑器：直接编辑磁盘上的文档，也可在可信局域网内共享。

> **不建议在公网使用。本软件未在公网环境下进行安全评估测试，请酌情配置。**
> 没有内置账号系统或 HTTPS，建议仅供本机及可信局域网使用。网络、目录权限和代理配置需要自行评估；配置代理并不代表已完成公网安全评估。

## 功能

- 所见即所得编辑，支持表格、代码块、图片、链接及自动保存。
- 多个文档目录、标签页、拖动排序、文档目录和本机文件管理。
- 行号、可调行号栏、本页搜索高亮、上下匹配和行号跳转。
- 远端目录权限：隐藏、只读、读写，权限继承至子目录和文件。
- 本页 Markdown/HTML 预览、隔离沙箱、本地图片及原图放大。
- 跨文档在线人数按 IP 合计，并展示各 IP 正在查看的文档。
- 版本冲突保护、变更通知、配置热加载和日志轮转。

界面目前为中文，说明文档提供中英文版本。

## 原生运行

从 GitHub Releases 下载对应系统和架构的压缩包，解压后先把 `config.example.yaml` 复制为 `config.yaml`，创建 `documents` 目录，放入 Markdown 文件。使用终端进入解压目录启动。

Windows PowerShell：

```powershell
Copy-Item config.example.yaml config.yaml
New-Item -ItemType Directory documents, logs -Force
.\md-editor.exe -config config.yaml
```

Linux / macOS：

```sh
cp config.example.yaml config.yaml
mkdir -p documents logs
chmod +x md-editor
./md-editor -config config.yaml
```

打开 <http://127.0.0.1:8080/>。下载版不需要 Go 或 Node.js。没有文档时可在 `documents/` 中手动放入 `.md` 文件。

### 从源码构建

需要 Go 1.24+，并允许下载 `go.mod` 指定的工具链；完整测试另需 Node.js 22+。

```sh
go build -trimpath -o md-editor .
```

Windows 输出名改为 `md-editor.exe`。前端资源已打包进程序，无需 npm 构建。也可准备配置与目录后运行 `go run . -config config.yaml`。

## Docker Compose

需要 Docker Engine / Docker Desktop 和 Compose v2。在仓库目录中执行：

```sh
mkdir -p runtime documents logs
docker compose up -d --build
```

Windows PowerShell 用 `New-Item -ItemType Directory runtime, documents, logs -Force` 创建目录。首次启动自动生成 `runtime/config.yaml`；不用把原生配置复制进容器。

默认仅向宿主机 `127.0.0.1:8080` 发布端口。访问 <http://127.0.0.1:8080/>。

| 宿主机目录 | 容器目录 | 用途 |
| --- | --- | --- |
| `runtime/` | `/data/config` | 持久配置，支持原子写入 |
| `documents/` | `/data/documents` | Markdown 文档和引用资源 |
| `logs/` | `/data/logs` | 轮转日志 |

镜像默认 UID/GID 为 `1000:1000`。Linux 上这些目录必须可由该用户写入；若当前普通用户 UID/GID 不同，可在 `.env` 中设置 `EDITOR_UID`、`EDITOR_GID`。`EDITOR_PORT` 可调整宿主机端口，`EDITOR_BIND` 可调整绑定地址。开放至局域网前请评估网络边界及远端权限。

Docker 端口转发可能使浏览器请求被识别为远端，管理按钮不可见；可在宿主机修改 `runtime/config.yaml`。`server_ips` 只应填写确实需要管理权的**实际连接来源**，不要把整个网段或所有访客设为管理员。容器内不支持打开宿主机文件管理器或桌面默认程序。

```sh
docker compose logs -f
docker compose down
```

关闭 Compose 不会删除绑定目录。单独构建镜像可用 `docker build -t local-markdown-editor .`；运行时需发布端口并挂载上述三个数据目录。

## 配置与边界

| 字段 | 说明 |
| --- | --- |
| `host` | 原生默认 `127.0.0.1`；`0.0.0.0` 监听全部 IPv4 网卡；CIDR 可限制访问网段。 |
| `docs_dir` | 目录或单个 Markdown 文件列表，相对路径以配置文件所在目录为准。 |
| `permissions` | 远端 `none` 隐藏、`r` 只读、`rw` 读写；本机管理员不受远端权限限制。 |
| `server_ips` | 额外的精确管理来源 IP，**不是普通访问白名单**。 |
| `file_operations` | 是否允许管理员新建/删除文档，远端仍不能操作。 |
| `memory` / `log` | Go 内存预算与日志轮转。 |

文档目录、权限及管理来源可热加载；监听地址、端口、日志和内存设置修改后需重启。访问地址仅支持 IP 或 `localhost`；自定义域名和反向代理身份认证未实现。自动保存会修改原文件，请自行保留备份。

## 测试与版本发布

```sh
node scripts/test.mjs
go run ./tools/release -version v0.1.0
```

测试脚本先运行 Go 测试和静态检查、构建程序，再运行 Node/HTTP 回归。发布工具生成 6 个系统/架构压缩包及 SHA-256 校验文件。详见[测试说明](docs/TESTING.md)、[发布说明](docs/RELEASING.md)和[本次导出验证](docs/VALIDATION.md)。

## 许可与第三方组件

Copyright © 2026 **sili**。

本项目采用 **GNU Affero General Public License v3.0（AGPL-3.0-only）**，完整条款见 [`LICENSE`](LICENSE)。分发或修改时须遵守许可证；修改后的程序通过网络提供服务时，也须按许可证第 13 条向远程交互用户提供获取对应源码的途径。

第三方组件保留各自版权与许可，见 [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md)、`third_party/` 和 `web/vendor/`。AGPLv3 不改变本项目“未做公网安全评估、不建议公网使用”的说明。
