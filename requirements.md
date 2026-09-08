# 本地运行要求

## 当前必需

- Windows 10/11 与 PowerShell 5.1 或更新版本。
- Node.js 26.7.0 与 npm 11.19.0：当前仅承诺这组已验证的运行版本，不承诺 Node.js 20 或其他未验证版本。Next.js 自身的最低版本不能代表完整工具链；已安装的 Vitest、Vite、jsdom 有更高的 Node 要求，且未来仓储将使用原生 `node:sqlite`（已在此运行版本确认可加载）。
- `package-lock.json` 是精确依赖清单。使用 `npm ci`，不要用本文维护第二份版本列表。
- Playwright Chromium。首次完整验证时运行 `scripts/verify.ps1 -InstallBrowser` 显式安装。

当前 Phase 1 夹具界面只需原生 Node.js/npm，不需要数据库或供应商凭据。

## 未来本地与外部依赖

- SQLite 本地文件持久化：仓储模块尚未集成。未来由 `DATABASE_PATH` 指向版本控制忽略的数据目录，并由仓储模块负责初始化；当前启动脚本不创建数据库。
- AMap 浏览器能力：`NEXT_PUBLIC_AMAP_WEB_KEY` 是可公开的浏览器 Web Key，应配置域名限制。
- AMap JavaScript 安全码：仅通过服务端 `AMAP_SECURITY_JS_CODE` 配置，供未来 `serviceHost` 安全代理使用；不得使用 `NEXT_PUBLIC_` 前缀或进入浏览器 bundle。该代理尚未集成，配置变量不代表能力已可用。
- AMap 服务端能力：独立的 `AMAP_WEB_SERVICE_KEY`，用于未来地点与路线 Web Service；不得与浏览器凭据互换。
- 模型服务：未来需要 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，实际端点和模型能力必须在接入阶段验证。
- 网页研究服务：未来需要选定供应商并配置 `WEB_RESEARCH_API_KEY`。

所有值只保存在本机环境中。不得把凭据写入仓库、日志、夹具、截图、提示词或测试输出。缺少未来依赖应显示为阻塞状态，不能用夹具成功冒充实时成功。

## 验收追踪

唯一规范是 [设计 0001 第 20 节](docs/design/0001-mvp-product-and-workflow.md#20-verification-strategy) 的 AC-01 至 AC-17 矩阵，本文不复制或改写其判定规则。

| 阶段 | 相关验收 ID | 当前状态 |
| --- | --- | --- |
| Phase 1 桌面夹具 | AC-12 | 已实现；实际运行证据见 `docs/reviews/phase1-verification.md` |
| Phase 2 浏览器地图 | AC-13 | 待实现并验证 AMap 浏览器能力 |
| Phase 3 领域/仓储/HTTP | AC-01、AC-03 至 AC-06、AC-08、AC-09、AC-11 | 待实现；包括 SQLite 仓储 |
| Phase 4 假适配器工作流 | AC-01 至 AC-11、AC-14、AC-15、AC-17 | 待实现 |
| Phase 5 实时适配器 | AC-13 至 AC-17 | 待外部能力和凭据验证；夹具测试不能通过此门槛 |
| Phase 6 发布回归 | 所有适用 AC | 待实现 |

运行命令本身不是验收通过证据。完整发布仍须满足矩阵中所有适用门槛，并另行记录真实供应商 smoke test。
