/** CPM + Resource Leveling на WebGPU
 * Архитектура:
 *  - Связи хранятся в CSR (Compressed Sparse Row): O(E) памяти, E ≈ 2-5 рёбер на задачу
 *  - Forward/backward pass реализованы как итеративные WebGPU compute shaders
 *  - Каждый шейдер обрабатывает все N задач параллельно за один dispatch
 *  - Итерации повторяются пока есть изменения (atomics через staging buffer)
 *  - Resource leveling - serial scheduling, тоже на GPU где возможно
 * Fallback на CPU (JS) если WebGPU недоступен */

declare global {
  var GPUBufferUsage: {
    MAP_READ: number; MAP_WRITE: number; COPY_SRC: number; COPY_DST: number
    INDEX: number; VERTEX: number; UNIFORM: number; STORAGE: number
    INDIRECT: number; QUERY_RESOLVE: number
  }
  var GPUMapMode: { READ: number; WRITE: number }
}

export const REL_FS = 0
export const REL_SS = 1
export const REL_FF = 2
export const REL_SF = 3

export interface ActivityMin {
  id: string
  duration: number
  constraint_es: number | null
  actual_start: string | null
  actual_finish: string | null
  pct_complete: number
  actual_duration: number | null
  remaining_duration: number | null
  name: string
  parent_id: string | null
  act_type: string
}

export interface Relation {
  pred: string
  succ: string
  type: string  // 'FS' | 'SS' | 'FF' | 'SF'
  lag: number
}

export interface Resource {
  id: string
  name: string
  max_units: number
  cost_per_unit: number
}

export interface Assignment {
  activity_id: string
  resource_id: string
  units: number
  actual_qty: number | null
  remaining_qty: number | null
}

export interface ScheduleResult {
  es: Float64Array  // Early Start в днях от project start
  ef: Float64Array  // Early Finish
  ls: Float64Array  // Late Start
  lf: Float64Array  // Late Finish
  tf: Float64Array  // Total Float
  ff: Float64Array  // Free Float
  on_critical: Uint8Array
}

export interface CSR {
  /** row_ptr[i]..row_ptr[i+1] - диапазон рёбер из вершины i */
  row_ptr: Int32Array
  col: Int32Array
  lag: Float64Array
  rel_type: Uint8Array  // REL_FS | REL_SS | REL_FF | REL_SF
}

export function buildCSR(N: number, relations: Relation[], idxMap: Map<string, number>): {
  fwd: CSR
  rev: CSR
} {
  const fwdAdj: Array<Array<{ j: number; lag: number; type: number }>> = Array.from({ length: N }, () => [])
  const revAdj: Array<Array<{ j: number; lag: number; type: number }>> = Array.from({ length: N }, () => [])
  for (const r of relations) {
    const i = idxMap.get(r.pred)!
    const j = idxMap.get(r.succ)!
    const type = r.type === 'SS' ? REL_SS : r.type === 'FF' ? REL_FF : r.type === 'SF' ? REL_SF : REL_FS
    fwdAdj[i].push({ j, lag: r.lag, type })
    revAdj[j].push({ j: i, lag: r.lag, type })
  }
  return { fwd: _buildCSRFromAdj(N, fwdAdj), rev: _buildCSRFromAdj(N, revAdj) }
}

function _buildCSRFromAdj(N: number, adj: Array<Array<{ j: number; lag: number; type: number }>>): CSR {
  const row_ptr = new Int32Array(N + 1)
  for (let i = 0; i < N; i++) row_ptr[i + 1] = row_ptr[i] + adj[i].length
  const E = row_ptr[N]
  // GPU буферы не могут быть нулевого размера - минимум 1 элемент
  const col = new Int32Array(Math.max(E, 1))
  const lag = new Float64Array(Math.max(E, 1))
  const rel_type = new Uint8Array(Math.max(E, 1))
  for (let i = 0; i < N; i++) {
    let k = row_ptr[i]
    for (const e of adj[i]) {
      col[k] = e.j; lag[k] = e.lag; rel_type[k] = e.type; k++
    }
  }
  return { row_ptr, col, lag, rel_type }
}

