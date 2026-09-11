# API 索引

对应 0.6.0 当前契约。应用内部前缀为 `/api`；经 `/studio/` 代理部署时，浏览器请求 `/studio/api/...`，代理剥离 `/studio/`。`APP_BASE_PATH` 控制 Cookie 路径，前端使用构建时 `VITE_BASE_PATH`，详见[服务器部署](server-testing.md)。

成功通常返回 JSON，MediaMTX 鉴权成功为 204。普通错误为 `{ "error": "说明" }`，SRS 拒绝使用 `{ "code": 403 }`。金额用整数分，时间戳用 Unix 毫秒。普通写请求使用 `Content-Type: application/json`，空参数也传 `{}`。

## 接口表

下列路径均接在 `/api` 后。

| 认证   | 方法 / 路径                                                         | 说明                                                          |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| 公开   | `GET /health`                                                       | 数据库健康、演示/支付/提词/流媒体配置及播放要求               |
| 公开   | `GET /auth/me`                                                      | 当前有效商家会话与 demo 开关                                  |
| 公开   | `POST /auth/demo`                                                   | 本地演示登录，生产禁用                                        |
| 公开   | `POST /auth/merchant`                                               | `{merchantId,token}`，签发含 sid 与凭据版本的商家 Cookie      |
| 公开   | `POST /auth/viewer`                                                 | 签发/复用匿名互动 Cookie，不是观看前置条件                    |
| 会话   | `POST /auth/logout`                                                 | 持久撤销当前商家 sid，并清 Cookie；重复调用安全               |
| 商家   | `GET /merchant/rooms`                                               | 仅当前商家的房间                                              |
| 商家   | `POST /merchant/rooms`                                              | `{title,productName}`                                         |
| 商家   | `PATCH /merchant/rooms/:id`                                         | `{status:"draft"/"live"/"ended"}`；结束时附断流结果           |
| 商家   | `GET /merchant/rooms/:id/stream`                                    | provider、RTMP server、完整 streamKey、HLS URL、authEnabled   |
| 商家   | `POST /merchant/rooms/:id/stream/rotate`                            | 轮换密钥并尝试踢出旧推流，返回 streamAction                   |
| 商家   | `GET /merchant/rooms/:id/signal`                                    | MediaMTX 实际信号状态、引擎 reader 数或未知提示               |
| 商家   | `POST /merchant/rooms/:id/stream/disconnect`                        | 踢出支持的推流连接并二次查询核验                              |
| 商家   | `GET /merchant/rooms/:id/facts`                                     | 事实、出处、批准状态                                          |
| 商家   | `POST /merchant/rooms/:id/facts`                                    | `{text,evidence,approved:false}`                              |
| 商家   | `PATCH /merchant/facts/:id`                                         | `{approved:boolean}`，人工审核                                |
| 商家   | `POST /merchant/rooms/:id/copilot`                                  | `{transcript,question?}`，经私有 Agent 服务进行本地规则检查   |
| 商家   | `GET /merchant/rooms/:id/campaigns`                                 | 活动列表与 serverTime                                         |
| 商家   | `POST /merchant/rooms/:id/campaigns`                                | 创建演示活动                                                  |
| 商家   | `POST /merchant/campaigns/:id/close`                                | 幂等关闭，返回演示余量                                        |
| 商家   | `GET /merchant/rooms/:id/ledger`                                    | 最近 200 笔账本                                               |
| 商家   | `GET /merchant/rooms/:id/analytics`                                 | 房间累计访问、停留、问题与领取分析                            |
| 商家   | `GET /merchant/rooms/:id/questions`                                 | 按文本精确聚合的前 20 类问题                                  |
| 商家   | `GET /merchant/rooms/:id/speech/status`                             | 语音供应方、最近最终分段及 Agent 入队状态                     |
| 商家   | `GET /merchant/rooms/:id/recordings`                                | 已登记录像片段、校验信息和删除状态                            |
| 商家   | `GET /merchant/recordings/:id/download`                             | 再次校验后下载；已复核删除返回 410                            |
| 商家   | `GET /merchant/recordings/:id/retention`                            | 保存期限、争议、保留及删除复核历史                            |
| 商家   | `POST /merchant/recordings/:id/retention/holds`                     | 建立争议、监管或业务保留                                      |
| 商家   | `POST /merchant/recordings/:id/retention/holds/:holdId/release`     | 由另一账号复核释放保留                                        |
| 商家   | `POST /merchant/recordings/:id/deletion-requests`                   | 到期后提交删除申请                                            |
| 审核员 | `POST /merchant/recordings/:id/deletion-requests/:requestId/review` | 退回或复核执行物理删除                                        |
| 公开   | `GET /public/rooms/:id`                                             | 房间及 signal、活动、serverTime、requirePlayback、paymentMode |
| 观众   | `POST /viewer/rooms/:id/heartbeat`                                  | `{visible,playing}`，返回本场/累计时长及计时状态              |
| 观众   | `POST /viewer/rooms/:id/questions`                                  | `{text}`，直播中可提问，每会话每房间至少间隔 5 秒             |
| 观众   | `POST /viewer/campaigns/:id/claim`                                  | 幂等领取，返回 claim 与 simulation 模式                       |
| 观众   | `GET /viewer/rooms/:id/claims`                                      | 当前观众在该房间的历史领取记录                                |
| 引擎   | `POST /streams/mediamtx/auth?secret=...`                            | 引擎原生发布/观看鉴权载荷                                     |
| 引擎   | `POST /streams/srs/publish?secret=...`                              | SRS on_publish 回调                                           |
| 语音方 | `POST /streams/speech/segments`                                     | Bearer 鉴权的最终转写分段 webhook；幂等接入                   |
| 未实现 | `POST /payments/wechat/notify`                                      | 固定 501，不更新状态                                          |

