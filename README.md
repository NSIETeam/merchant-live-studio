# Merchant Live Studio

适合自托管的商家直播平台 MVP：商家工作台、观众 H5、演示红包与账本、有事实依据的动态提词、基础直播分析。

版本 **0.2.0**，代码托管在[公开 GitHub 仓库](https://github.com/NSIETeam/merchant-live-studio)。已通过 **26 项回归测试**；本机真实 RTMP 推流、HLS 分片下载与 H.264/AAC 解码等 **10 项媒体链路检查**通过。另已在独立 Linux 测试部署完成 **8 组媒体/业务检查和 3 组公网链路检查**，并通过浏览器真实播放、暂停计时、提问和提词审核验收。部署方式见[服务器测试说明](docs/server-testing.md)，实际范围见[验收记录](docs/acceptance.md)。

微信身份与支付、远程大模型、实时 ASR 尚未接入。红包只做模拟处理，不发生资金转账；本机媒体测试也不替代 OBS 硬件、手机或微信内实际播放验收。

## 技术栈

- Node.js **24.10+ / 24.x**、TypeScript、Hono API。
- React 19、Vite 7、响应式中文界面；浏览器原生 HLS / hls.js 按需加载。
- Node 内置 SQLite、WAL、整数分账本、事务与持久化 outbox，无 Redis 或数据库容器的强制依赖。
- MediaMTX **1.21.0** 为默认流媒体引擎，支持真实流状态及断流控制；SRS **6.0.191** 保留地址和发布鉴权适配。
- npm 锁定文件、Node 内置测试、GitHub Actions、可选 Docker Compose；服务器提供独立 Node 运行时、systemd 与 Nginx 模板。

业务 API 与视频分发独立，应用按单实例设计，降低首版运维成本。SQLite 同步写入不适合直接承担大规模红包争抢，当前没有分布式队列或自动扩容。

## 本地启动

```bash
git clone https://github.com/NSIETeam/merchant-live-studio.git
cd merchant-live-studio
cp .env.example .env
npm ci
npm run dev
```

打开 [本地工作台](http://127.0.0.1:5173)，点击「进入演示工作台」。API 监听 `127.0.0.1:8787`，Vite 同源代理 `/api`。`APP_ORIGIN` 必须与浏览器 origin 一致，请勿混用 `localhost` 与 `127.0.0.1`。

默认建立示例房间及三条标注为演示的商品事实；自建房间不会自动添加事实。数据库保存在 `data/studio.sqlite`，未提交至 Git。

1. 创建或选择直播间，点击「开放直播间」。这改变业务状态，不会启动 OBS 或摄像头。
2. 在「提词与合规」添加事实与出处，人工审核后生成建议。输入当前话术或选择观众问题，查看依据、风险提示与下一环节。
3. 创建演示红包活动，打开观众页，满足倒计时与本场停留门槛后领取。
4. 查看提问、领取记录、账本和分析；模拟 worker 每 2 秒处理领取。

默认 `.env.example` 使用 `REQUIRE_PLAYBACK=false`，可不启动视频引擎演示业务流程；此时资格仅根据直播间开放期间的可见页面心跳累计。测试真实观看资格时须配置 MediaMTX Control API 并明确设置 `REQUIRE_PLAYBACK=true`，要求存在真实信号且播放器报告播放中。

## 开发与验证

```bash
npm test             # 26 项 API、服务与回归测试
npm run typecheck
npm run build        # Web + API 编译
npm run smoke        # 构建后同源 HTTP 闭环
npm run check        # 测试 + 构建 + HTTP 闭环
APP_ORIGIN=http://127.0.0.1:8787 npm start
```

最后一条在 [8787 端口](http://127.0.0.1:8787) 同源提供构建后的网页与 API。先停止占用同一端口的开发 API；修改 API `PORT` 时需同步 Vite 代理目标。

回归覆盖租户边界、Cookie 伪造与注销重放、凭据撤销、可信代理限流、旧库升级、本场资格重置、毫秒精度、播放/暂停/隐藏/断线、金额守恒、领取与 worker 幂等、故障回滚、提词依据、发布鉴权及断流失败处理。

本机媒体检查使用真实 MediaMTX 与 FFmpeg，验证错误密钥拒绝、正确 RTMP 上线、HLS 分片解码、无信号/暂停资格、领取账本、结束后实际断流和旧密钥拒绝。`playing` 在该 HTTP 检查中由测试发送，不能代替浏览器播放器验收。详情见[验收记录](docs/acceptance.md)与[流媒体说明](docs/streaming.md)。

## 真实视频与自托管

本机可选 Compose 先只启动引擎：

```bash
docker compose --profile mediamtx up -d mediamtx
```

另一个终端运行 `npm run dev`。默认本机配置仅绑定回环端口，未开启发布鉴权或 Control API；它用于本地开发，不能直接作为服务器公开推流配置。SRS 与 MediaMTX 都使用 1935 端口，只能选一个；切换到 SRS 时同步修改 `STREAM_PROVIDER` 与 `STREAM_HLS_BASE`。

商家端将 Server 与完整 Stream Key 复制至 OBS 自定义推流服务，使用 H.264/AAC 编码。观众直接通过公开 HLS 播放；互动身份或领取记录失败时，公开房间和播放器仍独立加载。

服务器配置参考 [服务器测试部署](docs/server-testing.md)、[MediaMTX 模板](infra/mediamtx-server.yml.example)、[Nginx 子路径模板](infra/nginx-studio.conf)。Control API 留在回环或受控私网，部署凭据放在仓库外。设置 `NODE_ENV=production`、`DEMO_MODE=false`、HTTPS `APP_ORIGIN`、固定 `SESSION_SECRET`、独立 `MERCHANT_CREDENTIALS` 和 `REQUIRE_PLAYBACK=true`。

生产模式要求至少 32 字符的会话签名密钥、每商家至少 24 字符的访问密钥。修改环境文件中的商家凭据后重启应用，新配置生效即拒绝对应旧会话。注销只撤销当前登录会话，不影响同商家的其他有效登录。

```dotenv
MERCHANT_CREDENTIALS={"merchant-a":"REPLACE_WITH_RANDOM_SECRET_AT_LEAST_24_CHARS"}
```

示例字符串必须替换，可用 `openssl rand -hex 32` 生成独立随机值。`.env.example` 中显式的 `REQUIRE_PLAYBACK=false` 不会因改为生产模式自动变为 true；共享媒体测试须明确覆盖此值。

`TRUSTED_PROXY_IPS` 只列出实际连接应用的代理 socket 地址，代理必须覆盖 `X-Real-IP`。应用不会信任未列入的来源，也不会采用任意 `X-Forwarded-For`。商家鉴权和观众建会话使用独立限流预算，观众 Cookie 不能重置商家登录尝试预算。

### 部署到 `/studio/`

构建时明确传入前端前缀：

```bash
VITE_BASE_PATH=/studio/ npm run build
```

运行环境设置 `APP_BASE_PATH=/studio/`，`APP_ORIGIN` 仍为不含路径的 HTTPS origin。Nginx 将 `/studio/` 前缀剥离后转发至应用根路径；后端 API 本身仍挂在 `/api`。前端资源、请求、观众链接和 Cookie 路径使用 `/studio/`。仅修改环境文件而不重新构建前端，不能改变已构建资源的前缀。常规本地开发保持两个前缀为 `/`。

## 已实现与边界

| 模块 | 当前可运行行为                                                                       | 后续接入                               |
| ---- | ------------------------------------------------------------------------------------ | -------------------------------------- |
| 商家 | 会话认证与撤销、凭据版本校验、租户隔离、房间状态、独立推流密钥与轮换                 | 自助注册、企业认证、商家内 RBAC        |
| 观众 | 免下载 H5、独立公开播放、匿名互动会话、提问与领取历史                                | 微信身份、实名与防刷                   |
| 红包 | 服务端倒计时、本场资格、毫秒累计、整数分随机池、幂等领取、账本、outbox、到期余量退回 | 真实预算、出款、验签对账、分布式争抢   |
| 提词 | 已审核事实、动态下一句、证据、风险规则、高频问题、专注模式                           | 远程 LLM、实时 ASR、行业与完整语义规则 |
| 分析 | 当前可见会话、累计访问/停留、近 30 分钟活跃走势、提问和模拟领取数据                  | 视频 QoE、订单与真实转化归因           |
| 视频 | RTMP/HLS、两引擎发布鉴权适配、MediaMTX 状态、RTMP/RTMPS 断流及二次核验               | SRS 控制面、CDN/WebRTC、多设备验收     |

同一房间再次开播会清空本场资格累计；历史停留、问题、领取和账本继续保留。`watchSeconds` 用于本场资格，`totalWatchSeconds` 表示累计停留；分析仍按房间累计，不是完整的分场报表系统。旧 schema v1 自动迁移为 v2，保留历史秒数并转成毫秒，本场资格从零开始。

配置 MediaMTX 控制面后，结束房间、轮换密钥或调用断流接口会尝试踢出已有推流，并再次查询引擎。未配置、请求失败或仍在线时返回失败提示，需停止 OBS 或重试；房间状态或密钥更新本身不会因断流失败而回滚。

提词使用 `grounded-rules` 本地规则，不采集麦克风、不调用远程模型。只根据人工审核事实组织建议，未命中规则不代表合规。红包 provider 只能为 `simulation`；微信通知接口固定返回 501，不更新支付状态。接入要求见[微信支付说明](docs/payments.md)。

## 文档

- [架构与数据流](docs/architecture.md)
- [接口索引](docs/api.md)
- [流媒体接入](docs/streaming.md)
- [服务器部署与测试](docs/server-testing.md)
- [微信支付接入](docs/payments.md)
- [验证结果与下一步](docs/acceptance.md)
- [协作者迁移记录](docs/collaboration.md)

仓库已公开。目前未添加项目源码许可证；公开可见不等同于授予开源使用许可。依赖和独立流媒体引擎按各自许可证使用。
