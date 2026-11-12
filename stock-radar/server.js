'use strict';
/**
 * 短线雷达 · 复盘工作台 — 后端服务
 * 零依赖 Node.js 服务：通过 MCP 协议直连通达信数据服务 (txmcp.tdx.com.cn)
 * 提供：大盘复盘 / 复盘计划 / 短线策略选股 / 实时机会 / 个股详情
 * 未配置 API Key 时自动降级为快照模式 (data/snapshot.json)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const MCP_URL = 'https://txmcp.tdx.com.cn:3001/traemcp';
const MCP_TIMEOUT = 90000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json');

// ---------------- 基础工具 ----------------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function nowStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------- MCP 客户端 ----------------
let mcpSession = null;

function getSession(apiKey) {
  if (!mcpSession || mcpSession.apiKey !== apiKey) {
    mcpSession = { apiKey, sessionId: null, inited: false, reqId: 0 };
  }
  return mcpSession;
}

function parseRpcPayload(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  // SSE 格式
  const objs = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      try { objs.push(JSON.parse(line.slice(5).trim())); } catch { /* 忽略心跳等 */ }
    }
  }
  return objs.reverse().find(o => o && (o.result !== undefined || o.error)) || objs[0] || null;
}

async function mcpRpc(sess, method, params, isNotification = false) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${sess.apiKey}`,
    'tdx-api-key': sess.apiKey,
  };
  if (sess.sessionId) headers['mcp-session-id'] = sess.sessionId;
  const body = isNotification
    ? JSON.stringify({ jsonrpc: '2.0', method, params })
    : JSON.stringify({ jsonrpc: '2.0', id: ++sess.reqId, method, params });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MCP_TIMEOUT);
  let res;
  try {
    res = await fetch(MCP_URL, { method: 'POST', headers, body, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('MCP 请求超时');
    throw new Error(`MCP 网络错误: ${e.message}`);
  }
  clearTimeout(timer);
  const sid = res.headers.get('mcp-session-id');
  if (sid) sess.sessionId = sid;
  if (res.status === 202 || res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    if (res.status === 401) err.authFailed = true;
    throw err;
  }
  return parseRpcPayload(text);
}

async function callTool(apiKey, name, args) {
  const sess = getSession(apiKey);
  if (!sess.inited) {
    await mcpRpc(sess, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'tdx-review-radar', version: '1.0.0' },
    });
    sess.inited = true;
    try { await mcpRpc(sess, 'notifications/initialized', {}, true); } catch { /* 忽略 */ }
  }
  const resp = await mcpRpc(sess, 'tools/call', { name, arguments: args });
  if (!resp) throw new Error('MCP 空响应');
  if (resp.error) throw new Error(`MCP 错误: ${resp.error.message || JSON.stringify(resp.error)}`);
  if (resp.result && resp.result.isError) {
    const t = (resp.result.content || []).map(c => c.text || '').join(' ');
    throw new Error(`工具执行失败: ${t.slice(0, 200)}`);
  }
  const content = resp.result && resp.result.content;
  return Array.isArray(content) ? content.map(c => c.text || '').join('\n') : '';
}

// 从工具返回的 markdown 文本中提取 JSON 数据块
function extractJsonBlock(text) {
  if (!text) return null;
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* 继续兜底 */ } }
  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

async function callScreener(apiKey, message, pageSize = 20) {
  const text = await callTool(apiKey, 'tdx_screener', { message, pageSize: String(pageSize) });
  const json = extractJsonBlock(text);
  if (!json || !Array.isArray(json.data)) return { meta: null, rows: [], rawSummary: text.slice(0, 300) };
  return { meta: json.meta || null, rows: json.data };
}

async function callQuotes(apiKey, code, setcode) {
  const text = await callTool(apiKey, 'tdx_quotes', { code, setcode, hasCalcInfo: '1', hasCwInfo: '1' });
  return extractJsonBlock(text);
}

async function callKline(apiKey, code, setcode, wantNum = 120, period = '4') {
  const text = await callTool(apiKey, 'tdx_kline', { code, setcode, period, wantNum: String(wantNum) });
  return extractJsonBlock(text);
}

// ---------------- 内存缓存 ----------------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;
  const data = await fn();
  cache.set(key, { ts: Date.now(), data });
  return data;
}

// ---------------- 数据加工 ----------------
const num = v => {
  if (v === undefined || v === null || v === '' || v === '--') return null;
  const n = Number(String(v).replace(/[,%]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const INDEX_LIST = [
  { name: '上证指数', code: '000001', setcode: '1' },
  { name: '深证成指', code: '399001', setcode: '0' },
  { name: '创业板指', code: '399006', setcode: '0' },
  { name: '沪深300', code: '000300', setcode: '62' },
];

async function fetchIndex(apiKey, idx) {
  try {
    const [quote, kline] = await Promise.all([
      callQuotes(apiKey, idx.code, idx.setcode),
      callKline(apiKey, idx.code, idx.setcode, 3),
    ]);
    const out = { name: idx.name, code: idx.code, close: null, chg: null, prevClose: null, pro: {}, date: null };
    if (quote && quote.HQInfo) {
      out.close = num(quote.HQInfo.Close);
      out.date = String(quote.HQInfo.HQDate || '');
    }
    if (quote && quote.ProInfo) {
      out.pro = {
        chgPrev: num(quote.ProInfo['昨日涨幅']),
        chg5d: num(quote.ProInfo['5日涨幅']),
        chg20d: num(quote.ProInfo['20日涨幅']),
        ytd: num(quote.ProInfo['年初至今']),
      };
    }
    const rows = (kline && (kline.Rows || kline.rows)) || [];
    if (rows.length >= 2) {
      const last = rows[rows.length - 1];
      const prev = rows[rows.length - 2];
      const c = num(last.Close), p = num(prev.Close);
      if (c && p) { out.close = c; out.prevClose = p; out.chg = +((c / p - 1) * 100).toFixed(2); out.date = String(last.Data || last.Date || out.date); }
    }
    return out;
  } catch (e) {
    return { name: idx.name, code: idx.code, close: null, chg: null, error: e.message };
  }
}

// 涨停池整理
function normalizeLimitPool(rows) {
  return rows.map(r => ({
    code: r.sec_code, name: r.sec_name, market: r.market,
    price: num(r.now_price), chg: num(r.chg),
    date: r['发生日期'] || '',
    sealAmt: num(r['封单金额0#']),
    firstTime: r['首次涨停时间'] || '', lastTime: r['最近涨停时间'] || '',
    openTimes: num(r['涨停打开次数']),
    reason: r['涨停原因'] || '', days: num(r['连续涨停天数']) || 1,
    boards: r['几天几板'] || '', boardType: r['板型'] || '',
    amount: num(r['涨停成交额(万)']),
    sealRatio: num(r['封成比']),
  })).sort((a, b) => (b.days - a.days) || ((b.sealAmt || 0) - (a.sealAmt || 0)));
}

// 题材聚合：按涨停原因聚类
function aggregateThemes(pool) {
  const map = new Map();
  for (const s of pool) {
    const key = (s.reason || '其他').trim() || '其他';
    if (!map.has(key)) map.set(key, { name: key, count: 0, maxDays: 0, leader: null, members: [] });
    const t = map.get(key);
    t.count++;
    t.members.push(s.name);
    if (s.days > t.maxDays) { t.maxDays = s.days; t.leader = s.name; }
    else if (!t.leader) t.leader = s.name;
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 12);
}

// 情绪与复盘计划（完全由数据规则推导）
function buildReviewPlan({ indices, pool, downRows, themes }) {
  const up = pool.length;
  const down = downRows.length;
  const maxDays = pool.reduce((m, s) => Math.max(m, s.days), 0);
  const firstBoard = pool.filter(s => s.days === 1).length;
  const highBoard = pool.filter(s => s.days >= 3);
  const sealTotal = pool.reduce((s, x) => s + (x.sealAmt || 0), 0);
  const broken = pool.filter(s => (s.openTimes || 0) > 0).length;
  const effect = up + down > 0 ? up / (up + down) : 0.5;

  let stage, stageDesc;
  if (maxDays >= 6 && up > 60) { stage = '高潮期'; stageDesc = '连板高度与涨停家数均处高位，情绪亢奋，注意盛极而衰，谨防高位股集体退潮。'; }
  else if (maxDays >= 4) { stage = '发酵期'; stageDesc = '连板梯队成型，题材有持续性，可围绕主线核心股积极参与。'; }
  else if (up >= 40 && maxDays >= 2) { stage = '启动期'; stageDesc = '涨停家数回升、出现晋级梯队，情绪修复中，关注新题材首板与晋级方向。'; }
  else if (effect < 0.35 || down > up) { stage = '冰点期'; stageDesc = '亏钱效应明显，情绪处冰点附近。轻仓观望或仅试错低位首板，等待冰点转折信号。'; }
  else { stage = '退潮期'; stageDesc = '高度受压、梯队断层，旧周期退潮中。控制仓位，关注补涨与切换信号。'; }

  const mainIdx = indices[0] || {};
  const trend = mainIdx.chg == null ? '未知' : mainIdx.chg > 0.5 ? '强势上涨' : mainIdx.chg > -0.5 ? '窄幅震荡' : '明显调整';
  const mainTheme = themes[0];

  const plan = [
    { step: '大盘定调', detail: `${mainIdx.name || '上证指数'}收 ${mainIdx.close ?? '--'} 点（${mainIdx.chg == null ? '--' : (mainIdx.chg > 0 ? '+' : '') + mainIdx.chg + '%'}），当日定调：${trend}。${mainIdx.pro && mainIdx.pro.chg5d != null ? `近5日累计 ${mainIdx.pro.chg5d > 0 ? '+' : ''}${mainIdx.pro.chg5d}%。` : ''}` },
    { step: '情绪周期', detail: `涨停 ${up} 家 / 跌停 ${down} 家，赚钱效应 ${(effect * 100).toFixed(0)}%，最高连板 ${maxDays} 板，炸板回封 ${broken} 家。判定为【${stage}】：${stageDesc}` },
    { step: '主线题材', detail: mainTheme ? `涨停家数最多的题材为「${mainTheme.name}」（${mainTheme.count} 家，高度 ${mainTheme.maxDays} 板，代表 ${mainTheme.leader}）。` + (themes[1] ? `次主线：${themes.slice(1, 3).map(t => `「${t.name}」${t.count}家`).join('、')}。` : '') : '当日无明显聚集题材，多为独立个股行情。' },
    { step: '梯队结构', detail: `${maxDays} 板 ${highBoard.length} 家、首板 ${firstBoard} 家。` + (maxDays >= 3 && highBoard.length <= 2 ? '高度独苗，注意断层风险。' : maxDays <= 2 ? '无高度板，梯队未成型，以首板试错为主。' : '梯队完整，晋级路径清晰。') },
    { step: '资金信号', detail: `涨停封单合计约 ${(sealTotal / 1e8).toFixed(1)} 亿元。` + (sealTotal > 5e9 ? '封单资金积极，承接意愿强。' : '封单规模一般，追高需谨慎。') },
    { step: '明日策略', detail: stage === '发酵期' ? '围绕主线核心股做低吸或打板，优先有封单、有辨识度的前排标的；后排跟风谨慎。' : stage === '高潮期' ? '不追高位加速股，警惕集体核按钮；只做最强龙头或低位补涨切换。' : stage === '冰点期' ? '以观望为主，若出现放量反核/地天信号可小仓位试错新周期首板。' : '观察最高板晋级与首板数量变化，确认退潮结束（首板放量回升）后再加大仓位。' },
  ];
  return {
    stats: { up, down, maxDays, firstBoard, highBoardCount: highBoard.length, broken, sealTotal, effect: +(effect * 100).toFixed(1), stage },
    plan,
  };
}

// 策略定义（短线精选）
const STRATEGIES = [
  { id: 'limit_leader', name: '涨停龙头', desc: '当日涨停按连板高度与封单强度排序，做强势股基因复盘', query: '今日涨停', size: 30 },
  { id: 'capital_attack', name: '主力进攻', desc: '主力资金净流入居前，跟随聪明钱方向', query: '主力净流入', size: 20 },
  { id: 'tech_gold', name: '技术金叉', desc: 'MACD 金叉且放量，趋势启动信号', query: 'MACD金叉且放量', size: 20 },
  { id: 'pre_launch', name: '异动蓄势', desc: '量比放大且温和上涨，疑似启动前兆', query: '量比大于2且涨幅3%到6%', size: 20 },
];

function normalizeScreenerRows(rows) {
  return rows.map(r => {
    const out = { code: r.sec_code, name: r.sec_name, market: r.market, price: num(r.now_price), chg: num(r.chg), extra: {} };
    for (const [k, v] of Object.entries(r)) {
      if (!['POS', 'market', 'sec_code', 'sec_name', 'now_price', 'chg'].includes(k) && v !== '' && v != null) out.extra[k] = v;
    }
    return out;
  });
}

async function fetchReview(apiKey) {
  const [indices, lu, ld] = await Promise.all([
    Promise.all(INDEX_LIST.map(i => fetchIndex(apiKey, i))),
    callScreener(apiKey, '今日涨停', 150),
    callScreener(apiKey, '今日跌停', 60),
  ]);
  const pool = normalizeLimitPool(lu.rows);
  const downRows = ld.rows;
  const themes = aggregateThemes(pool);
  const { stats, plan } = buildReviewPlan({ indices, pool, downRows, themes });
  return {
    tradeDate: (pool[0] && pool[0].date) || (indices[0] && indices[0].date) || '',
    indices, themes, stats, plan,
    ladder: pool.filter(s => s.days >= 2),
    pool: pool.slice(0, 60),
    downList: normalizeScreenerRows(downRows).slice(0, 30),
  };
}

async function fetchPicks(apiKey) {
  const results = await Promise.all(STRATEGIES.map(async s => {
    try {
      const r = await callScreener(apiKey, s.query, s.size);
      return { id: s.id, name: s.name, desc: s.desc, query: s.query, total: r.meta ? r.meta.total : r.rows.length, stocks: normalizeScreenerRows(r.rows) };
    } catch (e) {
      return { id: s.id, name: s.name, desc: s.desc, query: s.query, total: 0, stocks: [], error: e.message };
    }
  }));
  return { strategies: results };
}

const REALTIME_CHANNELS = [
  { id: 'surge', name: '快速拉升', desc: '涨幅迅速拉大、短线异动', query: '涨幅大于5%', size: 20 },
  { id: 'limit_new', name: '涨停前线', desc: '最新涨停与封板情况', query: '今日涨停', size: 20 },
  { id: 'inflow', name: '资金抢筹', desc: '主力资金实时净流入', query: '主力净流入', size: 20 },
];

async function fetchRealtime(apiKey) {
  const channels = await Promise.all(REALTIME_CHANNELS.map(async c => {
    try {
      const r = await callScreener(apiKey, c.query, c.size);
      return { id: c.id, name: c.name, desc: c.desc, total: r.meta ? r.meta.total : r.rows.length, stocks: normalizeScreenerRows(r.rows) };
    } catch (e) {
      return { id: c.id, name: c.name, desc: c.desc, total: 0, stocks: [], error: e.message };
    }
  }));
  return { channels };
}

async function fetchStockDetail(apiKey, code, setcode) {
  const [quote, kline] = await Promise.all([
    callQuotes(apiKey, code, setcode || guessSetcode(code)),
    callKline(apiKey, code, setcode || guessSetcode(code), 120),
  ]);
  let capital = null;
  try {
    const text = await callTool(apiKey, 'tdx_api_data', { entry: 'TdxSharePCCW.tdxf10_gg_jyds', fixedTag: 'zjlx', code });
    capital = extractJsonBlock(text);
  } catch { /* 资金流可选 */ }
  return { quote, kline, capital };
}

function guessSetcode(code) {
  if (/^6/.test(code)) return '1';
  if (/^(00|30)/.test(code)) return '0';
  if (/^(43|83|87|92)/.test(code)) return '2';
  if (/^88/.test(code)) return '1';
  if (/^000300$/.test(code)) return '62';
  return '1';
}

// ---------------- 免费实时数据源（东方财富公开接口，无需 API Key） ----------------
const EM_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://quote.eastmoney.com/' };
const FS_ALL = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048'; // 沪深主板/创业板/科创板/北交所
const CLIST_FIELDS = 'f2,f3,f5,f6,f8,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f62,f184';

// 行情接口主机容灾池：东财按节点限流（单节点被重置时其他节点通常仍可用），qt 系接口可互换
const EM_HOST_POOL = [
  'push2.eastmoney.com',
  '1.push2.eastmoney.com',
  '7.push2.eastmoney.com',
  'push2his.eastmoney.com',
  'push2delay.eastmoney.com',
];
// 可重试的网络层错误码
const EM_TRANSIENT = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CLOSED', 'ECONNREFUSED']);

// 全局并发/频率节流：最多 3 并发，相邻请求间隔 ≥80ms，避免触发上游风控
const EM_MAX_CONCURRENT = 3;
const EM_MIN_INTERVAL = 80;
let emActive = 0;
const emWaiters = [];
let emLastEmit = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function emAcquireSlot() {
  if (emActive >= EM_MAX_CONCURRENT) await new Promise(res => emWaiters.push(res));
  emActive++;
  const gap = EM_MIN_INTERVAL - (Date.now() - emLastEmit);
  if (gap > 0) await sleep(gap);
  emLastEmit = Date.now();
}
function emReleaseSlot() {
  emActive--;
  const next = emWaiters.shift();
  if (next) next();
}

function emErrCode(e) {
  return (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.code) || '';
}
function emErrText(e) {
  const code = emErrCode(e);
  return code ? `${e.message}(${code})` : String(e && e.message || e);
}

async function emFetchOnce(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: EM_HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`行情接口 HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('行情接口超时');
    throw e;
  } finally { clearTimeout(timer); }
}

