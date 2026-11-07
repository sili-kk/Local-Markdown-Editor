# Windows 一键合并与 GitHub 发布

入口为项目根目录的 `publish_github.bat`。需要 Windows PowerShell 5.1、Git、Go、Node.js 22+，并已配置 Git 提交身份和 `origin` 推送认证。脚本复用现有 Git 凭据，不要求安装 GitHub CLI。

## 用法

在主项目目录运行，或者双击 BAT：

```powershell
.\publish_github.bat
.\publish_github.bat v0.1.2
.\publish_github.bat v0.1.2-rc.1
.\publish_github.bat --check
.\publish_github.bat --help
```

`v0.1.2` 仅为版本格式示例。未指定版本时，脚本读取本地和远端标签，自动使用最高正式版本的下一个补丁版本，无需输入或确认。例如最高版本为 `v0.1.9` 时自动发布 `v0.1.10`；没有正式版本标签时从 `v0.1.0` 开始。预发布标签不参与自动递增，主版本和次版本保持不变。`1.2.3` 会自动补成 `v1.2.3`。`--check` 也可以与版本号一起使用。

| 模式 | 行为 |
| --- | --- |
| 正常发布 | 合并主目录源码到 `github/Local-Markdown-Editor`，运行检查，为全部未忽略的仓库改动创建 `chore: release <版本>` 提交，创建附注标签，然后一次原子推送 `main` 与该新标签。 |
| `--check` | 仍会合并到本地仓库、更新同步基线并运行检查；发生源码同步时会追加验证记录。不会暂存、提交、创建标签或推送。不是纯预览模式。 |
| 直接运行仓库内 BAT | 如果 BAT 旁边就是 `.git`，直接检查和发布该仓库，不会反向修改主目录。 |

脚本只操作选定的仓库，主目录自身不需要是 Git 仓库。不会自动把其他分支合入 `main`。现有未推送的 `main` 提交和仓库内未忽略的新文件、修改、删除都会一起发布，请在运行前确认仓库内容。

## 同步范围与仓库差异

| 范围 | 合并规则 |
| --- | --- |
| Go、前端、测试、工具 | 根目录 `*.go`、`go.mod`、`go.sum`，以及 `web/`、`tests/`、`tools/`、`scripts/` 下允许的源码与资源；支持新增、修改和删除。 |
| README 与截图 | 三方合并 `README.md` 的新增改动；同步 `docs/screenshots/` 下的图片。 |
| 其他文档 | 仅合并目标仓库已经存在的同名公开文档；源目录中尚未公开的历史文档和检查产物不会自动新增到仓库。 |
| 仓库专用内容 | 仅存在于仓库的版本、跨平台适配、英文说明、Docker、CI、发布工具、许可证等保留；源目录没有这些文件时不会删除它们。 |
| 本机数据 | 不同步实际 `config.yaml`、个人文档、日志、缓存、构建产物、`docs/access`、`docs/security`、`docs/resources`、`docs/concurrency` 等本机测试结果；拒绝跟随符号链接和目录联接。 |

同步使用上次已确认的主目录源码作为基线，把主目录本次改动合并到仓库当前文件。主目录未变化时，仓库独有改动不受影响。所有文件先计算合并结果；任一文件冲突时，本轮同步不写入仓库，列出文件并停止发布。手动在仓库文件中合并冲突并核对后，需要登记已完成合并的文件，再重新运行发布。两端因公开说明或跨平台适配继续保留不同内容时，单纯重跑无法自动判断人工合并已经完成。

例如已将主目录本次改动合入公开 README，并保留仓库原有结构后，从主目录执行：

```powershell
node scripts\sync-source.mjs --source . --accept-merge README.md
publish_github.bat --check
```

`--accept-merge` 表示指定文件已经由你或代理核对并人工合并，不会替你合并或覆盖该文件；它只登记指定文件的当前源版本，不重置整个同步基线。多文件可重复传入该参数，文件必须存在于两端且属于源码同步范围。其他文件仍按正常规则同步；若还有未解决冲突，本轮仓库文件和基线均不写入。确认检查通过后，再按正常方式发布。

基线保存在目标仓库的 `.git/mojian-publish-sync/source-base.json`，只供本机合并使用，不会提交或推送，也不包含凭据。

首次搭建双目录布局时，需要先检查并合并当前源码差异，确认剩余差异都是有意保留的仓库适配，再从主目录初始化：

```powershell
node scripts\sync-source.mjs --source . --init
```

此命令只记录现状，不替你合并文件；已有基线时拒绝覆盖。缺少基线且两端文件不同，普通发布会停止，避免误把未同步的改动当作既有适配。不要为了绕过冲突重置基线。

## 检查与失败处理

| 检查 | 结果 |
| --- | --- |
| 发布前 | 必须位于 `main`，没有合并／变基／拣选等未完成操作；Git 身份有效；`origin` 只有一个且相同的 fetch/push 地址。 |
| 分支状态 | 获取远端 `main`；远端领先或双方分叉时停止，需要先手动合并或变基，不执行强制推送。 |
| 版本标签 | 检查本地与远端重名，已有版本不能复用；标签指向本次待发布提交。 |
| 项目验证 | 运行仓库现有 `node scripts/test.mjs`，包括 Go 测试、vet、构建以及 Node/HTTP 回归。失败时不暂存、不提交、不创建标签、不推送；已合并到本地仓库的源码保留。 |
| 更新记录 | 检查成功后在仓库 `update.md` 追加实际日期、同步文件范围和验证结果；正常发布时记录随提交一起推送。 |
| 推送 | 使用 `--atomic`，只推送 `main` 与本次新标签，禁用隐式跟随其他标签和 mirror；服务端不支持原子推送或拒绝任一引用时整体失败，不自动降级。 |
| 推送失败 | 保留本地提交和标签，并输出重试同一提交与标签的命令。先核对远端状态；网络报错可能发生在服务端接受推送之后。脚本不删除远端内容，也不回滚本地工作。 |

推送成功只表示 Git 分支与标签已经更新。现有 `.github/workflows/release.yml` 会响应 `v*` 标签，另行测试、构建并创建 GitHub Release；最终发布结果以 Actions 状态为准。

## English

Run `publish_github.bat [version] [--check]` on Windows. In the two-directory project layout it first merges source changes into `github/Local-Markdown-Editor`, preserving repository adaptations with a local three-way merge baseline. With no version argument, it automatically increments the highest local or remote stable version by one patch (or starts at `v0.1.0`), without prompting. It then runs the project checks, commits all non-ignored repository changes, creates an annotated version tag, and atomically pushes only `main` and that tag to `origin`. Inside a standalone clone it publishes that clone directly.

`--check` still synchronizes local files and runs tests, but never stages, commits, tags or pushes. After manually merging a conflicted file while retaining public adaptations, record the reviewed result with `node scripts/sync-source.mjs --source . --accept-merge README.md`, then rerun `publish_github.bat --check`. This accepts only the named files; any remaining conflict still aborts without changing files or the baseline. Review intentional differences before initializing a new local baseline with `node scripts/sync-source.mjs --source . --init`. Tests use temporary local repositories and bare remotes, never GitHub.
