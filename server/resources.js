const { AppError } = require('./errors');
const store = require('./store');
const coldlib = require('./coldlib');

const ROOM_STATUS = ['运行', '检修', '停用'];
const ROOM_TYPE = ['冷藏库', '冷藏车', '冷冻库'];
const PROBE_STATUS = ['在用', '停用', '送检'];
const BATCH_STATUS = ['在库', '待放行', '已放行', '已拒收'];
const SOURCE_LIST = ['自动', '人工'];

function roomCode(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  return room ? room.code : '';
}
function batchCode(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  return batch ? batch.code : '';
}
function probeCode(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  return probe ? probe.code : '';
}

function decorateRoom(data, room) {
  const probes = data.probes.filter((p) => p.roomId === room.id);
  const here = data.batches.filter((b) => coldlib.roomIdAt(data, b, store.nowText()) === room.id);
  return Object.assign({}, room, {
    probeCount: probes.length,
    runningProbeCount: probes.filter((p) => p.status === '在用').length,
    batchCount: here.length,
    openBatchCount: here.filter((b) => b.status === '在库' || b.status === '待放行').length,
  });
}

function decorateProbe(data, probe) {
  const records = data.records.filter((r) => r.probeId === probe.id);
  return Object.assign({}, probe, {
    roomCode: roomCode(data, probe.roomId),
    recordCount: records.length,
    manualCount: records.filter((r) => r.source === '人工').length,
    expired: !coldlib.probeValidOn(probe, store.nowText().slice(0, 10)),
  });
}

function decorateBatch(data, batch) {
  const stats = coldlib.excursionStats(data, batch.id);
  const check = coldlib.releaseCheck(data, batch);
  const releases = data.releases.filter((r) => r.batchId === batch.id);
  const timeline = coldlib.locationTimeline(data, batch);
  const currentRoomId = coldlib.roomIdAt(data, batch, store.nowText());
  return Object.assign({}, batch, {
    roomId: currentRoomId,
    roomCode: roomCode(data, currentRoomId),
    registeredRoomId: batch.roomId,
    recordCount: stats.recordCount,
    longestExcursionMinutes: stats.longestMinutes,
    totalExcursionMinutes: stats.totalMinutes,
    mkt: check.mkt,
    chainGapCount: check.chain.gapCount,
    expiredProbeCodes: check.expiredProbes.map((p) => p.probeCode),
    releaseCheck: check,
    releaseCount: releases.length,
    lastDecision: releases.length ? releases[releases.length - 1].decision : '',
    changeCount: timeline.changes.length,
    lastChangeAt: timeline.changes.length ? timeline.changes[timeline.changes.length - 1].changedAt : '',
  });
}

function listRooms(data, query) {
  const q = query || {};
  let rows = data.rooms.slice();
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.type) rows = rows.filter((r) => r.type === q.type);
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((r) => [r.code, r.name, r.location].some((f) => String(f || '').toLowerCase().includes(kw)));
  }
  return rows.map((r) => decorateRoom(data, r)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function roomDetail(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  return Object.assign({}, decorateRoom(data, room), {
    probes: data.probes.filter((p) => p.roomId === id).map((p) => decorateProbe(data, p)),
    batches: data.batches.filter((b) => coldlib.roomIdAt(data, b, store.nowText()) === id).map((b) => decorateBatch(data, b)),
  });
}

function validateRoom(payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!String(merged.name || '').trim()) errors.name = '名称不能为空';
  if (!ROOM_TYPE.includes(merged.type)) errors.type = '类型只能是：' + ROOM_TYPE.join('、');
  if (!ROOM_STATUS.includes(merged.status)) errors.status = '状态只能是：' + ROOM_STATUS.join('、');
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有项目没通过校验', errors);
}

