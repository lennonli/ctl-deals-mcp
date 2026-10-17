// ctl-deals-mcp HTTP/RPC 层测试：鉴权、健康检查、JSON-RPC 分发、
// 以及两类曾导致进程崩溃的畸形报文（body 为 null、恶意 Host 头）的回归防护。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

process.env.PORT = '0';
process.env.AUTH_TOKEN = 'test-token';
process.env.KB_LOCAL_ROOT = fileURLToPath(new URL('./fixtures/kb', import.meta.url));

const { server, SERVER_INFO } = await import('../server.mjs');
if (!server.listening) await once(server, 'listening');
const BASE = `http://127.0.0.1:${server.address().port}`;
const AUTH = { Authorization: 'Bearer test-token' };
const JSONH = { ...AUTH, 'Content-Type': 'application/json' };

test.after(() => {
  server.closeAllConnections();
  server.close();
});

async function post(body, { headers = JSONH, path = '/mcp' } = {}) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

async function rpc(method, params, id = 1) {
  const { status, text } = await post(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return { status, body: JSON.parse(text) };
}

function rawRequest(headers, { path = '/health', method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('GET /health：带 token 200，无/错 token 401，支持 ?token=', async () => {
  const ok = await fetch(`${BASE}/health`, { headers: AUTH });
  assert.equal(ok.status, 200);
  const health = await ok.json();
  assert.equal(health.ok, true);
  assert.deepEqual(health.server, SERVER_INFO);
  assert.deepEqual(health.years, ['2022', '2023', '2024', '2025', '2026']);

  assert.equal((await fetch(`${BASE}/health`)).status, 401);
  assert.equal((await fetch(`${BASE}/health`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${BASE}/health?token=test-token`)).status, 200);
});

test('POST /mcp：initialize → tools/list → tools/call 全链路', async () => {
  const init = await rpc('initialize', {});
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, 'ctl-deals-mcp');

  const list = await rpc('tools/list', {});
  assert.equal(list.body.result.tools.length, 5);

  const call = await rpc('tools/call', { name: 'search_deals', arguments: { query: '通达' } });
  assert.equal(call.status, 200);
  const text = call.body.result.content[0].text;
  assert.ok(text.includes('002576'));
  assert.equal(call.body.result.isError, undefined);
});

test('tools/call 错误：未知工具 → isError', async () => {
  const r = await rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal(r.body.result.isError, true);
  assert.ok(r.body.result.content[0].text.includes('Unknown tool'));
});

test('鉴权：无 token 的 tools/call 返回 401', async () => {
  const { status } = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    { headers: { 'Content-Type': 'application/json' } });
  assert.equal(status, 401);
});

test('畸形报文回归：body 为 null 不崩溃', async () => {
  const { status, text } = await post('null');
  assert.equal(status, 200);
  assert.equal(JSON.parse(text).error.code, -32600);
  // 服务仍存活
  const ping = await rpc('ping', {});
  assert.deepEqual(ping.body.result, {});
});

test('畸形报文回归：恶意 Host 头返回 400 不崩溃', async () => {
  const r = await rawRequest({ Host: '::::' });
  assert.equal(r.status, 400);
  const ping = await rpc('ping', {});
  assert.deepEqual(ping.body.result, {});
});

test('批量 JSON-RPC：数组报文返回数组', async () => {
  const body = JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  const { status, text } = await post(body);
  assert.equal(status, 200);
  const arr = JSON.parse(text);
  assert.ok(Array.isArray(arr) && arr.length === 2);
});
