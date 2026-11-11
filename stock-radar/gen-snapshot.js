'use strict';
/**
 * 快照生成脚本：读取 MCP 工具调用持久化输出（manifest.json 指定），
 * 组装为 data/snapshot.json（结构与 server.js 实时接口一致）。
 * 用法: node gen-snapshot.js
 */
const fs = require('fs');
const path = require('path');
const S = require('./server.js');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));

function loadText(entry) {
  const raw = fs.readFileSync(entry.file, 'utf8');
  const start = raw.indexOf('[');
  if (start < 0) throw new Error(`无法解析 ${entry.file}`);
  const arr = JSON.parse(raw.slice(start));
  return arr.map(x => x.text || '').join('\n');
}

function screenerRows(entry) {
  if (!entry || !fs.existsSync(entry.file)) return { meta: null, rows: [] };
  const json = S.extractJsonBlock(loadText(entry));
  if (!json || !Array.isArray(json.data)) return { meta: null, rows: [] };
  return { meta: json.meta || null, rows: json.data };
}

const num = v => {
  if (v === undefined || v === null || v === '' || v === '--') return null;
  const n = Number(String(v).replace(/[,%]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function buildIndex(name, code, quoteEntry, klineEntry) {
  const quote = S.extractJsonBlock(loadText(quoteEntry));
  const kline = S.extractJsonBlock(loadText(klineEntry));
  const out = { name, code, close: null, chg: null, prevClose: null, pro: {}, date: null };
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
    if (c && p) {
      out.close = c; out.prevClose = p;
      out.chg = +((c / p - 1) * 100).toFixed(2);
      out.date = String(last.Data || last.Date || out.date);
    }
  }
  return out;
}

// ---------- 组装复盘 ----------
const byId = {};
for (const e of manifest) byId[e.id] = e;

const indices = [
  buildIndex('上证指数', '000001', byId.q_sh, byId.k_sh),
  buildIndex('深证成指', '399001', byId.q_sz, byId.k_sz),
  buildIndex('创业板指', '399006', byId.q_cy, byId.k_cy),
  buildIndex('沪深300', '000300', byId.q_300, byId.k_300),
];

const lu = screenerRows(byId.lu);       // 涨停
const ld = screenerRows(byId.ld);       // 跌停
const pool = S.normalizeLimitPool(lu.rows);
const themes = S.aggregateThemes(pool);
const { stats, plan } = S.buildReviewPlan({ indices, pool, downRows: ld.rows, themes });

const review = {
  tradeDate: (pool[0] && pool[0].date) || (indices[0] && indices[0].date) || '',
  indices, themes, stats, plan,
  ladder: pool.filter(s => s.days >= 2),
  pool: pool.slice(0, 60),
  downList: S.normalizeScreenerRows(ld.rows).slice(0, 30),
};

// ---------- 组装短线精选 ----------
const pickInputs = {
  limit_leader: byId.lu,
  capital_attack: byId.inflow,
  tech_gold: byId.gold,
  pre_launch: byId.prelaunch,
};
const strategies = S.STRATEGIES.map(s => {
  const r = screenerRows(pickInputs[s.id]);
  return {
    id: s.id, name: s.name, desc: s.desc, query: s.query,
    total: r.meta ? r.meta.total : r.rows.length,
    stocks: S.normalizeScreenerRows(r.rows).slice(0, 30),
  };
});
const picks = { strategies };

// ---------- 组装实时机会 ----------
const rtInputs = {
  surge: byId.surge,
  limit_new: byId.lu,
  inflow: byId.inflow,
};
const channels = S.REALTIME_CHANNELS.map(c => {
  const r = screenerRows(rtInputs[c.id]);
  return {
    id: c.id, name: c.name, desc: c.desc,
    total: r.meta ? r.meta.total : r.rows.length,
    stocks: S.normalizeScreenerRows(r.rows).slice(0, 20),
  };
});
const realtime = { channels };

// ---------- 写出 ----------
const snapshot = { generatedAt: S.nowStr(), review, picks, realtime };
fs.mkdirSync(path.dirname(S.SNAPSHOT_FILE), { recursive: true });
fs.writeFileSync(S.SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
console.log(`快照已生成: ${S.SNAPSHOT_FILE}`);
console.log(`  复盘: 涨停 ${stats.up} / 跌停 ${stats.down} / 题材 ${themes.length} / 指数 ${indices.filter(i => i.close).length} 个`);
console.log(`  精选: ${strategies.map(s => `${s.name}=${s.stocks.length}`).join(', ')}`);
console.log(`  实时: ${channels.map(c => `${c.name}=${c.stocks.length}`).join(', ')}`);