function createRoom(data, payload) {
  validateRoom(payload, null);
  const room = {
    id: store.nextId('rm', data.rooms),
    code: String(payload.code).trim(),
    name: String(payload.name).trim(),
    type: payload.type,
    location: String(payload.location || '').trim(),
    capacityPlt: Number(payload.capacityPlt) || 0,
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.rooms.push(room);
  return decorateRoom(data, room);
}

function updateRoom(data, id, payload) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  validateRoom(payload, room);
  const merged = Object.assign({}, room, payload);
  Object.assign(room, {
    name: String(merged.name).trim(),
    type: merged.type,
    location: String(merged.location || '').trim(),
    capacityPlt: Number(merged.capacityPlt) || 0,
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateRoom(data, room);
}

function removeRoom(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  const probesHere = data.probes.filter((p) => p.roomId === id).length;
  const batchesHere = data.batches.filter((b) => coldlib.roomIdAt(data, b, store.nowText()) === id).length;
  const changeRefs = (data.changes || []).filter((c) => c.fromRoomId === id || c.toRoomId === id).length;
  const registeredHere = data.batches.filter((b) => b.roomId === id).length - batchesHere;
  const used = probesHere + batchesHere + changeRefs + registeredHere;
  if (used > 0) throw new AppError(409, 'ROOM_IN_USE', '还有 ' + used + ' 项探头、当前/历史批次或变更登记引用这个库位，不能删除', { count: used });
  data.rooms = data.rooms.filter((r) => r.id !== id);
  return { removed: id };
}

function listProbes(data, query) {
  const q = query || {};
  let rows = data.probes.slice();
  if (q.roomId) rows = rows.filter((p) => p.roomId === q.roomId);
  if (q.status) rows = rows.filter((p) => p.status === q.status);
  return rows.map((p) => decorateProbe(data, p)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateProbe(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编号不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所属冷库不存在';
  if (!PROBE_STATUS.includes(merged.status)) errors.status = '状态只能是：' + PROBE_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.calibratedUntil || ''))) errors.calibratedUntil = '校准有效期要像 2026-12-31';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createProbe(data, payload) {
  validateProbe(data, payload, null);
  const probe = {
    id: store.nextId('pb', data.probes),
    code: String(payload.code).trim(),
    roomId: payload.roomId,
    position: String(payload.position || '').trim(),
    status: payload.status,
    calibratedUntil: String(payload.calibratedUntil),
    remark: String(payload.remark || ''),
  };
  data.probes.push(probe);
  return decorateProbe(data, probe);
}

function updateProbe(data, id, payload) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  validateProbe(data, payload, probe);
  const merged = Object.assign({}, probe, payload);
  Object.assign(probe, {
    roomId: merged.roomId,
    position: String(merged.position || '').trim(),
    status: merged.status,
    calibratedUntil: String(merged.calibratedUntil),
    remark: String(merged.remark || ''),
  });
  return decorateProbe(data, probe);
}

function removeProbe(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  const used = data.records.filter((r) => r.probeId === id).length;
  if (used > 0) throw new AppError(409, 'PROBE_IN_USE', '这个探头名下还有 ' + used + ' 条温度记录，不能删除', { count: used });
  data.probes = data.probes.filter((p) => p.id !== id);
  return { removed: id };
}

function listBatches(data, query) {
  const q = query || {};
  let rows = data.batches.slice();
  if (q.roomId) rows = rows.filter((b) => coldlib.roomIdAt(data, b, store.nowText()) === q.roomId);
  if (q.status) rows = rows.filter((b) => b.status === q.status);
  if (q.product) rows = rows.filter((b) => String(b.product || '').includes(q.product));
  const decorated = rows.map((b) => decorateBatch(data, b));
  return decorated.sort((a, b) => (a.loadedAt < b.loadedAt ? 1 : -1));
}

function decorateChange(data, c) {
  const roomName = (id) => {
    const room = data.rooms.find((r) => r.id === id);
    return room ? room.code + ' ' + room.name : '(已删除库位 ' + id + ')';
  };
  const batch = data.batches.find((b) => b.id === c.batchId);
  return Object.assign({}, c, {
    fromRoomCode: roomName(c.fromRoomId),
    toRoomCode: roomName(c.toRoomId),
    batchCode: batch ? batch.code : '',
    batchStatus: batch ? batch.status : '',
  });
}

function batchDetail(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const timelineData = coldlib.locationTimeline(data, batch);
  const rows = coldlib.recordsOfBatch(data, id).map((r) => {
    const segIdx = coldlib.segmentIndexAt(timelineData.segments, r.at);
    const seg = timelineData.segments[segIdx];
    const room = data.rooms.find((x) => x.id === seg.roomId);
    return Object.assign({}, r, {
      probeCode: probeCode(data, r.probeId),
      segmentIndex: segIdx,
      roomId: seg.roomId,
      roomCode: room ? room.code : '',
      probeExpired: !coldlib.probeValidOn(coldlib.probeOf(data, r.probeId), String(r.at).slice(0, 10)),
    });
  });
  const analysis = coldlib.segmentedAnalysis(data, batch);
  // 每次放行当时采用的是哪个库位段、哪一段的数据：按放行单冻结的 dataScope 标注，缺快照的老单据回退推断
  const releases = data.releases.filter((r) => r.batchId === id).slice().sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1)).map((r) => {
    let scopeSegments = [];
    if (r.dataScope && Array.isArray(r.dataScope.segmentIndexes)) {
      scopeSegments = r.dataScope.segmentIndexes.slice();
    } else {
      scopeSegments = analysis.segments.filter((s) => String(s.startAt) <= String(r.decidedAt)).map((s) => s.index);
    }
    return Object.assign({}, r, {
      scopeSegmentIndexes: scopeSegments,
      scopeRooms: scopeSegments.map((i) => (analysis.segments[i] || {}).roomCode).filter(Boolean),
      scopeAsOf: r.dataScope ? r.dataScope.asOf : r.decidedAt,
      scopeRecordCount: r.dataScope ? r.dataScope.recordCount : null,
      hasDataScope: !!(r.dataScope && Array.isArray(r.dataScope.segmentIndexes)),
    });
  });
  return Object.assign({}, decorateBatch(data, batch), {
    records: rows,
    effectiveRecords: coldlib.effectiveRecords(data, id).map((r) => Object.assign({}, r, { probeCode: probeCode(data, r.probeId) })),
    segments: coldlib.excursionStats(data, id).segments,
    chainGaps: coldlib.chainGaps(data, id).gaps,
    changes: timelineData.changes.map((c) => decorateChange(data, c)),
    locationSegments: analysis.segments,
    boundaryGaps: analysis.boundaryGaps,
    releases,
  });
}

