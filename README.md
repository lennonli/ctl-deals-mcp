# ctl-deals-mcp

A股控制权变更案例数据库 MCP Server（无状态 Streamable HTTP）。零依赖（仅 Node ≥ 18，无需 `npm install`），
数据源为 [`lennonli/ctl-deals-kb`](https://github.com/lennonli/ctl-deals-kb)：
2022–2026 五年度共 1223 单，每单为 JSON，核心是股份转让协议六大条款的结构化抽取
（payment 付款节奏 / conditions 先决条件 / breach 违约责任 /
reps_warranties 陈述与保证 / transition 过渡期安排 / tax 税费承担，附原文引证）。

## 快速开始

```bash
npm start          # 等价于 node server.mjs
npm test           # 运行单元测试（node --test，零外部依赖，数据走本地 fixture）
```

## 工具（5个）

| 工具 | 说明 |
| ---- | ---- |
| `list_years` | 列出已接入年度及案例数量 |
| `search_deals` | 按代码/名称子串检索，可按年度、变更方式、交易状态、板块过滤 |
| `get_deal` | 取单个案例完整 JSON（含六大条款原文及引证） |
| `search_clauses` | **核心工具**：按条款类型检索条款原文，keyword 在原文内子串匹配；null 条款（原文未披露）自动跳过；返回原文 text 及引证 evidence{file,quote} |
| `stats` | 总数及按交易状态 / 变更方式 / 板块的分布 |

典型用法：起草/审查股份转让协议条款前，先调 `search_clauses`
（如 `{clause:"breach", keyword:"违约金"}`）看市场实践，再调 `get_deal` 看完整案例。

## 配置（环境变量）

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PORT` | 否 | `8788` | 监听端口 |
| `HOST` | 否 | `0.0.0.0` | 监听地址 |
| `AUTH_TOKEN` | 强烈建议 | 空（不鉴权） | 设置后所有请求（含 `/health`）都需携带令牌，见下方「鉴权」 |
| `KB_LOCAL_ROOT` | 否 | 空（读 GitHub raw） | 本地数据仓克隆根目录；设置后直读本地文件，免 GitHub 依赖，生产推荐 |

未设置 `KB_LOCAL_ROOT` 时从 `https://raw.githubusercontent.com/lennonli/ctl-deals-kb/main`
拉取数据；索引与案例缓存 10 分钟。

## 鉴权

设置 `AUTH_TOKEN` 后，二选一：

- 请求头 `Authorization: Bearer <token>`
- URL 查询参数 `?token=<token>`（或 `?access_token=`，兼容不支持自定义请求头的客户端）

## 部署（dmit，systemd + cloudflared）

```bash
PORT=8788
AUTH_TOKEN=<redacted>
# 可选：直读本地数据仓克隆（免 GitHub raw，推荐生产用）
KB_LOCAL_ROOT=/path/to/ctl-deals-kb
HOST=0.0.0.0   # 默认 0.0.0.0

npm start      # 或 node server.mjs
```

## 接入（以 Claude Code / MCP 客户端为例）

```json
{
  "mcpServers": {
    "ctl-deals": {
      "type": "http",
      "url": "https://your-host/mcp?token=<redacted>"
    }
  }
}
```

## 给别人用（公网接入）

作者自用的公网实例（dmit 常驻，systemd + cloudflared）：

- MCP 端点：`https://ctl-deals-mcp.licheng.uk/mcp`
- 鉴权二选一：请求头 `Authorization: Bearer <token>`，或 URL 直接拼
  `?token=<token>`（兼容不支持自定义请求头的客户端）
- token 找作者要；不要把 token 提交进任何公开仓库或聊天记录

⚠️ 手机 App 接入注意：Claude 手机 App 添加 MCP 时，**必须关掉 "Requires sign-in"**
（开着会走 OAuth 登录流程，报连不上）；URL 填
`https://ctl-deals-mcp.licheng.uk/mcp?token=<你的token>` 即可。

## 数据说明

- null 约定：条款值为 null 表示已核查原文但未披露，不是数据缺失；`search_clauses` 自动跳过。
- 引文 quote ≤60 字，均可在 evidence.file 标注的公告原文中找到。
- 约 15 单存在源文件错配，已在 notes 如实标注、字段填 null，未编造。
