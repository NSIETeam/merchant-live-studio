# 靠谱 · 内容与直播工作台

适合自托管的内容准备与真人直播 MVP。主流程是 **商品资料 → 周期课程 → 讲稿审改与人工定稿 → 真人播讲 → 互动复盘**。产品中文名为“靠谱”，英文名称与最终 Logo 尚未确定；技术仓库名保持 `merchant-live-studio`。

版本 **0.6.0**，代码托管在[公开 GitHub 仓库](https://github.com/NSIETeam/merchant-live-studio)。内容域有独立的商品、课程、不可变讲稿版本与定稿记录；直播底座经接口读取已绑定定稿，Agent 仍使用独立进程、数据库和私有 HTTP 接口。

商家端默认进入“商品与课程”，使用更紧凑的目录、编辑区和复核栏。观众端以视频为主，提问、红包与观看详情默认收起。三套原创 Logo 可在运行中的 `/brand/index.html` 查看，图形与组合标志在 `public/brand/`。

**真实模型稍后配置。** 当前支持粘贴/UTF-8 文字导入整稿、逐段手工编辑、结构化语义风险提示和人工定稿；0.6 已加入成员角色、集中待审、逐条修改建议和独立审稿流程；长稿任务已支持大纲、分章生成、失败续写和待审导入，详见[生成任务说明](docs/generation.md)。真实模型与主播风格效果尚未验收，默认 `grounded-rules` 不执行长稿生成。实时转写已提供最终分段 webhook、持久队列和有界 Agent 联动；MediaMTX → FFmpeg → OpenAI 兼容 ASR → webhook 的独立自托管中继已经部署，但真实 ASR 模型仍未配置。微信公众号 OAuth 身份接口已实现但默认关闭，尚未使用获授权公众号实测；微信商家转账 APIv3 的请求签名、应答验签、原单查询和通知解密适配器已实现但未接入业务任务，收款授权、持久出款单和对账仍未完成，红包只做模拟处理。

0.6 已在现有测试服务器完成迁移和线上角色流程验收；真实模型与支付仍待配置，完整产品范围仍在推进。发布说明见[0.6 升级说明](docs/release-v06.md)。

使用流程见[内容工作台说明](docs/content-workflow.md)，测试边界见[验收记录](docs/acceptance.md)。

## 技术栈

- Node.js **24.10+ / 24.x**、TypeScript、Hono API。
- React 19、Vite 7、响应式中文界面；浏览器原生 HLS / hls.js 按需加载。
- Node 内置 SQLite、WAL；直播账本与 Agent 版本/任务分别存库，无 Redis 或数据库容器的强制依赖。
- 独立 Agent 核心库与 Hono 私有服务，持久化任务队列、不可变提示词版本、受约束模型适配与明确回退。
- MediaMTX **1.21.0** 为默认流媒体引擎，支持真实流状态及断流控制；SRS **6.0.191** 保留地址和发布鉴权适配。
- npm 锁定文件、Node 内置测试、GitHub Actions、可选 Docker Compose；服务器提供独立 Node 运行时、systemd 与 Nginx 模板。

业务 API、视频分发和 Agent 执行分别运行。当前每个服务按单实例设计，Agent 队列也不是分布式队列；本版没有自动扩容或万人并发能力声明。

## 本地启动

```bash
git clone https://github.com/NSIETeam/merchant-live-studio.git
cd merchant-live-studio
cp .env.example .env
npm ci
npm run dev
```

`npm run dev` 并行启动直播 API `127.0.0.1:8787`、Agent `127.0.0.1:8788` 和网页 `127.0.0.1:5173`。打开[本地工作台](http://127.0.0.1:5173)，点击「进入演示工作台」。Vite 同源代理 `/api`，浏览器经直播 API 使用 Agent，不直接访问 8788。`APP_ORIGIN` 必须与浏览器 origin 一致，请勿混用 `localhost` 与 `127.0.0.1`。

默认建立示例房间及标注为演示的商品事实；自建房间不会自动添加事实。直播数据库为 `data/studio.sqlite`，Agent 数据库为 `data/agent.sqlite`，均不提交至 Git。每个商家首次使用 Agent 时建立自己的标准风格版本。

1. 在“商品与课程”建立商品/SKU、选择类别并录入有出处的事实，逐条人工核对后保存商品证据版本。无需先建直播间。
2. 建立营销周期（默认 45 天，可调整），按天添加课程，填写主题、目标、真人主播、计划时长与早午晚安排。课时目标不是实际录制时长，计划不会自动开播。
3. 导入或粘贴文字讲稿，逐段关联依据、修改内容并保存版本。规则定位风险和引用缺口，人工确认真实性、适用范围与完整语境后定稿；命中阻断项不能定稿。
4. 创建直播间，将已定稿课程绑定；在“直播现场”按段播讲、调整字号或打开专注阅读，再连接 OBS。商品依据变化后，旧定稿暂停使用并要求重新复核。
5. 在“表达与提示词”调试通用/品牌风格，在“品牌与评测”导入获授权样例并做场景对比。已绑定场次使用课程商品依据；旧房间资料保留为备用。
6. 创建演示红包活动，打开观众页并连接实际视频，展开互动抽屉提问或领取。分析区展示真实接口记录的观看与模拟互动，不将领取等同于成交。

直播现场的“开播准备检查”可以下载当前技术准备报告，供内部审核逐项补材料。报告只记录生成时点的配置、检查结果和依据版本，不包含密钥或正文，也不代表行政许可或平台审核已经通过。

内容工作台不会自动填满 45 天课程，也不会凭空生成真实商品资料或授权主播样例。当前没有真实纳豆 SKU 的标签、检测/资质与授权话术材料，请使用自己的已核验材料建立商品。

## 开发与验证

开发前必须阅读 [仓库硬门禁](AGENTS.md) 和 [模块开发规范](docs/module-development.md)。现有业务实现已迁入 `src/modules/`、`src/platform/` 与 `src/composition/`，前端按功能归类，详见 [代码分配与迁移记录](docs/module-migration.md)。`npm run check` 与 CI 检查模块依赖、persistence 中的 SQL 和表归属，并执行对应负向测试；原路径仅保留部署入口与历史数据库初始化。

新增功能或修改业务行为，先填写[简短功能卡](docs/feature-card-template.md)，按可验证的业务流程实现，合并前全跑基础检查并按改动补专项验证，发布时填写[具体版本验收记录](docs/release-verification-template.md)。已有规则直接引用，只有验收通过的阶段才能标记完成；纯文档或样式调整使用简短变更说明。

涉及数据、附件或媒体时还必须遵循 [平台存储规范](docs/storage-architecture.md)：数据库保存业务状态与版本关系，私有资产按所属模块管理，原件、AI 候选、正式素材、录像与临时缓存分层，开发时明确权限、清理及备份恢复。统一文件服务与录制归档尚待按规范实现；当前数据库路径保持不变，新增本地运行文件使用不提交 Git、不进入镜像构建上下文的 `var/`。

```bash
npm test             # 直播、Agent 核心/服务/桥接与回归测试
npm run check:architecture # 模块边界、存量依赖与门禁负向测试
npm run typecheck
npm run build        # Web + 直播 API + Agent 编译
npm run smoke        # 构建后同源 HTTP 闭环
npm run check        # 测试 + 构建 + HTTP 闭环
npm run dev:agent    # 仅独立启动 Agent 开发进程
npm run capacity:probe -- --room=demo-room # 分阶段只读容量基线
```

构建后用两个终端分别运行：

```bash
# 终端一：Agent
npm run start:agent
```

```bash
# 终端二：直播 API 与网页
APP_ORIGIN=http://127.0.0.1:8787 npm start
```

网页在 [8787 端口](http://127.0.0.1:8787)。先停止占用同一端口的开发进程；修改 API `PORT` 时需同步 Vite 代理目标。`npm start` 不隐式拉起 Agent，Agent 离线时会显示状态，直播和演示红包继续独立运行。

验证内容包括直播身份/资格/账本边界，以及 Agent 服务鉴权、版本不可变、发布限制、队列容量、幂等与重启、证据引用、提示注入、情感亲历防伪、模型未配置和失败回退。外部模型测试使用模拟响应，不能视为真实模型已接通。

本机媒体检查使用真实 MediaMTX 与 FFmpeg，验证错误密钥拒绝、正确 RTMP 上线、HLS 分片解码、无信号/暂停资格、领取账本、结束后实际断流和旧密钥拒绝。`playing` 在该 HTTP 检查中由测试发送，不能代替浏览器播放器验收。详情见[验收记录](docs/acceptance.md)与[流媒体说明](docs/streaming.md)。

## 真实视频与自托管

本机可选 Compose 先只启动引擎：

```bash
docker compose --profile mediamtx up -d mediamtx
```

另一个终端运行 `npm run dev`。默认本机配置仅绑定回环端口，未开启发布鉴权或 Control API；它用于本地开发，不能直接作为服务器公开推流配置。SRS 与 MediaMTX 都使用 1935 端口，只能选一个；切换到 SRS 时同步修改 `STREAM_PROVIDER` 与 `STREAM_HLS_BASE`。

商家端将 Server 与完整 Stream Key 复制至 OBS 自定义推流服务，使用 H.264/AAC 编码。观众直接通过公开 HLS 播放；互动身份或领取记录失败时，公开房间和播放器仍独立加载。

服务器配置参考 [服务器测试部署](docs/server-testing.md)、[MediaMTX 模板](infra/mediamtx-server.yml.example)、[Nginx 子路径模板](infra/nginx-studio.conf)。Control API 留在回环或受控私网，部署凭据放在仓库外。设置 `NODE_ENV=production`、`DEMO_MODE=false`、HTTPS `APP_ORIGIN`、固定 `SESSION_SECRET`、独立 `MERCHANT_CREDENTIALS` 和 `REQUIRE_PLAYBACK=true`。

Agent 另外使用独立服务进程、数据目录和 `AGENT_SERVICE_TOKEN`，通过回环/私网 `AGENT_SERVICE_URL` 与直播 API 通信；不要将 Agent 端口或模型密钥暴露给浏览器。模型变量只供 Agent 进程使用。部署模板见 [merchant-live-agent.service](infra/merchant-live-agent.service)，配置与重启行为见[Agent 说明](docs/agent.md)。

生产模式要求至少 32 字符的会话签名密钥、每商家至少 24 字符的访问密钥。修改环境文件中的商家凭据后重启应用，新配置生效即拒绝对应旧会话。注销只撤销当前登录会话，不影响同商家的其他有效登录。

平台运营主体、投诉渠道、隐私政策和服务协议通过服务器环境变量 `PLATFORM_COMPLIANCE` 配置，公开入口为 `/compliance`，观众直播间的「经营者信息」也会同时展示。缺少配置时页面与健康接口明确标为未配置，不使用品牌名或测试资料代替真实主体。字段和验收边界见[平台信息与隐私](docs/platform-compliance.md)。

公开保存期限声明通过 `DATA_RETENTION_POLICY` 配置，同一合规页面会同时显示软件当前真实执行状态。录像管理支持到期删除申请、另一审核账号复核、主动保留、未解决投诉/申诉自动阻断，以及可恢复的物理删除隔离；登记和审计记录不会随视频文件删除。它仍不能代替真实政策配置、基础设施日志、异地备份或运营核验，详见[录像保留与删除](docs/recording-retention-controls.md)和[记录留存声明](docs/retention-policy.md)。

```dotenv
MERCHANT_CREDENTIALS={"merchant-a":"REPLACE_WITH_RANDOM_SECRET_AT_LEAST_24_CHARS"}
```

示例字符串必须替换，可用 `openssl rand -hex 32` 生成独立随机值。`.env.example` 中显式的 `REQUIRE_PLAYBACK=false` 不会因改为生产模式自动变为 true；共享媒体测试须明确覆盖此值。

`TRUSTED_PROXY_IPS` 只列出实际连接应用的代理 socket 地址，代理必须覆盖 `X-Real-IP`。应用不会信任未列入的来源，也不会采用任意 `X-Forwarded-For`。商家鉴权和观众建会话使用独立限流预算，观众 Cookie 不能重置商家登录尝试预算。

API 另有进程内并发门禁：生产默认最多同时处理 256 个 API 请求，其中观众建会话、公开房间和观众接口最多占 192 个，余量保留给商家控制、流媒体回调与健康检查。可用 `REQUEST_CONCURRENCY_MAX` 和 `AUDIENCE_CONCURRENCY_MAX` 调整，后者必须更小；超过门禁返回 503 与 `Retry-After: 1`。健康接口只公开当前、峰值和累计拒绝计数，不包含身份或密钥。

`capacity:probe` 默认仅访问回环地址的公开房间 JSON，并按 10/25/50/100 并发逐级运行。远端测试必须同时使用 HTTPS 和与主机名完全一致的 `--allow-remote`；子路径部署还须明确 `--base-path`，例如 `--origin=https://studio.example.com --base-path=/studio/ --allow-remote=studio.example.com --room=ROOM_ID`。脚本只读、不创建观看会话、不发送心跳、不领取红包，也不传入商家凭据；它输出各阶段 p50/p95/p99、吞吐、状态码和错误率，任一阶段超过阈值立即停止。详见[容量保护与基线](docs/capacity-guard.md)。

### 部署到 `/studio/`

构建时明确传入前端前缀：

```bash
VITE_BASE_PATH=/studio/ npm run build
```

运行环境设置 `APP_BASE_PATH=/studio/`，`APP_ORIGIN` 仍为不含路径的 HTTPS origin。Nginx 将 `/studio/` 前缀剥离后转发至应用根路径；后端 API 本身仍挂在 `/api`。前端资源、请求、观众链接和 Cookie 路径使用 `/studio/`。仅修改环境文件而不重新构建前端，不能改变已构建资源的前缀。常规本地开发保持两个前缀为 `/`。

正式发布包在根目录写入一行完整 Git SHA 的 `REVISION`；应用启动时校验并通过 `/api/health` 的 `revision` 返回。没有该文件的本地开发环境返回 null，格式无效的发布文件会阻止服务启动。自动部署以此直接核对实际运行版本，详见[线上运行版本核对](docs/release-revision-health.md)。

## 已实现与边界

| 模块  | 当前可运行行为                                                                                                                                      | 后续接入                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 内容  | 独立商品/SKU与证据版本、周期/课次/课时、长稿编辑/引用、规则定位、人工定稿、房间绑定与播讲                                                           | 真实长稿质量、主播档案、线下归因                        |
| 商家  | 会话认证与撤销、凭据版本校验、租户隔离、房间状态、独立推流密钥与轮换                                                                                | 自助注册、企业认证、商家内 RBAC                         |
| 观众  | 免下载 H5、独立公开播放、匿名互动会话、可配置公众号 OAuth 身份、提问与领取历史                                                                      | 真实公众号/微信客户端、实名与防刷                       |
| 红包  | 服务端倒计时、本场资格、毫秒累计、整数分随机池、幂等领取、账本、outbox、到期余量退回                                                                | 真实预算、出款、验签对账、分布式争抢                    |
| Agent | 独立进程/库、标准与品牌风格、版本/试演/发布、异步建议、结构化主张复核、证据和阶段摘要、反馈、语音分段联动；本地候选含独立媒体语音中继及运行状态诊断 | 真实模型与 ASR 服务配置、效果调试、持续扩充行业评测语料 |
| 分析  | 当前可见会话、累计访问/停留、近 30 分钟活跃走势、提问和模拟领取数据                                                                                 | 视频 QoE、订单与真实转化归因                            |
| 视频  | RTMP/HLS、两引擎发布鉴权适配、MediaMTX 状态、RTMP/RTMPS 断流及二次核验                                                                              | SRS 控制面、CDN/WebRTC、多设备验收                      |
| 合规  | 平台与商家公示、独立审核、开播准入、投诉、录像留存；本地候选可下载逐房间提审材料包                                                                  | 真实主体、许可、政策原件及审核机构验收                  |

同一房间再次开播会清空本场资格累计；历史停留、问题、领取和账本继续保留。`watchSeconds` 用于本场资格，`totalWatchSeconds` 表示累计停留；分析仍按房间累计，不是完整的分场报表系统。数据库按 v1 → v2 → v3 → v4 顺序迁移：保留历史观看与账本，新增导入记录和内容域表。内容版本不会改写旧房间资料。

配置 MediaMTX 控制面后，结束房间、轮换密钥或调用断流接口会尝试踢出已有推流，并再次查询引擎。未配置、请求失败或仍在线时返回失败提示，需停止 OBS 或重试；房间状态或密钥更新本身不会因断流失败而回滚。

默认 Agent 使用 `grounded-rules`，不采集麦克风、不调用远程模型。语气可以温暖，但不替主播虚构童年、家庭亲历或商品功效；“妈妈的味道”等只能保留主观感受边界。“第一”换成“无出其右”仍表达相近的优越性主张，不能以同义替换视为合规。规则会显示主张类型、完整语境、所需依据和处理方向，并区分“第一步”等顺序词。提示词、品牌样例和用户文本都是受固定证据规则约束的数据，风险未命中不代表合法保证。

模型 provider 接口已支持显式配置的兼容 HTTP 服务，当前输出为受约束的事实片段 JSON，而非任意自由话术；事实与出处由本地映射。设置方法及准确边界见[Agent 说明](docs/agent.md)。渠道另设身份/分享适配契约，`GET /api/channels` 按实际配置报告能力。公众号 OAuth 关闭时明确不可用；启用后只建立不透明的已验证观众身份，不保存 access token、不等于付款授权，也不会启用真实收款。`WECHAT_IDENTITY_SECRET` 必须独立生成并长期保持稳定，否则历史观众关联会改变。微信 JS-SDK 签名分享使用额外开关，只签署本站对应直播间地址；公众号 access token 与 ticket 仅在服务端短时缓存。红包 provider 只能为 `simulation`，微信通知接口固定返回 501，接入要求见[微信身份](docs/wechat-channel-identity.md)、[微信签名分享](docs/wechat-signed-sharing.md)和[支付说明](docs/payments.md)。

## 资料与评测

0.4.0 增加 CSV/JSON 资料预览与待审导入、授权样例新草稿、题组修订、双版本批量比较及人工评分。模型仍默认关闭；短题评测不等于完整讲稿审核发布。操作与边界见[资料与评测说明](docs/training.md)。

## 文档

- [架构与数据流](docs/architecture.md)
- [独立 Agent、提示词版本与模型配置](docs/agent.md)
- [资料导入与场景评测](docs/training.md)
- [接口索引](docs/api.md)
- [流媒体接入](docs/streaming.md)
- [服务器部署与测试](docs/server-testing.md)
- [微信公众号观众身份](docs/wechat-channel-identity.md)
- [微信签名分享](docs/wechat-signed-sharing.md)
- [微信支付接入](docs/payments.md)
- [微信商家转账 APIv3 适配器](docs/wechat-transfer-adapter.md)
- [微信公众号观众身份](docs/wechat-channel-identity.md)
- [验证结果与下一步](docs/acceptance.md)
- [协作者迁移记录](docs/collaboration.md)

仓库已公开。目前未添加项目源码许可证；公开可见不等同于授予开源使用许可。依赖和独立流媒体引擎按各自许可证使用。

## 团队审稿开发增量

仓库已新增独立登录账号与编辑、审核、主播、复盘角色；团队和生产空间使用“提交审核 → 另一账号批准或退回 → 主播绑定”的流程。保存者和提交者不能自审，旧版本人确认不能代替独立批准。配置、权限表与迁移说明见 [团队审核](docs/team-review.md)。该增量尚未部署到原测试站；完整目标仍见 [交付跟踪](docs/delivery-plan.md)。
