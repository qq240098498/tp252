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
  const batches = data.batches.filter((b) => b.roomId === room.id);
  return Object.assign({}, room, {
    probeCount: probes.length,
    runningProbeCount: probes.filter((p) => p.status === '在用').length,
    batchCount: batches.length,
    openBatchCount: batches.filter((b) => b.status === '在库' || b.status === '待放行').length,
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

function latestReleaseOf(data, batchId) {
  const rows = data.releases.filter((r) => r.batchId === batchId);
  return rows.length ? rows[rows.length - 1] : null;
}

function decorateBatch(data, batch) {
  const check = coldlib.releaseCheck(data, batch);
  const releases = data.releases.filter((r) => r.batchId === batch.id);
  const changes = coldlib.batchChangesOf(data, batch.id);
  const currentProbe = batch.probeId ? data.probes.find((p) => p.id === batch.probeId) : null;
  const latestRelease = latestReleaseOf(data, batch.id);
  return Object.assign({}, batch, {
    roomCode: roomCode(data, batch.roomId),
    probeId: batch.probeId || '',
    probeCode: currentProbe ? currentProbe.code : '',
    changeCount: changes.length,
    recordCount: check.recordCount,
    longestExcursionMinutes: check.longestMinutes,
    totalExcursionMinutes: check.totalMinutes,
    mkt: check.mkt,
    chainGapCount: check.chain.gapCount,
    crossStintGapCount: check.chain.crossStintGapCount,
    expiredProbeCodes: check.expiredProbes.map((p) => p.probeCode),
    releaseCheck: check,
    releaseCount: releases.length,
    lastDecision: releases.length ? releases[releases.length - 1].decision : '',
    // 已放行/拒收：当时判定用的是第几段口径，冻结在放行单上，不随后续变更重写
    releaseBasis: latestRelease ? {
      decidedAt: latestRelease.decidedAt,
      decision: latestRelease.decision,
      changeCount: latestRelease.changeCount || 0,
      pass: latestRelease.pass,
      mkt: latestRelease.mkt,
      longestExcursionMinutes: latestRelease.longestExcursionMinutes,
      totalExcursionMinutes: latestRelease.totalExcursionMinutes,
      chainGapCount: latestRelease.chainGapCount,
      stints: latestRelease.stints || [],
      boundaryRule: latestRelease.boundaryRule || '',
    } : null,
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
    batches: data.batches.filter((b) => b.roomId === id).map((b) => decorateBatch(data, b)),
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
  const used = data.probes.filter((p) => p.roomId === id).length + data.batches.filter((b) => b.roomId === id).length;
  if (used > 0) throw new AppError(409, 'ROOM_IN_USE', '名下还有 ' + used + ' 条探头或者批次，不能删除', { count: used });
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
  if (q.roomId) rows = rows.filter((b) => b.roomId === q.roomId);
  if (q.status) rows = rows.filter((b) => b.status === q.status);
  if (q.product) rows = rows.filter((b) => String(b.product || '').includes(q.product));
  const decorated = rows.map((b) => decorateBatch(data, b));
  return decorated.sort((a, b) => (a.loadedAt < b.loadedAt ? 1 : -1));
}

function batchDetail(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const plan = coldlib.stintPlan(data, batch);
  const rows = coldlib.recordsOfBatch(data, id).map((r) => Object.assign({}, r, {
    probeCode: probeCode(data, r.probeId),
    probeExpired: !coldlib.probeValidOn(coldlib.probeOf(data, r.probeId), String(r.at).slice(0, 10)),
    stintIndex: coldlib.stintIndexAt(plan, r.at),
  }));
  return Object.assign({}, decorateBatch(data, batch), {
    records: rows,
    effectiveRecords: coldlib.effectiveRecords(data, id).map((r) => Object.assign({}, r, { probeCode: probeCode(data, r.probeId) })),
    segments: coldlib.excursionStats(data, id).segments,
    chainGaps: coldlib.chainGaps(data, id).gaps,
    changes: coldlib.batchChangesOf(data, id).map((c) => coldlib.decorateChange(data, c)),
    stints: coldlib.releaseCheck(data, batch).stints,
    crossStintGaps: coldlib.releaseCheck(data, batch).chain.crossStintGaps,
    comparison: coldlib.horizonComparison(data, batch),
    boundaryRule: coldlib.BOUNDARY_RULE,
    releases: data.releases.filter((r) => r.batchId === id).slice().sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1)),
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
  if (payload.probeId && !data.probes.some((p) => p.id === payload.probeId)) {
    throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', { probeId: '监测探头不存在' });
  }
  const batch = {
    id: store.nextId('bt', data.batches),
    code: String(payload.code).trim(),
    product: String(payload.product).trim(),
    spec: String(payload.spec || '').trim(),
    units: Number(payload.units),
    roomId: payload.roomId,
    probeId: payload.probeId || '',
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
  // 库位/设备归属不能直接改：必须走变更登记，留下从哪到哪、时刻、原因、经办人
  if (payload.roomId !== undefined && String(payload.roomId) !== String(batch.roomId)) {
    throw new AppError(400, 'USE_CHANGE_REGISTRATION', '换冷库/换车厢要在批次详情里登记变更，不能直接改所在冷库', { roomId: '请登记一条库位/设备变更' });
  }
  if (payload.probeId !== undefined && String(payload.probeId) !== String(batch.probeId || '')) {
    throw new AppError(400, 'USE_CHANGE_REGISTRATION', '换探头要在批次详情里登记变更', { probeId: '请登记一条库位/设备变更' });
  }
  validateBatch(data, payload, batch);
  const merged = Object.assign({}, batch, payload);
  Object.assign(batch, {
    product: String(merged.product).trim(),
    spec: String(merged.spec || '').trim(),
    units: Number(merged.units),
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
  data.batchChanges = (data.batchChanges || []).filter((c) => c.batchId !== id);
  data.batches = data.batches.filter((b) => b.id !== id);
  return { removed: id, removedRecords: used };
}

/* ===================== 库位/设备变更登记 ===================== */

const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function validateBatchChange(data, batch, payload) {
  const errors = {};
  const changes = coldlib.batchChangesOf(data, batch.id);
  const toRoomId = payload.toRoomId === undefined || payload.toRoomId === '' ? batch.roomId : String(payload.toRoomId);
  // __keep / 未传：探头随批次沿用；也可以只换库位不换探头（便携探头随货走）
  const toProbeId = payload.toProbeId === undefined || payload.toProbeId === '__keep'
    ? (batch.probeId || '')
    : String(payload.toProbeId || '');
  if (!data.rooms.some((r) => r.id === toRoomId)) errors.toRoomId = '变更后的冷库/车厢不存在';
  if (toProbeId && !data.probes.some((p) => p.id === toProbeId)) errors.toProbeId = '变更后的探头不存在';
  if (!TIME_RE.test(String(payload.changedAt || ''))) errors.changedAt = '变更时刻格式要像 2026-09-01 08:00:00';
  if (!String(payload.reason || '').trim()) errors.reason = '变更原因要填';
  if (!String(payload.operator || '').trim()) errors.operator = '经办人要填';
  const sameRoom = toRoomId === batch.roomId;
  const sameProbe = toProbeId === (batch.probeId || '');
  if (sameRoom && sameProbe) errors.toRoomId = '变更后的库位或设备要与当前不同';
  if (!errors.changedAt && changes.length && String(payload.changedAt) <= changes[changes.length - 1].changedAt) {
    errors.changedAt = '变更时刻要晚于上一条变更（' + changes[changes.length - 1].changedAt + '），变更只按时间顺序登记';
  }
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条变更没通过校验', errors);
  return { toRoomId, toProbeId };
}

// 登记一次库位/设备变更：履历追加一条，批次当前归属同步更新；
// 已放行/拒收的批次也允许补登记（事后补录换库事实），但当时的判定结论冻结在放行单上，不重算。
function createBatchChange(data, batchId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const form = validateBatchChange(data, batch, payload || {});
  const beforeCheck = coldlib.releaseCheck(data, batch);
  const change = {
    id: store.nextId('bc', data.batchChanges || []),
    batchId: batch.id,
    changedAt: String(payload.changedAt),
    fromRoomId: batch.roomId || '',
    toRoomId: form.toRoomId,
    fromProbeId: batch.probeId || '',
    toProbeId: form.toProbeId,
    reason: String(payload.reason).trim(),
    operator: String(payload.operator).trim(),
    remark: String(payload.remark || '').trim(),
    registeredAt: store.nowText(),
    decided: batch.status === '已放行' || batch.status === '已拒收',
  };
  data.batchChanges = data.batchChanges || [];
  data.batchChanges.push(change);
  batch.roomId = form.toRoomId;
  if (form.toProbeId) batch.probeId = form.toProbeId;

  const afterCheck = coldlib.releaseCheck(data, batch);
  const released = latestReleaseOf(data, batch.id);
  const response = {
    change: coldlib.decorateChange(data, change),
    batch: decorateBatch(data, batch),
    before: compactCheckForCompare(beforeCheck),
    after: compactCheckForCompare(afterCheck),
    diff: compareChecks(beforeCheck, afterCheck),
    releasedBasis: released ? frozenBasis(released) : null,
    comparison: coldlib.horizonComparison(data, batch),
  };
  return response;
}

function compactCheckForCompare(check) {
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
    conditions: check.conditions.map((c) => ({ key: c.key, text: c.text, ok: c.ok, value: c.value, limit: c.limit })),
  };
}

function compareChecks(before, after) {
  const cond = [];
  const map = {};
  for (const c of before.conditions) map[c.key] = c;
  for (const c of after.conditions) {
    const p = map[c.key];
    if (p && (p.ok !== c.ok || p.value !== c.value)) {
      cond.push({ key: c.key, text: c.text, okChanged: p.ok !== c.ok, fromOk: p.ok, toOk: c.ok, fromValue: p.value, toValue: c.value });
    }
  }
  return {
    passChanged: before.pass !== after.pass,
    fromPass: before.pass,
    toPass: after.pass,
    recordCountChanged: before.recordCount !== after.recordCount,
    fromRecordCount: before.recordCount,
    toRecordCount: after.recordCount,
    conditions: cond,
  };
}

function frozenBasis(release) {
  return {
    releaseId: release.id,
    decision: release.decision,
    decidedAt: release.decidedAt,
    decider: release.decider,
    changeCount: release.changeCount || 0,
    pass: release.pass,
    mkt: release.mkt,
    longestExcursionMinutes: release.longestExcursionMinutes,
    totalExcursionMinutes: release.totalExcursionMinutes,
    chainGapCount: release.chainGapCount,
    stints: release.stints || [],
    boundaryRule: release.boundaryRule || '',
  };
}

function listBatchChanges(data, batchId) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  return coldlib.batchChangesOf(data, batchId).map((c) => coldlib.decorateChange(data, c));
}

function listRecords(data, query) {
  const q = query || {};
  let rows = data.records.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.probeId) rows = rows.filter((r) => r.probeId === q.probeId);
  if (q.source) rows = rows.filter((r) => r.source === q.source);
  if (q.from) rows = rows.filter((r) => r.at >= q.from);
  if (q.to) rows = rows.filter((r) => r.at <= q.to);
  const plans = {};
  return rows
    .map((r) => {
      const batch = data.batches.find((b) => b.id === r.batchId);
      let stintIndex = 0;
      if (batch) {
        if (!plans[r.batchId]) plans[r.batchId] = coldlib.stintPlan(data, batch);
        stintIndex = coldlib.stintIndexAt(plans[r.batchId], r.at);
      }
      return Object.assign({}, r, {
        batchCode: batchCode(data, r.batchId),
        probeCode: probeCode(data, r.probeId),
        outOfRange: Number(r.temperatureC) > Number(data.settings.upperLimitC) || Number(r.temperatureC) < Number(data.settings.lowerLimitC),
        stintIndex,
        stintRoomCode: batch ? roomCode(data, plans[r.batchId][stintIndex].roomId) : '',
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
  return rows
    .map((r) => {
      const currentChanges = coldlib.batchChangesOf(data, r.batchId).length;
      const frozenChangeCount = r.changeCount || 0;
      return Object.assign({}, r, {
        batchCode: batchCode(data, r.batchId),
        frozenPass: r.pass === undefined ? null : r.pass,
        frozenChangeCount: frozenChangeCount,
        stintCount: (r.stints || []).length,
        laterChangeCount: Math.max(0, currentChanges - frozenChangeCount),
      });
    })
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
}

// 放行：登记放行单并改批次状态
function decide(data, batchId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (!['放行', '拒收'].includes(payload.decision)) {
    throw new AppError(400, 'VALIDATION_FAILED', '决定只能是放行或者拒收', { decision: '请选择放行或者拒收' });
  }
  if (!String(payload.decider || '').trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', '经办人要填', { decider: '经办人不能为空' });
  }
  const check = coldlib.releaseCheck(data, batch);
  const release = {
    id: store.nextId('rl', data.releases),
    batchId: batch.id,
    decision: payload.decision,
    decidedAt: String(payload.decidedAt || store.nowText()),
    decider: String(payload.decider).trim(),
    mkt: check.mkt,
    longestExcursionMinutes: check.longestMinutes,
    totalExcursionMinutes: check.totalMinutes,
    chainGapCount: check.chain.gapCount,
    // 冻结当时用的分段口径：前几段、每段库位/探头/记录数/超限/断链；之后补登记变更不重写
    pass: check.pass,
    changeCount: check.changeCount,
    boundaryRule: coldlib.BOUNDARY_RULE,
    stints: check.stints.map((s) => ({
      index: s.index,
      startAt: s.startAt,
      endAt: s.endAt,
      roomId: s.roomId,
      roomCode: s.roomCode,
      probeId: s.probeId,
      probeCode: s.probeCode,
      recordCount: s.recordCount,
      longestMinutes: s.longestMinutes,
      totalMinutes: s.totalMinutes,
      gapCount: s.gapCount,
      mkt: s.mkt,
    })),
    basis: String(payload.basis || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.releases.push(release);
  batch.status = payload.decision === '放行' ? '已放行' : '已拒收';
  batch.decidedAt = release.decidedAt;
  return { release, batch: decorateBatch(data, batch) };
}

module.exports = {
  listRooms, roomDetail, createRoom, updateRoom, removeRoom,
  listProbes, createProbe, updateProbe, removeProbe,
  listBatches, batchDetail, createBatch, updateBatch, removeBatch,
  createBatchChange, listBatchChanges,
  listRecords, createRecord, removeRecord,
  listReleases, decide,
  ROOM_STATUS, ROOM_TYPE, PROBE_STATUS, BATCH_STATUS, SOURCE_LIST,
};