async function emGet(url) {
  const u = new URL(url);
  // /api/qt/* 接口可在 push2 / push2his / push2delay 间互换；其他（如 push2ex 涨停池）只能同主机重试
  const hostList = u.pathname.startsWith('/api/qt/')
    ? [u.hostname, ...EM_HOST_POOL.filter(h => h !== u.hostname)]
    : [u.hostname];
  const maxAttempts = u.pathname.startsWith('/api/qt/') ? 5 : 3;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const host = hostList[attempt % hostList.length];
    const target = new URL(url);
    target.hostname = host;
    try {
      await emAcquireSlot();
      try {
        return await emFetchOnce(target.toString());
      } finally { emReleaseSlot(); }
    } catch (e) {
      lastErr = e;
      const retryable = EM_TRANSIENT.has(emErrCode(e)) || /超时|HTTP 5\d\d/.test(e.message);
      if (!retryable) throw e;
      // 指数退避：200/400/700/1000ms，等待上游限流窗口释放
      await sleep(Math.min(1000, 200 * Math.pow(1.6, attempt)));
    }
  }
  throw new Error(`行情接口不可用（${emErrText(lastErr || new Error('未知错误'))}）`);
}

// 腾讯日 K 备用源（东财全部主机失败时兜底），输出与东财一致的 klines 结构
// 东财 klines 每行：日期,开盘,收盘,最高,最低,成交量,成交额
async function tencentKline(secid, lmt) {
  const [mkt, code] = String(secid).split('.');
  const prefix = mkt === '1' ? 'sh' : mkt === '0' ? 'sz' : 'bj';
  const sym = prefix + code;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,${lmt},qfq`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: EM_HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`备用行情接口 HTTP ${res.status}`);
    const json = await res.json();
    const node = json && json.data && json.data[sym];
    const rows = (node && (node.qfqday || node.day)) || [];
    if (!rows.length) throw new Error('备用行情接口无 K 线数据');
    return { data: { klines: rows.map(r => [r[0], r[1], r[2], r[3], r[4], r[5]].join(',')) } };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('备用行情接口超时');
    throw e;
  } finally { clearTimeout(timer); }
}

// 统一日 K 获取：短时缓存 + 东财容灾链 + 腾讯兜底
async function emKline(secid, lmt, ttl = 60e3) {
  return cached(`kline:${secid}:${lmt}`, ttl, async () => {
    try {
      return await emGet(emKlineUrl(secid, lmt));
    } catch (e) {
      return await tencentKline(secid, lmt).catch(() => { throw e; });
    }
  });
}

function todayDate() { return nowStr().slice(0, 10); }
function todayCompact() { return todayDate().replace(/-/g, ''); }
function fmtEMTime(v) {
  if (v == null) return '';
  const s = String(v).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}
function fmtYi(v) {
  if (v == null || !Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  if (abs >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (abs >= 1e4) return (v / 1e4).toFixed(0) + '万';
  return String(Math.round(v));
}
function emSecid(code) { return (/^6/.test(code) ? '1' : '0') + '.' + code; }
function emKlineUrl(secid, lmt) {
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=${lmt}`;
}

