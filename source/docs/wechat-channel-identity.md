# 功能卡：微信公众号观众身份入口

## 实现前填写

- **所属模块**：`identity` 负责观众会话、OAuth state 和稳定主体；`adapters` 负责微信 OAuth HTTP 协议；`operations` 只报告动态渠道能力。`live` 继续使用不透明 viewerId，`payments` 不读取 OAuth access token，也不因登录成功启用真实出款。
- **用户验收场景**：服务器配置已审核的公众号 AppID、密钥和回调地址后，观众从房间页发起微信身份验证，跳转到微信静默授权，再回到原房间。页面后续建立/复用已验证的微信观看会话，刷新不会变成新的匿名身份。未配置、state 不匹配、超时、重复回调或微信换码失败时明确失败，不伪造微信身份。
- **接口变化**：`GET /api/channels` 改为按实际配置返回微信 `viewerEntry/verifiedIdentity`；新增 `GET /api/channels/wechat/authorize?roomId=...` 返回官方授权地址，新增公开回调 `GET /api/channels/wechat/callback?code=...&state=...`，成功后 302 回原观看页。`POST /api/auth/viewer` 兼容新增 `verified` 与 `channel`，原 `identity` 字段继续存在。配置为 `WECHAT_OAUTH_ENABLED`、`WECHAT_APP_ID`、`WECHAT_APP_SECRET`、`WECHAT_IDENTITY_SECRET`、`WECHAT_OAUTH_REDIRECT_URI`，必须成组启用。
- **数据变化**：不新增数据库或文件。原始 OpenID 和 access token 不持久化、不返回浏览器；服务端用独立且必须长期稳定的 `WECHAT_IDENTITY_SECRET` 做 HMAC，派生稳定且不透明的 viewerId。OAuth state 使用短时签名载荷、Lax HttpOnly cookie 与进程内一次性 nonce；服务重启后未完成的授权须重新发起。
- **权限**：授权入口仅接受受限 roomId；回调必须同时通过 state 签名、期限、state cookie 和一次性校验。回调 URI 在生产必须使用 HTTPS、同 `APP_ORIGIN`，且精确指向当前 `APP_BASE_PATH` 下的回调接口。浏览器不能提交 AppID、密钥、换码端点或 OpenID。
- **失败处理**：微信网络、非 200、超时、超限响应、错误码或无效 OpenID 均返回通用 502，不泄露密钥、access token 或上游正文。state 错误返回 400，未配置返回 503；失败不改变已有观众 Cookie。换码调用固定 8 秒超时、固定微信 HTTPS 地址和有界响应。

实现依据微信公众平台网页授权流程；身份与支付继续分开。微信支付新版“商家转账”仍需产品开通、场景审核和用户确认或免确认授权，详见[支付边界](payments.md)。

## 随实现补充证据

- **流程结果**：已完成按配置动态展示渠道能力、公众号静默授权地址、短时 state、同源回调、固定微信换码适配、稳定不透明 viewerId、观众 Cookie 与原房间跳转。观众页“观看信息”能显示匿名/微信身份；仅在真实配置存在时提供验证按钮，并持续注明身份验证不等于收款授权。
- **基础检查**：`npm run check` 通过架构与数据归属检查、195 项业务测试、类型检查、生产构建和 HTTP 冒烟。高等级依赖审计为 0 个漏洞，部署脚本 9 项测试通过。
- **专项验证**：微信专项覆盖关闭状态、配置组合、同源及精确回调、官方授权地址、固定换码端点、稳定身份、state cookie、过期与重放、上游错误、响应上限及秘密不泄露。实际 Chrome 渲染使用合成配置检查 1280×900 和 390×844：两种视口横向溢出均为 0、绿色元素为 0，观看信息中均存在身份状态、微信验证入口和“不能用于真实提现”边界；未跳转真实微信。
- **阶段状态**：软件已随 `ff9f2d6` 部署，线上渠道能力按未配置状态返回，不会伪造微信身份。真实公众号域名、AppID/密钥、微信客户端授权和 OpenID 结果仍依赖渠道授权；模拟换码只证明软件协议流程，不证明真实账号开通、签名分享或支付能力。