## 会话与限流

商家会话有独立 `sid`，注销后重放原 Cookie 仍返回 401；同商家的其他有效登录不受影响。凭据删除或轮换使旧凭据版本失效，部署环境配置需重启后生效。Cookie 为 HttpOnly / SameSite=Strict，生产为 Secure，Path 为 `APP_BASE_PATH`。

观众建会话返回 `viewerId`、`identity:"anonymous"`、`canReceiveRealMoney:false`。公开房间和 HLS 不依赖 Cookie；只有提问、心跳、领取及领取历史需要观众身份。

商家鉴权每分钟 60 次、观众建会话每分钟 600 次，预算独立。读取和写入限额分别为每分钟 1200、300 次；已验证业务会话单独计数，商家登录预算按可信客户端地址计数。超额返回 429 与 `Retry-After: 60`。仅 `TRUSTED_PROXY_IPS` 中的代理可提供有效 `X-Real-IP`，不能用观众 Cookie 或任意代理头绕过商家登录预算。

## 房间与媒体控制

业务状态允许 `draft → live → ended → draft`，可重复写入当前状态。进入新的 `live` 清本场资格，历史累计与账本保留。结束房间关闭活动并尝试断流；轮换密钥先更新密钥，再尝试断流。

信号字段 `configured` 表示控制面是否配置，`connected` 为 `true/false/null`，`null` 表示未知；`viewers` 为引擎报告的 reader 数，不是房间的去重观众人数。响应不包含控制地址或控制凭据。

断流结果形如：

```json
{
  "disconnected": false,
  "message": "断流请求失败，请手动停止 OBS 后重试"
}
```

MediaMTX 支持 RTMP/RTMPS 踢连接后再次查询。未配置、协议不支持、请求失败或仍在线都不能报成功。显式断流接口直接返回此对象；结束和轮换响应将其放在 `streamAction`。HTTP 200 仅表示业务请求已处理，客户端仍需检查 `disconnected`。控制失败不会回滚已经生效的业务状态或新密钥。SRS 尚未实现控制面。

`authEnabled` 只表示应用配置了共享回调密钥，不证明引擎配置已实际启用鉴权。详细接入见[流媒体说明](streaming.md)。

## 演示红包与资格

创建活动：

```json
{
  "totalCents": 10000,
  "count": 20,
  "minWatchSeconds": 10,
  "delaySeconds": 10,
  "durationSeconds": 600
}
```

已结束房间不能创建活动。商家列表 `{campaigns,serverTime}` 与公开房间的 `serverTime` 使用同一个服务端时钟，前端据此显示倒计时。真正的开启、过期和资格检查仍在服务端执行。

心跳请求与响应示例：

```json
{ "visible": true, "playing": true }
```

```json
{
  "watchSeconds": 12,
  "totalWatchSeconds": 132,
  "counting": true,
  "qualifiedBy": "playback-heartbeats-demo-only"
}
```

`watchSeconds` 是本场资格整秒数，`totalWatchSeconds` 是房间历史累计整秒数，数据库按毫秒保存。`playing` 缺省为 false。`REQUIRE_PLAYBACK=true` 时必须页面可见、房间 live、playing=true 且引擎信号在线；关闭该要求时 `qualifiedBy` 为 `server-heartbeats-demo-only`，只用于本地演示。

