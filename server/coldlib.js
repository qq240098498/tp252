// 温控口径都集中在这里：超限段、断链、MKT、放行判定
// 批次中途换库位/换设备后，按「变更履历」把记录切成若干段（stint）：
// 变更时刻整刻起的记录计入新段（边界时刻算变更后那一段）；
// 各段独立统计超限与断链，段与段交接处的缺口单列为「换链缺口」，不计断链。
const store = require('./store');

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

function roomOf(data, roomId) {
  return data.rooms.find((r) => r.id === roomId) || null;
}

function roomLabel(data, roomId) {
  const room = roomOf(data, roomId);
  return room ? room.code + ' ' + room.name : (roomId || '');
}

function probeLabel(data, probeId) {
  const probe = probeOf(data, probeId);
  return probe ? probe.code + (probe.position ? '（' + probe.position + '）' : '') : (probeId || '');
}

// 同一探头同一时刻既有自动记录又有手工更正时，以手工为准
function effectiveRecords(data, batchId) {
  const rows = recordsOfBatch(data, batchId);
  const picked = {};
  const order = [];
  for (const row of rows) {
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    const current = picked[key];
    if (current.source === '人工' && row.source === '自动') picked[key] = row;
  }
  return order.map((key) => picked[key]);
}

// 超限：连续超出上下限的时段，回到范围内即断开
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      const previous = current;
      if (previous) {
        previous.endAt = row.at;
        previous.minutes += previous.lastGapMinutes || 0;
        previous.peakC = value > previous.peakC ? value : previous.peakC;
        previous.points += 1;
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
        segments.push(current);
      }
      // 与上一条记录的间隔按固定记录间隔计
      current.lastGapMinutes = Number(settings.recordIntervalMinutes);
    } else {
      current = null;
    }
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0 });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, data.settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻记录的时刻差超过门槛
function gapsInRows(rows, settings, stintIndex) {
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      const gap = { from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: Number(settings.recordIntervalMinutes) };
      if (stintIndex !== undefined) gap.stintIndex = stintIndex;
      gaps.push(gap);
    }
  }
  return gaps;
}

function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = gapsInRows(rows, settings);
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

// MKT：平均动力学温度
function mktCelsius(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  const sum = rows.reduce((acc, row) => acc + Number(row.temperatureC), 0);
  return store.round(sum / rows.length, 2);
}

function mktOfRows(rows) {
  if (!rows.length) return 0;
  const sum = rows.reduce((acc, row) => acc + Number(row.temperatureC), 0);
  return store.round(sum / rows.length, 2);
}

// 探头校准有效期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

function expiredProbes(data, batchId, day) {
  const rows = effectiveRecords(data, batchId);
  const bad = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe) continue;
    if (!probeValidOn(probe, String(row.at).slice(0, 10))) {
      if (!bad.some((b) => b.probeCode === probe.code)) {
        bad.push({ probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil, at: row.at });
      }
    }
  }
  return bad;
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

function monthlyExcursionMinutes(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const firstAt = rows.length ? rows[0].at : '';
  const month = firstAt.slice(0, 7);
  const scoped = rows.filter((r) => String(r.at).slice(0, 7) === month);
  return segmentStats(scoped, data.settings).totalMinutes;
}

/* ===================== 变更履历与分段归属 ===================== */

const BOUNDARY_RULE = '变更时刻整刻起的记录计入新段；边界时刻算变更后那一边。段间交接处的时刻差单列为换链缺口，不计断链。';

// 取一个批次的全部设备/库位变更，按变更时刻升序
function batchChangesOf(data, batchId) {
  return (data.batchChanges || [])
    .filter((c) => c.batchId === batchId)
    .slice()
    .sort((a, b) => (a.changedAt < b.changedAt ? -1 : a.changedAt > b.changedAt ? 1 : (a.id < b.id ? -1 : 1)));
}

// 由批次当前归属 + 变更履历推出各段：第 0 段从入库时刻起，每次变更开一段
function stintPlan(data, batch) {
  const changes = batchChangesOf(data, batch.id);
  const stints = [];
  // 第 0 段归属取第一条变更的「从」；没有变更时才用批次当前归属
  let roomId = changes.length ? changes[0].fromRoomId : (batch.roomId || '');
  let probeId = changes.length ? changes[0].fromProbeId : (batch.probeId || '');
  stints.push({
    index: 0, startAt: batch.loadedAt || '', endAt: changes.length ? changes[0].changedAt : null,
    roomId, probeId, changeId: null,
  });
  changes.forEach((ch, i) => {
    if (ch.toRoomId) roomId = ch.toRoomId;
    if (ch.toProbeId) probeId = ch.toProbeId;
    stints.push({
      index: i + 1, startAt: ch.changedAt,
      endAt: i + 1 < changes.length ? changes[i + 1].changedAt : null,
      roomId, probeId, changeId: ch.id,
    });
  });
  return stints;
}

