# 流媒体接入与验证

对应 0.2.0。流媒体独立接收 RTMP、通过 HLS 分发；业务 API 不转发视频字节。默认 MediaMTX 1.21.0，SRS 6.0.191 保留基础适配。

## 已完成的本机验证

2026-09-11 在 macOS arm64 回环网络中，用真实 MediaMTX 与 FFmpeg 完成 10 项检查：

1. 独立测试端口可用。
2. 构建后的 API 与 MediaMTX 启动，开启播放资格要求。
3. 无信号不能累计时长或领取。
4. 错误发布密钥被拒绝。
5. 正确 RTMP 发布上线，引擎报告 `rtmpConn`。
6. 暂停状态的观众心跳不计时。
7. 真实 HLS 清单与分片可下载，H.264 视频和 AAC 音频实际解码成功。
8. 播放心跳、资格、幂等领取、账本、模拟 worker 与分析闭环通过。
9. 结束房间实际踢出 RTMP 连接，并拒绝重连。
10. 重新开放后，轮换前的旧密钥无法发布。

测试进程已停止，临时凭据已清理，应用数据库使用内存。该验收通过 HTTP 提供 `playing` 标志，FFmpeg 独立验证真实分片解码；没有因此声称浏览器画面、OBS 硬件、手机、微信内播放或远程服务器已验收。服务器部署与最终证据见[服务器测试说明](server-testing.md)，应用回归见[验收记录](acceptance.md)。

## 三类状态

- **房间状态**：`draft/live/ended` 由商家操作，开放房间不会启动 OBS 或摄像头。
- **引擎信号**：MediaMTX Control API 返回真实在线来源与 reader 数，独立于房间状态。
- **观众播放**：播放器事件报告 playing，与页面可见状态一起发送心跳。

`REQUIRE_PLAYBACK=true` 只有上述条件都满足才累计演示资格；无控制配置、未知信号或断线时不累计。它仍不是可靠反作弊或真人观看证明。公开房间和播放器独立加载，互动身份失败不阻断视频。

## 引擎与地址

| 项目                    | MediaMTX                     | SRS                          |
| ----------------------- | ---------------------------- | ---------------------------- |
| 固定版本                | `bluenviron/mediamtx:1.21.0` | `ossrs/srs:6.0.191`          |
| `STREAM_PROVIDER`       | `mediamtx`                   | `srs`                        |
| 本机 `STREAM_RTMP_BASE` | `rtmp://localhost:1935/live` | `rtmp://localhost:1935/live` |
| 本机 `STREAM_HLS_BASE`  | `http://localhost:8888/live` | `http://localhost:8080/live` |
| 生成的播放路径尾部      | `/<roomId>/index.m3u8`       | `/<roomId>.m3u8`             |
| 发布鉴权                | HTTP auth                    | on_publish 回调              |
| 当前状态/强制断流       | MediaMTX Control API         | 尚未实现                     |

两种引擎默认占用同一 1935 端口，任选一个。切换 provider 时同步修改 HLS base，不会自动切端口。公开播放 URL 不含发布 token；房间 ID 不能充当推流密码。

商家端读取 Server 与完整 `<roomId>?token=<roomSecret>`，填入 OBS 自定义服务；使用 H.264/AAC，建议 2 秒关键帧。HLS 首次播放要等待分片生成。手机必须使用可访问的域名/IP，手机 `localhost` 指向手机本身。

