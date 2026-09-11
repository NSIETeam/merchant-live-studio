# Merchant Live Studio

适合自托管的商家直播平台 MVP：商家直播工作台、观众 H5 页、演示红包资格与账本、有事实依据的动态提词、基础直播分析。

**可本地运行，已完成 API 测试与构建。真实视频、微信支付、实时 ASR 和远程 AI 模型尚未完成端到端接入。** 这是可继续开发的应用骨架，不是已经投产的直播服务。

## 技术栈

- Node.js **24.10+ / 24.x**、TypeScript、[Hono](https://hono.dev/docs/getting-started/nodejs) API。
- React 19、Vite 7、响应式中文界面；原生 HLS / hls.js 按需加载。
- Node 内置 SQLite、WAL、整数分账本、事务与持久化 outbox；无 Redis/数据库容器的强制依赖。
- 流媒体独立适配：MediaMTX 1.21.0（默认）或 SRS 6.0.191；RTMP 推流、HLS 播放。未来可扩展 WebRTC / CDN。
- npm 锁定文件、Node 内置测试、GitHub Actions、Docker Compose。

选择单体 API + 服务边界以降低首版运维成本；当前按单实例设计，SQLite 同步写入不适合直接承担大规模红包争抢。没有实现自动扩容。

## 3 分钟启动

```bash
git clone git@github.com:NSIETeam/merchant-live-studio.git
cd merchant-live-studio
cp .env.example .env
npm ci
npm run dev
```

打开 **http://127.0.0.1:5173**，点击「进入演示工作台」。API 在 `127.0.0.1:8787`；Vite 代理 `/api`，Cookie 与请求保持同源。请使用上述地址，不要把 `localhost` 与 `127.0.0.1` 混用；`APP_ORIGIN` 必须与浏览器 origin 一致。

默认创建示例直播间与三条示例事实；所有示例出处均明确标注为演示资料。新建商家自己的直播间不会自动生成商品事实。数据库保存在 `data/studio.sqlite`，未提交至 Git。

演示闭环：

1. 创建或选择直播间，点击「开放直播间」。这会开放页面活动，不会自动启动 OBS。
2. 在「提词与合规」添加事实和依据，人工审核后进入提词。输入“全网最低价”“保证见效”等话术，查看风险提示；点击观众问题可更新回答建议。
3. 在「红包活动」创建 ¥100 / 20 个 / 观看 10 秒的演示活动。
4. 打开「观众页」，保持页面可见。倒计时与观看门槛满足后领取；模拟 worker 每 2 秒处理记录。
5. 回商家端查看账本、观众提问、在线人数和平均停留。领取与分析无需视频服务即可演示，心跳不是实际视频播放证明。

开发命令：

```bash
npm test             # API/资金边界测试
npm run typecheck
npm run build        # Web + API 编译
npm run check        # 测试 + 完整构建
APP_ORIGIN=http://127.0.0.1:8787 npm start
```

最后一条提供构建后的同源网页和 API，打开 `http://127.0.0.1:8787`。开发服务器与构建服务不能同时占用 8787；先停下 `npm run dev`。环境变量 `PORT` 改动时也需同步 Vite 代理。

## 本机 Docker 与真实推流

Docker 为可选项，本次执行环境没有 Docker/OBS/FFmpeg，尚未实际运行下列容器与视频链路。

只启动引擎、Web/API 留在宿主机开发：

```bash
docker compose --profile mediamtx up -d mediamtx
# 另一个终端运行 npm run dev
```

或将应用与引擎一起运行：

```bash
APP_ORIGIN=http://127.0.0.1:8787 docker compose --profile mediamtx up --build
```

打开 `http://127.0.0.1:8787`。选择 SRS 时先停止 MediaMTX，再运行：

```bash
APP_ORIGIN=http://127.0.0.1:8787 STREAM_PROVIDER=srs STREAM_HLS_BASE=http://localhost:8080/live docker compose --profile srs up --build
```

两个引擎都使用 1935，不能同时启用。默认 Compose 端口仅绑定本机，未启用推流鉴权。商家端复制 Server 和完整 Stream Key 到 OBS（H.264/AAC），开始推流后在观众页点击「连接直播」。手机观看需配置可访问的实际域名/IP、同源设置与 HTTPS，手机 `localhost` 不是开发电脑。

推流鉴权、CORS、引擎选择与停播边界见 [直播适配说明](docs/streaming.md)。结束直播间或旋转密钥不会断开已有 OBS 连接，需停止 OBS；强制断流接口待接入。

## 已实现与预留边界

| 模块 | 可运行行为                                                                      | 后续接入                                   |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| 商家 | 会话认证、租户隔离、房间创建/开放/结束、独立推流密钥与轮换                      | 自助注册、企业认证、商家内 RBAC            |
| 观众 | 免下载网页、HLS 播放组件、匿名 Cookie 会话、提问、领取记录                      | 微信登录、实名身份、真正防刷               |
| 红包 | 规则/倒计时、服务端心跳资格、整数分随机池、幂等领取、演示账本、outbox、到期退回 | 真实预算、出款、对账、风控、分布式争抢     |
| 提词 | 审核事实库、动态下一句、依据展示、规则风险提示、高频问题、专注模式              | LLM、实时 ASR、复杂语义与行业规则          |
| 分析 | 当前在线、累计会话、平均停留、30 分钟活跃走势、提问/红包记录                    | 视频 QoE、订单与真实转化归因               |
| 视频 | 两种引擎地址适配、发布鉴权回调、HLS 前端和本机配置                              | 引擎真实联调、流状态同步、断流、CDN/WebRTC |

**AI 提词当前使用 `grounded-rules` 本地规则实现，不调用远程大模型或语音服务。** `CopilotProvider` 已预留替换接口；建议只拼接已审核事实，规则未命中仍要求人工复核，不能承诺合规。观众 API 不返回推流密钥、商品内部证据或主播提示。

**红包永远是 simulation。** 环境切换为 `wechat` 会拒绝启动；微信通知接口返回 501，防止把未验签通知当作到账。匿名身份不能领真实资金。接入契约、用户确认模式、幂等出款与回调验签见 [微信支付接入说明](docs/payments.md)。

## 配置与自托管

完整配置见 [.env.example](.env.example)。`SESSION_SECRET` 在本机留空时随机生成，重启后需重新登录。持久会话需生成固定的至少 32 字符随机密钥；不要提交 `.env`。

共享部署前设置 `NODE_ENV=production`、`DEMO_MODE=false`、HTTPS `APP_ORIGIN`、固定 `SESSION_SECRET`，以及每商家独立的至少 24 字符密钥：

```dotenv
MERCHANT_CREDENTIALS={"merchant-a":"REPLACE_WITH_RANDOM_SECRET_AT_LEAST_24_CHARS"}
```

示例字符串必须替换；可用 `openssl rand -hex 32` 生成。商家在登录页输入对应编号与密钥。生产模式拒绝演示登录、不合格会话密钥、缺失商家凭证和非 HTTPS origin；这仍不等于具备商业投产条件。反向代理应提供 TLS、受信入口限流和日志脱敏；SQLite 使用持久磁盘并做好一致性备份。单实例内的限流按已验证会话隔离，匿名登录仍需入口保护。

同一直播间重复开播的观看统计与资格累计按房间保留；如需全新场次请创建新房间。当前没有保留周期清理、账本全量导出、退款审计后台或凭证撤销会话机制。请阅读 [架构与边界](docs/architecture.md) 后再扩展共享部署。

## 仓库与文档

- [架构与数据流](docs/architecture.md)
- [接口索引](docs/api.md)
- [微信支付接入](docs/payments.md)
- [流媒体接入](docs/streaming.md)
- [验证结果与下一步](docs/acceptance.md)
- [协作者迁移记录](docs/collaboration.md)

主要依赖许可证：React/Hono/Zod 为 MIT，hls.js 为 Apache-2.0，lucide-react 为 ISC；流媒体引擎独立部署，按其官方许可证使用。仓库目前为私有，项目源码尚未授予对外开源许可。
