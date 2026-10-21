# 独立直播 Agent

对应 0.3.0。Agent 负责生成有依据的主播建议，直播底座负责房间、媒体、身份和演示红包。当前按明确选择先完成可切换模型接口，真实模型稍后配置；默认输出来自 `grounded-rules`，不调用外部模型。

## 进程、数据库与核心库

| 部分         | 默认位置                                | 职责                                               |
| ------------ | --------------------------------------- | -------------------------------------------------- |
| 直播 API     | `127.0.0.1:8787` / `data/studio.sqlite` | 商家会话、房间归属、事实审核、播放接入、资格与账本 |
| Agent 服务   | `127.0.0.1:8788` / `data/agent.sqlite`  | 风格版本、发布、队列、执行结果、反馈               |
| Agent 核心库 | `src/agent/core/index.ts`               | 接受执行输入，生成和复核建议；不依赖直播数据库     |
| 网页         | `127.0.0.1:5173`                        | 商家工作台与观众页，经直播 API 使用 Agent          |

核心导出 `runAgent(input, config?)`、`AgentModelConfig`、`STANDARD_PROMPT_CONTENT`、`DEFAULT_PROMPT_CONTENT` 和 `isModelConfigured`。私有服务复用核心库；直播进程仅依赖 `src/shared/agent.ts` 消息契约及 HTTP 桥接，不把模型 SDK、模型密钥或 Agent 数据库装入直播业务路径。

Agent 接收房间 ID、商品、当前话术、选中问题、已审核事实和活动提示。直播网关负责组装事实和可信租户，不让浏览器直接提交另一租户、额外事实、模型端点或密钥。Agent 返回的只有建议、出处、风险、阶段摘要和状态，不具备操作推流、创建活动、改商品或付款的能力。

## 启动

```bash
npm run dev
```

这会并行运行直播 8787、Agent 8788 和网页 5173。只调试 Agent：

```bash
npm run dev:agent
```

构建后的进程分开启动：

```bash
npm run build
npm run start:agent
```

再在另一个终端运行直播：

```bash
APP_ORIGIN=http://127.0.0.1:8787 npm start
```

`npm start` 不隐式启动 Agent。Agent 离线时工作台明确提示，直播和演示红包继续运行；同步话术检查也通过私有 Agent 服务，不偷偷在直播进程加载一套模型实现。

## 标准与品牌风格

首次访问时，每个租户建立自己的标准风格，初始版本已发布。品牌风格包含：

- `systemPrompt`：希望完成的提词任务和内容侧重点。
- `styleGuide`：语气、节奏、措辞偏好。
- `audience`：当前沟通对象。
- `examples`：由 `situation` 和 `response` 组成的场景样例。

这些字段用于提示词调试，是受固定证据规则约束的任务数据。字段名称 `systemPrompt` 不表示它能覆盖核心系统规则；发给模型时它与样例均放在任务数据消息内。样例可以影响编排与语气，不能凭空批准功效、价格、事实或个人亲历。

默认本地规则只支持有限的事实选择和语气片段，不会把任意样例学习成新的语言能力。真实模型配置后也先采用受约束输出，不能称为已经调优完成的品牌模型。

## 版本、试演与发布

每次保存提示词都会新增版本。已有版本不可编辑或删除，数据库触发器也保护这一约束；更改内容需保存为下一版。

试演 `rehearsal` 可指定任一已有版本，省略时使用最新版本；直播 `live` 必须使用已发布版本，不能用未发布版本替代。发布操作切换 `publishedVersion` 指针，可选择已有版本。新品牌尚未发布时，直播任务会被拒绝。

入队时保存 profile、promptVersion 和上下文快照，之后另发新版本不会改写正在执行或历史任务。结果记录版本、上下文摘要和证据引用，可提供 `useful` / `needs_work` 及文字反馈。当前反馈只是人工迭代记录，没有自动训练、微调、改提示词或发布能力。

读取直播建议时，直播网关会检查被引用事实是否撤回；场次变化、房间不再直播或建议距创建超过两分钟也会标记过期。该提示用于避免继续采用旧建议，不自动改写原始运行结果。

## 队列、幂等与重启

任务状态为 `queued → running → completed/failed`，入队接口返回 202，结果通过轮询读取。默认：

| 配置                       | 默认值 | 含义                         |
| -------------------------- | ------ | ---------------------------- |
| `AGENT_QUEUE_LIMIT`        | 100    | 全局 queued + running 上限   |
| `AGENT_TENANT_QUEUE_LIMIT` | 20     | 单租户 queued + running 上限 |
| `AGENT_CONCURRENCY`        | 2      | 当前进程同时执行的任务数     |

