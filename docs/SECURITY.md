# Security notes

**不建议在公网使用。本软件未在公网环境下进行安全评估测试，请酌情配置。** 建议仅在本机或可信局域网内使用，公开仓库中不要提交个人配置、文档或日志。

This project is intended for local use and trusted private networks.

**Public Internet use is not recommended. The software has not been security-assessed for public Internet deployment.** It has no built-in user accounts or HTTPS. Keep the service behind a trusted network boundary, or add authentication, TLS, rate limiting, and a carefully hardened reverse proxy before any broader exposure.

Configure `host`, `server_ips`, `permissions.default`, and `permissions.rules` conservatively. Do not publish `config.yaml`, personal documents, logs, or generated binaries containing local metadata. Review the effective configuration after every deployment.

The tests in this release directory are sanitized and use temporary fixtures. A passing test suite does not guarantee safety for a public deployment.