只累计相邻有效心跳间大于零且不超过 20 秒的服务端时间，隐藏、暂停、断线及无信号不补算。领取还要求最近 30 秒内有效心跳和 active 状态、当前场次时长达标、活动可领以及房间 live；严格模式额外要求当前信号在线。失败返回 403/409。

服务端对同一活动和匿名会话只创建一个 claim；严格模式下断线可阻止重复领取入口，历史结果应通过 `/claims` 查询。金额和账本只属于模拟流程，`reserved → simulated` 不表示真实到账。

## 错误与后续接口

无有效会话为 401；跨站操作或资格不足为 403；无权访问另一商家资源统一为 404；状态、窗口和信号冲突通常为 409；格式验证为 400；超限为 429。微信通知能力未接入，返回 501 并保持支付状态不变。

当前契约由共享 DTO、Zod 与回归测试维护，尚未生成 OpenAPI。后续需增加 API 版本化、分页、稳定错误码与审计。微信 OAuth/支付尚未接入；实时转写已有供应方无关的 webhook 边界，但尚未配置真实 ASR 服务。模型 HTTP 适配已实现但真实模型按用户选择保持未配置，见[Agent 说明](agent.md)、[架构](architecture.md)与[支付说明](payments.md)。

## 实时语音分段

启用 `SPEECH_PROVIDER=webhook` 后，语音供应方使用独立的 `SPEECH_INGEST_SECRET` 调用 `POST /api/streams/speech/segments`，密钥只放在 `Authorization: Bearer ...` 请求头。该入口不接受商家 Cookie 代替供应方凭据，也不从正文接受租户、模型地址或 Agent 凭据。

```json
{
  "roomId": "当前房间 ID",
  "eventId": "供应方稳定事件 ID",
  "text": "最终识别文本",
  "startedOffsetMs": 1000,
  "endedOffsetMs": 2500,
  "final": true
}
```

非最终分段返回 `accepted:false` 且不保存。最终分段只在房间正在直播时保存；同一场次的相同事件重复请求返回原记录，相同事件 ID 携带不同正文或时间范围返回 409。接口在同一事务内写入 Live 数据库并建立持久待处理任务，随后立即返回，不等待 Agent 推理。后台按 `SPEECH_DISPATCH_CONCURRENCY` 有界处理，取同一场次最近 8 段组成不超过 4000 字的上下文，再按服务端固定的 `SPEECH_AGENT_PROFILE_ID` 创建 `live` Agent 任务。Agent 未配置、超时或限流不会回滚转写，任务会退避重试；进程重启恢复中断任务，Agent 幂等键阻止重复运行。

商家通过 `GET /api/merchant/rooms/:id/speech/status` 查看配置、最近分段和入队状态。转写属于非公开直播记录，观众房间接口不返回正文或 Agent 运行标识。此边界不采集浏览器麦克风；真实 ASR 服务的音频采集、签名协议和服务商效果需要独立接入与验收。

## 录像保留与删除复核

录像删除只接受已经结束的直播间，并以服务器配置的 `DATA_RETENTION_POLICY.liveContentDays` 和录像完成时间计算最早删除时间。没有真实政策、尚未到期、存在有效主动保留或本直播间仍有未解决投诉/申诉时均返回 409。owner 提交删除申请；团队和生产空间由不同 actor 的 reviewer 复核，申请人不能自审。

批准后服务先校验登记大小和 SHA-256，把文件原子移动到录像根目录内的私有删除隔离区，再次同步核对保留与争议状态。复核通过后写入 `deleting` 事件并物理移除；中断时可从确定的隔离路径继续或恢复。所有申请、保留和状态事件不可修改或删除，录像登记也继续保存。完成删除的下载接口返回 410，不把文件缺失当作完成删除。接口正文中的理由/说明为 8–1000 字，建立保留与删除申请使用 UUID 幂等键。

## 独立 Agent 网关（0.3）

以下表格路径接在 `/api` 后，全部要求商家会话；网关从会话设置租户，商家不能伪造租户或模型连接配置。所有正文沿用 32 KiB 总上限。Agent 的私有 API 不直接暴露给浏览器。

