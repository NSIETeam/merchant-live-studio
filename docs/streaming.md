# 直播流媒体适配与自托管

资料核对日期：2026-09-11。Web/API 使用 Node.js 24.10+；流媒体独立运行，通过 RTMP 接收 OBS 推流，通过 HLS 向网页分发。

## 当前实现与边界

`src/server/services/stream.ts` 提供统一配置及播放地址生成。商家创建直播间后可读取推流地址、独立推流密钥，观众页使用公开 HLS 地址播放；发布密钥不包含在公开房间接口中。

目前房间 `draft / live / ended` 状态由商家手动切换。点击“开始直播”不会启动摄像头、OBS 或流媒体容器，也不代表服务器已检测到视频流。基础分析统计的是网页会话与可见页面心跳，不能当作引擎连接数或真实视频观看证明。

默认 Compose 的两个流媒体引擎只绑定本机且没有启用推流鉴权，适用于本地试验。**仅在 `.env` 填写 `STREAM_AUTH_SECRET` 不会自动修改流媒体配置**；API 返回的 `authEnabled` 仅表示应用配置了共享密钥，不证明引擎已启用或验证回调。

本次未运行 Docker 容器，也未用 OBS/FFmpeg 完成真实推流到浏览器的端到端验收。下方步骤和配置依据官方资料与当前 API 编写，接入方仍需实际验证。

## 引擎与环境变量

| 项目               | MediaMTX                     | SRS                          |
| ------------------ | ---------------------------- | ---------------------------- |
| 固定镜像           | `bluenviron/mediamtx:1.21.0` | `ossrs/srs:6.0.191`          |
| `STREAM_PROVIDER`  | `mediamtx`                   | `srs`                        |
| `STREAM_RTMP_BASE` | `rtmp://localhost:1935/live` | `rtmp://localhost:1935/live` |
| `STREAM_HLS_BASE`  | `http://localhost:8888/live` | `http://localhost:8080/live` |
| 生成播放路径       | `/<roomId>/index.m3u8`       | `/<roomId>.m3u8`             |

