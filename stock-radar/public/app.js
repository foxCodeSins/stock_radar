'use strict';
/* ============ 短线雷达 · 前端逻辑 ============ */

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const state = {
  tab: 'review',
  status: null,
  review: null, picks: null, realtime: null, lbDip: null, relay: null,
  picksIdx: 0,
  boardFilter: 'all',
  capFilter: 'all',
  autoRefresh: true,
  countdown: 30,
  timer: null,
  lastRtKeys: {},
  klineChart: null,
};

/* 板块筛选 */
const BOARDS = [
  { id: 'all', name: '全部板块', test: () => true },
  { id: 'main', name: '主板', test: c => /^(60|00)/.test(c) },
  { id: 'cyb', name: '创业板', test: c => /^30/.test(c) },
  { id: 'kcb', name: '科创板', test: c => /^68/.test(c) },
  { id: 'bj', name: '北交所', test: c => /^(43|83|87|92)/.test(c) },
];
function boardMatch(code) {
  const b = BOARDS.find(x => x.id === state.boardFilter) || BOARDS[0];
  return b.test(String(code || ''));
}
function renderBoardFilter() {
  $('#boardFilter').innerHTML = '<span class="bf-label">板块筛选</span>' + BOARDS.map(b =>
    `<button class="bf-btn ${b.id === state.boardFilter ? 'active' : ''}" data-board="${b.id}">${b.name}</button>`).join('');
}

/* 流通市值筛选（作用于 实时机会 / 短线精选 / 连板低吸） */
const CAPS = [
  { id: 'all', name: '全部市值', test: () => true },
  { id: 's', name: '30亿以下', test: v => v != null && v < 3e9 },
  { id: 'm', name: '30-100亿', test: v => v != null && v >= 3e9 && v < 1e10 },
  { id: 'l', name: '100-500亿', test: v => v != null && v >= 1e10 && v < 5e10 },
  { id: 'xl', name: '500亿以上', test: v => v != null && v >= 5e10 },
];
function capMatch(stock) {
  const c = CAPS.find(x => x.id === state.capFilter) || CAPS[0];
  return c.test(stock.floatCap);
}
function renderCapFilter() {
  $('#capFilter').innerHTML = '<span class="bf-label">市值</span>' + CAPS.map(c =>
    `<button class="bf-btn ${c.id === state.capFilter ? 'active' : ''}" data-cap="${c.id}">${c.name}</button>`).join('');
}
function rerenderCurrent() {
  if (state.tab === 'review' && state.review) renderReview(state.review);
  if (state.tab === 'picks' && state.picks) renderPicksTable();
  if (state.tab === 'realtime' && state.realtime) renderRealtime(true);
  if (state.tab === 'lbdip' && state.lbDip) renderLbDip();
  if (state.tab === 'relay' && state.relay) renderRelay();
}

/* ---------- 工具函数 ---------- */
async function api(path, opts) {
  const res = await fetch(path, opts);
  return res.json();
}

