// ctl-deals-mcp v0.1.0
// A股控制权变更案例数据库 MCP Server —— 无状态 Streamable HTTP，零依赖（仅 Node >= 18）。
// 数据源：lennonli/ctl-deals-kb（2022/2023/2024/2025/2026 五年度，共1223单，每单为JSON）。
// 设 KB_LOCAL_ROOT=本地数据仓克隆路径 时直读本地文件（免 GitHub raw、适合部署机），
// 否则读取 GitHub raw。
// 架构（鉴权/缓存/错误处理/JSON-RPC分发）仿照 legal-knowledge-mcp v0.4.0。

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const REPO = 'lennonli/ctl-deals-kb';
const BRANCH = 'main';

const YEARS = ['2022', '2023', '2024', '2025', '2026'];

// 六大条款字段：payment/conditions/breach 为协议通用字段，
// reps_warranties/transition/tax 为 v1.2 新增字段（值为字符串或null）。
const CLAUSES = ['payment', 'conditions', 'breach', 'reps_warranties', 'transition', 'tax'];

// 条款 → 引证字段映射：payment/conditions/breach 的引证在 evidence.<clause>；
// v1.2 三字段的引证为顶层 <clause>_evidence。
function clauseEvidence(deal, clause) {
  if (clause === 'reps_warranties' || clause === 'transition' || clause === 'tax') {
    return deal[`${clause}_evidence`] ?? null;
  }
  return deal.evidence?.[clause] ?? null;
}

/** 取条款原文：字符串直接返回；数组（conditions）用换行拼接；null/空 → null（跳过）。 */
function clauseText(deal, clause) {
  const v = deal[clause];
  if (Array.isArray(v)) {
    const s = v.filter((x) => typeof x === 'string' && x.trim()).join('\n');
    return s || null;
  }
  if (typeof v === 'string' && v.trim()) return v;
  return null;
}

const LOCAL_ROOT = process.env.KB_LOCAL_ROOT || '';
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

const INDEX_TTL_MS = 10 * 60 * 1000;
const DEAL_TTL_MS = 10 * 60 * 1000;
const DEAL_FETCH_CONCURRENCY = 8;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

// ── 数据读取 ────────────────────────────────────────────────

/**
 * 读取数据仓原始文件：设置 KB_LOCAL_ROOT 时直读本地克隆，否则走 GitHub raw。
 * 本地路径先 resolve 归一化，再校验目标必须落在 KB_LOCAL_ROOT 内部，防止路径穿越。
 */