function validateBatch(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '批次号不能为空';
  if (!String(merged.product || '').trim()) errors.product = '品名不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所在冷库不存在';
  if (!BATCH_STATUS.includes(merged.status)) errors.status = '状态只能是：' + BATCH_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(merged.loadedAt || ''))) errors.loadedAt = '入库时刻格式要像 2026-09-01 08:00:00';
  const units = Number(merged.units);
  if (!Number.isFinite(units) || units <= 0) errors.units = '件数要是大于零的数';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createBatch(data, payload) {
  validateBatch(data, payload, null);
  const batch = {
    id: store.nextId('bt', data.batches),
    code: String(payload.code).trim(),
    product: String(payload.product).trim(),
    spec: String(payload.spec || '').trim(),
    units: Number(payload.units),
    roomId: payload.roomId,
    loadedAt: String(payload.loadedAt),
    supplier: String(payload.supplier || '').trim(),
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.batches.push(batch);
  return decorateBatch(data, batch);
}

function updateBatch(data, id, payload) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  // 库位不能用批次修改接口静默改：换冷库/车厢必须走"库位变更登记"，否则早先记录的归属就乱了
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'roomId') && payload.roomId !== batch.roomId) {
    const currentRoomId = coldlib.roomIdAt(data, batch, store.nowText());
    if (payload.roomId !== currentRoomId) {
      throw new AppError(409, 'ROOM_CHANGE_MUST_BE_REGISTERED', '换冷库或者车厢要走"库位变更登记"，不能直接改批次的所在冷库', { field: 'roomId' });
    }
  }
  validateBatch(data, payload, batch);
  const merged = Object.assign({}, batch, payload);
  Object.assign(batch, {
    product: String(merged.product).trim(),
    spec: String(merged.spec || '').trim(),
    units: Number(merged.units),
    roomId: batch.roomId,
    loadedAt: String(merged.loadedAt),
    supplier: String(merged.supplier || '').trim(),
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateBatch(data, batch);
}

function removeBatch(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (batch.status === '已放行') throw new AppError(409, 'BATCH_RELEASED', '这个批次已经放行，不能直接删除', { code: batch.code });
  const used = data.records.filter((r) => r.batchId === id).length;
  data.records = data.records.filter((r) => r.batchId !== id);
  data.releases = data.releases.filter((r) => r.batchId !== id);
  data.changes = (data.changes || []).filter((c) => c.batchId !== id);
  data.batches = data.batches.filter((b) => b.id !== id);
  return { removed: id, removedRecords: used };
}

function listRecords(data, query) {
  const q = query || {};
  let rows = data.records.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.probeId) rows = rows.filter((r) => r.probeId === q.probeId);
  if (q.source) rows = rows.filter((r) => r.source === q.source);
  if (q.from) rows = rows.filter((r) => r.at >= q.from);
  if (q.to) rows = rows.filter((r) => r.at <= q.to);
  return rows
    .map((r) => {
      const batch = data.batches.find((b) => b.id === r.batchId);
      let roomCode = '';
      if (batch) {
        const tl = coldlib.locationTimeline(data, batch);
        roomCode = (function () {
          const room = data.rooms.find((x) => x.id === tl.segments[coldlib.segmentIndexAt(tl.segments, r.at)].roomId);
          return room ? room.code : '';
        })();
      }
      return Object.assign({}, r, {
        batchCode: batchCode(data, r.batchId),
        probeCode: probeCode(data, r.probeId),
        roomCode,
        outOfRange: Number(r.temperatureC) > Number(data.settings.upperLimitC) || Number(r.temperatureC) < Number(data.settings.lowerLimitC),
      });
    })
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

function validateRecord(data, payload) {
  const errors = {};
  const batch = data.batches.find((b) => b.id === payload.batchId);
  if (!batch) errors.batchId = '批次不存在';
  const probe = data.probes.find((p) => p.id === payload.probeId);
  if (!probe) errors.probeId = '探头不存在';
  if (!SOURCE_LIST.includes(payload.source)) errors.source = '来源只能是：' + SOURCE_LIST.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(payload.at || ''))) errors.at = '记录时刻格式要像 2026-09-01 08:00:00';
  if (payload.temperatureC === undefined || payload.temperatureC === '') errors.temperatureC = '温度不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条温度记录没通过校验', errors);
  return { batch, probe };
}