function fmtNum(n, d = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  return Number(n).toFixed(d);
}
function fmtChg(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  return (n > 0 ? '+' : '') + Number(n).toFixed(2) + '%';
}
function chgClass(n) {
  if (n === null || n === undefined || Number.isNaN(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}
function fmtAmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (abs >= 1e4) return (n / 1e4).toFixed(0) + '万';
  return String(Math.round(n));
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 清理通达信字段名中的 <br>、日期后缀等噪音，如 "主力净额<br>2026.11.110#" → "主力净额"
function cleanKey(k) {
  return String(k).split('<br>')[0].replace(/[.．]\d{4}[.\-]\d{2}[.\-]\d{2}.*$/, '').replace(/#$/, '').trim();
}
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function applyMode(mode, generatedAt, error) {
  const pill = $('#statusPill');
  pill.classList.remove('live', 'snapshot', 'error');
  const dotText = { live: '官方实时', free: '免费实时', snapshot: '快照数据', fallback: '快照兜底', auth_error: 'Key 失效', none: '未配置', error: '数据错误' };
  if (mode === 'live' || mode === 'free') pill.classList.add('live');
  else if (mode === 'snapshot' || mode === 'fallback') pill.classList.add('snapshot');
  else pill.classList.add('error');
  let text = dotText[mode] || mode;
  if (generatedAt) text += ` · ${String(generatedAt).slice(5, 16)}`;
  $('#statusText').textContent = text;
  const banner = $('#snapshotBanner');
  if (mode === 'live' || mode === 'free') {
    banner.hidden = true;
  } else {
    banner.hidden = false;
    const msgs = {
      snapshot: '当前为快照数据（不会实时变动）。在设置中填写通达信 API Key 后即可启用实时自动刷新。',
      fallback: `实时接口异常（${error || '网络错误'}），暂展示快照数据，下次刷新自动重试。`,
      auth_error: 'API Key 无效（401 未授权），请在设置中重新填写。',
      none: '未配置 API Key。在设置中填写后即可启用实时数据。',
      error: error || '数据加载失败',
    };
    $('#bannerText').textContent = msgs[mode] || msgs.error;
  }
  if (error && mode !== 'snapshot') console.warn('[数据提示]', error);
}

/* ---------- 状态栏 ---------- */
async function loadStatus() {
  try {
    state.status = await api('/api/status');
  } catch {
    state.status = { hasKey: false, mode: 'error' };
  }
}

/* ---------- 复盘中心 ---------- */
async function loadReview(silent = false) {
  if (!silent) $('#indexRow').innerHTML = '<div class="loading-tip">正在获取大盘数据</div>';
  const r = await api('/api/review');
  applyMode(r.mode, r.generatedAt, r.error);
  if (!r.data) {
    $('#indexRow').innerHTML = `<div class="error-tip">${esc(r.error || '暂无数据')}</div>`;
    return;
  }
  state.review = r.data;
  renderReview(r.data);
}

function renderReview(d) {
  $('#reviewDate').textContent = d.tradeDate ? `交易日 ${d.tradeDate}` : '';

  // 指数卡片
  $('#indexRow').innerHTML = d.indices.map(ix => {
    const cls = ix.chg == null ? '' : ix.chg > 0 ? 'is-up' : ix.chg < 0 ? 'is-down' : '';
    const pro = ix.pro || {};
    return `<div class="index-card ${cls}">
      <div class="index-name">${esc(ix.name)}</div>
      <div>
        <span class="index-price ${chgClass(ix.chg)}">${fmtNum(ix.close)}</span>
        <span class="index-chg ${chgClass(ix.chg)}">${fmtChg(ix.chg)}</span>
      </div>
      <div class="index-sub">
        <span>5日 ${fmtChg(pro.chg5d)}</span>
        <span>20日 ${fmtChg(pro.chg20d)}</span>
        <span>年初至今 ${fmtChg(pro.ytd)}</span>
      </div>
    </div>`;
  }).join('');

  // 情绪带
  const s = d.stats || {};
  $('#sentimentBand').innerHTML = `
    <div class="sent-item"><div class="sent-label">涨停家数</div><div class="sent-value up">${s.up ?? '--'}<small>家</small></div></div>
    <div class="sent-item"><div class="sent-label">跌停家数</div><div class="sent-value down">${s.down ?? '--'}<small>家</small></div></div>
    <div class="sent-item"><div class="sent-label">最高连板</div><div class="sent-value" style="color:var(--gold)">${s.maxDays ?? '--'}<small>板</small></div></div>
    <div class="sent-item"><div class="sent-label">赚钱效应</div><div class="sent-value ${chgClass((s.effect ?? 50) - 50)}">${fmtNum(s.effect, 0)}<small>%</small></div></div>
    <div class="sent-item"><div class="sent-label">封单总额</div><div class="sent-value">${fmtAmt(s.sealTotal)}</div></div>
    <div class="sent-item"><div class="sent-label">炸板回封</div><div class="sent-value">${s.broken ?? '--'}<small>家</small></div></div>
    <div class="stage-badge"><span class="stage-name">${esc(s.stage || '--')}</span></div>`;

  // 题材热度
  const maxCount = Math.max(1, ...(d.themes || []).map(t => t.count));
  $('#themeList').innerHTML = (d.themes || []).length
    ? d.themes.map(t => `<div class="theme-row">
        <span class="theme-name" title="${esc(t.name)}">${esc(t.name)}</span>
        <div class="theme-bar-wrap"><div class="theme-bar" style="width:${(t.count / maxCount * 100).toFixed(1)}%"></div></div>
        <span class="theme-count">${t.count}家</span>
        <span class="theme-leader" title="代表：${esc(t.leader)}（${t.maxDays}板）">${esc(t.leader)} ${t.maxDays}板</span>
      </div>`).join('')
    : '<div class="empty-tip">当日无明显题材聚集</div>';

  // 连板天梯
  const ladder = (d.ladder || []).filter(s => boardMatch(s.code));
  if (ladder.length) {
    const groups = new Map();
    for (const st of ladder) {
      if (!groups.has(st.days)) groups.set(st.days, []);
      groups.get(st.days).push(st);
    }
    const levels = [...groups.keys()].sort((a, b) => b - a);
    $('#ladderList').innerHTML = levels.map(lv => `<div class="ladder-group">
        <div class="ladder-level">◆ ${lv} 连板</div>
        <div class="ladder-stocks">${groups.get(lv).map(st =>
          `<span class="stock-chip" data-code="${esc(st.code)}" data-market="${esc(st.market)}" data-name="${esc(st.name)}">${esc(st.name)}<span class="chip-chg ${chgClass(st.chg)}">${fmtChg(st.chg)}</span></span>`).join('')}</div>
      </div>`).join('');
  } else {
    $('#ladderList').innerHTML = '<div class="empty-tip">暂无 2 板以上晋级个股</div>';
  }

  // 复盘计划
  $('#planGrid').innerHTML = (d.plan || []).map((p, i) => `<div class="plan-card">
      <div class="plan-step"><span class="step-num">${i + 1}</span>${esc(p.step)}</div>
      <div class="plan-detail">${esc(p.detail)}</div>
    </div>`).join('');

  // 涨停池
  const pool = (d.pool || []).filter(s => boardMatch(s.code));
  $('#poolNote').textContent = `显示 ${pool.length} 家 / 全市场 ${s.up ?? '--'} 家，按连板与封单排序`;
  $('#poolTable').innerHTML = poolTableHtml(pool);
  $('#downTable').innerHTML = downTableHtml((d.downList || []).filter(s => boardMatch(s.code)));
}

function poolTableHtml(pool) {
  if (!pool.length) return '<div class="empty-tip">暂无涨停数据</div>';
  return `<table class="data"><thead><tr>
    <th>名称 / 代码</th><th>连板</th><th>最新价</th><th>流通市值</th><th>封单额</th><th>首次封板</th><th>打开</th><th>涨停原因</th>
  </tr></thead><tbody>${pool.map(st => `<tr data-code="${esc(st.code)}" data-market="${esc(st.market)}" data-name="${esc(st.name)}">
    <td class="tname">${esc(st.name)}<br><span style="color:var(--faint);font-size:11px">${esc(st.code)}</span></td>
    <td><span class="badge badge-days ${st.days >= 3 ? 'hot' : ''}">${st.days}板</span></td>
    <td>${fmtNum(st.price)}</td>
    <td>${fmtAmt(st.floatCap)}</td>
    <td>${fmtAmt(st.sealAmt)}</td>
    <td>${esc(st.firstTime || '--')}</td>
    <td>${st.openTimes || 0}</td>
    <td class="reason-cell" title="${esc(st.reason)}">${esc(st.reason || '--')}</td>
  </tr>`).join('')}</tbody></table>`;
}

function downTableHtml(rows) {
  if (!rows.length) return '<div class="empty-tip">暂无跌停个股，风险偏好尚可</div>';
  return `<table class="data"><thead><tr><th>名称 / 代码</th><th>最新价</th><th>跌幅</th></tr></thead><tbody>
    ${rows.map(st => `<tr data-code="${esc(st.code)}" data-market="${esc(st.market)}" data-name="${esc(st.name)}">
      <td class="tname">${esc(st.name)}<br><span style="color:var(--faint);font-size:11px">${esc(st.code)}</span></td>
      <td>${fmtNum(st.price)}</td>
      <td class="down">${fmtChg(st.chg)}</td>
    </tr>`).join('')}</tbody></table>`;
}

/* ---------- 短线精选 ---------- */
async function loadPicks(silent = false) {
  if (!silent) $('#picksTable').innerHTML = '<div class="loading-tip">正在执行多策略选股</div>';
  const r = await api('/api/picks');
  applyMode(r.mode, r.generatedAt, r.error);
  if (!r.data) {
    $('#picksTable').innerHTML = `<div class="error-tip">${esc(r.error || '暂无数据')}</div>`;
    return;
  }
  state.picks = r.data;
  renderStrategyTabs();
  renderPicksTable();
}

function renderStrategyTabs() {
  $('#strategyTabs').innerHTML = state.picks.strategies.map((s, i) => `
    <button class="strategy-tab ${i === state.picksIdx ? 'active' : ''}" data-idx="${i}">
      <div class="st-name">${esc(s.name)}</div>
      <div class="st-count">${s.error ? '获取失败' : `命中 ${s.total ?? s.stocks.length} 只`}</div>
    </button>`).join('');
}

function renderPicksTable() {
  const s = state.picks.strategies[state.picksIdx];
  if (!s) return;
  $('#picksTitle').textContent = s.name;
  $('#picksDesc').textContent = s.desc;
  if (s.error) {
    $('#picksTable').innerHTML = `<div class="error-tip">该策略获取失败：${esc(s.error)}</div>`;
    return;
  }
  if (!s.stocks.length) {
    $('#picksTable').innerHTML = '<div class="empty-tip">当前条件下暂无命中个股</div>';
    return;
  }
  const stocks = s.stocks.filter(st => boardMatch(st.code) && capMatch(st));
  const shown = stocks.slice(0, 30);
  // 动态附加列：取首行 extra 的前 3 个字段
  const extraKeys = Object.keys(stocks[0]?.extra || {}).slice(0, 3);
  const headExtra = extraKeys.map(k => `<th>${esc(cleanKey(k))}</th>`).join('');
  $('#picksDesc').textContent = `${s.desc} · 显示 ${stocks.length}/${s.stocks.length} 只${stocks.length > 30 ? '（列表展示前30）' : ''}`;
  if (!stocks.length) {
    $('#picksTable').innerHTML = '<div class="empty-tip">当前板块/市值筛选下暂无个股，请调整筛选条件</div>';
    return;
  }
  $('#picksTable').innerHTML = `<table class="data"><thead><tr>
    <th>名称 / 代码</th><th>最新价</th><th>涨跌幅</th>${headExtra}
  </tr></thead><tbody>${shown.map(st => `<tr data-code="${esc(st.code)}" data-market="${esc(st.market)}" data-name="${esc(st.name)}">
    <td class="tname">${esc(st.name)}<br><span style="color:var(--faint);font-size:11px">${esc(st.code)}</span></td>
    <td>${fmtNum(st.price)}</td>
    <td class="${chgClass(st.chg)}">${fmtChg(st.chg)}</td>
    ${extraKeys.map(k => {
      const v = st.extra[k];
      const n = Number(String(v).replace(/[,%]/g, ''));
      const display = Number.isFinite(n) && Math.abs(n) >= 1e4 ? fmtAmt(n) : esc(String(v).slice(0, 24));
      return `<td title="${esc(String(v))}">${display}</td>`;
    }).join('')}
  </tr>`).join('')}</tbody></table>`;
}

/* ---------- 实时机会 ---------- */
async function loadRealtime(silent = false) {
  if (!silent) $('#rtGrid').innerHTML = '<div class="loading-tip">正在扫描市场异动</div>';
  const r = await api('/api/realtime');
  applyMode(r.mode, r.generatedAt, r.error);
  if (!r.data) {
    $('#rtGrid').innerHTML = `<div class="error-tip">${esc(r.error || '暂无数据')}</div>`;
    return;
  }
  state.realtime = r.data;
  renderRealtime(silent);
  $('#realtimeClock').textContent = `更新 ${String(r.generatedAt || '').slice(11, 19)}`;
}

function renderRealtime(silent) {
  const newKeys = {};
  $('#rtGrid').innerHTML = state.realtime.channels.map(c => {
    const filtered = (c.stocks || []).filter(st => boardMatch(st.code) && capMatch(st));
    const rows = filtered.slice(0, 30).map(st => {
      const key = `${c.id}:${st.code}:${st.price}`;
      newKeys[key] = true;
      const flash = silent && !state.lastRtKeys[key] ? 'flash' : '';
      const extraEntries = Object.entries(st.extra || {}).slice(0, 2);
      return `<tr class="${flash}" data-code="${esc(st.code)}" data-market="${esc(st.market)}" data-name="${esc(st.name)}">
        <td class="tname">${esc(st.name)}<br><span style="color:var(--faint);font-size:11px">${esc(st.code)}</span></td>
        <td>${fmtNum(st.price)}</td>
        <td class="${chgClass(st.chg)}">${fmtChg(st.chg)}</td>
        <td><div class="extra-tags">${extraEntries.map(([k, v]) => `<span class="extra-tag" title="${esc(cleanKey(k))}: ${esc(String(v))}">${esc(cleanKey(k))} ${esc(String(v).slice(0, 10))}</span>`).join('')}</div></td>
      </tr>`;
    }).join('');
    return `<div class="panel">
      <div class="panel-head"><h3>${esc(c.name)}</h3><span class="panel-note">${esc(c.desc)} · 显示 ${filtered.length}${c.total ? ` / 共${c.total}条` : ''}${filtered.length > 30 ? '（列表展示前30）' : ''}</span></div>
      <div class="panel-body table-wrap">${c.error ? `<div class="error-tip">${esc(c.error)}</div>` : rows ? `<table class="data"><thead><tr><th>名称 / 代码</th><th>最新价</th><th>涨跌幅</th><th>信号</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty-tip">暂无异动</div>'}</div>
    </div>`;
  }).join('');
  state.lastRtKeys = newKeys;
}

/* ---------- 连板低吸 ---------- */
async function loadLbDip(silent = false) {
  if (!silent) $('#lbTable').innerHTML = '<div class="empty-tip">加载中…</div>';
  const r = await api('/api/lbdip');
  applyMode(r.mode, r.generatedAt, r.error);
  if (!r.data) {
    $('#lbTable').innerHTML = `<div class="error-tip">${esc(r.error || '暂无数据')}</div>`;
    $('#lbNote').textContent = '';
    return;
  }
  state.lbDip = r.data;
  renderLbDip();
}

async function loadRelay(silent = false) {
  if (!silent) {
    $('#relayLbTable').innerHTML = '<div class="empty-tip">加载中…</div>';
    $('#relayFbTable').innerHTML = '';
  }
  const r = await api('/api/relay');
  applyMode(r.mode, r.generatedAt, r.error);
  if (!r.data) {
    $('#relayLbTable').innerHTML = `<div class="error-tip">${esc(r.error || '暂无数据')}</div>`;
    $('#relayFbTable').innerHTML = '';
    $('#relayNote').textContent = '';
    return;
  }
  state.relay = r.data;
  renderRelay();
}

function relayRows(stocks, withType) {
  return stocks.map(st => `<tr data-code="${esc(st.code)}" data-market="${esc(st.market)}" data-name="${esc(st.name)}">
    <td class="tname">${esc(st.name)}<br><span style="color:var(--faint);font-size:11px">${esc(st.code)}</span></td>
    <td>${fmtNum(st.price)}</td>
    <td class="${chgClass(st.chg)}">${fmtChg(st.chg)}</td>
    ${withType ? `<td><span class="fb-badge fb-${st.fbType === '跌停反包' ? 'dt' : 'zb'}">${esc(st.fbType)}</span></td>` : ''}
    <td><span class="badge badge-days ${st.days >= 3 ? 'hot' : ''}">${st.days}板</span></td>
    <td>${esc(st.firstTime ? st.firstTime.slice(0, 5) : '--')}</td>
    <td>${st.openTimes != null ? st.openTimes + '次' : '--'}</td>
    <td>${fmtAmt(st.sealAmt)}</td>
    <td>${fmtAmt(st.floatCap)}</td>
    <td class="reason-cell" title="${esc(st.reason || '')}">${esc(st.reason || '--')}<br><span style="color:var(--faint);font-size:11px">${st.themeZt || 0}家涨停</span></td>
    <td class="rating-cell" title="${esc(st.why || '')}"><span class="rating-stars">${esc(st.rating || '★')}</span><br><span class="rating-advice">${esc(st.advice || '')}</span></td>
  </tr>`).join('');
}

function renderRelay() {
  const d = state.relay;
  const lb = ((d.lianban && d.lianban.stocks) || []).filter(s => boardMatch(s.code) && capMatch(s));
  const fb = ((d.fanbao && d.fanbao.stocks) || []).filter(s => boardMatch(s.code) && capMatch(s));
  $('#relayNote').textContent = `${d.note || ''} · 连板接力 显示${lb.length}${d.lianban && d.lianban.total != null ? '/' + d.lianban.total : ''} · 反包 显示${fb.length}${d.fanbao && d.fanbao.total != null ? '/' + d.fanbao.total : ''}`;
  const lbHead = '<table class="data"><thead><tr><th>名称 / 代码</th><th>最新价</th><th>今日涨幅</th><th>连板</th><th>首封</th><th>开板</th><th>封单</th><th>流通市值</th><th>题材</th><th>评级</th></tr></thead><tbody>';
  $('#relayLbTable').innerHTML = lb.length
    ? lbHead + relayRows(lb, false) + '</tbody></table>'
    : '<div class="empty-tip">今日暂无 2 连板及以上个股（或已被板块/市值筛选过滤）</div>';
  const fbHead = '<table class="data"><thead><tr><th>名称 / 代码</th><th>最新价</th><th>今日涨幅</th><th>反包类型</th><th>连板</th><th>首封</th><th>开板</th><th>封单</th><th>流通市值</th><th>题材</th><th>评级</th></tr></thead><tbody>';
  $('#relayFbTable').innerHTML = fb.length
    ? fbHead + relayRows(fb, true) + '</tbody></table>'
    : '<div class="empty-tip">今日暂无反包涨停（昨日炸板/跌停个股今日未涨停，或已被筛选过滤）</div>';
}

function renderLbDip() {
  const d = state.lbDip;
  const stocks = (d.stocks || []).filter(s => boardMatch(s.code) && capMatch(s));
  $('#lbNote').textContent = `${d.note || ''} · 显示 ${stocks.length}${d.total != null ? ` / ${d.total}` : ''}`;
  if (!stocks.length) {
    $('#lbTable').innerHTML = '<div class="empty-tip">当前没有符合「昨日连板 + 今日回调」条件的个股（或已被板块/市值筛选过滤）</div>';
    return;
  }
  $('#lbTable').innerHTML = `<table class="data"><thead><tr>
    <th>名称 / 代码</th><th>最新价</th><th>今日涨幅</th><th>昨连板</th><th>定位</th><th>题材（昨涨停 / 今日）</th><th>题材预期</th><th>技术分析</th><th>流通市值</th><th>评级</th>
  </tr></thead><tbody>${stocks.map(st => `<tr data-code="${esc(st.code)}" data-market="${esc(st.market)}" data-name="${esc(st.name)}">
    <td class="tname">${esc(st.name)}<br><span style="color:var(--faint);font-size:11px">${esc(st.code)}</span></td>
    <td>${fmtNum(st.price)}</td>
    <td class="${chgClass(st.chg)}">${fmtChg(st.chg)}</td>
    <td><span class="badge badge-days ${st.days >= 3 ? 'hot' : ''}">${st.days}板</span>${st.boards ? `<br><span style="color:var(--faint);font-size:11px">${esc(st.boards)}</span>` : ''}</td>
    <td><span class="role-badge role-${st.role === '总龙头' ? 'leader' : st.role === '题材核心' ? 'core' : 'follow'}">${esc(st.role || '跟风')}</span></td>
    <td class="reason-cell" title="${esc(st.themeName || '')}">${esc(st.themeName || '--')}<br><span style="font-size:11px">${st.themeZt || 0}家涨停${st.themeAvgChg != null ? ` · 今 <span class="${chgClass(st.themeAvgChg)}">${fmtChg(st.themeAvgChg)}</span>` : ''}</span></td>
    <td><span class="expect-badge expect-${st.expect === '强' ? 'strong' : st.expect === '退潮' ? 'weak' : 'split'}">${esc(st.expect || '分歧')}</span></td>
    <td class="reason-cell" title="${esc(st.tech || '')}">${esc(st.tech || '--')}</td>
    <td>${fmtAmt(st.floatCap)}</td>
    <td class="rating-cell" title="${esc(st.why || '')}"><span class="rating-stars">${esc(st.rating || '★')}</span><br><span class="rating-advice">${esc(st.advice || '')}</span></td>
  </tr>`).join('')}</tbody></table>`;
}

function refreshActive(silent = false) {
  if (state.tab === 'review') return loadReview(silent);
  if (state.tab === 'picks') return loadPicks(silent);
  if (state.tab === 'lbdip') return loadLbDip(silent);
  if (state.tab === 'relay') return loadRelay(silent);
  return loadRealtime(silent);
}

function startGlobalTimer() {
  stopGlobalTimer();
  state.countdown = 30;
  state.timer = setInterval(() => {
    if (!state.autoRefresh) return;
    state.countdown--;
    $('#countdown').textContent = `${state.countdown}s`;
    if (state.countdown <= 0) {
      state.countdown = 30;
      refreshActive(true).catch(() => {});
    }
  }, 1000);
}
function stopGlobalTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/* ---------- 个股抽屉 ---------- */
function guessSetcode(code) {
  if (/^6/.test(code)) return '1';
  if (/^(00|30)/.test(code)) return '0';
  if (/^(43|83|87|92)/.test(code)) return '2';
  if (/^88/.test(code)) return '1';
  return '1';
}

async function openDrawer(code, market, name) {
  if (!code) return;
  $('#drawer').classList.add('open');
  $('#drawerMask').classList.add('open');
  $('#dName').textContent = name || code;
  $('#dCode').textContent = code;
  $('#dPrice').textContent = '--';
  $('#dChg').textContent = '';
  $('#dMeta').innerHTML = '';
  $('#dExtra').innerHTML = '';
  $('#klineChart').innerHTML = '<div class="chart-fallback">加载 K 线中…</div>';

  try {
    const r = await api(`/api/stock?code=${encodeURIComponent(code)}&setcode=${encodeURIComponent(market || guessSetcode(code))}`);
    if (r.mode === 'error') throw new Error(r.error);
    renderDrawer(r.data, name);
  } catch (e) {
    $('#klineChart').innerHTML = `<div class="chart-fallback">加载失败：${esc(e.message)}</div>`;
  }
}

function renderDrawer(data, fallbackName) {
  const q = data.quote || {};
  const name = (q.BaseInfo && q.BaseInfo.Name) || fallbackName || '--';
  $('#dName').textContent = name;
  const close = q.HQInfo ? q.HQInfo.Close : null;
  const prevChg = q.ProInfo ? q.ProInfo['昨日涨幅'] : null;
  if (close != null) {
    $('#dPrice').textContent = Number(close).toFixed(2);
    $('#dPrice').className = 'drawer-price ' + chgClass(prevChg);
    $('#dChg').textContent = prevChg != null ? `昨日 ${fmtChg(Number(prevChg))}` : '';
    $('#dChg').className = 'drawer-chg ' + chgClass(prevChg);
  }
  // 元信息
  const meta = [];
  if (q.ExtInfo) {
    if (q.ExtInfo.ZSZ) meta.push(['总市值', fmtAmt(q.ExtInfo.ZSZ)]);
    if (q.ExtInfo.SYL) meta.push(['市盈率', Number(q.ExtInfo.SYL).toFixed(2)]);
    if (q.ExtInfo.LTGB) meta.push(['流通股本', fmtAmt(q.ExtInfo.LTGB)]);
  }
  if (q.ProInfo) {
    for (const k of ['5日涨幅', '20日涨幅', '年初至今']) {
      if (q.ProInfo[k] != null) meta.push([k, fmtChg(Number(q.ProInfo[k]))]);
    }
  }
  $('#dMeta').innerHTML = meta.map(([k, v]) => `<div class="meta-item"><div class="mk">${esc(k)}</div><div class="mv">${esc(String(v))}</div></div>`).join('');

  // 资金流
  const cap = data.capital;
  if (cap && (cap.summary || (cap.tables && cap.tables.length))) {
    const firstTable = cap.tables && cap.tables[0];
    const rows = firstTable ? firstTable.rows.slice(0, 4) : [];
    $('#dExtra').innerHTML = `<div class="panel" style="margin-top:4px"><div class="panel-head"><h3>主力资金</h3></div><div class="panel-body" style="font-size:12.5px;color:var(--muted)">
      ${cap.summary ? `<p style="margin-bottom:8px">${esc(cap.summary)}</p>` : ''}
      ${rows.map(r => `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border-soft)">${Object.entries(r).slice(0, 4).map(([k, v]) => `<span>${esc(k)}：<b class="mono">${esc(String(v))}</b></span>`).join('')}</div>`).join('')}
    </div></div>`;
  }

  renderKline(data.kline);
}

function renderKline(kline) {
  const box = $('#klineChart');
  if (!window.echarts) {
    box.innerHTML = '<div class="chart-fallback">图表库加载失败（CDN 不可达）</div>';
    return;
  }
  const rows = (kline && (kline.Rows || kline.rows)) || [];
  if (!rows.length) {
    box.innerHTML = '<div class="chart-fallback">暂无 K 线数据</div>';
    return;
  }
  const pick = (row, ...keys) => {
    for (const k of keys) {
      if (row[k] !== undefined) return row[k];
      const lk = Object.keys(row).find(x => x.toLowerCase() === k.toLowerCase());
      if (lk !== undefined) return row[lk];
    }
    return null;
  };
  const dates = rows.map(r => String(pick(r, 'Data', 'Date', 'date') || ''));
  const k = rows.map(r => [pick(r, 'Open'), pick(r, 'Close'), pick(r, 'Low'), pick(r, 'High')].map(Number));
  const vols = rows.map((r, i) => ({ value: Number(pick(r, 'Volume') || 0), itemStyle: { color: k[i][1] >= k[i][0] ? 'rgba(240,69,62,.55)' : 'rgba(20,184,127,.55)' } }));

  if (state.klineChart) state.klineChart.dispose();
  state.klineChart = echarts.init(box);
  state.klineChart.setOption({
    backgroundColor: 'transparent',
    animation: false,
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: '#171c27', borderColor: '#232a38', textStyle: { color: '#e6e9f0', fontSize: 12 } },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 55, right: 16, top: 18, height: '58%' },
      { left: 55, right: 16, top: '76%', height: '16%' },
    ],
    xAxis: [
      { type: 'category', data: dates, gridIndex: 0, axisLine: { lineStyle: { color: '#232a38' } }, axisLabel: { color: '#5c6478', fontSize: 10 }, boundaryGap: true },
      { type: 'category', data: dates, gridIndex: 1, axisLine: { lineStyle: { color: '#232a38' } }, axisLabel: { show: false }, boundaryGap: true },
    ],
    yAxis: [
      { scale: true, gridIndex: 0, splitLine: { lineStyle: { color: '#1b2130' } }, axisLabel: { color: '#5c6478', fontSize: 10 } },
      { scale: true, gridIndex: 1, splitLine: { show: false }, axisLabel: { show: false } },
    ],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], start: 40, end: 100 }],
    series: [
      {
        type: 'candlestick', data: k, xAxisIndex: 0, yAxisIndex: 0,
        itemStyle: { color: '#f0453e', color0: '#14b87f', borderColor: '#f0453e', borderColor0: '#14b87f' },
      },
      { type: 'bar', data: vols, xAxisIndex: 1, yAxisIndex: 1 },
    ],
  });
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawerMask').classList.remove('open');
}

/* ---------- 设置弹窗 ---------- */
function openSettings() {
  $('#settingsMask').classList.add('open');
  $('#apiKeyInput').value = '';
  $('#keyTestResult').textContent = '';
  $('#keyTestResult').className = 'modal-result';
}
function closeSettings() { $('#settingsMask').classList.remove('open'); }

async function testKey() {
  const key = $('#apiKeyInput').value.trim();
  const result = $('#keyTestResult');
  result.textContent = '测试中…';
  result.className = 'modal-result';
  const r = await api('/api/config/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: key }) });
  result.textContent = r.ok ? '连接成功，数据服务可用' : `连接失败：${r.error || '未知错误'}`;
  result.className = 'modal-result ' + (r.ok ? 'ok' : 'fail');
}

async function saveKey() {
  const key = $('#apiKeyInput').value.trim();
  await api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: key }) });
  await loadStatus();
  closeSettings();
  toast(key ? 'API Key 已保存，切换为实时数据模式' : '已清除 API Key，切换为快照模式');
  switchTab(state.tab, true);
}

/* ---------- Tab 切换 ---------- */
function switchTab(tab, force) {
  if (state.tab === tab && !force) return;
  state.tab = tab;
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${tab}`));
  if (tab === 'review') { if (!state.review || force) loadReview().catch(e => toast(e.message)); }
  if (tab === 'picks') { if (!state.picks || force) loadPicks().catch(e => toast(e.message)); }
  if (tab === 'realtime') { if (!state.realtime || force) loadRealtime().catch(e => toast(e.message)); }
  if (tab === 'lbdip') { if (!state.lbDip || force) loadLbDip().catch(e => toast(e.message)); }
  if (tab === 'relay') { if (!state.relay || force) loadRelay().catch(e => toast(e.message)); }
  state.countdown = 30;
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  $$('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#refreshReview').addEventListener('click', () => { state.countdown = 30; loadReview().then(() => toast('复盘数据已刷新')).catch(e => toast(e.message)); });
  $('#refreshPicks').addEventListener('click', () => { state.countdown = 30; loadPicks().then(() => toast('选股结果已刷新')).catch(e => toast(e.message)); });
  $('#refreshRealtime').addEventListener('click', () => { state.countdown = 30; loadRealtime(true).catch(e => toast(e.message)); });
  $('#refreshLb').addEventListener('click', () => { state.countdown = 30; loadLbDip().then(() => toast('连板低吸已刷新')).catch(e => toast(e.message)); });
  $('#refreshRelay').addEventListener('click', () => { state.countdown = 30; loadRelay().then(() => toast('明日接力已刷新')).catch(e => toast(e.message)); });
  $('#autoSwitch').addEventListener('change', e => { state.autoRefresh = e.target.checked; $('#countdown').textContent = ''; });

  $('#boardFilter').addEventListener('click', e => {
    const btn = e.target.closest('.bf-btn');
    if (!btn) return;
    state.boardFilter = btn.dataset.board;
    renderBoardFilter();
    rerenderCurrent();
  });
  $('#capFilter').addEventListener('click', e => {
    const btn = e.target.closest('.bf-btn');
    if (!btn) return;
    state.capFilter = btn.dataset.cap;
    renderCapFilter();
    rerenderCurrent();
  });
  $('#bannerSettingsBtn').addEventListener('click', openSettings);

  $('#strategyTabs').addEventListener('click', e => {
    const btn = e.target.closest('.strategy-tab');
    if (!btn) return;
    state.picksIdx = Number(btn.dataset.idx);
    renderStrategyTabs();
    renderPicksTable();
  });

  // 表格/筹码点击 → 个股抽屉（事件委托）
  document.addEventListener('click', e => {
    const row = e.target.closest('tr[data-code], .stock-chip[data-code]');
    if (row) openDrawer(row.dataset.code, row.dataset.market, row.dataset.name);
  });

  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerMask').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawer(); closeSettings(); } });

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#settingsMask').addEventListener('click', e => { if (e.target === $('#settingsMask')) closeSettings(); });
  $('#testKeyBtn').addEventListener('click', () => testKey().catch(e => toast(e.message)));
  $('#saveKeyBtn').addEventListener('click', () => saveKey().catch(e => toast(e.message)));
  $('#toggleKeyVisible').addEventListener('click', () => {
    const inp = $('#apiKeyInput');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    $('#toggleKeyVisible').textContent = inp.type === 'password' ? '显示' : '隐藏';
  });

  window.addEventListener('resize', () => { if (state.klineChart) state.klineChart.resize(); });
}

/* ---------- 启动 ---------- */
(async function init() {
  bindEvents();
  renderBoardFilter();
  renderCapFilter();
  await loadStatus();
  switchTab('review', true);
  startGlobalTimer();
})();