/** WGSL шейдер: один шаг forward pass.
 *  Каждый workgroup обрабатывает одну задачу j.
 *  Читает ES предшественников из fwd CSR, обновляет ES[j].
 *  changed[] атомарно записывает 1 если что-то изменилось */
const WGSL_FORWARD = `
struct Uniforms { N: u32, dummy: u32 };

@group(0) @binding(0) var<storage, read>       fwd_ptr:  array<i32>;
@group(0) @binding(1) var<storage, read>       fwd_col:  array<i32>;
@group(0) @binding(2) var<storage, read>       fwd_lag:  array<f32>;
@group(0) @binding(3) var<storage, read>       fwd_type: array<u32>;
@group(0) @binding(4) var<storage, read>       D:        array<f32>;
@group(0) @binding(5) var<storage, read>       constraint_es: array<f32>;  // -1 = no constraint
@group(0) @binding(6) var<storage, read_write> ES:       array<atomic<i32>>;  // * 1000 (fixed-point)
@group(0) @binding(7) var<storage, read_write> changed:  array<atomic<u32>>;

@compute @workgroup_size(64)
fn forward_step(@builtin(global_invocation_id) gid: vec3<u32>) {
  let j = gid.x;
  if (j >= arrayLength(&D)) { return; }

  var best: f32 = 0.0;
  let c = constraint_es[j];
  if (c >= 0.0) { best = c; }

  let start = fwd_ptr[j];
  let end   = fwd_ptr[j + 1u];
  // rev pass: fwd_ptr здесь на самом деле rev CSR (successors-predecessors)
  for (var k = start; k < end; k++) {
    let i   = fwd_col[k];
    let lg  = fwd_lag[k];
    let rt  = fwd_type[k];
    let es_i = f32(atomicLoad(&ES[i])) / 1000.0;
    let ef_i = es_i + D[i];
    var cand: f32;
    switch rt {
      case 0u: { cand = ef_i + lg; }              // FS
      case 1u: { cand = es_i + lg; }              // SS
      case 2u: { cand = ef_i + lg - D[j]; }       // FF
      default: { cand = es_i + lg - D[j]; }       // SF
    }
    if (cand > best) { best = cand; }
  }

  let best_fixed = i32(best * 1000.0);
  let old = atomicMax(&ES[j], best_fixed);
  if (old < best_fixed) { atomicStore(&changed[0], 1u); }
}
`

const WGSL_BACKWARD = `
@group(0) @binding(0) var<storage, read>       rev_ptr:  array<i32>;
@group(0) @binding(1) var<storage, read>       rev_col:  array<i32>;
@group(0) @binding(2) var<storage, read>       rev_lag:  array<f32>;
@group(0) @binding(3) var<storage, read>       rev_type: array<u32>;
@group(0) @binding(4) var<storage, read>       D:        array<f32>;
@group(0) @binding(5) var<storage, read>       project_finish: array<f32>;
@group(0) @binding(6) var<storage, read_write> LF:       array<atomic<i32>>;  // * 1000 fixed-point, inverted: store -LF
@group(0) @binding(7) var<storage, read_write> changed:  array<atomic<u32>>;

@compute @workgroup_size(64)
fn backward_step(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&D)) { return; }

  var best: f32 = project_finish[0];  // LF cannot exceed project finish

  let start = rev_ptr[i];
  let end   = rev_ptr[i + 1u];
  for (var k = start; k < end; k++) {
    let j   = rev_col[k];
    let lg  = rev_lag[k];
    let rt  = rev_type[k];
    // stored as -LF (inverted for atomicMin - atomicMax trick)
    let lf_j = -f32(atomicLoad(&LF[j])) / 1000.0;
    let ls_j = lf_j - D[j];
    var cand: f32;
    switch rt {
      case 0u: { cand = ls_j - lg; }                      // FS: LF_i ≤ LS_j - lag
      case 1u: { cand = ls_j - lg + D[i]; }               // SS
      case 2u: { cand = lf_j - lg; }                      // FF
      default: { cand = lf_j + D[i] - lg; }               // SF
    }
    if (cand < best) { best = cand; }
  }

  // Store as negative (we use atomicMax on -LF to implement atomicMin on LF)
  let best_neg_fixed = i32(-best * 1000.0);
  let old = atomicMax(&LF[i], best_neg_fixed);
  if (old < best_neg_fixed) { atomicStore(&changed[0], 1u); }
}
`