async function fetchRaw(relPath) {
  if (LOCAL_ROOT) {
    const root = path.resolve(LOCAL_ROOT);
    const target = path.resolve(root, relPath);
    if (!target.startsWith(root + path.sep)) {
      throw new Error('Invalid path');
    }
    return readFile(target, 'utf8');
  }
  const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${relPath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GitHub raw fetch failed: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

const indexCache = new Map(); // year -> { data, at }
const dealCache = new Map(); // `${year}/${code}` -> { data, at }

async function loadIndex(year) {
  assertYear(year);
  const cached = indexCache.get(year);
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.data;
  const text = await fetchRaw(`${year}/index.json`);
  const data = JSON.parse(text);
  indexCache.set(year, { data, at: Date.now() });
  return data;
}

/** 证券代码白名单：6位数字，可选 _2 后缀（同代码多笔）。 */
function validateCode(code) {
  if (typeof code !== 'string' || !/^[0-9]{6}(_2)?$/.test(code)) {
    throw new Error(`Invalid code: ${JSON.stringify(code)}（应为6位证券代码，如 002576）`);
  }
  return code;
}

async function loadDeal(year, code) {
  assertYear(year);
  validateCode(code);
  const key = `${year}/${code}`;
  const cached = dealCache.get(key);
  if (cached && Date.now() - cached.at < DEAL_TTL_MS) return cached.data;
  const text = await fetchRaw(`${year}/${code}.json`);
  const data = JSON.parse(text);
  dealCache.set(key, { data, at: Date.now() });
  return data;
}

function assertYear(year) {
  if (!YEARS.includes(year)) {
    throw new Error(`Unsupported year: ${year}（可选：${YEARS.join(' / ')}）`);
  }
}

function assertClause(clause) {
  if (!CLAUSES.includes(clause)) {
    throw new Error(`Unsupported clause: ${clause}（可选：${CLAUSES.join(' / ')}）`);
  }
}

/** 有界并发地 map：同时最多 concurrency 个 worker，结果按原顺序返回。 */
async function mapWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function consume() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
  return results;
}

// ── 纯函数（可单元测试） ─────────────────────────────────────

/** index 条目过滤：query 匹配 code/name 子串（去空格），其余为精确匹配；null 值永不误杀。 */
function filterDeals(deals, { query, change_type, status, board }) {
  const q = (query ?? '').replace(/\s+/g, '');
  return deals.filter((d) => {
    if (q) {
      const hay = `${d.code ?? ''}${d.name ?? ''}`.replace(/\s+/g, '');
      if (!hay.includes(q)) return false;
    }
    if (change_type !== undefined && change_type !== null && d.change_type !== change_type) return false;
    if (status !== undefined && status !== null && d.status !== status) return false;
    if (board !== undefined && board !== null && d.board !== board) return false;
    return true;
  });
}

/** 空白容忍的子串匹配。 */
function textIncludes(text, keyword) {
  const t = text.replace(/\s+/g, '');
  const k = (keyword ?? '').replace(/\s+/g, '');
  return !k || t.includes(k);
}

/** 聚合统计：by_status / by_change_type / by_board；null 归入"未披露"。 */
function aggregateStats(allDeals) {
  const by_status = {};
  const by_change_type = {};
  const by_board = {};
  for (const d of allDeals) {
    const s = d.status ?? '未披露';
    const c = d.change_type ?? '未披露';
    const b = d.board ?? '未披露';
    by_status[s] = (by_status[s] ?? 0) + 1;
    by_change_type[c] = (by_change_type[c] ?? 0) + 1;
    by_board[b] = (by_board[b] ?? 0) + 1;
  }
  return { total: allDeals.length, by_status, by_change_type, by_board };
}

// ── 工具实现 ────────────────────────────────────────────────

async function toolListYears() {
  const years = [];
  for (const year of YEARS) {
    try {
      const index = await loadIndex(year);
      years.push({ year, count: index.count ?? index.deals?.length ?? 0, ready: true });
    } catch (error) {
      years.push({ year, count: 0, ready: false, note: `索引读取失败: ${error.message}` });
    }
  }
  return years;
}

async function toolSearchDeals({ query, year, change_type, status, board, limit = 20 }) {
  const years = year ? [year] : [...YEARS];
  if (year) assertYear(year);
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const out = [];
  for (const y of years) {
    let index;
    try {
      index = await loadIndex(y);
    } catch {
      continue; // 该年度索引不可用时跳过，不中断跨年检索
    }
    const hits = filterDeals(index.deals ?? [], { query, change_type, status, board });
    for (const h of hits) {
      out.push({ year: y, ...h });
      if (out.length >= lim) return out;
    }
  }
  return out;
}

async function toolGetDeal({ year, code }) {
  return loadDeal(year, code);
}

async function toolSearchClauses({ clause, keyword, year, limit = 20 }) {
  assertClause(clause);
  const years = year ? [year] : [...YEARS];
  if (year) assertYear(year);
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const out = [];
  for (const y of years) {
    let index;
    try {
      index = await loadIndex(y);
    } catch {
      continue; // 该年度索引不可用时跳过
    }
    const deals = await mapWithConcurrency(
      index.deals ?? [],
      async (entry) => {
        try {
          return await loadDeal(y, entry.file.replace(/\.json$/, ''));
        } catch {
          return null; // 单个案例读取失败不影响整体
        }
      },
      DEAL_FETCH_CONCURRENCY,
    );
    for (const deal of deals) {
      if (!deal) continue;
      const text = clauseText(deal, clause);
      if (!text) continue; // null 表示原文未披露，跳过
      if (!textIncludes(text, keyword)) continue;
      out.push({
        year: y,
        code: deal.code,
        name: deal.name,
        text,
        evidence: clauseEvidence(deal, clause),
      });
      if (out.length >= lim) return out;
    }
  }
  return out;
}

async function toolStats({ year } = {}) {
  const years = year ? [year] : [...YEARS];
  if (year) assertYear(year);
  const all = [];
  for (const y of years) {
    let index;
    try {
      index = await loadIndex(y);
    } catch {
      continue; // 该年度索引不可用时跳过
    }
    all.push(...(index.deals ?? []));
  }
  return { year: year ?? 'all', ...aggregateStats(all) };
}

// ── MCP 工具清单与 JSON-RPC 分发 ────────────────────────────

const yearSchema = {
  type: 'string', enum: YEARS,
  description: '年度：2022 / 2023 / 2024 / 2025 / 2026（不填则跨年度）',
};

const TOOLS = [
  {
    name: 'list_years',
    description: '列出数据库已接入的年度及案例数量。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => toolListYears(),
  },
  {
    name: 'search_deals',
    description: '按证券代码/证券简称子串检索案例，可按年度、变更方式(change_type)、交易状态(status)、板块(board)过滤。返回年度索引条目。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '代码或名称子串，如 002576 / 通达动力' },
        year: yearSchema,
        change_type: { type: 'string', description: '如 直接协议转让' },
        status: { type: 'string', description: '过户完成 / 进行中 / 已终止' },
        board: { type: 'string', description: '如 主板 / 创业板 / 科创板 / 北交所' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
    handler: (args) => toolSearchDeals(args),
  },
  {
    name: 'get_deal',
    description: '取单个案例完整 JSON（含 payment/conditions/breach/reps_warranties/transition/tax 六大条款原文及引证）。',
    inputSchema: {
      type: 'object',
      properties: { year: { ...yearSchema }, code: { type: 'string', description: '证券代码，如 002576' } },
      required: ['year', 'code'],
      additionalProperties: false,
    },
    handler: (args) => toolGetDeal(args),
  },
  {
    name: 'search_clauses',
    description: '按条款类型检索条款原文：起草/审查股份转让协议时查市场实践用。clause 取 payment(付款节奏)/conditions(先决条件)/breach(违约责任)/reps_warranties(陈述与保证)/transition(过渡期安排)/tax(税费承担)；keyword 在条款原文内做子串匹配；null 条款（原文未披露）自动跳过。返回条款原文 text 及引证 evidence{file,quote}。',
    inputSchema: {
      type: 'object',
      properties: {
        clause: { type: 'string', enum: CLAUSES, description: '条款类型' },
        keyword: { type: 'string', description: '条款原文内的关键词，如 违约金 / 分期' },
        year: yearSchema,
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['clause'],
      additionalProperties: false,
    },
    handler: (args) => toolSearchClauses(args),
  },
  {
    name: 'stats',
    description: '统计案例分布：总数及按交易状态 / 变更方式 / 板块的分布。',
    inputSchema: {
      type: 'object',
      properties: { year: yearSchema },
      additionalProperties: false,
    },
    handler: (args) => toolStats(args),
  },
];

const SERVER_INFO = { name: 'ctl-deals-mcp', version: '0.1.0' };

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function dispatchTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler(args ?? {});
}

/**
 * 处理单条 JSON-RPC 消息：initialize / ping / tools/list / tools/call，
 * 以及空实现的 resources/list 与 prompts/list。
 * 返回响应对象；通知（无 id）返回 null；非对象消息按 Invalid Request 处理而不是抛错。
 */
async function handleRpc(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = message;
  if (id === undefined || id === null) {
    return null; // notification
  }
  switch (method) {
    case 'initialize':
      return jsonRpcResult(id, {
        protocolVersion: params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return jsonRpcResult(id, {});
    case 'tools/list':
      return jsonRpcResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      try {
        const result = await dispatchTool(params?.name, params?.arguments);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return jsonRpcResult(id, { content: [{ type: 'text', text }] });
      } catch (error) {
        return jsonRpcResult(id, {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        });
      }
    }
    case 'resources/list':
      return jsonRpcResult(id, { resources: [] });
    case 'prompts/list':
      return jsonRpcResult(id, { prompts: [] });
    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ── HTTP 服务 ───────────────────────────────────────────────

// 恒定时间比较令牌：对两侧做 SHA-256 后再 timingSafeEqual，规避逐字节比较的时序侧信道
function tokenEquals(a, b) {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Session-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  let requestUrl;
  try {
    requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'Bad Request' }));
    return;
  }

  if (AUTH_TOKEN) {
    const authHeader = req.headers.authorization ?? '';
    const queryToken = requestUrl.searchParams.get('token') || requestUrl.searchParams.get('access_token') || '';
    const authorized = tokenEquals(authHeader, `Bearer ${AUTH_TOKEN}`) || tokenEquals(queryToken, AUTH_TOKEN);
    if (!authorized) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  if (req.method === 'GET') {
    if (requestUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ok: true, server: SERVER_INFO, years: YEARS }));
      return;
    }
    res.writeHead(405, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'Method Not Allowed（请用 POST /mcp）' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }
  if (requestUrl.pathname !== '/mcp' && requestUrl.pathname !== '/mcp/') {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not Found（MCP 端点为 POST /mcp）' }));
    return;
  }

  const contentLength = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Payload Too Large' }), () => req.destroy());
    return;
  }
  // 以 Buffer 收集再统一解码：逐 chunk 拼字符串会把跨 chunk 的多字节 UTF-8 字符截断成乱码
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    if (tooLarge) continue;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) {
    res.writeHead(413, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'Payload Too Large' }));
    return;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  const responses = (await Promise.all(messages.map((m) => handleRpc(m)))).filter(Boolean);
  const out = Array.isArray(payload) ? responses : responses[0] ?? null;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (out === null) res.end();
  else res.end(JSON.stringify(out));
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch {
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    } catch {
      // 连接已断开，无从应答
    }
  }
});

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`[ctl-deals-mcp] Invalid PORT: ${JSON.stringify(process.env.PORT ?? '')}`);
  process.exit(1);
}
server.on('error', (error) => {
  console.error(`[ctl-deals-mcp] server error: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[${new Date().toISOString()}] ctl-deals-mcp ${SERVER_INFO.version} listening on http://${HOST}:${PORT}/mcp`);
  console.log(`  years: ${YEARS.join(', ')}`);
  console.log(`  data: ${LOCAL_ROOT ? `local ${LOCAL_ROOT}` : `github ${REPO}@${BRANCH}`}`);
  console.log(`  auth: ${AUTH_TOKEN ? 'Bearer token enabled (also accepts ?token= / ?access_token=)' : 'WARNING: no AUTH_TOKEN set'}`);
});

// 导出内部实现供单元测试（node --test）使用；纯增量导出，不改变 `node server.mjs` 的行为
export {
  YEARS, CLAUSES, TOOLS, SERVER_INFO, server,
  clauseEvidence, clauseText, filterDeals, textIncludes, aggregateStats,
  validateCode, assertYear, assertClause, mapWithConcurrency,
  fetchRaw, loadIndex, loadDeal,
  toolListYears, toolSearchDeals, toolGetDeal, toolSearchClauses, toolStats,
  dispatchTool, handleRpc,
};