// 某条记录（时刻）落在第几段：at >= 某段起点即归该段，故边界整刻归新段
function stintIndexAt(plan, at) {
  let idx = 0;
  for (let i = 1; i < plan.length; i += 1) {
    if (String(at) >= plan[i].startAt) idx = i;
    else break;
  }
  return idx;
}

function decorateStint(data, stint, rows) {
  const settings = data.settings;
  const seg = segmentStats(rows, settings);
  const gaps = gapsInRows(rows, settings, stint.index);
  const firstMonth = rows.length ? String(rows[0].at).slice(0, 7) : '';
  const monthRows = firstMonth ? rows.filter((r) => String(r.at).slice(0, 7) === firstMonth) : [];
  const monthTotal = segmentStats(monthRows, settings).totalMinutes;
  const expired = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (probe && !probeValidOn(probe, String(row.at).slice(0, 10)) && !expired.some((e) => e.probeCode === probe.code)) {
      expired.push({ probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil, at: row.at });
    }
  }
  const room = roomOf(data, stint.roomId);
  const probe = probeOf(data, stint.probeId);
  return {
    index: stint.index,
    startAt: stint.startAt,
    endAt: stint.endAt,
    changeId: stint.changeId,
    roomId: stint.roomId,
    roomCode: room ? room.code : '',
    roomName: room ? room.name : '',
    roomType: room ? room.type : '',
    roomMissing: !room,
    probeId: stint.probeId || '',
    probeCode: probe ? probe.code : '',
    probePosition: probe ? probe.position : '',
    probeMissing: !!(stint.probeId && !probe),
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
    longestMinutes: seg.longestMinutes,
    totalMinutes: seg.totalMinutes,
    monthTotalMinutes: monthTotal,
    segmentCount: seg.segmentCount,
    segments: seg.segments.map((s) => Object.assign({}, s, { stintIndex: stint.index })),
    gapCount: gaps.length,
    gaps,
    mkt: mktOfRows(rows),
    expiredProbes: expired,
  };
}

