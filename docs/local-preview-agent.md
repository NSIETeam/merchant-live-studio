# 本地预览的 Agent 服务

2026-09-11 已为本地预览接通独立 Agent：Live 位于 `http://127.0.0.1:18959/`，Agent 仅监听 `127.0.0.1:8788`，数据独立保存于本机工作目录中的 `work/layout-agent.sqlite`。Live 无需重启，使用现有开发配置连接 Agent。未更改服务器、未配置第三方模型或 API 密钥。

浏览器实测“独立服务已连接”、标准风格 V1 可读取；输入“这款产品无出其右。”后，快检提示优越性比较需要范围、条件和证据。点击试演后任务由排队进入完成，返回已有示例事实与出处，明确显示“本地规则生成，不是 LLM 生成”，并保留人工复核要求。390px 视口有结果时横向溢出 0。

当前使用 `grounded-rules`。确定性输出仅用于接口、任务、提示词工作台和事实引用流程调试，不证明风格质量或法律合规。真实模型按用户安排稍后配置；现有 `openai-compatible` 接口仍保留。

从项目目录重新启动该本地 Agent（先确认端口没有其他服务占用）：

```sh
AGENT_HOST=127.0.0.1 AGENT_PORT=8788 AGENT_DATABASE_PATH=../../work/layout-agent.sqlite AGENT_MODEL_PROVIDER=grounded-rules node dist/server/agent/index.js
```

该命令依赖已经完成的构建，使用仅适用于回环地址的开发鉴权配置。不是生产部署命令，也不会自动开机启动。不要用其默认开发配置暴露公网服务。
