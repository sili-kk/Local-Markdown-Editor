# Local Markdown Editor · 屿墨笺

[中文](README.md) · [Testing](docs/TESTING.md) · [Releases](docs/RELEASING.md)

A Go application for editing Markdown files on your own disk and sharing documents within a trusted LAN. The interface is currently in Chinese; documentation is available in Chinese and English.

> **Public Internet use is not recommended. This software has not undergone a security assessment for public Internet deployment. Configure it at your own discretion.**
> There are no built-in accounts or HTTPS. Prefer local or trusted LAN use. Network rules, permissions and proxy settings require your own assessment; adding a proxy is not a public deployment security assessment.

## Features

- WYSIWYG editing, tables, code blocks, images, links and automatic saves.
- Multiple document roots, tabs, outline, sorting and local file management.
- Adjustable line numbers, line jumps, current-document search and highlighting.
- Remote directory permissions with inheritance: hidden, read-only or read/write.
- In-page Markdown/HTML previews, sandbox isolation and embedded local images with zoom.
- Viewer totals across all documents, deduplicated by IP, with document activity details.
- Save conflict protection, change notifications, configuration reload and rotating logs.

## Native installation

Download a matching OS/architecture archive from GitHub Releases. Extract it and run from its directory. No Go or Node.js installation is needed for a downloaded binary.

Windows PowerShell:

```powershell
Copy-Item config.example.yaml config.yaml
New-Item -ItemType Directory documents, logs -Force
.\md-editor.exe -config config.yaml
```

Linux / macOS:

```sh
cp config.example.yaml config.yaml
mkdir -p documents logs
chmod +x md-editor
./md-editor -config config.yaml
```

Place `.md` files in `documents/` and open <http://127.0.0.1:8080/>.

### Build from source

Requires Go 1.24+ with access to the toolchain selected in `go.mod`. Node.js 22+ is only required for the full test suite.

```sh
go build -trimpath -o md-editor .
```

On Windows, use `-o md-editor.exe`. Frontend assets are embedded; no npm build is needed. After preparing the configuration and documents directory, `go run . -config config.yaml` also works.

## Docker Compose

With Docker Engine / Docker Desktop and Compose v2 installed:

```sh
mkdir -p runtime documents logs
docker compose up -d --build
```

On PowerShell, create directories with `New-Item -ItemType Directory runtime, documents, logs -Force`. The first start creates `runtime/config.yaml` from the container example. Do not copy the native configuration into the container.

The default host binding is `127.0.0.1:8080`. The directories `runtime/`, `documents/` and `logs/` persist configuration, Markdown files and logs. Configuration is mounted as a writable directory to support atomic updates.

The default container UID/GID is `1000:1000`. On Linux, grant that user write access to the mounted directories, or set `EDITOR_UID` / `EDITOR_GID` in `.env` to match your ordinary user. `EDITOR_PORT` and `EDITOR_BIND` control the published port and host address. Assess remote permissions and network boundaries before changing the binding.

Port forwarding may cause browser requests to be treated as remote users, hiding management controls. Edit `runtime/config.yaml` on the host if necessary. `server_ips` grants administrator privileges to exact socket source IPs; it is not a visitor allowlist. Opening host desktop applications or a host file manager is not supported inside a container.

```sh
docker compose logs -f
docker compose down
```

Stopping Compose preserves bind-mounted data. Build the image separately with `docker build -t local-markdown-editor .` if preferred; publish the port and mount the three data directories when running it.

## Configuration

Native defaults bind to `127.0.0.1`; `0.0.0.0` binds all IPv4 interfaces and a CIDR can restrict clients. Document paths are relative to the configuration file. `none`, `r`, and `rw` govern remote permissions; local administrators can manage all configured content. `server_ips` adds exact management sources. Paths and permissions reload automatically; network, memory and logging changes require a restart.

Only literal IP addresses and `localhost` are accepted as request hosts. Custom domains and authenticated reverse proxy identity are not implemented. Automatic saving changes the original files; keep your own backups.

## Tests and releases

```sh
node scripts/test.mjs
go run ./tools/release -version v0.1.0
```

The test runner builds the current application before running Node/HTTP tests. The release tool creates six OS/architecture archives and a checksum manifest. See [testing](docs/TESTING.md), [release instructions](docs/RELEASING.md), and [export validation](docs/VALIDATION.md).

## Licensing

Copyright © 2026 **sili**.

Licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0-only)**. See [`LICENSE`](LICENSE). Distribution and modifications must comply with its terms; modified versions offered over a network must provide interacting users a way to obtain the corresponding source under section 13.

Third-party components retain their own notices and licenses in [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md), `third_party/`, and `web/vendor/`. This license does not change the warning that public Internet deployment has not been security-assessed and is not recommended.