function mapClistRow(x) {
  const n2 = v => (v === '-' || v == null ? null : num(v));
  return {
    code: String(x.f12), market: x.f13, name: x.f14,
    price: n2(x.f2), chg: n2(x.f3), amount: n2(x.f6),
    turnover: n2(x.f8), volRatio: n2(x.f10), floatCap: n2(x.f21),
    mainInflow: n2(x.f62), mainRatio: n2(x.f184), mktcap: n2(x.f20),
  };
}

async function emClistPage({ fid, po = 1, pn = 1, fs = FS_ALL }) {
  const d = await emGet(`https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=${po}&np=1&fltt=2&invt=2&fid=${fid}&fs=${fs}&fields=${CLIST_FIELDS}`);
  return ((d.data && d.data.diff) || []).map(mapClistRow);
}

// 涨停池（含连板数/封单/行业板块，作为题材聚合依据）
async function fetchEMZTPool() {
  const d = await emGet(`https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fbt%3Aasc&date=${todayCompact()}`);
  const pool = (d.data && d.data.pool) || [];
  return pool.map(r => ({
    code: String(r.c), name: r.n, market: r.m,
    price: r.p != null ? r.p / 1000 : null, chg: num(r.zdp),
    date: todayDate(),
    sealAmt: num(r.fund),
    firstTime: fmtEMTime(r.fbt), lastTime: fmtEMTime(r.lbt),
    openTimes: num(r.zbc),
    reason: r.hybk || '',
    days: num(r.lbc) || 1,
    boards: r.zttj && typeof r.zttj === 'object' ? `${r.zttj.days}天${r.zttj.ct}板` : (r.zttj ? String(r.zttj) : ''),
    boardType: '',
    amount: r.amount != null ? r.amount / 1e4 : null,
    sealRatio: null,
    floatCap: num(r.ltsz),
  })).sort((a, b) => (b.days - a.days) || ((b.sealAmt || 0) - (a.sealAmt || 0)));
}

async function fetchEMDTPool() {
  const d = await emGet(`https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=100&sort=fund%3Aasc&date=${todayCompact()}`);
  const pool = (d.data && d.data.pool) || [];
  return pool.map(r => ({ sec_code: String(r.c), sec_name: r.n, market: r.m, now_price: r.p != null ? r.p / 1000 : null, chg: num(r.zdp) }));
}

// 指数实时 + 区间涨幅（由日K计算 5日/20日/年初至今）
const EM_INDEX = [
  { name: '上证指数', code: '000001', secid: '1.000001' },
  { name: '深证成指', code: '399001', secid: '0.399001' },
  { name: '创业板指', code: '399006', secid: '0.399006' },
  { name: '沪深300', code: '000300', secid: '1.000300' },
];

async function fetchAllIndexPro() {
  const out = {};
  await Promise.all(EM_INDEX.map(async ix => {
    try {
      const d = await emKline(ix.secid, 260, 600e3);
      const ks = (d.data && d.data.klines) || [];
      const rows = ks.map(s => { const p = s.split(','); return { date: p[0], close: +p[2] }; });
      const n = rows.length;
      if (!n) return;
      const last = rows[n - 1];
      const pro = {};
      if (n > 6) pro.chg5d = +((last.close / rows[n - 6].close - 1) * 100).toFixed(2);
      if (n > 21) pro.chg20d = +((last.close / rows[n - 21].close - 1) * 100).toFixed(2);
      const year = last.date.slice(0, 4);
      for (let i = n - 1; i >= 0; i--) {
        if (rows[i].date.slice(0, 4) !== year) { pro.ytd = +((last.close / rows[i].close - 1) * 100).toFixed(2); break; }
      }
      out[ix.secid] = pro;
    } catch { /* 区间涨幅可选 */ }
  }));
  return out;
}

async function fetchEMIndices() {
  const d = await emGet('https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f4,f6,f12,f14&secids=1.000001,0.399001,0.399006,1.000300');
  const diff = (d.data && d.data.diff) || [];
  const pros = await cached('free_idxpro', 600e3, fetchAllIndexPro);
  return EM_INDEX.map(ix => {
    const q = diff.find(x => String(x.f12) === ix.code) || {};
    return { name: ix.name, code: ix.code, close: num(q.f2), chg: num(q.f3), prevClose: null, pro: pros[ix.secid] || {}, date: todayDate() };
  });
}

// MACD 金叉且放量（候选：成交额前 60，逐只取日K计算）
function emaSeries(vals, n) {
  const k = 2 / (n + 1);
  const out = [vals[0]];
  for (let i = 1; i < vals.length; i++) out.push(vals[i] * k + out[i - 1] * (1 - k));
  return out;
}
function macdSeries(closes) {
  const dif = emaSeries(closes, 12).map((v, i) => v - emaSeries(closes, 26)[i]);
  const dea = emaSeries(dif, 9);
  return { dif, dea };
}

