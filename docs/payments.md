# 红包与微信支付接入边界

资料核对日期：2026-09-11。本文区分当前可运行的演示闭环与尚未实现的真实支付。

## 当前实现

运行环境为 Node.js 24.10+、SQLite；`.env` 必须使用 `PAYMENT_PROVIDER=simulation`。任何其他值都会使服务启动失败。`/api/health` 返回 `payments: "simulation"`。

微信公众号 OAuth 观众身份接口已实现但默认关闭，尚未使用获授权公众号、备案域名和微信客户端实测。即使 OAuth 成功，系统也只建立不透明的稳定观看身份，不保存 access token，不把登录当作付款或收款授权，并继续返回 `canReceiveRealMoney: false`。目前没有商户资金充值、真实转账或用户提现；演示领取只能产生 `reserved` 和 `simulated` 状态，不能产生“已到账”。

商家与观众接口如下，写接口要求 JSON；商家接口使用商家会话，观众接口使用观众会话：

| 接口                                     | 当前行为                               |
| ---------------------------------------- | -------------------------------------- |
| `POST /api/merchant/rooms/:id/campaigns` | 创建演示活动并记入预算占用账本         |
| `POST /api/merchant/campaigns/:id/close` | 关闭活动，记回未领取演示预算           |
| `POST /api/viewer/rooms/:id/heartbeat`   | 服务端计时，记录可见页面心跳           |
| `POST /api/viewer/campaigns/:id/claim`   | 校验资格，原子分配金额，保存领取和任务 |
| `GET /api/viewer/rooms/:id/claims`       | 查询本观看会话的领取记录               |
| `GET /api/merchant/rooms/:id/ledger`     | 查询最近 200 条演示账本记录            |
| `POST /api/payments/wechat/notify`       | 固定返回 501；不更新任何支付状态       |

创建活动参数：`totalCents`、`count`、`minWatchSeconds`、`delaySeconds`、`durationSeconds`。金额是整数分，总金额不小于红包数量，保证每份至少 1 分。

领取资格要求活动在有效期、房间状态为 `live`、最近 30 秒有观看心跳、累计时长达标、还有剩余份额。服务端只计入间隔不超过 20 秒且页面可见时的时间；这是演示资格判断，不能证明真人观看或视频实际播放。

领取采用 SQLite `BEGIN IMMEDIATE` 事务；`UNIQUE(campaign_id, viewer_id)` 使同一会话重复领取返回原结果，避免重复扣减。当前是单实例实现，不代表已具备十万人并发能力，也不能阻止清除 Cookie 后取得新匿名身份。

账本路径为 `simulation_budget → campaign_reserved → claim_reserved → simulation_settled`。后台每 2 秒处理持久化模拟任务；关闭活动的剩余金额流向 `simulation_budget_returned`。这些账户是演示营销预算，不是银行账户、微信零钱或商户实际可用余额。

## 已预留的代码接口

`src/modules/payments/provider.ts` 定义：

```ts
interface PaymentProvider {
  createTransfer(request: TransferRequest): Promise<TransferReceipt>;
  queryTransfer(
    merchantId: string,
    outBillNo: string,
  ): Promise<TransferReceipt>;
  verifyAndDecodeNotification(
    headers: Record<string, string>,
    rawBody: Uint8Array,
  ): Promise<VerifiedTransferEvent>;
}
```

`TransferRequest` 包含 `merchantId`、`outBillNo`、`amountCents`、`verifiedRecipientId`。后者应由服务端可信身份映射生成，不能接受匿名浏览器随意提交的 OpenID。返回状态预留 `pending / wait_user_confirm / paid / failed / cancelled`。

`WeChatPaymentProvider` 的三个方法当前全部抛出“尚未实现”错误。`.env.example` 中从 `WECHAT_MCH_ID` 开始的支付字段只是接入占位，模拟服务不会读取它们；公众号 OAuth 和 JS-SDK 会使用单独启用的 AppID/AppSecret，但这仍不能启用支付。真实支付需要补充数据迁移、商户配置存储、授权状态、订单、幂等通知收件箱与对账任务。

## 微信支付产品选择与身份

后续以商户实际获批的新版“商家转账”产品及场景为准，不能将旧“现金红包”“商家转账到零钱”的接口、单据和回调混用。当前官方开通说明要求商户信用及转账场景证明资料，暂不支持小微商户。[开发接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4013740645)

