// ctl-deals-mcp 核心逻辑单元测试：过滤、条款抽取、统计、输入校验，
// 以及基于本地 fixture 的各 tool 实现。fixture 为最小化数据仓结构
//（test/fixtures/kb），通过 KB_LOCAL_ROOT 环境变量完全离线可测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

process.env.PORT = '0'; // 随机端口，避免与其他测试进程冲突
process.env.AUTH_TOKEN = 'test-token';
process.env.KB_LOCAL_ROOT = fileURLToPath(new URL('./fixtures/kb', import.meta.url));

const {
  YEARS, CLAUSES, TOOLS, SERVER_INFO, server,
  clauseEvidence, clauseText, filterDeals, textIncludes, aggregateStats,
  validateCode, assertYear, assertClause,
  toolListYears, toolSearchDeals, toolGetDeal, toolSearchClauses, toolStats,
  dispatchTool, handleRpc,
} = await import('../server.mjs');

// 导入 server.mjs 会顺带启动监听，测试结束后必须关闭，否则测试进程无法退出
test.after(() => {
  server.closeAllConnections();
  server.close();
});

test('filterDeals：query 匹配 code/name 子串', () => {
  const deals = [
    { code: '002576', name: '通达动力' },
    { code: '600001', name: '测试银行' },
  ];
  assert.equal(filterDeals(deals, { query: '002576' }).length, 1);
  assert.equal(filterDeals(deals, { query: '通达' })[0].code, '002576');
  assert.equal(filterDeals(deals, { query: '不存在' }).length, 0);
  assert.equal(filterDeals(deals, {}).length, 2);
});

test('filterDeals：change_type/status/board 精确过滤，null 不误杀', () => {
  const deals = [
    { code: 'a', change_type: '直接协议转让', status: '过户完成', board: null },
    { code: 'b', change_type: '表决权委托', status: '进行中', board: '主板' },
  ];
  assert.equal(filterDeals(deals, { change_type: '直接协议转让' }).length, 1);
  assert.equal(filterDeals(deals, { status: '进行中' })[0].code, 'b');
  assert.equal(filterDeals(deals, { board: '主板' })[0].code, 'b');
  // 不传过滤条件时 board=null 的条目保留
  assert.equal(filterDeals(deals, {}).length, 2);
});

test('clauseText：字符串/数组/null', () => {
  assert.equal(clauseText({ payment: '分三期' }, 'payment'), '分三期');
  assert.equal(clauseText({ conditions: ['a。', 'b。'] }, 'conditions'), 'a。\nb。');
  assert.equal(clauseText({ tax: null }, 'tax'), null);
  assert.equal(clauseText({ tax: '  ' }, 'tax'), null);
  assert.equal(clauseText({}, 'breach'), null);
});

test('clauseEvidence：三类映射', () => {
  const deal = {
    evidence: { payment: { file: 'a', quote: 'q1' }, breach: { file: 'a', quote: 'q2' } },
    tax_evidence: { file: 'b', quote: 'q3' },
  };
  assert.deepEqual(clauseEvidence(deal, 'payment'), { file: 'a', quote: 'q1' });
  assert.deepEqual(clauseEvidence(deal, 'tax'), { file: 'b', quote: 'q3' });
  assert.equal(clauseEvidence(deal, 'transition'), null);
});

test('textIncludes：空白容忍', () => {
  assert.ok(textIncludes('分 三期 支付', '分三期'));
  assert.ok(textIncludes('abc', ''));
  assert.ok(!textIncludes('abc', 'xyz'));
});

test('aggregateStats：null 归入未披露', () => {
  const s = aggregateStats([
    { status: '过户完成', change_type: '直接协议转让', board: null },
    { status: null, change_type: null, board: '主板' },
  ]);
  assert.equal(s.total, 2);
  assert.deepEqual(s.by_status, { '过户完成': 1, '未披露': 1 });
  assert.deepEqual(s.by_board, { '未披露': 1, '主板': 1 });
});

