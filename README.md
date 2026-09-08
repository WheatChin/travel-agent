# Travel Agent

Travel Agent 是一个桌面端旅行规划工作台。目前仓库交付的是 Phase 1 北京三日游夹具界面：行程库、连续日程、日详情、地图占位视图和对话面板共享同一个不可变 Itinerary Version。当前数据是本地演示夹具，不是实时生成、实时地图或已由供应商核验的数据。

## 快速开始

当前已验证的运行基线为 Node.js 26.7.0 与 npm 11.19.0，不承诺其他版本兼容；完整前置条件见 [requirements.md](requirements.md)。在 Windows 上双击 `start.cmd`，或从任意工作目录运行：

```powershell
C:\path\to\travel-agent\start.cmd
```

默认地址是 `http://127.0.0.1:3000`，进程保持在当前窗口，按 `Ctrl+C` 正常停止。端口被占用时脚本会报错且不会终止占用端口的进程；请显式选择其他端口：

```powershell
.\start.cmd -Port 3001
.\start.cmd -Mode prod -Host 127.0.0.1 -Port 3001
```

开发模式在缺少 `node_modules` 时执行 `npm ci`。生产模式还会先执行生产构建，成功后才启动服务。所有子命令的非零退出码都会使启动失败。

## 当前能力与边界

当前已实现桌面端 Phase 1 夹具体验及其类型、单元和浏览器测试。支持的验收视口是 1024x768、1280x800 和 1440x900。地图是明确标注的占位界面；编辑、生成、失败和取消流程也是演示状态。

尚未实现 SQLite 持久化、Owner 隔离、真实生成工作流、LLM、AMap 浏览器地图、AMap Web Service 地点/路线或网页研究适配器。未来仓储模块将从 `DATABASE_PATH` 初始化本地 SQLite 文件；在该模块集成前，启动脚本不会创建数据库或声称已完成持久化。未来数据文件应位于被版本控制忽略的本地数据目录。

## 验证

首次运行浏览器测试的机器可显式安装 Chromium，并执行完整的 fail-fast 验证：

```powershell
.\scripts\verify.ps1 -InstallBrowser
```

之后运行 `.\scripts\verify.ps1` 即可。验证顺序为 typecheck、lint、单元测试、生产构建、浏览器测试；任一步失败都会立即停止。Phase 1 的实际证据和限制见 [验证报告](docs/reviews/phase1-verification.md)，验收标准见 [设计 0001 第 20 节](docs/design/0001-mvp-product-and-workflow.md#20-verification-strategy)。

## 配置与架构

复制 `.env.example` 所列名称并在本机配置真实值，不要提交密钥。`NEXT_PUBLIC_AMAP_WEB_KEY` 是可公开、应限制域名的浏览器 Web Key；JavaScript 安全码只保存在服务端 `AMAP_SECURITY_JS_CODE`，供未来 `serviceHost` 安全代理使用，不能进入浏览器 bundle 或使用 `NEXT_PUBLIC_` 前缀。安全代理尚未集成。独立的服务端 `AMAP_WEB_SERVICE_KEY` 用于地点/路线 Web Service，不得与浏览器 Web Key 或 JavaScript 安全码互换。当前夹具模式不需要任何供应商凭据，也不会静默降级成“实时”结果。

领域术语以 [CONTEXT.md](CONTEXT.md) 为准，产品与验收基线见 [设计 0001](docs/design/0001-mvp-product-and-workflow.md)，当前桌面实现见 [设计 0002](docs/design/0002-phase1-desktop-implementation.md)，本地交付约束见 [设计 0004](docs/design/0004-local-delivery.md)。