| 路径                                                          | 功能                                                                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /merchant/agent/status`                                  | 可用性、模型是否配置、队列占用；Agent 离线不会让直播健康接口失败                                                                                   |
| `GET/POST /merchant/agent/profiles`                           | 标准/品牌风格列表；创建品牌风格                                                                                                                    |
| `GET/POST /merchant/agent/profiles/:id/versions`              | 不可变版本历史；追加草稿版本                                                                                                                       |
| `POST /merchant/agent/profiles/:id/versions/:version/publish` | 选择直播使用的已发布版本                                                                                                                           |
| `POST /merchant/rooms/:id/copilot`                            | 兼容快速检查接口，转交独立 Agent 的本地规则，不触发远端模型                                                                                        |
| `POST /merchant/rooms/:id/agent/runs`                         | 异步创建试演/直播建议，202 返回任务；正文为 profileId、version?、transcript、question?、mode、idempotencyKey；幂等重放返回原任务并复核当前过期状态 |
| `GET /merchant/agent/runs/:id`                                | 读取任务与结果；结合当前直播数据标记过期                                                                                                           |
| `POST /merchant/agent/runs/:id/feedback`                      | rating 为 useful/needs_work，note 为复盘意见；返回结果也复核事实撤回与过期状态                                                                     |
| `GET /merchant/rooms/:id/agent/latest`                        | 只读取最近的 live 任务；rehearsal 草稿不会覆盖直播卡，Agent 离线返回 available=false                                                               |

公开 `GET /api/channels` 不要求商家会话，报告当前渠道能力：网页入口可用，微信和合作方未配置，不冒充已验证身份、签名分享或真实支付。

运行输入的商品、已审核事实与活动提示由网关从当前商家直播间提取。正文中附加 `context`、`facts`、`tenant`、模型地址或密钥会被拒绝。试演可指定草稿版本；`live` 任务入队时必须使用已发布版本。任务固定入队时的提示词与上下文快照，之后发布新版本不会改写历史任务。

新结果兼容增加 `policyVersion`、`policyPack` 和 `claimDecisions`。每个 `claimDecisions` 项包含稳定规则编号、主张类型、`block/review/context` 处置、风险类别、命中片段、所在完整句、解释、需要的依据和处理方向。旧历史任务可能没有这三个字段，客户端必须按缺省处理；新结果仍保留原 `alerts`，供旧客户端兼容显示。

`/agent/latest` 向私有服务明确查询 `mode=live`，不会把时间较新的试演任务作为直播建议。返回的是最近直播任务及其真实状态，可能仍在排队、执行、失败或已完成；它不是“最近任意草稿”或“始终存在有效建议”的保证。

任务单独读取、最新建议读取、创建接口的幂等重放结果及反馈结果都经过同一 `validateRun` 复核：引用事实撤回会标记 `stale`；直播任务在场次改变、房间结束或距创建超过 120 秒时也会标记 `stale` 并给出 `staleReason`。该标记在返回时根据当前直播数据计算，提交反馈或重放请求不能使旧结果重新有效。过期结果仅供历史复盘，当前建议需重新生成。

详细数据结构见 `src/shared/agent.ts`，执行与模型契约见[Agent 说明](agent.md)。当前模型未配置；试演、反馈和阶段摘要不表示已经完成模型调优或微调。

## 资料和场景评测（0.4.0）

以下接口均要求商家会话、同源 JSON 写入，并校验房间/租户。Agent 仍通过私有接口使用服务端组装的审核事实。

| 方法与路径                                                      | 内容                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| GET `/api/merchant/rooms/:id/materials`                         | 最近导入批次与来源                                                             |
| POST `/api/merchant/rooms/:id/materials/preview`                | `{sourceName,format,content}`，只读预览                                        |
| POST `/api/merchant/rooms/:id/materials/import`                 | 同上加 `idempotencyKey`；原子待审导入                                          |
| POST `/api/merchant/agent/profiles/:id/examples/import`         | `{sourceName,authorization,examples,baseVersion,idempotencyKey}`；新草稿及回执 |
| GET `/api/merchant/agent/profiles/:id/example-imports`          | 样例来源和授权声明回执                                                         |
| GET/POST `/api/merchant/rooms/:id/agent/suites`                 | 读取题组；`{name,cases}` 保存不可变修订                                        |
| POST `/api/merchant/rooms/:id/agent/evaluations`                | `{suiteId,variants,idempotencyKey}`；整批入队返回 202                          |
| GET `/api/merchant/rooms/:id/agent/evaluations`                 | 最近十份报告                                                                   |
| GET `/api/merchant/agent/evaluations/:id`                       | 含历史快照与当前过期标记的报告                                                 |
| POST `/api/merchant/agent/evaluations/:id/items/:itemId/review` | `{style,naturalness,decision,note}`；1–5 分人工评价，非发布审批                |

完整数据契约见 `src/shared/training.ts`。材料 24 KiB/40条，样例合并最多12条，题组最多8题/2方案。新增资料不自动批准；同键不同请求409，评测队列容量不足429；新评分前后复核依据，已经过期的报告不接受新评分。