export class CPMEngineGPU {
  private device: GPUDevice | null = null
  private ready = false
  async init(): Promise<boolean> {
    if (!navigator.gpu) return false
    try {
      const adapter = await navigator.gpu.requestAdapter()
      if (!adapter) return false
      this.device = await adapter.requestDevice()
      this.ready = true
      console.log('[CPM] WebGPU ready:', this.device.label || 'GPU')
      return true
    } catch {
      return false
    }
  }

  get isGPU() { return this.ready }

  /** Рассчитывает расписание CPM.
   * Использует WebGPU если доступен, иначе CPU fallback */
  async schedule(
    activities: ActivityMin[],
    relations: Relation[],
  ): Promise<ScheduleResult> {
    const N = activities.length
    if (N === 0) return _emptyResult(0)
    if (this.ready && this.device) {
      try {
        return await this._scheduleGPU(activities, relations)
      } catch (e) {
        console.warn('[CPM] GPU error, fallback to CPU:', e)
      }
    }
    return _scheduleCPU(activities, relations)
  }
  private async _scheduleGPU(
    activities: ActivityMin[],
    relations: Relation[],
  ): Promise<ScheduleResult> {
    const device = this.device!
    const N = activities.length
    const idxMap = new Map(activities.map((a, i) => [a.id, i]))
    const { fwd, rev } = buildCSR(N, relations, idxMap)
    const D = new Float32Array(activities.map(a => a.duration))
    const constraintES = new Float32Array(N).fill(-1)
    activities.forEach((a, i) => { if (a.constraint_es != null) constraintES[i] = a.constraint_es })
    // ES forward pass
    const ES_fixed = new Int32Array(N) // все 0
    const esGPU = await _gpuIterativePass(device, WGSL_FORWARD, 'forward_step', N, rev, D, constraintES, ES_fixed, N * 3 + 10)
    const ES = new Float64Array(N)
    for (let i = 0; i < N; i++) ES[i] = esGPU[i] / 1000.0
    const EF = new Float64Array(N)
    for (let i = 0; i < N; i++) EF[i] = ES[i] + activities[i].duration
    let projFinish = 0
    for (let i = 0; i < N; i++) if (EF[i] > projFinish) projFinish = EF[i]
    // LF backward pass (stored as -LF, inverted for atomicMax)
    const LF_init = new Int32Array(N).fill(Math.round(-projFinish * 1000))
    const LF_neg = await _gpuIterativePass(device, WGSL_BACKWARD, 'backward_step', N, fwd, D, new Float32Array([projFinish]), LF_init, N * 3 + 10)
    const LF = new Float64Array(N)
    const LS = new Float64Array(N)
    const TF = new Float64Array(N)
    const FF = new Float64Array(N)
    const on_critical = new Uint8Array(N)
    for (let i = 0; i < N; i++) {
      LF[i] = -LF_neg[i] / 1000.0
      LS[i] = LF[i] - activities[i].duration
      TF[i] = LF[i] - EF[i]
      if (Math.abs(TF[i]) < 1e-6) TF[i] = 0
      on_critical[i] = Math.abs(TF[i]) < 1e-6 ? 1 : 0
    }
    // Free Float (CPU - небольшой проход, не узкое место)
    _calcFreeFloat(N, activities, relations, idxMap, fwd, ES, EF, TF, FF)
    return { es: ES, ef: EF, ls: LS, lf: LF, tf: TF, ff: FF, on_critical }
  }
}