async function fetchMacdGolden() {
  const cand = await cached('free_clist_amount', 30e3, () => emClistPage({ fid: 'f6', po: 1, pn: 1 }));
  const top = cand.filter(s => s.price != null && s.chg != null).slice(0, 40);
  const hits = [];
  for (let i = 0; i < top.length && hits.length < 20; i += 4) {
    const batch = top.slice(i, i + 4);
    const results = await Promise.all(batch.map(async s => {
      try {
        const d = await emKline(emSecid(s.code), 60);
        const ks = (d.data && d.data.klines) || [];
        if (ks.length < 35) return null;
        const parts = ks.map(x => x.split(','));
        const closes = parts.map(p => +p[2]);
        const vols = parts.map(p => +p[5]);
        const { dif, dea } = macdSeries(closes);
        const n = closes.length;
        let crossAt = -1;
        for (let j = n - 2; j < n; j++) {
          if (j >= 1 && dif[j] > dea[j] && dif[j - 1] <= dea[j - 1]) { crossAt = j; break; }
        }
        if (crossAt < 0 || vols[n - 1] <= vols[n - 2]) return null;
        return { ...s, signalDate: parts[crossAt][0] };
      } catch { return null; }
    }));
    for (const r of results) if (r) hits.push(r);
    // 批次间轻微间隔，降低触发上游限流的概率
    if (i + 4 < top.length && hits.length < 20) await new Promise(r => setTimeout(r, 60));
  }
  return hits.slice(0, 20);
}

// 量比>=2 且涨幅 3%~6%（按量比降序翻页直到量比不足）
async function fetchPrelaunch() {
  const out = [];
  for (let pn = 1; pn <= 4; pn++) {
    const rows = await emClistPage({ fid: 'f10', po: 1, pn });
    let stop = false;
    for (const r of rows) {
      if (r.volRatio == null || r.volRatio < 2) { stop = true; break; }
      if (r.price != null && r.chg != null && r.chg >= 3 && r.chg <= 6) out.push(r);
    }
    if (stop || rows.length < 100) break;
  }
  return out;
}