队列满返回 429。相同租户、幂等键和输入返回同一任务；同一键提交不同内容返回 409。执行按数据库中的排队顺序调度，不宣称跨租户公平调度或分布式消费保证。

Agent 数据库持久保存 queued 任务，重启后恢复调度；上次遗留的 running 任务标记为 failed，不自动重复可能已经送出的模型请求。用户重试应创建新任务及幂等键，原键仍对应原任务。

正常停止时暂停接单和调度，默认最多等待 35 秒让当前任务结束；仍未结束的任务标记失败。模型调用默认 10 秒，配置上限 30 秒。当前只支持一个进程管理该 Agent 数据库，不要启动多个实例共享同一个文件。

## 证据与情感边界

核心先筛选相关、已审核、出处完整且标识唯一的事实。缺失依据、重复标识或高风险事实不用于生成；问题没有相关事实时保留答复，不用不相干参数装作回答。

阶段结果提供简短的证据准备、生成、引用核对与表达复核摘要，不输出模型内部思维链。全部结果保留人工复核要求，`completed` 只表示任务完成，不表示广告法律审查通过。

温暖可以体现在“我们慢慢看，一起把适合自己的选择弄清楚”这类表达里。不能自动写“我小时候妈妈每天做这个”或替观众声称共同体验；“妈妈的味道”等需要明确口味和联想因人而异，也不能借情感文案暗示未经证明的商品功效。