微信当前支持两种收款模式：逐笔用户确认，以及用户授权免确认。后者仍须先拉起微信官方授权页并得到用户明确授权；授权可以撤销。静默登录获得 OpenID 不等于付款授权、收款授权、实名验证或入账。[产品介绍](https://pay.wechatpay.cn/doc/v3/merchant/4012711988)、[开发指引](https://pay.wechatpay.cn/doc/v3/merchant/4012715211)

多商户平台需逐商户确认主体、AppID 绑定关系、产品权限与获批场景，并选择适用的普通商户或服务商产品。下文普通商户接口示例不代表平台获得代其他商户统一出款的资格；不能把商户资金汇集到模拟预算账本后宣称已托管。

## 后续接入流程

1. 完成商户产品准入、AppID 绑定、转账场景申请和安全参数配置；通过微信登录等真实链路建立服务端收款身份。
2. 用实际资金来源核实预算，资格判断、预算保留与出款任务写入同一事务。正式支付须补充风控、异常处理及可靠队列，不直接在抢红包请求内调用微信。
3. 为每笔出款持久化唯一 `out_bill_no`，关联商户、领取、金额、收款身份与不可变请求快照，再由 worker 发起转账。
4. 如返回 `WAIT_USER_CONFIRM`，把 `package_info` 安全交给对应已验证用户，按官方 JSAPI/小程序等载体拉起确认收款；不要把创建受理成功显示为到账。
5. 通过经过验签的通知或服务端查询确认终态，幂等记账，向观众分别展示待处理、待确认、已到账、失败或撤销。
6. 持续查询结果未知的单据，定期对账并处理退款、撤销与人工异常；保留可审计的状态迁移。

普通商户用户确认模式的官方端点：

| 操作           | 微信 API                                                                 |
| -------------- | ------------------------------------------------------------------------ |
| 发起转账       | `POST /v3/fund-app/mch-transfer/transfer-bills`                          |
| 按商户单号查询 | `GET /v3/fund-app/mch-transfer/transfer-bills/out-bill-no/{out_bill_no}` |

请求需包含绑定的 `appid`、该 AppID 下的 `openid`、获批的 `transfer_scene_id`、金额与回调地址。`out_bill_no` 最长 32 位，只能包含数字及大小写字母；现有带连字符 UUID 不能原样使用。金额以整数分传输，敏感字段按官方要求加密。[发起转账](https://pay.wechatpay.cn/doc/v3/merchant/4012716434)、[商户单号查询](https://pay.wechatpay.cn/doc/v3/merchant/4012716437)

## 状态、验签与幂等

`ACCEPTED / PROCESSING / WAIT_USER_CONFIRM / TRANSFERING / CANCELING` 均为非终态；只有确认 `SUCCESS` 才写 `paid`。`FAIL / CANCELLED` 的后续动作需核对原单结果。网络超时、未知错误或未收到回调时，先查原商户单号，不能立即换单重付。[查询接口](https://pay.wechatpay.cn/doc/v3/merchant/4012716437)、[官方常见问题](https://pay.wechatpay.cn/doc/v3/merchant/4013778940)

通知处理应保留原始请求体，使用可信平台证书/微信支付公钥验证 `Wechatpay-*` 签名头，再用 APIv3 密钥解密业务信息；不能对重新序列化的 JSON 验签。核对商户、单号、金额和收款身份，持久化去重事件，再快速应答并异步处理后续业务。验签失败不能返回支付成功；浏览器回调不是到账凭据。[商家转账通知](https://pay.wechatpay.cn/doc/v3/merchant/4012712115)、[官方示例](https://pay.wechatpay.cn/doc/v3/merchant/4018940876)

未来应为通知事件、出款单和账本迁移增加唯一约束，处理重复通知、乱序通知、进程崩溃和查询与回调并发；数据库事务与外部支付之间需要幂等出站任务和对账恢复机制。密钥只保存于服务端密钥管理设施，不进入浏览器、源码、日志或示例文件。

## 验收边界

本 MVP 可验证模拟活动、资格、重复领取、预算账本和异步模拟结算。尚未验证真实微信商户权限、微信身份绑定、用户授权、真实转账、通知验签、资金对账及大规模并发。运行成功或界面显示演示领取成功均不代表支付链路已上线。
