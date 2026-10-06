// 温控口径都集中在这里：超限段、断链、MKT、放行判定
// 库位变更口径：批次可在冷库/车厢之间转移，变更登记形成时间线；
// 记录按"记录时刻"归属到当时所在的段，边界时刻（变更时刻那条记录）归变更后（新库位）这一段。
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
    // 后来的是手工更正记录，则覆盖自动记录
    if (row.source === '人工') picked[key] = row;
  }
  return order.map((key) => picked[key]);
}

// 超限：连续超出上下限的时段，回到范围内即断开；
// 每段时长按该段相邻记录的实际时刻差累加（最后一条只知时刻、没有后续，不计时长）
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  let previousAt = '';
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      if (current) {
        current.endAt = row.at;
        current.minutes += previousAt ? store.minutesBetween(previousAt, row.at) : 0;
        current.peakC = value > current.peakC ? value : current.peakC;
        current.points += 1;
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
        segments.push(current);
      }
    } else {
      current = null;
    }
    previousAt = row.at;
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0 });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStatsRows(rows, settings) {
  const stats = segmentStats(rows, settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

function excursionStats(data, batchId) {
  return excursionStatsRows(effectiveRecords(data, batchId), data.settings);
}

// 断链：相邻记录的时刻差超过门槛，缺口时长按实际时刻差算
function chainGapsRows(rows, settings) {
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({ from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: minutes });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

function chainGaps(data, batchId) {
  return chainGapsRows(effectiveRecords(data, batchId), data.settings);
}

// MKT：平均动力学温度
// MKT = −Ea / (R × ln((Σ e^(−Ea/(R·T))) / n)) − 273.15，T 用开尔文
function mktRowsCelsius(rows, settings) {
  if (!rows.length) return 0;
  const ea = Number(settings.mktActivationEnergy || 83144);
  const r = Number(settings.gasConstant || 8.314);
  const n = rows.length;
  let sum = 0;
  for (const row of rows) {
    const kelvin = Number(row.temperatureC) + 273.15;
    sum += Math.exp(-ea / (r * kelvin));
  }
  const mktKelvin = -ea / (r * Math.log(sum / n));
  return store.round(mktKelvin - 273.15, 2);
}

function mktCelsius(data, batchId) {
  return mktRowsCelsius(effectiveRecords(data, batchId), data.settings);
}

// 探头校准有效期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

function expiredProbeRows(data, rows) {
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

function expiredProbes(data, batchId, day) {
  return expiredProbeRows(data, effectiveRecords(data, batchId));
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

function monthlyExcursionMinutes(data, batchId) {
  return accumulatedExcursionMinutes(data, batchId);
}

/* ---------- 库位变更时间线与分段 ---------- */

function sortedChanges(data, batchId) {
  return (data.changes || [])
    .filter((c) => c.batchId === batchId)
    .slice()
    .sort((a, b) => (a.changedAt < b.changedAt ? -1 : a.changedAt > b.changedAt ? 1 : a.id < b.id ? -1 : 1));
}

// 时间线：从入库起，每次变更切一段。边界时刻归变更后（新库位）这一段。
function locationTimeline(data, batch) {
  const changes = sortedChanges(data, batch.id);
  const segments = [{ index: 0, roomId: batch.roomId, startAt: batch.loadedAt, endAt: null, changeId: null }];
  changes.forEach((c, i) => {
    segments[i].endAt = c.changedAt;
    segments.push({ index: i + 1, roomId: c.toRoomId, startAt: c.changedAt, endAt: null, changeId: c.id });
  });
  return { changes, segments };
}

function segmentIndexAt(segments, at) {
  let idx = 0;
  for (const seg of segments) {
    if (String(at) >= String(seg.startAt)) idx = seg.index;
  }
  return idx;
}

// 某一时刻批次所在的库位（登记变更后，批次的"当前库位"即时间线末段）
function roomIdAt(data, batch, at) {
  const timeline = locationTimeline(data, batch);
  return timeline.segments[segmentIndexAt(timeline.segments, at)].roomId;
}

function conditionsFrom(rows, settings, data) {
  const stats = segmentStats(rows, settings);
  const chain = chainGapsRows(rows, settings);
  const expired = expiredProbeRows(data, rows);
  const conditions = [
    { key: 'longest', ok: stats.longestMinutes <= Number(settings.allowExcursionMinutes), value: stats.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: stats.totalMinutes <= Number(settings.allowTotalExcursionMinutes), value: stats.totalMinutes, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟' },
    { key: 'chain', ok: chain.gapCount === 0, value: chain.gapCount, limit: 0, text: '全程没有断链' },
    { key: 'calibration', ok: expired.length === 0, value: expired.length, limit: 0, text: '参与判定的探头都在校准有效期内' },
  ];
  return {
    stats, chain, expired, conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
  };
}

// 放行判定：最长超限、累计超限、断链、探头校准四条
// asOf 给定时只采用记录时刻 <= asOf 的数据（用于放行后重放当时判定，不得用后来的数据改过去结论）
function releaseCheckAt(data, batch, asOf) {
  const settings = data.settings;
  let rows = effectiveRecords(data, batch.id);
  if (asOf) rows = rows.filter((r) => String(r.at) <= String(asOf));
  const base = conditionsFrom(rows, settings, data);
  return {
    asOf: asOf || '',
    mkt: mktRowsCelsius(rows, settings),
    longestMinutes: base.stats.longestMinutes,
    totalMinutes: base.stats.totalMinutes,
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
    chain: base.chain,
    expiredProbes: base.expired,
    conditions: base.conditions,
    pass: base.pass && rows.length > 0,
    hasData: rows.length > 0,
    failed: rows.length === 0 ? ['no-record'] : base.failed,
  };
}

function releaseCheck(data, batch) {
  return releaseCheckAt(data, batch, null);
}

// 分段分析：每一段（每个库位区间）各自的记录条数、超限段、断链与四条判定。
// 跨变更边界的相邻两条记录不算同段内的断链（归属不同库位）。
// asOf 给定时只看记录时刻 <= asOf 的数据（用于登记变更时把变更前/后的切分固定在变更时刻对照）。
function segmentedAnalysis(data, batch, asOf) {
  return segmentedAnalysisForChanges(data, batch, sortedChanges(data, batch.id), asOf);
}

// 同上，但可以指定一组变更（例如登记新变更后，用"排除这条变更"的清单重算变更前旧归属）
function segmentedAnalysisForChanges(data, batch, changeList, asOf) {
  const settings = data.settings;
  const segments = [{ index: 0, roomId: batch.roomId, startAt: batch.loadedAt, endAt: null, changeId: null }];
  changeList.slice().sort((a, b) => (a.changedAt < b.changedAt ? -1 : a.changedAt > b.changedAt ? 1 : a.id < b.id ? -1 : 1))
    .forEach((c, i) => {
      segments[i].endAt = c.changedAt;
      segments.push({ index: i + 1, roomId: c.toRoomId, startAt: c.changedAt, endAt: null, changeId: c.id });
    });
  let rows = effectiveRecords(data, batch.id);
  if (asOf) rows = rows.filter((r) => String(r.at) <= String(asOf));
  const roomLabel = (id) => {
    const room = data.rooms.find((x) => x.id === id);
    return room ? room.code + ' ' + room.name : '(已删除库位 ' + id + ')';
  };
  let resultSegments = segments.map((seg) => {
    if (asOf && String(seg.startAt) > String(asOf)) return null;
    const srows = rows.filter((r) => segmentIndexAt(segments, r.at) === seg.index);
    const judged = conditionsFrom(srows, settings, data);
    return {
      index: seg.index,
      roomId: seg.roomId,
      roomCode: roomLabel(seg.roomId),
      startAt: seg.startAt,
      endAt: asOf && (seg.endAt === null || String(seg.endAt) > String(asOf)) ? asOf : seg.endAt,
      ongoing: seg.endAt === null && !asOf,
      changeId: seg.changeId,
      recordCount: srows.length,
      firstAt: srows.length ? srows[0].at : '',
      lastAt: srows.length ? srows[srows.length - 1].at : '',
      excursionSegments: judged.stats.segments,
      excursionSegmentCount: judged.stats.segmentCount,
      longestMinutes: judged.stats.longestMinutes,
      totalMinutes: judged.stats.totalMinutes,
      chainGaps: judged.chain.gaps,
      gapCount: judged.chain.gapCount,
      mkt: mktRowsCelsius(srows, settings),
      expiredProbes: judged.expired,
      conditions: judged.conditions,
      pass: judged.pass && srows.length > 0,
      hasData: srows.length > 0,
      failed: srows.length === 0 ? ['no-record'] : judged.failed,
    };
  }).filter(Boolean);
  if (asOf) resultSegments = resultSegments.filter((s) => String(s.startAt) <= String(asOf));
  // 跨段转移缺口：相邻两条记录归属不同库位段（搬运/换车厢期间的监控中断）。
  // 段内断链仍按整段判；转移缺口只挂在变更边界上，不计进任何一段的段内断链。
  const boundaryGaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prevIdx = segmentIndexAt(segments, rows[i - 1].at);
    const curIdx = segmentIndexAt(segments, rows[i].at);
    if (prevIdx !== curIdx) {
      const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
      if (minutes > Number(settings.chainGapMinutes)) {
        boundaryGaps.push({
          changeId: segments[curIdx].changeId,
          fromSegment: prevIdx,
          toSegment: curIdx,
          fromRoomCode: roomLabel(segments[prevIdx].roomId),
          toRoomCode: roomLabel(segments[curIdx].roomId),
          from: rows[i - 1].at,
          to: rows[i].at,
          minutes,
        });
      }
    }
  }
  return { changes: changeList, segments: resultSegments, boundaryGaps, changeCount: changeList.length };
}

module.exports = {
  toDate,
  probeOf,
  recordsOfBatch,
  effectiveRecords,
  segmentStats,
  excursionStats,
  chainGaps,
  chainGapsRows,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  monthlyExcursionMinutes,
  locationTimeline,
  segmentIndexAt,
  roomIdAt,
  segmentedAnalysis,
  segmentedAnalysisForChanges,
  releaseCheckAt,
  releaseCheck,
};