“第一”与“无出其右”表达相近的优越性主张，本版均提示核实，不提供“同义替换后合法”的承诺。市场监管总局《广告绝对化用语执法指南》同时涉及含义相近的用语，并要求结合广告内容、具体语境和实际情况判断；产品提示不构成逐字法律保证。[官方指南](https://www.samr.gov.cn/ggjgs/tzgg/art/2023/art_183b5cb48d9e4f0dba67f9f912a913ba.html)

本版的规则只覆盖有限风险，未命中不等于无风险。人工批准事实也不能替代证据真实性、商品类别、适用条件和整体情境审查。

## 模型配置：当前保持关闭

默认 `.env.example` 保持：

```dotenv
AGENT_MODEL_PROVIDER=grounded-rules
AGENT_MODEL_ENDPOINT=
AGENT_MODEL_MODEL=
AGENT_MODEL_API_KEY=
AGENT_MODEL_TIMEOUT_MS=10000
```

没有默认外部地址或密钥。只配置 endpoint 而不显式选择 provider 不会启用模型。用户准备好模型后，由可信部署管理员配置 Agent 进程并重启；商家提示词和任务正文不能改变这些值。

| 环境变量                 | 核心字段    | 要求                                                                 |
| ------------------------ | ----------- | -------------------------------------------------------------------- |
| `AGENT_MODEL_PROVIDER`   | `provider`  | `grounded-rules` 或 `openai-compatible`                              |
| `AGENT_MODEL_ENDPOINT`   | `endpoint`  | 完整 chat/completions 地址；远程 HTTPS，本机允许 localhost/回环 HTTP |
| `AGENT_MODEL_MODEL`      | `model`     | provider 开启时必填，实际模型名称由部署者提供                        |
| `AGENT_MODEL_API_KEY`    | `apiKey`    | 可选 Bearer 密钥，自托管可按服务要求省略                             |
| `AGENT_MODEL_TIMEOUT_MS` | `timeoutMs` | 默认 10000，最大 30000 毫秒                                          |

Agent 服务配置缺少必需项或端点不合要求时拒绝启动。直接调用核心库时，无效配置不会外发，而会返回明确的本地结果。URL 中的用户名、密码和 fragment 不被接受；请求禁止跟随重定向。

只有相关证据可用才调用已配置模型。`modelConfigured:true` 表示配置可用，不代表本次一定请求或成功；判断实际结果要同时看 `provider` 与阶段。超时、HTTP 错误、结构错误或证据引用无效会明确回退到 `grounded-rules`，不把回退文本标成远端生成。

## 受约束模型 JSON

当前 HTTP 适配采用兼容聊天完成接口的请求形状：`messages`、`model`、`response_format:{"type":"json_object"}`。固定规则在系统消息中，用户自定义提示、样例、话术和事实在数据消息中。模型正文必须是严格 JSON，例如：

```json
{
  "segments": [
    { "kind": "transition", "key": "warm-intro" },
    { "kind": "fact", "factId": "approved-fact-id" },
    { "kind": "transition", "key": "subjective-boundary" }
  ],
  "nextCue": "facts",
  "abstained": false
}
```

`factId` 必须引用本次提供的已审核事实，不能重复。过渡片段 key 只能是 `plain-intro`、`warm-intro`、`answer-intro`、`label-boundary`、`subjective-boundary`、`verify-next`；`nextCue` 只能是 `facts/questions/rules/verify`。最多 12 个片段；非保留答复必须含事实，保留答复不能夹带事实。

模型不能额外返回 `suggestion`、`text`、`evidence` 或任意自由主张。最终事实文字和出处从本地事实库回填，防止模型用一个合法 factId 给新编功效背书。活动提示也只引导核对平台配置，不原样把任意任务文本转成现金承诺。

这是可切换模型的受约束编排接口，还不是任意长文生成、完整语义推理或模型调优成果。兼容服务对 `response_format` 的支持、真实模型质量、延迟和成本需在配置后单独验收。目前远端分支测试使用模拟响应，没有据此宣称真实模型已经接通。

## 私有服务接口与权限

Agent `/v1/*` 需要 `Authorization: Bearer <AGENT_SERVICE_TOKEN>` 和可信 `x-studio-tenant`，二者由直播桥接层提供。`/health` 用于本机/私网状态读取，整个 Agent 服务不应反代到公网。

| Agent 私有接口                                    | 用途                               |
| ------------------------------------------------- | ---------------------------------- |
| `GET /health`                                     | 服务、模型配置及队列状态           |
| `GET/POST /v1/profiles`                           | 标准/品牌风格列表及品牌创建        |
| `GET/POST /v1/profiles/:id/versions`              | 历史版本及新版本                   |
| `POST /v1/profiles/:id/versions/:version/publish` | 发布已有版本                       |
| `POST /v1/runs`                                   | 带幂等键的试演/直播任务            |
| `GET /v1/runs`、`GET /v1/runs/:id`                | 房间历史或单次结果                 |
| `POST /v1/runs/:id/feedback`                      | 记录人工反馈                       |
| `POST /v1/check`                                  | 同步本地事实规则检查，不传模型配置 |

浏览器通过已认证的 `/api/merchant/agent/...`、`/api/merchant/rooms/:id/agent/...` 网关访问。原 `/api/merchant/rooms/:id/copilot` 兼容入口也转到独立 Agent 本地检查。Agent 不接受浏览器 Cookie，业务网关必须从自己的商家会话确定租户。

生产 `AGENT_SERVICE_TOKEN` 至少 32 字符，与会话签名、推流和模型密钥分别生成。开发默认 token 是公开的本机占位值，只用于回环开发。模型密钥只交给 Agent 进程；直播进程只需要 Agent 服务地址与服务 token。

## 数据最小化与部署

Agent 持久化提示词版本、完整执行输入快照、结果和反馈。`contextDigest` 用于追踪，不表示只存 hash 或已经脱敏。直播网关只发送当前选定问题、话术、相关商品资料及活动提示，不发送观众 Cookie、付款身份、推流密钥或账本。

使用前避免把手机号、身份号、姓名或不必要的聊天记录放进话术、样例与反馈。配置真实模型后，所选上下文和证据会按 provider 请求发送到管理员设定的地址；当前没有自动 PII 脱敏、证据文件真实性验证或自动保留期清理，需要部署者决定访问范围和保留策略。

服务器上将 Agent 作为独立 systemd 服务运行，使用独立数据路径和受限用户，`AGENT_SERVICE_URL` 指向回环/私网。模板见 [merchant-live-agent.service](../infra/merchant-live-agent.service)，安装、端口与回滚以[服务器测试说明](server-testing.md)为准；不要因修改提示词而重新发布直播底座，也不要把 Agent 库和模型密钥加入静态资源。

渠道通过 `src/shared/channels.ts` 的身份与分享 adapter 独立扩展，`GET /api/channels` 当前如实标记 web 入口可用、wechat/partner 未配置。微信身份、签名分享和支付不由 Agent 提示词代替，真实支付继续使用独立适配边界。

验证应分别覆盖版本与权限、排队与重启、事实和情感边界、未配置及失败回退、真实模型效果、直播浏览器体验和服务器部署。本版没有万人并发、自动调优、微调或微信真实资金能力声明。
