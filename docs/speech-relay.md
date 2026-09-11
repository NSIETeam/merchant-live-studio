# 功能卡：流媒体到实时语音检测中继

## 实现前填写

- **所属模块**：`platform/adapters` 负责调用外部或自托管 ASR；`composition` 提供由 MediaMTX 启动的独立中继进程；`live` 继续只接收既有最终转写 webhook，`agent` 继续只处理已保存的文字任务。三者不共享数据库、模型密钥或实现。
- **用户验收场景**：直播源上线后，MediaMTX 为该路径启动一个受限中继。中继从内部 HLS 读取音频，用 FFmpeg 切成短 WAV，逐段调用 OpenAI 音频转写兼容接口，并把非空最终文字送入 Live webhook。主播停止推流时 MediaMTX 向进程发送 SIGINT，中继停止读取并清理临时音频。ASR 或 Agent 故障不得停止视频直播。
- **接口变化**：新增中继运行入口及 `SPEECH_RELAY_*` / `SPEECH_ASR_*` 私有配置；下游继续调用 `POST /api/streams/speech/segments`，并通过同一私有鉴权调用 `POST /api/streams/speech/relay-status` 报告启动、正常流转、降级或停止。商家既有语音状态接口增加当前场次中继状态，浏览器据此显示真实故障阶段。提供 MediaMTX `runOnOnline` 配置片段，默认不启用。
- **数据变化**：新增 Live 所属的 `speech_relay_status` 当前状态表，只保存房间、当前开播时间、中继运行号、有限状态码和服务器接收时间；不保存模型地址、密钥、音频或上游错误。WAV 只写入进程专属的临时目录，单片大小和响应大小有上限，处理后立即删除，退出时清理目录。最终文字进入既有 `speech_segments` 和持久分析队列；音频片段不进入业务库或发布包。
- **权限**：仅接受 `MTX_PATH=live/<受限房间 ID>`；媒体源、ASR 和 webhook 地址只能来自服务器环境。远程 ASR 必须 HTTPS，HTTP 仅允许回环；内部 HLS 与 webhook 必须为回环 HTTP(S)。密钥只进请求头，不打印、不进入事件 ID或错误响应。
- **失败处理**：FFmpeg 启动失败、片段异常或 ASR/webhook 超时均以非零运行状态和无敏感信息的诊断结束或跳过当前片段；不会伪造转写。状态回送失败不阻断视频或音频处理，旧运行实例的迟到状态不能覆盖新实例。ASR 返回空文本时不写 webhook。相同片段的稳定事件号使 webhook 重试保持幂等；直播文字一旦被 Live 接收，后续 Agent 故障由既有持久队列恢复。

依据：[实时语音 webhook 与 Agent 隔离](live-speech-ingestion.md)、[流媒体边界](streaming.md)、[MediaMTX 配置参考](https://mediamtx.org/docs/references/configuration-file)、[faster-whisper-server 接口说明](https://github.com/lightforgemedia/faster-whisper-server/blob/master/README.md)。

## 随实现补充证据

- **流程结果**：新增独立 `speech-relay` 运行入口。它只接受 `live/<roomId>` 路径，从回环 HLS 读取音频，要求绝对 FFmpeg 路径，将音频切为 3–15 秒、16 kHz 单声道 PCM WAV；WAV 元数据重新计算实际时长，片段上限 2 MiB、积压上限 13 个。逐片调用可替换的 OpenAI 音频转写兼容接口，空转写不写入 Live；非空结果使用不含文本和密钥的 SHA-256 事件号投递现有最终分段 webhook。每次成功处理片段都会刷新中继状态，30 秒没有更新时商家端显示状态超时。
- **真实状态文案**：直播 Agent 卡区分等待中继、等待首个片段、链路正常、转写/回送异常、媒体读取异常、停止和状态超时；不再把 webhook 配置写成 ASR 已连接。只有实际收到当前场次最终分段后才展示接收时间与分析状态。
- **配置与部署**：新增 `infra/speech-relay.env.example`、`infra/mediamtx-speech-relay.yml.example`，媒体 systemd 模板读取独立私有环境文件。`runOnOnlineRestart` 默认关闭，避免 FFmpeg 或 ASR 配置错误造成无限重启；未合并配置片段时现有媒体行为不变。
- **专项验证**：7 项直接相关测试通过。覆盖路径/端点/密钥约束、multipart ASR 请求、真实 HTTP 两段转写回送、空结果不落库、上游私有错误不泄露、2 MiB 上限、稳定事件号、PCM WAV 时长、畸形 WAV、状态鉴权、状态过期和新旧运行实例竞争；运行时测试实际启动独立捕获子进程，验证正常启动/流转/停止以及 ASR 连续失败后的降级回送。
- **界面验证**：本地真实浏览器分别以 1280×900 和 390×844 打开直播现场的 Agent 建议页。等待中继和转写失败两种状态下，两个视口横向溢出均为 0，未发现绿色界面；失败时明确显示“转写或回送异常，视频直播继续运行”，未出现“已连接，等待本场语音”。该检查验证状态文案和响应式排版，不代表真实 ASR 或实体手机验收。
- **阶段状态**：本地软件边界完成；尚未安装或配置真实 faster-whisper/whisper.cpp 模型，也未用真实直播声音评估中文识别延迟、漏字和违规命中，因此不能宣称真实 ASR 验收通过。