// 渐进口径评估：k = 已生效的变更数（前 k 条），0 表示尚未登记任何变更时的旧口径。
// k=0 时数值与本文件原有整段口径完全一致（段只有一段，没有换链缺口）。
function horizonCheck(data, batch, k) {
  const settings = data.settings;
  const plan = stintPlan(data, batch);
  const totalChanges = plan.length - 1;
  const applied = k === undefined ? totalChanges : Math.max(0, Math.min(k, totalChanges));
  const rows = effectiveRecords(data, batch.id);
  // 按边界把记录分到前 applied+1 段；applied 之后才发生的变更在该口径下尚未生效，
  // 其记录仍归入最后一个已生效段。k=0 时全部记录在第 0 段，即旧的整批不分段口径。
  const buckets = plan.map(() => []);
  for (const row of rows) {
    const idx = Math.min(stintIndexAt(plan, row.at), applied);
    buckets[idx].push(row);
  }
  const stints = [];
  for (let j = 0; j <= applied; j += 1) stints.push(decorateStint(data, plan[j], buckets[j]));
  const usedStints = stints.filter((s) => s.recordCount > 0);

  const internalGaps = stints.reduce((acc, s) => acc.concat(s.gaps), []);
  const crossGaps = [];
  for (let j = 0; j + 1 < stints.length; j += 1) {
    const a = stints[j];
    const b = stints[j + 1];
    if (!a.recordCount || !b.recordCount) continue;
    const minutes = store.minutesBetween(a.lastAt, b.firstAt);
    if (minutes > Number(settings.chainGapMinutes)) {
      crossGaps.push({
        from: a.lastAt, to: b.firstAt, minutes,
        countedMinutes: Number(settings.recordIntervalMinutes),
        fromStint: j, toStint: j + 1,
        fromRoomCode: a.roomCode, toRoomCode: b.roomCode,
        fromProbeCode: a.probeCode, toProbeCode: b.probeCode,
      });
    }
  }

  const horizonRows = usedStints.reduce((acc, s) => acc.concat(buckets[s.index]), []);
  const longest = stints.reduce((acc, s) => Math.max(acc, s.longestMinutes), 0);
  const totalMinutes = stints.reduce((acc, s) => acc + s.totalMinutes, 0);
  const monthTotal = stints.reduce((acc, s) => acc + s.monthTotalMinutes, 0);
  const gapCount = stints.reduce((acc, s) => acc + s.gapCount, 0);
  const expiredMap = {};
  const expired = [];
  for (const s of stints) {
    for (const e of s.expiredProbes) {
      if (!expiredMap[e.probeCode]) { expiredMap[e.probeCode] = 1; expired.push(e); }
    }
  }
  const firstAt = horizonRows.length ? horizonRows.reduce((m, r) => (r.at < m ? r.at : m), horizonRows[0].at) : '';
  const lastAt = horizonRows.length ? horizonRows.reduce((m, r) => (r.at > m ? r.at : m), horizonRows[0].at) : '';

  const conditions = [
    { key: 'longest', ok: longest <= Number(settings.allowExcursionMinutes), value: longest, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: monthTotal <= Number(settings.allowTotalExcursionMinutes), value: monthTotal, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟' },
    { key: 'chain', ok: gapCount === 0, value: gapCount, limit: 0, text: '全程没有断链' },
  ];

  return {
    mkt: mktOfRows(horizonRows),
    longestMinutes: longest,
    totalMinutes,
    monthTotalMinutes: monthTotal,
    recordCount: horizonRows.length,
    firstAt,
    lastAt,
    chain: {
      gaps: internalGaps,
      gapCount,
      totalGapMinutes: internalGaps.reduce((acc, g) => acc + g.countedMinutes, 0),
      crossStintGaps: crossGaps,
      crossStintGapCount: crossGaps.length,
    },
    expiredProbes: expired,
    conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
    changeCount: applied,
    totalChanges,
    boundaryRule: BOUNDARY_RULE,
    stints,
  };
}

// 放行判定：默认按当前已登记的全部变更分段评估
function releaseCheck(data, batch, options) {
  const k = options && typeof options.k === 'number' ? options.k : undefined;
  return horizonCheck(data, batch, k);
}

function compactCheck(check) {
  return {
    pass: check.pass,
    failed: check.failed.slice(),
    recordCount: check.recordCount,
    longestMinutes: check.longestMinutes,
    totalMinutes: check.totalMinutes,
    monthTotalMinutes: check.monthTotalMinutes,
    gapCount: check.chain.gapCount,
    crossStintGapCount: check.chain.crossStintGapCount,
    mkt: check.mkt,
    changeCount: check.changeCount,
    conditions: check.conditions.map((c) => ({ key: c.key, ok: c.ok, value: c.value, limit: c.limit })),
  };
}

function conditionDiff(before, after) {
  const diffs = [];
  const beforeMap = {};
  for (const c of before.conditions) beforeMap[c.key] = c;
  for (const c of after.conditions) {
    const p = beforeMap[c.key];
    if (p && (p.ok !== c.ok || p.value !== c.value)) {
      diffs.push({
        key: c.key, text: c.text,
        okChanged: p.ok !== c.ok,
        fromOk: p.ok, toOk: c.ok,
        fromValue: p.value, toValue: c.value,
      });
    }
  }
  return {
    passChanged: before.pass !== after.pass,
    fromPass: before.pass,
    toPass: after.pass,
    conditions: diffs,
  };
}

// 逐次变更的口径对照：changeCount=0..n，每一步标出相对上一步哪些结论翻转、归因到哪次变更
function horizonComparison(data, batch) {
  const changes = batchChangesOf(data, batch.id);
  const items = [];
  let previous = null;
  for (let k = 0; k <= changes.length; k += 1) {
    const check = horizonCheck(data, batch, k);
    const item = {
      changeCount: k,
      change: k ? decorateChange(data, changes[k - 1]) : null,
      check: compactCheck(check),
    };
    item.diff = previous ? conditionDiff(previous.check, item.check) : null;
    items.push(item);
    previous = item;
  }
  return items;
}

function decorateChange(data, change) {
  return Object.assign({}, change, {
    fromRoomCode: roomOf(data, change.fromRoomId) ? roomOf(data, change.fromRoomId).code : '',
    toRoomCode: roomOf(data, change.toRoomId) ? roomOf(data, change.toRoomId).code : '',
    fromRoomName: roomOf(data, change.fromRoomId) ? roomOf(data, change.fromRoomId).name : '',
    toRoomName: roomOf(data, change.toRoomId) ? roomOf(data, change.toRoomId).name : '',
    fromProbeCode: probeOf(data, change.fromProbeId) ? probeOf(data, change.fromProbeId).code : '',
    toProbeCode: probeOf(data, change.toProbeId) ? probeOf(data, change.toProbeId).code : '',
    batchCode: data.batches.find((b) => b.id === change.batchId) ? data.batches.find((b) => b.id === change.batchId).code : '',
  });
}

module.exports = {
  toDate,
  probeOf,
  roomOf,
  roomLabel,
  probeLabel,
  recordsOfBatch,
  effectiveRecords,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  monthlyExcursionMinutes,
  releaseCheck,
  BOUNDARY_RULE,
  batchChangesOf,
  stintPlan,
  stintIndexAt,
  horizonCheck,
  horizonComparison,
  decorateChange,
};