function createRecord(data, payload) {
  validateRecord(data, payload);
  const record = {
    id: store.nextId('rc', data.records),
    batchId: payload.batchId,
    probeId: payload.probeId,
    at: String(payload.at),
    temperatureC: Number(payload.temperatureC),
    source: payload.source,
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.records.push(record);
  return Object.assign({}, record, { batchCode: batchCode(data, record.batchId), probeCode: probeCode(data, record.probeId) });
}

function removeRecord(data, id) {
  const record = data.records.find((r) => r.id === id);
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', '这条温度记录不存在');
  data.records = data.records.filter((r) => r.id !== id);
  return { removed: id };
}

function listReleases(data, query) {
  const q = query || {};
  let rows = data.releases.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.decision) rows = rows.filter((r) => r.decision === q.decision);
  const roomName = (id) => {
    const room = data.rooms.find((r) => r.id === id);
    return room ? room.code : '';
  };
  return rows
    .map((r) => Object.assign({}, r, {
      batchCode: batchCode(data, r.batchId),
      scopeRooms: r.dataScope && Array.isArray(r.dataScope.segmentRooms)
        ? r.dataScope.segmentRooms.map(roomName).filter(Boolean)
        : [],
      scopeRecordCount: r.dataScope ? r.dataScope.recordCount : null,
      hasDataScope: !!r.dataScope,
    }))
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
}