test('validateCode：白名单', () => {
  assert.equal(validateCode('002576'), '002576');
  assert.equal(validateCode('600001_2'), '600001_2');
  assert.throws(() => validateCode('../x'), /Invalid code/);
  assert.throws(() => validateCode('00257'), /Invalid code/);
  assert.throws(() => validateCode(null), /Invalid code/);
});

test('assertYear / assertClause：非法值抛错', () => {
  assert.throws(() => assertYear('2021'), /Unsupported year/);
  assert.throws(() => assertClause('foo'), /Unsupported clause/);
  assert.doesNotThrow(() => assertClause('tax'));
});

test('toolListYears：fixture 两年 ready，其余 not ready', async () => {
  const years = await toolListYears();
  assert.equal(years.length, 5);
  const y2022 = years.find((y) => y.year === '2022');
  assert.equal(y2022.count, 2);
  assert.equal(y2022.ready, true);
  const y2024 = years.find((y) => y.year === '2024');
  assert.equal(y2024.ready, false);
});

test('toolSearchDeals：跨年检索 + 过滤', async () => {
  const r1 = await toolSearchDeals({ query: '通达' });
  assert.equal(r1.length, 1);
  assert.equal(r1[0].code, '002576');
  assert.equal(r1[0].year, '2022');

  const r2 = await toolSearchDeals({ year: '2023', status: '过户完成' });
  assert.equal(r2.length, 1);
  assert.equal(r2[0].code, '000001');

  const r3 = await toolSearchDeals({ query: '银行', board: '主板' });
  assert.ok(r3.every((x) => x.board === '主板'));
});

test('toolGetDeal：完整 JSON', async () => {
  const d = await toolGetDeal({ year: '2022', code: '002576' });
  assert.equal(d.name, '通达动力');
  assert.ok(d.payment.includes('三期'));
  await assert.rejects(toolGetDeal({ year: '2021', code: '002576' }), /Unsupported year/);
  await assert.rejects(toolGetDeal({ year: '2022', code: '../../etc' }), /Invalid code/);
});

test('toolSearchClauses：null 条款跳过，keyword 过滤', async () => {
  // 002576 的 tax 为 null 应被跳过；000001 的 tax 命中
  const r1 = await toolSearchClauses({ clause: 'tax' });
  assert.equal(r1.length, 1);
  assert.equal(r1[0].code, '000001');
  assert.deepEqual(r1[0].evidence, { file: 'b.txt', quote: '各自承担己方税费' });

  const r2 = await toolSearchClauses({ clause: 'breach', keyword: '违约金' });
  assert.equal(r2.length, 2); // 两单的 breach 都含"违约金"

  const r3 = await toolSearchClauses({ clause: 'payment', keyword: '不存在的词' });
  assert.equal(r3.length, 0);

  // conditions 为数组，text 应为换行拼接
  const r4 = await toolSearchClauses({ clause: 'conditions', year: '2022' });
  assert.equal(r4.length, 1);
  assert.ok(r4[0].text.includes('\n'));
  assert.ok(Array.isArray(r4[0].evidence));
});

test('toolStats：聚合', async () => {
  const s = await toolStats({ year: '2022' });
  assert.equal(s.total, 2);
  assert.equal(s.by_status['过户完成'], 1);
  const all = await toolStats({});
  assert.equal(all.total, 3);
  assert.equal(all.year, 'all');
});

test('TOOLS 清单：5 个工具', () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_deal', 'list_years', 'search_clauses', 'search_deals', 'stats']);
  assert.equal(SERVER_INFO.name, 'ctl-deals-mcp');
});

test('handleRpc：initialize / tools/list / 未知方法', async () => {
  const init = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'ctl-deals-mcp');

  const list = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, 5);

  const bad = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'nope' });
  assert.equal(bad.error.code, -32601);

  const invalid = await handleRpc(null);
  assert.equal(invalid.error.code, -32600);

  const notif = await handleRpc({ method: 'ping' }); // 无 id → notification
  assert.equal(notif, null);
});

test('dispatchTool：未知工具抛错', async () => {
  await assert.rejects(dispatchTool('nope', {}), /Unknown tool/);
});