async function _gpuIterativePass(
  device: GPUDevice,
  wgsl: string,
  entryPoint: string,
  N: number,
  csr: CSR,
  D: Float32Array,
  extra: Float32Array,  // constraint_es (forward) или [projFinish] (backward)
  initValues: Int32Array,
  maxIter: number,
): Promise<Int32Array> {

  // GPUQueue.writeBuffer требует размер кратный 4 байтам.
  // Выравниваем размер вверх до ближайшего кратного 4
  const align4 = (n: number) => Math.max(4, Math.ceil(n / 4) * 4)

  const makeBuffer = (data: ArrayBufferView, usage: GPUBufferUsageFlags) => {
    const size = align4(data.byteLength)
    const buf = device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST })
    // Копируем данные через промежуточный ArrayBuffer выровненного размера
    // чтобы writeBuffer получал ровно size байт
    if (data.byteLength % 4 === 0) {
      device.queue.writeBuffer(buf, 0, data)
    } else {
      const aligned = new Uint8Array(size)
      aligned.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      device.queue.writeBuffer(buf, 0, aligned)
    }
    return buf
  }

  // rel_type хранится как Uint8Array (1 байт на ребро), но WGSL читает u32 (4 байта).
  // Конвертируем в Uint32Array чтобы шейдер мог обращаться напрямую
  const relTypeU32 = new Uint32Array(csr.rel_type.length)
  for (let k = 0; k < csr.rel_type.length; k++) relTypeU32[k] = csr.rel_type[k]

  const bPtr   = makeBuffer(csr.row_ptr, GPUBufferUsage.STORAGE)
  const bCol   = makeBuffer(csr.col,     GPUBufferUsage.STORAGE)
  // Float64Array - Float32Array для GPU (WGSL использует f32)
  const lagF32 = new Float32Array(csr.lag.length)
  for (let k = 0; k < csr.lag.length; k++) lagF32[k] = csr.lag[k]
  const bLagF  = makeBuffer(lagF32, GPUBufferUsage.STORAGE)
  const bType  = makeBuffer(relTypeU32,  GPUBufferUsage.STORAGE)
  const bD     = makeBuffer(D, GPUBufferUsage.STORAGE)
  const bExtra = makeBuffer(extra, GPUBufferUsage.STORAGE)

  // Int32Array.byteLength всегда кратен 4, но выравниваем явно
  const valuesSize = align4(initValues.byteLength)
  const bValues = device.createBuffer({
    size: valuesSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(bValues, 0, initValues)

  const bChanged = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  })

  const bReadback = device.createBuffer({
    size: valuesSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const bChangedRead = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })

  const module = device.createShaderModule({ code: wgsl })
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint },
  })

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: bPtr } },
      { binding: 1, resource: { buffer: bCol } },
      { binding: 2, resource: { buffer: bLagF } },
      { binding: 3, resource: { buffer: bType } },
      { binding: 4, resource: { buffer: bD } },
      { binding: 5, resource: { buffer: bExtra } },
      { binding: 6, resource: { buffer: bValues } },
      { binding: 7, resource: { buffer: bChanged } },
    ],
  })

  const workgroups = Math.ceil(N / 64)

  for (let iter = 0; iter < maxIter; iter++) {
    // Сбросить changed
    device.queue.writeBuffer(bChanged, 0, new Uint32Array([0]))

    const enc = device.createCommandEncoder()
    const pass = enc.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(workgroups)
    pass.end()

    // Читаем changed
    enc.copyBufferToBuffer(bChanged, 0, bChangedRead, 0, 4)
    device.queue.submit([enc.finish()])

    await bChangedRead.mapAsync(GPUMapMode.READ)
    const changedVal = new Uint32Array(bChangedRead.getMappedRange())[0]
    bChangedRead.unmap()

    if (changedVal === 0) break
  }

  // Читаем результат
  const enc2 = device.createCommandEncoder()
  enc2.copyBufferToBuffer(bValues, 0, bReadback, 0, valuesSize)
  device.queue.submit([enc2.finish()])

  await bReadback.mapAsync(GPUMapMode.READ)
  const result = new Int32Array(bReadback.getMappedRange().slice(0))
  bReadback.unmap()

  // Cleanup
  for (const b of [bPtr, bCol, bLagF, bType, bD, bExtra, bValues, bChanged, bReadback, bChangedRead]) b.destroy()

  return result
}

