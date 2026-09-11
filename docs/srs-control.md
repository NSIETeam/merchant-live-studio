# 功能卡：SRS 流状态与强制断流

- **所属模块**：`live` 的媒体控制适配器统一提供 MediaMTX 与 SRS 状态、准入探测和断流；房间状态、准入、现场处置仍由 Live 业务负责。
- **用户验收场景**：选择 SRS 并配置私网控制地址后，商家能看到指定 `live/<roomId>` 是否正在发布及连接数；结束直播、轮换密钥或现场处置时，系统读取发布端 `cid`、删除该客户端并再次查询，只有引擎确认离线才显示断流成功。
- **接口变化**：现有商家流状态和断流 HTTP 路径不变；新增 SRS 6 `/api/v1/versions`、`/api/v1/streams` 与 `DELETE /api/v1/clients/{cid}` 适配。
- **配置**：`MEDIA_CONTROL_URL` 不含凭据、查询或片段。原 Bearer token 继续用于 MediaMTX 或受保护代理；SRS 原生 HTTP API 可使用 `MEDIA_CONTROL_USERNAME` 与 `MEDIA_CONTROL_PASSWORD`。生产 SRS 控制必须配置其中一种认证方式。
- **安全与失败恢复**：控制响应流式限制为 256 KiB，非零 SRS 业务码、非 JSON、超时、无效发布连接或断流后二次查询仍在线都按失败处理，不把房间状态更新误报成物理断流成功。生产配置拒绝公网控制主机；控制接口必须位于回环或私网，并由防火墙限制来源。
- **依据**：SRS 6 官方文档说明流列表包含发布连接 `stream.publish.cid`，强制断流使用 `DELETE /api/v1/clients/{id}`，5.0.152+/6.0.40+ 支持 HTTP API Basic 认证：[SRS HTTP API](https://ossrs.io/lts/en-us/docs/v6/doc/http-api)。
