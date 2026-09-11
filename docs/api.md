# API 索引

API 前缀 `/api`。成功返回 JSON（MediaMTX 鉴权成功为 204）；错误为 `{ "error": "说明" }`，SRS 拒绝时返回 `{ "code": 403 }`。金额用整数分，时间用毫秒 Unix 时间戳。写入请求使用 `Content-Type: application/json`，空参数也传 `{}`。

| 认证   | 方法 / 路径                              | 说明                                   |
| ------ | ---------------------------------------- | -------------------------------------- |
| 公开   | `GET /health`                            | 服务状态及支付/提词 provider           |
| 公开   | `GET /auth/me`                           | 当前商家会话与 demo 开关               |
| 公开   | `POST /auth/demo`                        | 本地演示登录，生产禁用                 |
| 公开   | `POST /auth/merchant`                    | `{merchantId,token}`，签发商家 Cookie  |
| 公开   | `POST /auth/viewer`                      | 签发/复用匿名观众 Cookie               |
| 会话   | `POST /auth/logout`                      | 清除商家 Cookie                        |
| 商家   | `GET /merchant/rooms`                    | 仅当前商家的房间                       |
| 商家   | `POST /merchant/rooms`                   | `{title,productName}`                  |
| 商家   | `PATCH /merchant/rooms/:id`              | `{status: "draft" / "live" / "ended"}` |
| 商家   | `GET /merchant/rooms/:id/stream`         | RTMP server、streamKey、HLS URL        |
| 商家   | `POST /merchant/rooms/:id/stream/rotate` | 更换未来推流连接的密钥                 |
| 商家   | `GET /merchant/rooms/:id/facts`          | 事实、出处、批准状态                   |
| 商家   | `POST /merchant/rooms/:id/facts`         | `{text,evidence,approved:false}`       |
| 商家   | `PATCH /merchant/facts/:id`              | `{approved:boolean}`，人工审核         |
| 商家   | `POST /merchant/rooms/:id/copilot`       | `{transcript,question?}`，本地规则建议 |
| 商家   | `GET/POST /merchant/rooms/:id/campaigns` | 列表 / 新建活动                        |
| 商家   | `POST /merchant/campaigns/:id/close`     | 幂等关闭，返还演示余量                 |
| 商家   | `GET /merchant/rooms/:id/ledger`         | 最近 200 笔账本                        |
| 商家   | `GET /merchant/rooms/:id/analytics`      | 实际访问和领取统计                     |
| 商家   | `GET /merchant/rooms/:id/questions`      | 按文本精确聚合的前 20 类问题           |
| 公开   | `GET /public/rooms/:id`                  | 公开房间、可参与活动、服务端时间       |
| 观众   | `POST /viewer/rooms/:id/heartbeat`       | `{visible:boolean}`，返回 watchSeconds |
| 观众   | `POST /viewer/rooms/:id/questions`       | `{text}`，每会话每房间至少间隔 5 秒    |
| 观众   | `POST /viewer/campaigns/:id/claim`       | 幂等领取，返回 claim 与模拟模式        |
| 观众   | `GET /viewer/rooms/:id/claims`           | 当前观众在该房间的领取记录             |
| 引擎   | `POST /streams/mediamtx/auth?secret=...` | 引擎原生发布鉴权载荷                   |
| 引擎   | `POST /streams/srs/publish?secret=...`   | SRS on_publish 回调                    |
| 未实现 | `POST /payments/wechat/notify`           | 固定 501，不更新状态                   |

创建演示活动请求：

```json
{
  "totalCents": 10000,
  "count": 20,
  "minWatchSeconds": 10,
  "delaySeconds": 10,
  "durationSeconds": 600
}
```

房间状态允许 `draft → live → ended → draft`，同状态重复请求可接受。已结束房间不允许新建活动。领取需房间开放、活动已开始未过期、有效心跳时长达标；失败会返回 403/409。无权访问商家房间返回 404，不暴露其他商家资源。

接口契约当前用共享 DTO、Zod 和测试维护；尚未生成 OpenAPI。生产 API 应增加版本化、分页、审计、稳定错误码和合理的数据保留策略。