// CPU Fallback

export function _scheduleCPU(activities: ActivityMin[], relations: Relation[]): ScheduleResult {
  const N = activities.length
  const idxMap = new Map(activities.map((a, i) => [a.id, i]))
  const { fwd, rev } = buildCSR(N, relations, idxMap)

  const ES = new Float64Array(N)
  const EF = new Float64Array(N)
  const LS = new Float64Array(N)
  const LF = new Float64Array(N)
  const TF = new Float64Array(N)
  const FF = new Float64Array(N)
  const on_critical = new Uint8Array(N)

  // Применяем constraints
  for (let i = 0; i < N; i++) {
    if (activities[i].constraint_es != null) ES[i] = activities[i].constraint_es!
  }

  const maxIter = N * 3 + 10

  // Forward pass
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false
    for (let i = 0; i < N; i++) EF[i] = ES[i] + activities[i].duration

    for (let i = 0; i < N; i++) {
      const start = fwd.row_ptr[i], end = fwd.row_ptr[i + 1]
      for (let k = start; k < end; k++) {
        const j = fwd.col[k], lg = fwd.lag[k], rt = fwd.rel_type[k]
        let cand: number
        if (rt === REL_FS)       cand = EF[i] + lg
        else if (rt === REL_SS)  cand = ES[i] + lg
        else if (rt === REL_FF)  cand = EF[i] + lg - activities[j].duration
        else                     cand = ES[i] + lg - activities[j].duration
        if (cand > ES[j] + 1e-9) { ES[j] = cand; changed = true }
      }
    }
    // Re-apply constraints
    for (let i = 0; i < N; i++) {
      if (activities[i].constraint_es != null && activities[i].constraint_es! > ES[i] + 1e-9) {
        ES[i] = activities[i].constraint_es!; changed = true
      }
    }
    if (!changed) break
  }
  for (let i = 0; i < N; i++) EF[i] = ES[i] + activities[i].duration

  let projFinish = 0
  for (let i = 0; i < N; i++) if (EF[i] > projFinish) projFinish = EF[i]

  for (let i = 0; i < N; i++) LF[i] = projFinish

  // Backward pass
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false
    for (let j = 0; j < N; j++) {
      const lf_j = LF[j]; const ls_j = lf_j - activities[j].duration
      // rev CSR
      const start = rev.row_ptr[j], end = rev.row_ptr[j + 1]
      for (let k = start; k < end; k++) {
        const i = rev.col[k], lg = rev.lag[k], rt = rev.rel_type[k]
        let cand: number
        if (rt === REL_FS)       cand = ls_j - lg
        else if (rt === REL_SS)  cand = ls_j - lg + activities[i].duration
        else if (rt === REL_FF)  cand = lf_j - lg
        else                     cand = lf_j + activities[i].duration - lg
        if (cand < LF[i] - 1e-9) { LF[i] = cand; changed = true }
      }
    }
    if (!changed) break
  }

  for (let i = 0; i < N; i++) {
    LS[i] = LF[i] - activities[i].duration
    TF[i] = Math.abs(LF[i] - EF[i]) < 1e-9 ? 0 : LF[i] - EF[i]
    on_critical[i] = Math.abs(TF[i]) < 1e-6 ? 1 : 0
  }

  _calcFreeFloat(N, activities, relations, idxMap, fwd, ES, EF, TF, FF)

  return { es: ES, ef: EF, ls: LS, lf: LF, tf: TF, ff: FF, on_critical }
}

