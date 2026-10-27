# HTTP 并发检查工具

仅对隔离的测试服务运行，避免向正在使用的服务注入模拟在线用户或产生大量日志。测试目录必须包含 `.loadcheck-*.md` 文档；工具只读取这些测试正文，`write` 模式也只修改这些文件。`search` 和文件列表仍会访问整个测试目录。

```powershell
go build -o loadcheck.exe ./tools/loadcheck
# 200 人同时进入，独立 IP，同一文档
.\loadcheck.exe -url http://127.0.0.1:18095 -mode users -concurrency 200 -duration 20s -distinct-ips -same-document -out burst.json
# 2000 人在 20 秒内逐渐进入，全部进入后再观察 65 秒
.\loadcheck.exe -url http://127.0.0.1:18095 -mode users -concurrency 2000 -ramp 20s -duration 65s -distinct-ips -same-document -out users.json
# 持续请求：读取、文件列表、版本、在线名单、渲染、正文搜索
.\loadcheck.exe -url http://127.0.0.1:18095 -mode mixed -concurrency 100 -duration 10s -out mixed.json
# 同一文件竞争保存，409 表示版本保护正常触发
.\loadcheck.exe -url http://127.0.0.1:18095 -mode write -concurrency 100 -duration 10s -same-document -out write.json
# 当前版本阅读模型：每人保持一个实时通知连接，并按远端权限路径处理
.\loadcheck.exe -url http://127.0.0.1:18095 -mode users -concurrency 1000 -ramp 10s -duration 40s -distinct-ips -same-document -events -remote -out users-with-events.json
```

`users` 每人进入时请求文件列表、正文和在线状态，之后每 5 秒拉取文件列表、每 15 秒发送心跳、每 30 秒检查版本；轮询有少量时间错峰。`-duration` 是最后一个用户进入后的观察时间，逐渐进入阶段也会计入请求统计。此模型模拟 HTTP 行为，不启动真实浏览器，也不测前端渲染和静态资源首次下载。

`-distinct-ips` 在同机测试中从不同 `127/8` 地址连接，模拟按 IP 聚合的查看者。它要求目标服务位于同机回环地址，不能用于模拟外网不同设备。每个用户保留自己的 HTTP 连接。工具不自动重试请求，不以重试隐藏失败；`statuses` 中的 0 是没有获得 HTTP 响应的连接等错误。409 单独列出且不计入异常失败，须结合模式判断其含义。

原始 JSON 包含请求数、失败数、状态码、吞吐和 p50/p95/p99/最大耗时，耗时分位包含失败请求。Windows 的短时测量可能显示 0 毫秒，不能解释为没有实际开销。请求吞吐包含等待轮询的时间，不能把模拟人数或该吞吐当作服务器极限。

`-events` 仅用于 `users`，每位用户保持一个 `/api/document-events` SSE 连接直到测试结束，记录握手耗时、最大同时连接数及非预期提前断开。SSE 每次保活不是新的 HTTP 请求，握手耗时也不是推送延迟。`-remote` 给请求添加 `Via: loadcheck`，主动去掉本机管理权，用于同机测试远端权限分支；不会伪造管理权，不代表真实跨设备网络测试。

## CPU 与内存采样

项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/resourcecheck.ps1
```

脚本使用现有项目 `md-editor.exe`，另行编译压测客户端，在系统临时目录生成独立文档、配置和日志。每个场景启动新的服务进程，测量空闲、200／1000 个在线查看者加实时连接，以及 100 并发持续混合请求。仅采样这个服务进程，结束后关闭自己创建的进程并清理临时目录，原服务不作为目标。默认 JSON 输出在 `docs/resources/`，不记录主机名。

CPU 按进程 CPU 时间增量除以墙钟时间计算；`cpu_one_core_percent` 的 100% 表示一个逻辑处理器，`cpu_machine_percent` 再除以测试节点逻辑处理器数。默认每约 500 ms 采样一次，内存同时记录工作集和私有提交量，两者不能相加；采样峰值不等于真实瞬时峰值。原始时间序列、负载结果与汇总均保留。