// 主力净流入排行（取前 3 页共 300 只，供板块/市值筛选）
async function fetchInflow() {
  const out = [];
  for (let pn = 1; pn <= 3; pn++) {
    const rows = await emClistPage({ fid: 'f62', po: 1, pn });
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

// 涨幅>=5% 的异动股（按涨幅降序翻页）
async function fetchSurge() {
  const out = [];
  for (let pn = 1; pn <= 3; pn++) {
    const rows = await emClistPage({ fid: 'f3', po: 1, pn });
    let stop = false;
    for (const r of rows) {
      if (r.chg == null || r.chg < 5) { stop = true; break; }
      if (r.price != null) out.push(r);
    }
    if (stop || rows.length < 100) break;
  }
  return out;
}

function stockFromClistRow(s, extra) {
  return { code: s.code, name: s.name, market: s.market, price: s.price, chg: s.chg, floatCap: s.floatCap, extra };
}

async function fetchFreeReview() {
  const [indices, zt, dt] = await Promise.all([
    cached('free_idx', 30e3, fetchEMIndices).catch(() => []),
    cached('free_zt', 60e3, fetchEMZTPool).catch(() => []),
    cached('free_dt', 60e3, fetchEMDTPool).catch(() => []),
  ]);
  if (!indices.length && !zt.length && !dt.length) {
    throw new Error('行情数据源暂时不可用，请稍后重试');
  }
  const themes = aggregateThemes(zt);
  const { stats, plan } = buildReviewPlan({ indices, pool: zt, downRows: dt, themes });
  return {
    tradeDate: todayDate(),
    indices, themes, stats, plan,
    ladder: zt.filter(s => s.days >= 2),
    pool: zt.slice(0, 60),
    downList: normalizeScreenerRows(dt).slice(0, 30),
  };
}

async function fetchFreePicks() {
  // 各策略独立容错：单一数据源抖动不影响整页（全空才向上抛，触发快照兜底）
  const [zt, inflow, macd, prelaunch] = await Promise.all([
    cached('free_zt', 60e3, fetchEMZTPool).catch(() => []),
    cached('free_inflow', 60e3, fetchInflow).catch(() => []),
    cached('free_macd', 120e3, fetchMacdGolden).catch(() => []),
    cached('free_prelaunch', 60e3, fetchPrelaunch).catch(() => []),
  ]);
  if (!zt.length && !inflow.length && !macd.length && !prelaunch.length) {
    throw new Error('行情数据源暂时不可用，请稍后重试');
  }
  return {
    strategies: [
      { id: 'limit_leader', name: '涨停龙头', desc: STRATEGIES[0].desc, query: STRATEGIES[0].query, total: zt.length, stocks: zt.map(s => ({ code: s.code, name: s.name, market: s.market, price: s.price, chg: s.chg, floatCap: s.floatCap, extra: { '连板': `${s.days}板`, '封单': fmtYi(s.sealAmt), '行业': s.reason || '-' } })) },
      { id: 'capital_attack', name: '主力进攻', desc: STRATEGIES[1].desc, query: STRATEGIES[1].query, total: inflow.length, stocks: inflow.filter(s => s.price != null && (s.mainInflow || 0) > 0).map(s => stockFromClistRow(s, { '主力净流入': fmtYi(s.mainInflow), '净占比': s.mainRatio != null ? s.mainRatio.toFixed(1) + '%' : '-', '换手率': s.turnover != null ? s.turnover.toFixed(1) + '%' : '-' })) },
      { id: 'tech_gold', name: '技术金叉', desc: STRATEGIES[2].desc, query: STRATEGIES[2].query, total: macd.length, stocks: macd.map(s => stockFromClistRow(s, { '信号日': s.signalDate, '主力净流入': fmtYi(s.mainInflow), '换手率': s.turnover != null ? s.turnover.toFixed(1) + '%' : '-' })) },
      { id: 'pre_launch', name: '异动蓄势', desc: STRATEGIES[3].desc, query: STRATEGIES[3].query, total: prelaunch.length, stocks: prelaunch.map(s => stockFromClistRow(s, { '量比': s.volRatio != null ? s.volRatio.toFixed(2) : '-', '换手率': s.turnover != null ? s.turnover.toFixed(1) + '%' : '-', '主力净流入': fmtYi(s.mainInflow) })) },
    ],
  };
}

async function fetchFreeRealtime() {
  const [surgeRows, zt, inflow] = await Promise.all([
    cached('free_surge', 30e3, fetchSurge).catch(() => []),
    cached('free_zt', 60e3, fetchEMZTPool).catch(() => []),
    cached('free_inflow', 60e3, fetchInflow).catch(() => []),
  ]);
  if (!surgeRows.length && !zt.length && !inflow.length) {
    throw new Error('行情数据源暂时不可用，请稍后重试');
  }
  const ztSorted = [...zt].sort((a, b) => (b.lastTime || '').localeCompare(a.lastTime || ''));
  return {
    channels: [
      { id: 'surge', name: '快速拉升', desc: REALTIME_CHANNELS[0].desc, total: surgeRows.length, stocks: surgeRows.map(s => stockFromClistRow(s, { '量比': s.volRatio != null ? s.volRatio.toFixed(2) : '-', '换手率': s.turnover != null ? s.turnover.toFixed(1) + '%' : '-', '主力净流入': fmtYi(s.mainInflow) })) },
      { id: 'limit_new', name: '涨停前线', desc: REALTIME_CHANNELS[1].desc, total: zt.length, stocks: ztSorted.map(s => ({ code: s.code, name: s.name, market: s.market, price: s.price, chg: s.chg, floatCap: s.floatCap, extra: { '连板': `${s.days}板`, '封单': fmtYi(s.sealAmt), '封板时间': s.lastTime || '-' } })) },
      { id: 'inflow', name: '资金抢筹', desc: REALTIME_CHANNELS[2].desc, total: inflow.length, stocks: inflow.filter(s => s.price != null && (s.mainInflow || 0) > 0).map(s => stockFromClistRow(s, { '主力净流入': fmtYi(s.mainInflow), '净占比': s.mainRatio != null ? s.mainRatio.toFixed(1) + '%' : '-', '换手率': s.turnover != null ? s.turnover.toFixed(1) + '%' : '-' })) },
    ],
  };
}

// 最近一个历史交易日的涨停池（自动回溯，跳过周末/节假日）
async function fetchEMYesterdayZT() {
  for (let back = 1; back <= 8; back++) {
    const dt = new Date(Date.now() - back * 86400e3);
    const ds = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
    const d = await emGet(`https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=320&sort=fbt%3Aasc&date=${ds}`);
    const pool = (d.data && d.data.pool) || [];
    if (!pool.length) continue;
    return {
      date: `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`,
      stocks: pool.map(r => ({
        code: String(r.c), name: r.n, market: r.m,
        days: num(r.lbc) || 1,
        boards: r.zttj && typeof r.zttj === 'object' ? `${r.zttj.days}天${r.zttj.ct}板` : '',
        reason: r.hybk || '',
        floatCap: num(r.ltsz),
      })),
    };
  }
  return { date: '', stocks: [] };
}

// 批量实时报价（东财 ulist，按 secid 列表）
async function emUlistQuotes(secids) {
  const out = {};
  for (let i = 0; i < secids.length; i += 50) {
    const chunk = secids.slice(i, i + 50);
    const d = await emGet(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f8,f12,f13,f14,f18,f21,f62&secids=${chunk.join(',')}`);
    for (const x of ((d.data && d.data.diff) || [])) {
      const n2 = v => (v === '-' || v == null ? null : num(v));
      // 盘前/停牌无最新价时用昨收兜底，涨跌幅视为 0
      const price = n2(x.f2) ?? n2(x.f18);
      out[String(x.f12)] = { price, chg: n2(x.f3) ?? (price != null ? 0 : null), turnover: n2(x.f8), floatCap: n2(x.f21), mainInflow: n2(x.f62), market: x.f13, name: x.f14 };
    }
  }
  return out;
}

function todayDash() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 技术分析：5 日线乖离 + 今日量能（基于日 K，剔除当日未完成 K 线算均线）
async function techFromKline(code, market, price) {
  const d = await emKline(emSecid(code), 30, 120e3);
  const ks = ((d.data) && d.data.klines) || [];
  const rows = ks.map(s => {
    const p = s.split(',');
    return { date: p[0], close: num(p[2]), volume: num(p[5]) };
  });
  const today = todayDash();
  const bars = rows.filter(r => r.date !== today);
  if (bars.length < 6 || price == null) return { bias5: null, text: 'K线数据不足' };
  const closes = bars.map(r => r.close);
  const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const bias5 = (price - ma5) / ma5 * 100;
  const vols = bars.map(r => r.volume);
  const avgVol = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const todayBar = rows.find(r => r.date === today);
  let volDesc = '';
  if (todayBar && avgVol > 0) {
    const t = todayBar.volume / avgVol;
    volDesc = t >= 1.5 ? '放量' : t >= 0.7 ? '平量' : '缩量';
  }
  const pos = bias5 >= 0 ? `5日线上方${bias5.toFixed(1)}%` : `跌破5日线${Math.abs(bias5).toFixed(1)}%`;
  return { bias5, text: volDesc ? `${pos} · ${volDesc}` : pos };
}

// 连板低吸：上一交易日 2 连板及以上、今日回调，附龙头定位 / 题材预期 / 技术分析 / 推荐评级
async function fetchLbDip() {
  const yzt = await cached('free_yzt', 300e3, fetchEMYesterdayZT);
  const cand = yzt.stocks.filter(s => s.days >= 2);
  // 昨日全池今日报价（用于题材延续度判断）
  const allQuotes = yzt.stocks.length ? await emUlistQuotes(yzt.stocks.map(s => emSecid(s.code))) : {};
  // 题材聚合：昨日涨停家数 + 今日延续（涨幅≥5% 家数、平均涨幅）
  const themes = {};
  for (const s of yzt.stocks) {
    const key = s.reason || '未知题材';
    const t = (themes[key] = themes[key] || { ztCount: 0, chgs: [], strong: 0 });
    t.ztCount++;
    const q = allQuotes[s.code];
    if (q && q.chg != null) {
      t.chgs.push(q.chg);
      if (q.chg >= 5) t.strong++;
    }
  }
  for (const t of Object.values(themes)) {
    t.avgChg = t.chgs.length ? t.chgs.reduce((a, b) => a + b, 0) / t.chgs.length : null;
    t.expect = (t.strong >= 2 || (t.ztCount >= 6 && (t.avgChg || 0) > 1)) ? '强'
      : ((t.avgChg != null && t.avgChg < -2 && t.strong === 0) ? '退潮' : '分歧');
  }
  const maxDays = Math.max(0, ...yzt.stocks.map(s => s.days));
  const themeMax = {};
  for (const s of yzt.stocks) {
    const k = s.reason || '未知题材';
    themeMax[k] = Math.max(themeMax[k] || 0, s.days);
  }

  const picked = [];
  for (const s of cand) {
    const q = allQuotes[s.code];
    if (!q || q.price == null || q.chg == null) continue;
    if (q.chg > 2 || q.chg <= -9) continue;
    picked.push({ s, q });
  }
  // 逐只取日 K 做技术分析（并发）
  const techs = await Promise.all(picked.map(p => techFromKline(p.s.code, p.s.market, p.q.price).catch(() => ({ bias5: null, text: '--' }))));

  const rows = picked.map((p, i) => {
    const { s, q } = p;
    const themeKey = s.reason || '未知题材';
    const th = themes[themeKey] || { ztCount: 0, expect: '分歧', avgChg: null, strong: 0 };
    const role = s.days === maxDays ? '总龙头'
      : (s.days >= (themeMax[themeKey] || 0) && th.ztCount >= 2 ? '题材核心' : '跟风');
    const tech = techs[i];
    // 综合评分
    let score = 0; const why = [];
    if (role === '总龙头') { score += 3; why.push('最高空间板，辨识度龙头'); }
    else if (role === '题材核心') { score += 2; why.push('题材内最高连板核心'); }
    if (th.expect === '强') { score += 2; why.push(`题材${th.ztCount}家涨停且今日有延续`); }
    else if (th.expect === '退潮') { score -= 2; why.push('题材整体退潮'); }
    else why.push(`题材${th.ztCount}家涨停，今日分歧`);
    if (tech.bias5 != null) {
      if (tech.bias5 >= -2 && tech.bias5 <= 6) { score += 1; why.push('回调未远离5日线'); }
      if (tech.bias5 < -5) { score -= 1; why.push('5日线乖离偏大'); }
    }
    if (q.mainInflow != null && q.mainInflow > 0) { score += 1; why.push('今日主力净流入'); }
    if (q.chg <= -7) { score -= 1; why.push('跌幅过大防恐慌盘'); }
    const rating = score >= 5 ? '★★★' : score >= 2 ? '★★' : '★';
    const advice = rating === '★★★' ? '重点关注，分批低吸设止损' : rating === '★★' ? '观察为主，等企稳信号' : '谨慎参与';
    return {
      code: s.code, name: s.name, market: s.market,
      price: q.price, chg: q.chg,
      days: s.days, boards: s.boards,
      floatCap: q.floatCap != null ? q.floatCap : s.floatCap,
      turnover: q.turnover, mainInflow: q.mainInflow, reason: s.reason,
      role, themeName: themeKey, themeZt: th.ztCount, themeAvgChg: th.avgChg, expect: th.expect,
      tech: tech.text, bias5: tech.bias5,
      score, rating, advice, why: why.join('；'),
    };
  });
  rows.sort((a, b) => (b.score - a.score) || (b.days - a.days));
  return { stocks: rows, total: rows.length, note: `基准 ${yzt.date} 涨停 ${yzt.stocks.length} 家，其中连板 ${cand.length} 家` };
}

// 历史炸板池 / 跌停池（指定日期，用于反包板判定；接口必须带 sort 参数）
async function fetchEMHistPool(api, dateStr) {
  const sort = api === 'getTopicDTPool' ? 'fund%3Aasc' : 'fbt%3Aasc';
  const d = await emGet(`https://push2ex.eastmoney.com/${api}?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=320&sort=${sort}&date=${dateStr.replace(/-/g, '')}`);
  const pool = (d.data && d.data.pool) || [];
  return pool.map(r => ({ code: String(r.c), name: r.n }));
}

// 明日接力：连板接力（今日 2 连板+）+ 反包板（昨日炸板/跌停、今日涨停）
async function fetchRelay() {
  const zt = await cached('free_zt', 30e3, fetchEMZTPool);
  const yzt = await cached('free_yzt', 300e3, fetchEMYesterdayZT);
  const histDate = yzt.date;
  const [zb, dt] = histDate ? await Promise.all([
    fetchEMHistPool('getTopicZBPool', histDate).catch(() => []),
    fetchEMHistPool('getTopicDTPool', histDate).catch(() => []),
  ]) : [[], []];
  const zbSet = new Set(zb.map(s => s.code));
  const dtSet = new Set(dt.map(s => s.code));
  // 题材热度：今日各板块涨停家数
  const themeCount = {};
  for (const s of zt) {
    const k = s.reason || '未知题材';
    themeCount[k] = (themeCount[k] || 0) + 1;
  }
  const sealScore = (s, why) => {
    let sc = 0;
    if (s.firstTime && s.firstTime <= '09:45:00') { sc += 2; why.push('早盘封板'); }
    else if (s.firstTime && s.firstTime <= '10:30:00') { sc += 1; why.push('上午封板'); }
    if (s.openTimes === 0) { sc += 1; why.push('全天未开板'); }
    else if (s.openTimes >= 3) { sc -= 1; why.push(`开板${s.openTimes}次`); }
    if (s.sealAmt != null && s.floatCap && s.sealAmt / s.floatCap >= 0.05) { sc += 1; why.push('封单占流通盘大'); }
    return sc;
  };
  const rate = score => score >= 6 ? '★★★' : score >= 3 ? '★★' : '★';
  const adviceOf = r => r === '★★★' ? '强势接力，关注竞价承接' : r === '★★' ? '可接力，盯竞价与分时' : '接力偏弱，观察为主';
  const base = s => ({
    code: s.code, name: s.name, market: s.market, price: s.price, chg: s.chg,
    days: s.days, boards: s.boards, floatCap: s.floatCap,
    sealAmt: s.sealAmt, firstTime: s.firstTime, openTimes: s.openTimes,
    reason: s.reason, themeZt: themeCount[s.reason || '未知题材'] || 0,
  });

  // 连板接力
  const lianban = zt.filter(s => s.days >= 2).map(s => {
    const why = [`${s.days}连板`];
    let score = s.days >= 4 ? 3 : s.days === 3 ? 2 : 1;
    score += sealScore(s, why);
    if (s.themeZt >= 5) { score += 1; why.push(`题材${s.themeZt}家涨停`); }
    const rating = rate(score);
    return { ...base(s), score, rating, advice: adviceOf(rating), why: why.join('；') };
  }).sort((a, b) => (b.score - a.score) || (b.days - a.days));

  // 反包板
  const fanbao = zt.filter(s => zbSet.has(s.code) || dtSet.has(s.code)).map(s => {
    const fbType = dtSet.has(s.code) ? '跌停反包' : '炸板反包';
    const why = [fbType];
    let score = fbType === '跌停反包' ? 2 : 1;
    if (s.days >= 2) { score += 1; why.push(`${s.days}连板`); }
    score += sealScore(s, why);
    if (s.themeZt >= 5) { score += 1; why.push(`题材${s.themeZt}家涨停`); }
    const rating = rate(score);
    return { ...base(s), fbType, score, rating, advice: adviceOf(rating), why: why.join('；') };
  }).sort((a, b) => (b.score - a.score));

  return {
    date: todayDate(), histDate,
    lianban: { stocks: lianban, total: lianban.length },
    fanbao: { stocks: fanbao, total: fanbao.length },
    note: `今日涨停 ${zt.length} 家 · 昨日(${histDate})炸板 ${zb.length} 家 / 跌停 ${dt.length} 家`,
  };
}

// ---------------- AI 短线推荐 ----------------
// 候选聚合：多策略信号交叉（涨停龙头 / 主力进攻 / 技术金叉 / 异动蓄势 / 连板低吸）
// 打分：本地多因子规则引擎；配置 LLM 后追加大模型深度分析，失败自动回退规则引擎
function getLlmConfig() {
  const c = readJson(CONFIG_FILE, {}) || {};
  const llm = c.llm || {};
  if (!llm.apiKey) return null;
  return {
    baseUrl: String(llm.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: String(llm.apiKey),
    model: String(llm.model || 'gpt-4o-mini'),
  };
}

async function callLlm(llm, messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res;
  try {
    res = await fetch(`${llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${llm.apiKey}` },
      body: JSON.stringify({ model: llm.model, messages, temperature: 0.3 }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'LLM 请求超时' : `LLM 网络错误: ${e.message}`);
  }
  clearTimeout(timer);
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('LLM 响应解析失败'); }
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error('LLM 空响应');
  const parsed = extractJsonBlock(content) || (() => { try { return JSON.parse(content); } catch { return null; } })();
  if (!parsed) throw new Error('LLM 返回内容非 JSON');
  return parsed;
}

// 多因子评分 + 规则化分析文本
function scoreAiCandidate(c, marketCtx) {
  let score = 40; // 基础分
  const highlight = [];
  const risk = [];

  // 信号共振
  if (c.tags.length >= 3) { score += 10; highlight.push(`多信号共振（${c.tags.join('·')}）`); }
  else if (c.tags.length === 2) { score += 5; highlight.push(`${c.tags.join('、')}双信号`); }

  // 涨停强度
  if (c.days >= 4) { score += 12; highlight.push(`${c.days} 连板，市场空间高度，辨识度龙头`); }
  else if (c.days === 3) { score += 9; highlight.push('3 连板，梯队中坚'); }
  else if (c.days === 2) { score += 6; highlight.push('2 连板，晋级在途'); }
  if (c.sealAmt != null && c.floatCap && c.sealAmt / c.floatCap >= 0.05) { score += 5; highlight.push('封单占流通盘比例高，承接强'); }
  if ((c.openTimes || 0) >= 3) { score -= 5; risk.push(`盘中开板 ${c.openTimes} 次，分歧较大`); }

  // 资金
  if (c.mainInflow != null && c.mainInflow > 0) {
    score += c.mainInflow >= 1e8 ? 8 : 4;
    highlight.push(`主力净流入 ${fmtYi(c.mainInflow)}`);
  } else if (c.mainInflow != null && c.mainInflow < -5e7) {
    score -= 6; risk.push(`主力净流出 ${fmtYi(Math.abs(c.mainInflow))}`);
  }

  // 技术面
  if (c.macdGold) { score += 8; highlight.push(`MACD 金叉（${c.signalDate || '近期'}）且放量`); }
  if (c.volRatio != null && c.volRatio >= 2) { score += 4; highlight.push(`量比 ${c.volRatio.toFixed(1)}，量能活跃`); }
  if (c.bias5 != null) {
    if (c.bias5 >= -2 && c.bias5 <= 6) { score += 5; highlight.push('贴近 5 日线，位置安全'); }
    else if (c.bias5 > 12) { score -= 6; risk.push(`偏离 5 日线 ${c.bias5.toFixed(1)}%，追高有风险`); }
    else if (c.bias5 < -6) { score -= 5; risk.push('跌破 5 日线较深，趋势走弱'); }
  }

  // 题材
  if (c.themeZt >= 5) { score += 6; highlight.push(`题材「${c.reason}」当日 ${c.themeZt} 家涨停，板块效应强`); }
  if (marketCtx && marketCtx.stage === '退潮期' && c.days >= 3) { score -= 8; risk.push('情绪退潮期高位股，谨防补跌'); }
  if (marketCtx && marketCtx.stage === '冰点期') { score -= 4; risk.push('市场处冰点期，整体胜率偏低'); }

  // 位置 / 市值
  if (c.chg != null && c.chg > 7 && c.days <= 1) { score -= 5; risk.push('当日涨幅较大，追高性价比下降'); }
  if (c.floatCap != null && c.floatCap > 3e10) { score -= 4; risk.push('流通市值偏大，短线弹性受限'); }
  if (c.role === '总龙头') { score += 4; }
  if (!risk.length) risk.push('短线波动大，注意控制仓位与止损纪律');

  score = Math.max(5, Math.min(99, Math.round(score)));
  const rating = score >= 75 ? '★★★' : score >= 60 ? '★★' : '★';
  let action;
  if (c.tags.includes('连板低吸') && c.chg != null && c.chg <= 2) action = '回调低吸，设好止损（如跌破 5 日线离场）';
  else if (c.days >= 2) action = '接力思路，关注次日竞价承接强度，弱转强可参与';
  else if (c.macdGold) action = '趋势启动初期，回踩不破可分批介入';
  else action = '观察为主，等放量确认后再介入';
  return { score, rating, highlight, risk, action };
}

async function fetchAiPicks(apiKey) {
  // 聚合多源候选（免费源为主；配置 Key 时官方源数据走 /api/picks 等接口，此处保持免费源聚合保证稳定性）
  const [ztRaw, inflow, macd, prelaunch, lbdip] = await Promise.all([
    cached('free_zt', 30e3, fetchEMZTPool).catch(() => []),
    cached('free_inflow', 20e3, fetchInflow).catch(() => []),
    cached('free_macd', 120e3, fetchMacdGolden).catch(() => []),
    cached('free_prelaunch', 20e3, fetchPrelaunch).catch(() => []),
    cached('lbdip', 30e3, fetchLbDip).catch(() => ({ stocks: [] })),
  ]);

  // 盘前/非交易时段今日涨停池为空 → 回退到最近交易日涨停池 + 最新报价
  let zt = ztRaw;
  let ztFallbackNote = '';
  if (!zt.length) {
    const yzt = await cached('free_yzt', 300e3, fetchEMYesterdayZT).catch(() => ({ date: '', stocks: [] }));
    if (yzt.stocks.length) {
      const quotes = await emUlistQuotes(yzt.stocks.map(s => emSecid(s.code))).catch(() => ({}));
      zt = yzt.stocks.map(s => ({
        code: s.code, name: s.name, market: s.market,
        price: quotes[s.code] ? quotes[s.code].price : null,
        chg: quotes[s.code] ? quotes[s.code].chg : null,
        floatCap: s.floatCap, sealAmt: null, openTimes: 0,
        reason: s.reason, days: s.days || 1,
      }));
      ztFallbackNote = `（今日涨停池暂无数据，基于最近交易日 ${yzt.date} 涨停池分析）`;
    }
  }

  const marketCtx = await cached('review_free', 30e3, fetchFreeReview).catch(() => null);
  const themeCount = {};
  for (const s of zt) {
    const k = s.reason || '未知题材';
    themeCount[k] = (themeCount[k] || 0) + 1;
  }

  const map = new Map();
  const touch = code => {
    if (!map.has(code)) map.set(code, { code, tags: [], days: 0, openTimes: 0 });
    return map.get(code);
  };
  for (const s of zt.slice(0, 30)) {
    const c = touch(s.code);
    Object.assign(c, { name: s.name, market: s.market, price: s.price, chg: s.chg, floatCap: s.floatCap, sealAmt: s.sealAmt, openTimes: s.openTimes, reason: s.reason, days: Math.max(c.days, s.days || 1) });
    const ztTag = ztFallbackNote ? '昨日涨停' : '涨停龙头';
    if (!c.tags.includes(ztTag)) c.tags.push(ztTag);
  }
  for (const s of inflow.slice(0, 25)) {
    if (s.price == null || (s.mainInflow || 0) <= 0) continue;
    const c = touch(s.code);
    Object.assign(c, { name: s.name, market: s.market, price: c.price ?? s.price, chg: c.chg ?? s.chg, floatCap: c.floatCap ?? s.floatCap, mainInflow: s.mainInflow, volRatio: s.volRatio, turnover: s.turnover });
    if (!c.tags.includes('主力进攻')) c.tags.push('主力进攻');
  }
  for (const s of macd) {
    const c = touch(s.code);
    Object.assign(c, { name: c.name || s.name, market: c.market ?? s.market, price: c.price ?? s.price, chg: c.chg ?? s.chg, floatCap: c.floatCap ?? s.floatCap, macdGold: true, signalDate: s.signalDate, volRatio: c.volRatio ?? s.volRatio });
    if (!c.tags.includes('技术金叉')) c.tags.push('技术金叉');
  }
  for (const s of prelaunch.slice(0, 20)) {
    const c = touch(s.code);
    Object.assign(c, { name: c.name || s.name, market: c.market ?? s.market, price: c.price ?? s.price, chg: c.chg ?? s.chg, floatCap: c.floatCap ?? s.floatCap, volRatio: c.volRatio ?? s.volRatio });
    if (!c.tags.includes('异动蓄势')) c.tags.push('异动蓄势');
  }
  for (const s of (lbdip.stocks || []).slice(0, 15)) {
    const c = touch(s.code);
    Object.assign(c, { name: c.name || s.name, market: c.market ?? s.market, price: c.price ?? s.price, chg: c.chg ?? s.chg, floatCap: c.floatCap ?? s.floatCap, days: Math.max(c.days, s.days || 0), bias5: s.bias5, role: s.role, reason: c.reason || s.reason, mainInflow: c.mainInflow ?? s.mainInflow });
    if (!c.tags.includes('连板低吸')) c.tags.push('连板低吸');
  }

  // 补齐缺失字段（部分候选缺 bias5 / reason）
  const candidates = [...map.values()].filter(c => c.name && c.price != null);
  for (const c of candidates) {
    c.themeZt = themeCount[c.reason || '未知题材'] || 0;
    const scored = scoreAiCandidate(c, marketCtx && marketCtx.stats);
    Object.assign(c, scored);
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 12);

  // 大盘环境摘要（规则版）
  const stats = marketCtx && marketCtx.stats;
  const idx0 = marketCtx && marketCtx.indices && marketCtx.indices[0];
  const ruleSummary = stats
    ? `当前情绪判定为【${stats.stage}】：涨停 ${stats.up} 家 / 跌停 ${stats.down} 家，最高 ${stats.maxDays} 连板，赚钱效应 ${stats.effect}%。` +
      (idx0 && idx0.chg != null ? `上证指数 ${idx0.chg > 0 ? '+' : ''}${idx0.chg}%。` : '') +
      (stats.stage === '发酵期' ? '可围绕主线核心积极参与；' : stats.stage === '高潮期' ? '谨防高位退潮，控制追涨；' : stats.stage === '冰点期' ? '轻仓试错为主；' : '注意节奏，控制仓位；') +
      '以下个股按多因子信号综合评分排序，仅供参考。'
    : '市场数据暂缺，以下个股按多因子信号综合评分排序，仅供参考。';
  const ruleSummaryFinal = ruleSummary + ztFallbackNote;

  // LLM 深度分析（可选）
  const llm = getLlmConfig();
  let engine = 'rule';
  let summary = ruleSummaryFinal;
  if (llm && top.length) {
    try {
      const payload = {
        market: stats ? { stage: stats.stage, up: stats.up, down: stats.down, maxDays: stats.maxDays, effect: stats.effect, indexChg: idx0 && idx0.chg } : null,
        candidates: top.map(c => ({
          code: c.code, name: c.name, chg: c.chg, days: c.days, tags: c.tags,
          reason: c.reason, themeZt: c.themeZt, mainInflow: c.mainInflow,
          volRatio: c.volRatio, bias5: c.bias5, score: c.score,
        })),
      };
      const ai = await callLlm(llm, [
        { role: 'system', content: '你是 A 股短线交易员，擅长涨停战法与题材周期分析。基于给出的市场环境和候选股数据，输出严格的 JSON：{"summary":"一段话市场环境与操作策略总结(80字内)","picks":[{"code":"6位代码","highlight":"核心亮点(40字内)","risk":"主要风险(40字内)","action":"操作建议(40字内)"}]}。只输出 JSON，不要多余文字。必须覆盖每个候选股，code 原样返回。' },
        { role: 'user', content: JSON.stringify(payload) },
      ]);
      if (ai && Array.isArray(ai.picks)) {
        const byCode = new Map(ai.picks.map(p => [String(p.code), p]));
        for (const c of top) {
          const p = byCode.get(c.code);
          if (!p) continue;
          if (p.highlight) c.highlight = [String(p.highlight)];
          if (p.risk) c.risk = [String(p.risk)];
          if (p.action) c.action = String(p.action);
        }
        if (ai.summary) summary = String(ai.summary);
        engine = 'llm';
      }
    } catch (e) {
      console.warn('[AI 推荐] LLM 分析失败，回退规则引擎:', e.message);
    }
  }

  return {
    engine, summary,
    marketStage: stats ? stats.stage : null,
    total: candidates.length,
    stocks: top.map(c => ({
      code: c.code, name: c.name, market: c.market, price: c.price, chg: c.chg,
      days: c.days, floatCap: c.floatCap, reason: c.reason || '', tags: c.tags,
      score: c.score, rating: c.rating, highlight: c.highlight, risk: c.risk, action: c.action,
    })),
  };
}

// 个股详情（免费源）：输出与官方模式相同的 quote/kline/capital 结构
async function fetchFreeStockDetail(code) {
  const secid = emSecid(code);
  const [qd, kd] = await Promise.all([
    emGet(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f50,f57,f58,f60,f62,f84,f85,f116,f117,f162,f168,f169,f170,f171&fltt=2&invt=2`),
    emKline(secid, 120, 60e3),
  ]);
  const f = qd.data || {};
  const ks = ((kd.data) && kd.data.klines) || [];
  const Rows = ks.map(s => { const p = s.split(','); return { Data: p[0], Open: +p[1], Close: +p[2], High: +p[3], Low: +p[4], Volume: +p[5] }; });
  const n = Rows.length;
  const pro = {};
  const pct = (a, b) => (a && b ? +((a / b - 1) * 100).toFixed(2) : null);
  if (n >= 3) pro['昨日涨幅'] = pct(Rows[n - 2].Close, Rows[n - 3].Close);
  if (n > 6) pro['5日涨幅'] = pct(Rows[n - 1].Close, Rows[n - 6].Close);
  if (n > 21) pro['20日涨幅'] = pct(Rows[n - 1].Close, Rows[n - 21].Close);
  const year = n ? Rows[n - 1].Data.slice(0, 4) : '';
  for (let i = n - 1; i >= 0; i--) {
    if (Rows[i].Data.slice(0, 4) !== year) { pro['年初至今'] = pct(Rows[n - 1].Close, Rows[i].Close); break; }
  }
  const quote = {
    BaseInfo: { Name: f.f58 || '' },
    HQInfo: { Close: f.f43 != null && f.f43 !== '-' ? f.f43 : null, HQDate: todayDate() },
    ProInfo: pro,
    ExtInfo: { ZSZ: f.f116, SYL: f.f162, LTGB: f.f85 },
  };
  const capital = (f.f62 != null && f.f62 !== '-')
    ? { summary: `今日主力净流入 ${fmtYi(f.f62)}${f.f184 != null && f.f184 !== '-' ? `，占成交额 ${Number(f.f184).toFixed(1)}%` : ''}。`, tables: [] }
    : null;
  return { quote, kline: { Rows }, capital };
}

// ---------------- HTTP 服务 ----------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function getApiKey() {
  return (readJson(CONFIG_FILE, {}) || {}).apiKey || '';
}

// 模式优先级：有 API Key → 官方 MCP 实时；无 Key → 免费实时数据源；均失败 → 快照兜底
async function withDataMode(res, forceSnapshot, liveFn, freeFn, snapshotKey) {
  const snapshot = readJson(SNAPSHOT_FILE, null);
  const apiKey = getApiKey();
  if (forceSnapshot) {
    if (!snapshot) return sendJson(res, 200, { mode: 'none', error: '无快照数据。' });
    return sendJson(res, 200, { mode: 'snapshot', generatedAt: snapshot.generatedAt, data: snapshot[snapshotKey] || null });
  }
  if (apiKey) {
    try {
      const data = await liveFn(apiKey);
      return sendJson(res, 200, { mode: 'live', generatedAt: nowStr(), data });
    } catch (e) {
      if (e.authFailed) {
        return sendJson(res, 200, { mode: 'auth_error', error: 'API Key 无效或已过期（401），请在设置中更新。', data: snapshot ? snapshot[snapshotKey] : null, generatedAt: snapshot ? snapshot.generatedAt : null });
      }
      if (snapshot) return sendJson(res, 200, { mode: 'fallback', error: e.message, data: snapshot[snapshotKey], generatedAt: snapshot.generatedAt });
      return sendJson(res, 502, { mode: 'error', error: e.message });
    }
  }
  try {
    const data = await freeFn();
    return sendJson(res, 200, { mode: 'free', generatedAt: nowStr(), data });
  } catch (e) {
    if (snapshot) return sendJson(res, 200, { mode: 'fallback', error: `免费行情源异常（${e.message}），暂展示快照数据`, data: snapshot[snapshotKey], generatedAt: snapshot.generatedAt });
    return sendJson(res, 502, { mode: 'error', error: e.message });
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(ROOT, 'public', urlPath));
  if (!file.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/status') {
      const snapshot = readJson(SNAPSHOT_FILE, null);
      return sendJson(res, 200, { hasKey: !!getApiKey(), hasLLM: !!getLlmConfig(), mode: getApiKey() ? 'live' : 'free', snapshotTime: snapshot ? snapshot.generatedAt : null, serverTime: nowStr() });
    }
    if (p === '/api/config' && req.method === 'GET') {
      const c = readJson(CONFIG_FILE, {}) || {};
      const llm = c.llm || {};
      return sendJson(res, 200, {
        hasKey: !!c.apiKey,
        llm: { baseUrl: llm.baseUrl || '', model: llm.model || '', hasKey: !!llm.apiKey },
      });
    }
    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const prev = readJson(CONFIG_FILE, {}) || {};
      const next = { ...prev, updatedAt: nowStr() };
      if (body.apiKey !== undefined) next.apiKey = String(body.apiKey || '').trim();
      if (body.llm && typeof body.llm === 'object') {
        const prevLlm = prev.llm || {};
        next.llm = {
          baseUrl: String(body.llm.baseUrl ?? prev.llm?.baseUrl ?? '').trim(),
          model: String(body.llm.model ?? prev.llm?.model ?? '').trim(),
          // 留空表示保持原 Key；填 "CLEAR" 表示清除
          apiKey: body.llm.apiKey === 'CLEAR' ? '' : (body.llm.apiKey ? String(body.llm.apiKey).trim() : (prev.llm?.apiKey || '')),
        };
      }
      writeJson(CONFIG_FILE, next);
      mcpSession = null;
      return sendJson(res, 200, { ok: true, hasKey: !!next.apiKey, hasLLM: !!getLlmConfig() });
    }
    if (p === '/api/config/test' && req.method === 'POST') {
      const body = await readBody(req);
      const key = String(body.apiKey || getApiKey() || '').trim();
      if (!key) return sendJson(res, 200, { ok: false, error: '未提供 API Key' });
      try {
        const text = await callTool(key, 'tdx_quotes', { code: '399001', setcode: '0' });
        const ok = /深证成指/.test(text);
        return sendJson(res, 200, { ok, error: ok ? null : '返回数据异常' });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e.authFailed ? 'API Key 无效（401 未授权）' : e.message });
      }
    }
    if (p === '/api/review') {
      const force = url.searchParams.get('snapshot') === '1';
      return withDataMode(res, force, key => cached('review', 60e3, () => fetchReview(key)), () => cached('review_free', 30e3, fetchFreeReview), 'review');
    }
    if (p === '/api/picks') {
      const force = url.searchParams.get('snapshot') === '1';
      return withDataMode(res, force, key => cached('picks', 60e3, () => fetchPicks(key)), () => cached('picks_free', 30e3, fetchFreePicks), 'picks');
    }
    if (p === '/api/realtime') {
      const force = url.searchParams.get('snapshot') === '1';
      return withDataMode(res, force, key => cached('realtime', 20e3, () => fetchRealtime(key)), () => cached('realtime_free', 15e3, fetchFreeRealtime), 'realtime');
    }
    if (p === '/api/lbdip') {
      const force = url.searchParams.get('snapshot') === '1';
      const fn = () => cached('lbdip', 30e3, fetchLbDip);
      return withDataMode(res, force, fn, fn, 'lbdip');
    }
    if (p === '/api/relay') {
      const force = url.searchParams.get('snapshot') === '1';
      const fn = () => cached('relay', 30e3, fetchRelay);
      return withDataMode(res, force, fn, fn, 'relay');
    }
    if (p === '/api/ai-picks') {
      const force = url.searchParams.get('snapshot') === '1';
      const fn = () => cached('ai_picks', 60e3, fetchAiPicks);
      return withDataMode(res, force, fn, fn, 'aiPicks');
    }
    if (p === '/api/stock') {
      const code = url.searchParams.get('code') || '';
      const setcode = url.searchParams.get('setcode') || '';
      if (!code) return sendJson(res, 400, { error: '缺少 code 参数' });
      const apiKey = getApiKey();
      try {
        if (apiKey) {
          const data = await fetchStockDetail(apiKey, code, setcode);
          return sendJson(res, 200, { mode: 'live', data });
        }
        const data = await fetchFreeStockDetail(code);
        return sendJson(res, 200, { mode: 'free', data });
      } catch (e) {
        return sendJson(res, 502, { mode: 'error', error: e.message });
      }
    }
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: '未知接口' });
    return serveStatic(req, res);
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[短线雷达] 服务已启动: http://localhost:${PORT}`);
    console.log(`[短线雷达] 数据模式: ${getApiKey() ? '官方实时（已配置 API Key）' : '免费实时（东方财富公开行情，无需 Key）'}`);
  });
}

module.exports = {
  callTool, extractJsonBlock, callScreener, callQuotes, callKline,
  normalizeLimitPool, aggregateThemes, buildReviewPlan, normalizeScreenerRows,
  INDEX_LIST, STRATEGIES, REALTIME_CHANNELS, nowStr, SNAPSHOT_FILE,
};