function _calcFreeFloat(
  N: number,
  activities: ActivityMin[],
  _relations: Relation[],
  _idxMap: Map<string, number>,
  fwd: CSR,
  ES: Float64Array,
  EF: Float64Array,
  TF: Float64Array,
  FF: Float64Array,
) {
  FF.fill(Infinity)
  for (let i = 0; i < N; i++) {
    const start = fwd.row_ptr[i], end = fwd.row_ptr[i + 1]
    for (let k = start; k < end; k++) {
      const j = fwd.col[k], lg = fwd.lag[k], rt = fwd.rel_type[k]
      let ffVal: number
      if (rt === REL_FS)       ffVal = ES[j] - EF[i] - lg
      else if (rt === REL_SS)  ffVal = ES[j] - ES[i] - lg
      else if (rt === REL_FF)  ffVal = EF[j] - EF[i] - lg
      else                     ffVal = EF[j] - ES[i] - lg
      if (ffVal < FF[i]) FF[i] = ffVal
    }
    if (!isFinite(FF[i])) FF[i] = TF[i]
    if (Math.abs(FF[i]) < 1e-9) FF[i] = 0
  }
}

// Resource Leveling (CPU - serial scheduling)

export interface LevelingOptions {
  level_within_float_only: boolean
  max_overload_pct: number
}

/** Выравнивание ресурсов с учётом блокировки начатых/завершённых работ.
 * Возвращает новые ES/EF (остальные флоаты пересчитываются через schedule).
 * Начатые и завершённые работы НЕ СДВИГАЮТСЯ.
 * Для начатой незавершённой: только remaining_duration может быть смещена вправо */
export function levelResources(
  activities: ActivityMin[],
  relations: Relation[],
  resources: Resource[],
  assignments: Assignment[],
  schedResult: ScheduleResult,
  options: LevelingOptions,
): { es: Float64Array; ef: Float64Array } {
  const N = activities.length
  const idxMap = new Map(activities.map((a, i) => [a.id, i]))
  const { fwd, rev } = buildCSR(N, relations, idxMap)

  // Назначения ресурсов на работы
  const actRes: Map<number, Map<string, number>> = new Map()
  for (let i = 0; i < N; i++) actRes.set(i, new Map())
  for (const asgn of assignments) {
    const i = idxMap.get(asgn.activity_id)
    if (i == null) continue
    const m = actRes.get(i)!
    m.set(asgn.resource_id, (m.get(asgn.resource_id) ?? 0) + asgn.units)
  }

  // Топологическая сортировка
  const topo = _topoSort(N, fwd, schedResult.tf, activities)
  if (topo.length < N) {
    // цикл - возвращаем исходные
    return { es: schedResult.es.slice() as Float64Array, ef: schedResult.ef.slice() as Float64Array }
  }

  const maxDays = Math.ceil(Math.max(...Array.from(schedResult.ef))) + 500
  const limitFactor = options.max_overload_pct / 100
  const resAvail: Map<string, Float64Array> = new Map()
  for (const r of resources) {
    resAvail.set(r.id, new Float64Array(maxDays).fill(r.max_units * limitFactor))
  }

  const newES = schedResult.es.slice() as Float64Array
  const newEF = schedResult.ef.slice() as Float64Array

  // Определяем заблокированные работы и резервируем их ресурсы заранее
  for (let i = 0; i < N; i++) {
    if (_isLocked(activities[i])) {
      const s = Math.floor(newES[i]), e = Math.min(Math.ceil(newEF[i]), maxDays)
      const rm = actRes.get(i)!
      for (const [rid, units] of rm) {
        const avail = resAvail.get(rid)
        if (avail && s < e) for (let d = s; d < e; d++) avail[d] -= units
      }
    }
  }

  for (const i of topo) {
    if (_isLocked(activities[i])) continue  // не трогаем

    const dur = _remainingDur(activities[i])
    if (dur <= 0) continue

    // Логически ранний старт из предшественников (уже расставленных)
    let earliest = schedResult.es[i]
    const rp = rev.row_ptr
    for (let k = rp[i]; k < rp[i + 1]; k++) {
      const ip = rev.col[k], lg = rev.lag[k], rt = rev.rel_type[k]
      let cand: number
      if (rt === REL_FS)       cand = newEF[ip] + lg
      else if (rt === REL_SS)  cand = newES[ip] + lg
      else if (rt === REL_FF)  cand = newEF[ip] + lg - dur
      else                     cand = newES[ip] + lg - dur
      if (cand > earliest) earliest = cand
    }

    const upper = options.level_within_float_only
      ? schedResult.ls[i]
      : maxDays - Math.ceil(dur)
    const upperClamped = Math.min(upper, maxDays - Math.ceil(dur))

    let start = Math.floor(earliest)
    let placed = false
    const rm = actRes.get(i)!

    while (start <= Math.floor(upperClamped) + 1) {
      const endIdx = Math.min(start + Math.ceil(dur), maxDays)
      let ok = true
      for (const [rid, units] of rm) {
        const avail = resAvail.get(rid)
        if (avail && start < endIdx) {
          for (let d = start; d < endIdx; d++) {
            if (avail[d] < units - 1e-9) { ok = false; break }
          }
        }
        if (!ok) break
      }
      if (ok) {
        newES[i] = start
        newEF[i] = start + dur
        for (const [rid, units] of rm) {
          const avail = resAvail.get(rid)
          if (avail && start < endIdx) for (let d = start; d < endIdx; d++) avail[d] -= units
        }
        placed = true
        break
      }
      start++
    }

    if (!placed) {
      newES[i] = earliest
      newEF[i] = earliest + dur
      const s = Math.floor(earliest), e = Math.min(Math.ceil(newEF[i]), maxDays)
      for (const [rid, units] of rm) {
        const avail = resAvail.get(rid)
        if (avail && s < e) for (let d = s; d < e; d++) avail[d] -= units
      }
    }
  }

  return { es: newES, ef: newEF }
}