SRS `6.0.191` 对应官方 `v6.0-r1` 发布；MediaMTX 官方安装页提供精确版本镜像用法。两个引擎使用同一 RTMP 主机端口，应任选一个启动。[MediaMTX 安装](https://mediamtx.org/docs/kickoff/install)、[SRS 发布](https://github.com/ossrs/srs/releases/tag/v6.0-r1)

示例 `.env`：

```dotenv
HOST=127.0.0.1
PORT=8787
APP_ORIGIN=http://127.0.0.1:5173
STREAM_PROVIDER=mediamtx
STREAM_RTMP_BASE=rtmp://localhost:1935/live
STREAM_HLS_BASE=http://localhost:8888/live
STREAM_AUTH_SECRET=
```

切换引擎时同时修改 provider 与 HLS base，然后重启 API；只改 provider 不会自动修改端口。正式域名使用 HTTPS HLS，并使 CORS 允许实际网页 origin；手机上的 `localhost` 指向手机本身，不能用于访问开发电脑。

## 本机联调步骤

1. 启动所选流媒体引擎，再按 README 启动 Web/API。
2. 在商家端创建房间并切换到 `live`；读取 `GET /api/merchant/rooms/:id/stream` 返回值。
3. OBS 选择自定义服务，Server 填接口的 `server`，Stream Key 填完整 `streamKey`：`<roomId>?token=<roomSecret>`。建议先使用 H.264 视频、AAC 音频、2 秒关键帧间隔。
4. OBS 开始推流后，打开 `/watch/<roomId>`。HLS 需要积累分片，首屏可能等待数秒；若自动播放被浏览器阻止，点击播放器播放按钮。
5. 检查音视频持续播放、停止推流后的断流提示，以及网页刷新后恢复。仅返回 m3u8 地址并不能证明视频可播放。

MediaMTX 的完整 HLS 地址形如 `http://localhost:8888/live/<roomId>/index.m3u8`；SRS 形如 `http://localhost:8080/live/<roomId>.m3u8`。[MediaMTX HLS](https://mediamtx.org/docs/read/hls)、[OBS 推流](https://mediamtx.org/docs/publish/obs-studio)、[SRS 入门](https://ossrs.io/lts/en-us/docs/v6/doc/getting-started)

当前播放器使用浏览器原生 HLS 或 hls.js。开发配置推荐 MediaMTX `hlsVariant: mpegts`；官方列其为兼容性优先选项，默认低延迟 HLS 在 Apple 设备上需要 HTTPS。[配置参考](https://mediamtx.org/docs/references/configuration-file)

## 启用 MediaMTX 发布鉴权

以下是需由部署者合并到引擎配置的示例，不是默认已生效配置。先生成随机共享密钥，在应用 `.env` 设置同一个 `STREAM_AUTH_SECRET`，再配置引擎：

```yaml
authMethod: http
authHTTPAddress: http://api:8787/api/streams/mediamtx/auth?secret=REPLACE_SHARED_SECRET
authHTTPExclude: []
rtmp: true
rtmpAddress: :1935
hls: true
hlsAddress: :8888
hlsVariant: mpegts
hlsAllowOrigins: ["http://localhost:5173"]
api: false
paths:
  all_others:
```

`api` 是示例私有容器网络中的应用服务名；当前开发 API 在宿主机运行，不能直接照抄此主机名。在 Docker Desktop 下可改用 `host.docker.internal`，但须验证容器到宿主 API 的实际可达性。若需要调整 `HOST`，应只开放受控私有网络并限制防火墙；不要为连通性盲目公开演示登录或鉴权服务。

API 要求 `POST /api/streams/mediamtx/auth?secret=<共享密钥>`，请求体使用引擎原生字段：

```json
{ "action": "publish", "path": "live/<roomId>", "query": "token=<roomSecret>" }
```

共享密钥有效、房间状态为 `live` 且 token 匹配时返回 204；发布被拒绝时返回非 2xx。`read / playback` 在共享密钥核验后放行，其他动作拒绝。当前实现定位于公开观看，没有付费观看或分组观看权限。[MediaMTX HTTP 鉴权](https://mediamtx.org/docs/features/authentication)

## 启用 SRS 发布鉴权

保留现有 HLS 配置，在目标 vhost 中加入以下配置，使用同一个应用共享密钥和可达的私有 API 地址：

```conf
vhost __defaultVhost__ {
    http_hooks {
        enabled on;
        on_publish http://api:8787/api/streams/srs/publish?secret=REPLACE_SHARED_SECRET;
    }
    hls {
        enabled on;
        hls_path ./objs/nginx/html;
        hls_fragment 2;
        hls_window 10;
    }
}
```

回调使用 `action: "on_publish"`、`app: "live"`、`stream: "<roomId>"`、`param: "?token=<roomSecret>"`。应用核验共享密钥、app、房间状态和房间 token，成功返回 `{"code":0}`。它不实现 `on_unpublish` 或 HLS 观看鉴权，也不从回调自动切换房间状态。[SRS HTTP 回调](https://ossrs.io/lts/en-us/docs/v6/doc/http-callback)

## 密钥、结束直播与后续验收

`POST /api/merchant/rooms/:id/stream/rotate` 只更新数据库内的房间密钥；应重新读取推流配置并更新 OBS。启用回调后，新连接必须使用新密钥；**密钥轮换或把房间改为 `ended` 不会自动断开已经建立的 OBS 推流连接**。当前未接引擎断流 API，停播时还须停止 OBS；后续要实现强制断流与连接状态同步。

公开观看 URL 不携带发布 token。房间 ID 是公开标识，不能当作推流密码。共享密钥与发布 token 会出现在请求 URL 中，应限制为可信网络并对日志脱敏；远程推流还需评估 RTMPS、VPN 或其他传输保护。

启用鉴权后至少实测：正确密钥允许发布，错误/空/旧密钥拒绝新连接，非 `live` 房间拒绝发布，鉴权服务不可达时拒绝发布，普通观众仍能观看。另需测试重连、长播、断网、移动端、HTTPS/CORS，以及真实流存在性与应用状态不一致时的体验。

自托管配置和提词器提示不构成直播资质、广告宣传或支付合规结论。正式运营需结合商品类别、主体及平台规则完成实际审核。
