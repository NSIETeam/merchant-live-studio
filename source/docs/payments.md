# 红包与微信支付接入边界

资料核对日期：2026-09-11。本文区分默认演示模式、已经接通的微信转账软件链路，以及仍须外部资质和真实资金完成的验收。

## 当前实现

运行环境为 Node.js 24.10+、SQLite。默认 `PAYMENT_PROVIDER=simulation`；只有同时完成微信公众号 OAuth、JS-SDK、绝对路径商家私有配置和 32 字节收款身份加密密钥时，才允许启用 `PAYMENT_PROVIDER=wechat`。`/api/health` 与 `/api/channels` 按实际配置报告支付能力。

微信公众号 OAuth 默认关闭，且尚未使用获授权公众号、备案域名和微信客户端实测。OAuth 只建立不透明的稳定观看身份，不保存 access token；用户还须对当前商家明确授权，系统才会加密保存收款 OpenID。微信模式下，领取与预算扣减、账本和唯一出款任务在同一事务中写入；后台按原商户单号发起或查询，只有经过验签的通知或服务端查询结果才能确认终态。平台不提供商户充值、资金托管或用户提现。

商家与观众接口如下，写接口要求 JSON；商家接口使用商家会话，观众接口使用观众会话：

| 接口                                                     | 当前行为                               |
| -------------------------------------------------------- | -------------------------------------- |
| `POST /api/merchant/rooms/:id/campaigns`                 | 创建活动并快照当前商户支付模式         |
| `POST /api/merchant/campaigns/:id/close`                 | 关闭活动，记回未领取预算               |
| `POST /api/viewer/rooms/:id/heartbeat`                   | 服务端计时，记录可见页面心跳           |
| `POST /api/viewer/campaigns/:id/claim`                   | 校验资格，原子分配金额，保存领取和任务 |
| `GET /api/viewer/rooms/:id/claims`                       | 查询本观看会话的领取记录               |
| `GET /api/merchant/rooms/:id/ledger`                     | 查询最近 200 条账本记录                |
| `GET /api/merchant/rooms/:id/transfers`                  | 查询本房间微信出款状态                 |
| `GET /api/viewer/rooms/:id/payment-recipient`            | 查询当前商家收款授权状态               |
| `POST /api/viewer/rooms/:id/payment-recipient/authorize` | 授权保存已验证收款身份                 |
| `POST /api/viewer/rooms/:id/payment-recipient/revoke`    | 撤销当前商家收款授权                   |
| `GET /api/viewer/claims/:id/transfer`                    | 查询本人领取的出款与确认参数           |
| `POST /api/payments/wechat/notify`                       | 微信模式下验签、解密并幂等更新出款     |

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

`WeChatPaymentProvider` 已实现普通商户 APIv3 的请求签名、发起转账、原商户单号查询、微信应答验签、终态通知验签及 AES-256-GCM 解密。适配器固定商户号、AppID、获批场景、报备字段、通知地址和服务器密钥，并校验内部租户、商户单号、整数分金额、OpenID、回调商户号与终态；请求失败时明确要求查询原单，不能换单重付。协议实现与验证边界见[微信商家转账适配器功能卡](wechat-transfer-adapter.md)。

当前实现已将逐领取唯一出款单、不可改写状态事件、幂等通知收件箱和加密 OpenID 保险库接入 HTTP 用户流程。支付模块通过按商家隔离的 registry 选择普通商户配置；配置文件与私钥必须位于源码之外，生产环境拒绝组或其他用户可读的文件。领取接口不直接请求微信，持久 worker 会重复查询同一 `out_bill_no`，并将 `paid / failed / cancelled` 终态一次性对账到分类账。现阶段支持内部多个普通商户配置；若平台采用微信支付服务商模式，仍需根据最终合同另行实现子商户产品链路。

## 微信支付产品选择与身份

后续以商户实际获批的新版“商家转账”产品及场景为准，不能将旧“现金红包”“商家转账到零钱”的接口、单据和回调混用。当前官方开通说明要求商户信用及转账场景证明资料，暂不支持小微商户。[开发接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4013740645)

微信当前支持两种收款模式：逐笔用户确认，以及用户授权免确认。后者仍须先拉起微信官方授权页并得到用户明确授权；授权可以撤销。静默登录获得 OpenID 不等于付款授权、收款授权、实名验证或入账。[产品介绍](https://pay.wechatpay.cn/doc/v3/merchant/4012711988)、[开发指引](https://pay.wechatpay.cn/doc/v3/merchant/4012715211)

多商户平台需逐商户确认主体、AppID 绑定关系、产品权限与获批场景，并选择适用的普通商户或服务商产品。下文普通商户接口示例不代表平台获得代其他商户统一出款的资格；不能把商户资金汇集到模拟预算账本后宣称已托管。

## 真实环境启用流程

1. 完成商户产品准入、AppID 绑定、转账场景申请和安全参数配置；逐商户写入私有 registry，并通过微信登录建立服务端收款身份。
2. 用实际资金来源核实活动预算和会计含义；现有资格判断、预算保留与出款任务已经写入同一事务，正式运行还须配置限额、风控和人工异常处理。
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

通知事件、出款单和终态账本已有唯一约束与幂等处理；持久 worker 可在进程重启后继续查询原单，并处理重复通知。真实环境仍须验证乱序通知、长时间未知状态、微信侧限流、日终对账和人工补偿。密钥只保存于服务端密钥管理设施，不进入浏览器、源码、日志或示例文件。

## 验收边界

本 MVP 可验证模拟活动，也可用生成的密钥与注入适配器验证微信模式的身份授权、原子领取、唯一出款、用户确认参数、重复通知和终态账本。尚未验证真实微信商户权限、备案域名、微信客户端授权、真实资金转账、日终资金对账及大规模并发。软件检查通过或确认页成功拉起均不代表资金已经到账。