function _isLocked(a: ActivityMin): boolean {
  if (a.actual_start) return true
  if (a.actual_finish) return true
  if (a.pct_complete >= 100) return true
  if (a.actual_duration != null && a.actual_duration > 0 &&
      (a.remaining_duration == null || a.remaining_duration === 0)) return true
  return false
}

function _remainingDur(a: ActivityMin): number {
  if (a.remaining_duration != null && a.remaining_duration >= 0) return a.remaining_duration
  if (a.actual_duration != null && a.actual_duration > 0) return Math.max(0, a.duration - a.actual_duration)
  return a.duration
}

function _topoSort(N: number, fwd: CSR, TF: Float64Array, activities: ActivityMin[]): number[] {
  const inDeg = new Int32Array(N)
  for (let i = 0; i < N; i++) {
    for (let k = fwd.row_ptr[i]; k < fwd.row_ptr[i + 1]; k++) inDeg[fwd.col[k]]++
  }
  const queue: number[] = []
  for (let i = 0; i < N; i++) if (inDeg[i] === 0) queue.push(i)
  queue.sort((a, b) => TF[a] - TF[b] || activities[a].id.localeCompare(activities[b].id))

  const order: number[] = []
  while (queue.length > 0) {
    const u = queue.shift()!
    order.push(u)
    for (let k = fwd.row_ptr[u]; k < fwd.row_ptr[u + 1]; k++) {
      const v = fwd.col[k]
      inDeg[v]--
      if (inDeg[v] === 0) {
        const ins = queue.findIndex(x => TF[x] > TF[v] || (TF[x] === TF[v] && activities[x].id > activities[v].id))
        if (ins === -1) queue.push(v); else queue.splice(ins, 0, v)
      }
    }
  }
  return order
}

function _emptyResult(N: number): ScheduleResult {
  return {
    es: new Float64Array(N), ef: new Float64Array(N),
    ls: new Float64Array(N), lf: new Float64Array(N),
    tf: new Float64Array(N), ff: new Float64Array(N),
    on_critical: new Uint8Array(N),
  }
}

export const cpmEngine = new CPMEngineGPU()
