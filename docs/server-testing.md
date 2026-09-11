# 服务器测试部署

## 隔离部署

采用独立目录 `/opt/merchant-live-studio`、系统用户 `live-studio`、持久化数据目录 `/var/lib/merchant-live-studio`。使用独立 Node.js 24 运行时，不替换服务器现有 Node；MediaMTX 1.21.0 独立运行。

示例端口为 API `127.0.0.1:18890`、HLS `127.0.0.1:18891`、Control API `127.0.0.1:18892`、RTMP `1935`。部署前必须确认端口空闲和内存/磁盘余量。两个 systemd 服务模板分别限制内存为 384 MB / 128 MB。

`infra/nginx-studio.conf` 是现有 HTTPS server 的 location 片段，不是可直接覆盖现有站点的完整配置。它把 `/studio/` 转发至应用，把 `/studio/media/` 转发至 HLS，并阻止公网访问引擎回调。使用前备份原配置，运行 `nginx -t` 后仅 reload，再复核原站首页和健康接口。回滚移除该 include 并 reload，然后停止本项目服务，不删除业务数据。

子路径部署需要：

```bash
VITE_BASE_PATH=/studio/ npm run build
```

服务器环境文件仅由 root/专用服务用户读取：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=18890
APP_ORIGIN=https://YOUR_SERVER
APP_BASE_PATH=/studio/
DATABASE_PATH=/var/lib/merchant-live-studio/studio.sqlite
DEMO_MODE=false
SESSION_SECRET=GENERATE_A_RANDOM_64_CHARACTER_SECRET
MERCHANT_CREDENTIALS={"owner":"GENERATE_AN_INDEPENDENT_RANDOM_SECRET"}
PAYMENT_PROVIDER=simulation
STREAM_PROVIDER=mediamtx
STREAM_RTMP_BASE=rtmp://YOUR_SERVER:1935/live
STREAM_HLS_BASE=https://YOUR_SERVER/studio/media/live
STREAM_AUTH_SECRET=GENERATE_ANOTHER_RANDOM_SHARED_SECRET
MEDIA_CONTROL_URL=http://127.0.0.1:18892
REQUIRE_PLAYBACK=true
TRUSTED_PROXY_IPS=127.0.0.1,::ffff:127.0.0.1
```

将同一个 `STREAM_AUTH_SECRET` 填入部署后的 MediaMTX HTTP auth 配置。Control API 只监听本机且不反代公网；示例将 `action: api` 排除 HTTP 鉴权，因此不能改为公网监听。跨容器部署时应使用专用 API 凭据和私有网络，不能照搬无鉴权回环配置。

## 真实链路验收

1. 验证生产禁止演示登录、商家需要凭证、Cookie Secure/HttpOnly/SameSite、子路径资源正确加载。
2. 建立测试房间并开放，用 FFmpeg 测试画面/声音或 OBS 发 RTMP。先验证错误 key 拒绝，再验证正确 key 上线。
3. 用 Control API 确认 `online=true` 和 RTMP source；通过公开 HTTPS HLS 下载清单与分片并实际解码视频及音频。MediaMTX 1.21 会使用 302 和 HLS session，必须保留跳转、Cookie 和查询参数。
4. 在浏览器点击播放，确认画面时间推进；暂停、隐藏和断线不累计资格。HTTP 测试里的 playing 标志不能代替浏览器播放器的验证。
5. 达到门槛后领取演示红包，重复点击不能重复扣池，后台模拟处理/账本/分析一致。它不产生真实资金转账。
6. 结束房间后确认实际推流连接断开，OBS 自动重连被拒；重新准备后轮换密钥，旧密钥无法重新发布。API 断流调用失败或引擎仍在线时必须提示手动停止。
7. 核对服务重启后的数据库记录、原站健康、进程资源和磁盘增量。移除临时测试凭据和生成的视频文件；保留标记清楚的演示业务记录用于回看。

不要把测试画面编码器安装进项目产品依赖。只使用合规来源的测试工具，记录实际版本；真实付款、OBS 硬件、移动端或微信内播放如果未测，应单独列为待验收。

## 防火墙与公网推流

只验证 1935 的 TCP 连接并不足以确认 RTMP 可用。本次验收曾被已有主机防火墙拦截；保留原有规则、备份持久化配置后，仅增加 TCP 1935 入站规则，才通过独立公网主机的 RTMP 发布、HTTPS HLS 解码和主动断流验证。按实际部署选择推流协议及端口，云安全组与主机防火墙都需要检查。不得为了测试清空防火墙或暴露回环 Control API。回滚时同时移除本项目的端口规则及持久化条目，保留原业务规则。


## 0.3：独立部署 Agent

使用 `infra/merchant-live-agent.service`，单独系统用户 `live-agent`、数据目录 `/var/lib/merchant-live-agent`、环境文件 `/etc/merchant-live-agent/agent.env`；示例端口 `127.0.0.1:18893`。Live Core 不读取 Agent 数据库或模型密钥。两个服务共享一个随机的服务认证密钥，放在各自仅服务账号可读的环境文件；不要使用本地已知开发 token。

Agent 环境示例：

```dotenv
NODE_ENV=production
AGENT_HOST=127.0.0.1
AGENT_PORT=18893
AGENT_DATABASE_PATH=/var/lib/merchant-live-agent/agent.sqlite
AGENT_SERVICE_TOKEN=REPLACE_WITH_AN_INDEPENDENT_RANDOM_SECRET
AGENT_CONCURRENCY=2
AGENT_QUEUE_LIMIT=100
AGENT_TENANT_QUEUE_LIMIT=20
AGENT_MODEL_PROVIDER=grounded-rules
```

Live Core 环境追加：

```dotenv
AGENT_SERVICE_URL=http://127.0.0.1:18893
AGENT_SERVICE_TOKEN=THE_SAME_RANDOM_SERVICE_SECRET
```

Agent没有公网反向代理或端口开放；浏览器仍从同源 `/api/merchant/agent/...` 网关访问。systemd模板限制 Agent 内存192MB和半个CPU配额；实际限制应结合机器负载调整。Live Core不使用Requires=Agent，因此Agent重启、停机或模型失败不会让直播服务随之停止。模型配置以后只加入Agent环境文件，详见 [Agent配置](agent.md)。

升级前备份Live数据库与配置，将新版本解压至独立release，安装依赖后切换current软链接并分别启动Agent与Live。失败时将current和Live环境文件恢复至旧版本并重启Live，保留新Agent数据库用于检查。不要覆盖已有流媒体或其他业务服务。