// 放行：登记放行单并改批次状态；同时冻结当时判定所用的数据段（哪些库位段、截至时刻），
// 以后再登记库位变更，过去的放行结论也不按新归属重新解释
function decide(data, batchId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (!['放行', '拒收'].includes(payload.decision)) {
    throw new AppError(400, 'VALIDATION_FAILED', '决定只能是放行或者拒收', { decision: '请选择放行或者拒收' });
  }
  if (!String(payload.decider || '').trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', '经办人要填', { decider: '经办人不能为空' });
  }
  const decidedAt = String(payload.decidedAt || store.nowText());
  const check = coldlib.releaseCheckAt(data, batch, decidedAt);
  const timeline = coldlib.locationTimeline(data, batch);
  const segmentIndexes = [];
  timeline.segments.forEach((s) => { if (String(s.startAt) <= decidedAt) segmentIndexes.push(s.index); });
  const release = {
    id: store.nextId('rl', data.releases),
    batchId: batch.id,
    decision: payload.decision,
    decidedAt,
    decider: String(payload.decider).trim(),
    mkt: check.mkt,
    longestExcursionMinutes: check.longestMinutes,
    totalExcursionMinutes: check.totalMinutes,
    chainGapCount: check.chain.gapCount,
    dataScope: {
      asOf: decidedAt,
      segmentIndexes,
      segmentRooms: segmentIndexes.map((i) => timeline.segments[i].roomId),
      recordCount: check.recordCount,
      boundaryRule: '记录时刻 <= 判定时刻的记录参与判定；记录时刻恰为变更时刻的，归变更后（新库位）那一段',
    },
    basis: String(payload.basis || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.releases.push(release);
  batch.status = payload.decision === '放行' ? '已放行' : '已拒收';
  batch.decidedAt = release.decidedAt;
  return { release, batch: decorateBatch(data, batch) };
}

/* ---------- 库位变更登记 ---------- */

const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function listChanges(data, query) {
  const q = query || {};
  let rows = (data.changes || []).slice();
  if (q.batchId) rows = rows.filter((c) => c.batchId === q.batchId);
  if (q.roomId) rows = rows.filter((c) => c.fromRoomId === q.roomId || c.toRoomId === q.roomId);
  if (q.affected) rows = rows.filter((c) => Array.isArray(c.impact) && c.impact.some((x) => x.conclusionChanged));
  return rows.map((c) => decorateChange(data, c)).sort((a, b) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : a.id < b.id ? 1 : -1));
}

// 判定结论快照（用于变更前后对照）
function checkSummary(check) {
  return {
    pass: check.pass,
    failed: check.failed.slice(),
    recordCount: check.recordCount,
    longestMinutes: check.longestMinutes,
    totalMinutes: check.totalMinutes,
    gapCount: check.chain.gapCount,
    mkt: check.mkt,
    expiredProbeCount: check.expiredProbes.length,
  };
}

function segSummary(seg) {
  return {
    index: seg.index,
    roomCode: seg.roomCode,
    startAt: seg.startAt,
    endAt: seg.endAt,
    recordCount: seg.recordCount,
    longestMinutes: seg.longestMinutes,
    totalMinutes: seg.totalMinutes,
    gapCount: seg.gapCount,
    mkt: seg.mkt,
    expiredProbeCount: seg.expiredProbes.length,
    pass: seg.pass,
    hasData: seg.hasData,
    failed: seg.failed.slice(),
  };
}

function registerChange(data, batchId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const errors = {};
  const timeline = coldlib.locationTimeline(data, batch);
  const changedAt = String(payload.changedAt || '');
  // 允许补登记历史变更：起点库位按变更时刻在既有时间线上的实际库位推断（时刻等于已有变更时归变更后库位）
  const fromRoomId = timeline.segments[coldlib.segmentIndexAt(timeline.segments, changedAt || batch.loadedAt)].roomId;
  if (!data.rooms.some((r) => r.id === payload.toRoomId)) errors.toRoomId = '目标冷库或者车厢不存在';
  if (payload.toRoomId === fromRoomId) errors.toRoomId = '目标库位和该时刻所在库位一样，不用登记变更';
  if (!TIME_RE.test(changedAt)) errors.changedAt = '变更时刻格式要像 2026-09-13 08:00:00';
  if (!String(payload.operator || '').trim()) errors.operator = '经办人不能为空';
  if (!String(payload.reason || '').trim()) errors.reason = '变更原因不能为空';
  if (!errors.changedAt && changedAt <= String(batch.loadedAt)) errors.changedAt = '变更时刻要晚于入库时刻 ' + batch.loadedAt;
  if (!errors.changedAt && timeline.changes.some((c) => String(c.changedAt) === changedAt)) errors.changedAt = '这个时刻已经登记过一次变更，同一时刻不能登记两次';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '变更登记没通过校验', errors);

  // 冻结变更前的分段判定（截至变更时刻），再写入变更、算变更后的分段，逐段对照
  const beforeAnalysis = coldlib.segmentedAnalysis(data, batch, changedAt);
  const beforeWhole = checkSummary(coldlib.releaseCheckAt(data, batch, changedAt));
  const releasedBefore = data.releases.filter((r) => r.batchId === batch.id && String(r.decidedAt) <= changedAt);

  const change = {
    id: store.nextId('ch', data.changes || []),
    batchId: batch.id,
    fromRoomId,
    toRoomId: payload.toRoomId,
    changedAt,
    registeredAt: store.nowText(),
    retroactive: changedAt < store.nowText(),
    reason: String(payload.reason).trim(),
    operator: String(payload.operator).trim(),
    remark: String(payload.remark || '').trim(),
  };  data.changes.push(change);

  const afterAnalysis = coldlib.segmentedAnalysis(data, batch, changedAt);
  const afterWhole = checkSummary(coldlib.releaseCheckAt(data, batch, changedAt));

  // 另一套对照：按登记时已有的全部记录（不限时刻），变更前旧归属 vs 变更后新归属的完整时间线
  const beforeFullAnalysis = coldlib.segmentedAnalysisForChanges(data, batch, timeline.changes, null);
  const afterFullAnalysis = coldlib.segmentedAnalysis(data, batch, null);
  // 批次整体（全段合并）的记录集不随归属改变，整体指标相同；真正变化的是记录落在哪一段
  const beforeFullWhole = checkSummary(coldlib.releaseCheck(data, batch));
  const afterFullWhole = checkSummary(coldlib.releaseCheck(data, batch));

  const buildSegDiffs = (beforeSegs, afterSegs) => {
    const segKey = (s) => s.roomId + '@' + s.startAt;
    const beforeMap = {};
    beforeSegs.forEach((s) => { beforeMap[segKey(s)] = s; });
    const diffs = [];
    afterSegs.forEach((b) => {
      const a = beforeMap[segKey(b)] || null;
      const bs = segSummary(b);
      const as = a ? segSummary(a) : null;
      const changed = !a
        ? bs.recordCount > 0
        : as.recordCount !== bs.recordCount ||
          as.longestMinutes !== bs.longestMinutes ||
          as.totalMinutes !== bs.totalMinutes ||
          as.gapCount !== bs.gapCount ||
          as.mkt !== bs.mkt ||
          as.expiredProbeCount !== bs.expiredProbeCount ||
          as.pass !== bs.pass;
      diffs.push({ before: as, after: bs, changed, splitOut: !a });
    });
    const afterKeys = {};
    afterSegs.forEach((s) => { afterKeys[segKey(s)] = true; });
    beforeSegs.forEach((a) => {
      if (!afterKeys[segKey(a)]) diffs.push({ before: segSummary(a), after: null, changed: true, splitOut: false });
    });
    return diffs;
  };

  // 边界时刻对照（记录只取到变更时刻）
  const segDiffsAtBoundary = buildSegDiffs(beforeAnalysis.segments, afterAnalysis.segments);
  // 全量记录对照（登记时已存在的所有记录在两套归属下怎么落段）
  const segDiffs = buildSegDiffs(beforeFullAnalysis.segments, afterFullAnalysis.segments);

  const buildMetric = (b, a) => {
    const out = [];
    const addMetric = (metric, x, y) => { if (x !== y) out.push({ metric, before: x, after: y }); };
    addMetric('参与判定记录条数', b.recordCount, a.recordCount);
    addMetric('最长超限(分)', b.longestMinutes, a.longestMinutes);
    addMetric('累计超限(分)', b.totalMinutes, a.totalMinutes);
    addMetric('断链处数', b.gapCount, a.gapCount);
    addMetric('MKT(℃)', b.mkt, a.mkt);
    addMetric('过期探头数', b.expiredProbeCount, a.expiredProbeCount);
    return out;
  };
  const metricChanges = buildMetric(beforeFullWhole, afterFullWhole);

  const affectedSegments = segDiffs.filter((d) => d.changed);
  const conclusionChanged = affectedSegments.length > 0;

  change.impact = [{
    asOf: changedAt,
    boundaryRule: '记录时刻早于变更时刻归变更前库位；记录时刻与变更时刻相同归变更后（新库位）',
    whole: { before: beforeWhole, after: afterWhole, metricChanges: buildMetric(beforeWhole, afterWhole) },
    wholeFull: { before: beforeFullWhole, after: afterFullWhole, metricChanges },
    // 截至变更时刻的边界对照
    segments: segDiffsAtBoundary,
    // 按登记时全部已有记录的归属对照（决定"哪些结论变了"）
    segmentsFull: segDiffs,
    conclusionChanged,
    affectedSegmentCount: affectedSegments.length,
    releasedBefore: releasedBefore.map((r) => ({ id: r.id, decision: r.decision, decidedAt: r.decidedAt, keptFrozen: true })),
  }];
  change.currentConclusion = {
    pass: coldlib.releaseCheck(data, batch).pass,
    openBatch: batch.status === '在库' || batch.status === '待放行',
    batchStatus: batch.status,
  };

  return {
    change: decorateChange(data, change),
    beforeSegments: beforeAnalysis.segments.map(segSummary),
    afterSegments: afterAnalysis.segments.map(segSummary),
    segDiffs,
    whole: { before: beforeWhole, after: afterWhole, metricChanges },
    conclusionChanged,
    affectedSegmentCount: affectedSegments.length,
    locationSegments: coldlib.segmentedAnalysis(data, batch).segments,
    warning: releasedBefore.length
      ? '该批次在变更前已有 ' + releasedBefore.length + ' 份放行/拒收单，单据结论与所用数据段保持当时口径冻结，本次变更不重算过去的结论'
      : '',
  };
}

module.exports = {
  listRooms, roomDetail, createRoom, updateRoom, removeRoom,
  listProbes, createProbe, updateProbe, removeProbe,
  listBatches, batchDetail, createBatch, updateBatch, removeBatch,
  listRecords, createRecord, removeRecord,
  listReleases, decide,
  listChanges, registerChange, decorateChange,
  ROOM_STATUS, ROOM_TYPE, PROBE_STATUS, BATCH_STATUS, SOURCE_LIST,
};