官方参考：[MediaMTX 安装](https://mediamtx.org/docs/kickoff/install)、[OBS 推流](https://mediamtx.org/docs/publish/obs-studio)、[HLS](https://mediamtx.org/docs/read/hls)、[配置参考](https://mediamtx.org/docs/references/configuration-file)、[SRS 发布](https://github.com/ossrs/srs/releases/tag/v6.0-r1)。

## 本机开发与服务器配置

默认 `compose.yml`、`infra/mediamtx.yml` 和 `infra/srs.conf` 用于本机试验：端口绑定回环，默认未启用发布鉴权或控制面。仅在 `.env` 设置 `STREAM_AUTH_SECRET` 不会自动改动引擎配置；`authEnabled` 表示应用具有密钥，不表示真实鉴权已验证。

服务器使用[MediaMTX 配置模板](../infra/mediamtx-server.yml.example)及[systemd/代理部署说明](server-testing.md)。模板的应用回调、HLS 和 Control API 分别采用本机 18890、18891、18892；RTMP 为 1935，部署前确认空闲。应用需要匹配：

```dotenv
STREAM_PROVIDER=mediamtx
STREAM_RTMP_BASE=rtmp://YOUR_SERVER:1935/live
STREAM_HLS_BASE=https://YOUR_SERVER/studio/media/live
STREAM_AUTH_SECRET=REPLACE_WITH_RANDOM_SHARED_SECRET
MEDIA_CONTROL_URL=http://127.0.0.1:18892
MEDIA_CONTROL_TOKEN=
REQUIRE_PLAYBACK=true
```

所有示例占位值必须在部署文件中替换，真实文件放在仓库外。生产配置未显式指定 `REQUIRE_PLAYBACK` 时默认为 true；从 `.env.example` 复制而来的 false 仍需手动改成 true。

Control API 只留在回环或受控私网，不反代公网。当前单机模板将 `action: api` 排除 HTTP 鉴权，依赖仅回环监听；不能照搬到公网或不受控容器网络。`MEDIA_CONTROL_TOKEN` 会作为 Bearer 发给控制面，仅在控制面实际配置匹配认证时使用。

## 发布鉴权

MediaMTX 模板配置 `authMethod: http` 和带共享 secret 的 `authHTTPAddress`，引擎回调到应用内部地址，不通过公网 `/studio/`。请求体示例：

```json
{ "action": "publish", "path": "live/<roomId>", "query": "token=<roomSecret>" }
```

`POST /api/streams/mediamtx/auth?secret=...` 先验证引擎共享密钥，再要求房间 live、房间 token 匹配，成功返回 204；`read/playback` 通过共享密钥验证后放行。其他动作拒绝，控制 API 排除规则由引擎部署配置负责。[MediaMTX 鉴权参考](https://mediamtx.org/docs/features/authentication)

SRS 在所需 vhost 内启用 `http_hooks`，例如：

```conf
http_hooks {
    enabled on;
    on_publish http://api:8787/api/streams/srs/publish?secret=REPLACE_SHARED_SECRET;
}
```

`api` 仅为容器网络服务名示例，须改成实际可达的私网应用地址。SRS 载荷含 `action:"on_publish"`、`app:"live"`、`stream` 和 `param:"?token=..."`；应用核验后返回 `{"code":0}`。SRS 没有接入 `on_unpublish`、控制面或强制断流；不能把其基础地址适配视为与 MediaMTX 功能完全相同。[SRS HTTP 回调](https://ossrs.io/lts/en-us/docs/v6/doc/http-callback)

token 与共享密钥可能出现在 URL，应避免进入访问日志或对外错误内容。远程 RTMP 明文传输需要受控网络或另外配置 RTMPS 等保护，当前模板未自动配置推流 TLS。

## 流状态、轮换与停止

`GET /api/merchant/rooms/:id/signal` 读取 MediaMTX 路径，公开房间 DTO 同样包含 signal。返回 `configured`、`connected`、`checkedAt`、可选 `viewers/message`。查询约缓存 2.5 秒，请求超时为 3 秒；未知状态为 null，不会伪装在线。引擎 reader 数与业务可见页面人数是不同指标。

以下操作会尝试断流：

- 把房间改为 `ended`，同时关闭未完成活动。
- 轮换房间推流密钥。
- 调用 `POST /api/merchant/rooms/:id/stream/disconnect`。

实现读取当前来源，使用 RTMP/RTMPS 对应 kick API，再次读取路径验证结果。未配置控制服务、协议不支持、请求出错或仍有在线来源时，返回 `disconnected:false` 和人工处理提示。客户端必须检查该字段，不能把 HTTP 200 或业务房间已结束当作推流已断开的证据。

轮换/结束先更新业务状态或密钥，断流失败不会回滚。轮换后更新 OBS 密钥；结束后新连接会被发布鉴权拒绝。独立断流接口不会结束房间或轮换密钥，因此原密钥仍可在 live 状态下重连；长期停播使用结束房间并停止 OBS。

## HTTPS 与 `/studio/` 代理

使用 `VITE_BASE_PATH=/studio/ npm run build`，运行环境设 `APP_BASE_PATH=/studio/`；`APP_ORIGIN` 只填 HTTPS origin。代理从 `/studio/` 转到应用根路径，前端资源、API、观看链接与 Cookie 保持一致。开发默认使用根路径，改变部署前缀必须重建。

HLS base 对应 `https://YOUR_SERVER/studio/media/live`，代理把 `/studio/media/` 转到引擎 HLS 根路径。MediaMTX 1.21 的 HLS 使用重定向和 session，需保留 Location 改写、Cookie、查询参数以及后续分片访问；仅请求一次 m3u8 返回 200 不足以证明播放成功。模板见 [Nginx 片段](../infra/nginx-studio.conf)。

同源 HTTPS 分发避免浏览器混合内容问题；如果独立跨域分发，应配置实际网页 origin 的 CORS。不要公开 Control API、发布回调或部署凭据。服务器实际安装、端口暴露、原站健康和回滚结果统一记录在[服务器测试说明](server-testing.md)。

远程公网、长播重连、浏览器暂停/隐藏、OBS 硬件、手机和微信内播放须按实际环境继续验收。微信支付、远程模型及 ASR 尚未接入，流媒体通过不代表这些能力已完成。

## 浏览器播放兼容性

播放器按需加载 hls.js，在 `Hls.isSupported()` 可用时优先使用 MSE；不支持时回退原生 HLS。部分 Chromium 版本会报告原生 HLS 支持，却无法持续播放某些 TS 直播；本次浏览器验收实际遇到并修复这一问题。参考 [hls.js 官方说明](https://github.com/video-dev/hls.js#using-hlsjs)。播放错误会立即撤销播放器的播放中标志，避免错误状态继续累计资格。
