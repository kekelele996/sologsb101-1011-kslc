/**
 * 比降（落差）改正领域模型。
 *
 * 受洪水涨落与变动回水影响时，同一水位在涨水、落水过程中实测流量不同，
 * 水位流量关系点据会沿单值线两侧甩开（绳套）。巡测班在测流一趟中补记
 * 上下游比降水尺读数与时刻，资料室据此按落差指数法把实测流量改正到稳定流：
 *
 *   Qc = Qm × ( Zk / Z )^β
 *
 * - Qm 实测流量，Qc 稳定流改正流量，Z 当次实测落差，Zk 定线基准落差，β 落差指数。
 *
 * 比降观测一旦被改动或撤掉，凡用它改正过的点据立即失效、退回「待复核」，
 * 由资料室重新改正，原始比降水尺读数不在改正链路上回改。
 */

/** 往返（水势）方向：涨水 / 落水 / 平衡 */
export type SlopeTrend = '涨水' | '落水' | '平衡'

export const SLOPE_TRENDS: SlopeTrend[] = ['涨水', '落水', '平衡']

/**
 * 点据的比降改正状态：
 * - 未改正：未套用落差改正，点据以实测流量直接参与定线
 * - 已改正：已按当次比降改正到稳定流，以改正流量参与定线
 * - 待复核：比降观测被改动或撤掉后改正失效，退回资料室重算
 * - 待挂接：旧点据回填不到比降归属，先挂着、不参与定线
 */
export type CorrectionStatus = '未改正' | '已改正' | '待复核' | '待挂接'

export const CORRECTION_STATUSES: CorrectionStatus[] = ['未改正', '已改正', '待复核', '待挂接']

/** 点据状态徽标配色与文案，供 CorrectionStatusTag 与各页面共用 */
export const CORRECTION_STATUS_META: Record<
  CorrectionStatus,
  { type: 'primary' | 'success' | 'warning' | 'info'; label: string; hint: string }
> = {
  未改正: { type: 'info', label: '未改正', hint: '实测流量未做落差改正，直接参与定线' },
  已改正: { type: 'success', label: '已改正', hint: '已按当次比降改正到稳定流，以改正流量参与定线' },
  待复核: { type: 'warning', label: '待复核', hint: '比降观测改动或撤掉后改正失效，退回资料室重新改正' },
  待挂接: { type: 'info', label: '待挂接', hint: '旧点据按测次时间回填不到比降归属，暂不参与定线' }
}

/** 落差指数试算区间与步长（由已有关系点据试算 β） */
export const BETA_MIN = 0.1
export const BETA_MAX = 0.9
export const BETA_STEP = 0.01
/** 落差指数缺省值 */
export const DEFAULT_BETA = 0.5
/** 落差（m）下限保护，避免除以零或极小值放大改正系数 */
export const MIN_FALL_M = 0.001

/** 比降观测：一趟测流补记的上下游比降水尺读数与时刻 */
export interface SlopeObservation {
  id: string
  /** 所属测站 */
  stationId: string
  /** 归属断面测次（可空：补记时可能尚未建档测次） */
  sectionId: string | null
  /** 测次号（用于与旧点据按测次号回填归属） */
  measureNo: string
  /** 上游比降水尺读数（m） */
  upstreamGaugeM: number
  /** 下游比降水尺读数（m） */
  downstreamGaugeM: number
  /** 上下游水尺间距（m），用于计算水面比降 */
  gaugeDistanceM: number
  /** 观测时刻（与测流同时刻核对） */
  observedAt: string
  /** 往返 / 水势方向 */
  trend: SlopeTrend
  /** 备注 */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 落差 Z = 上游读数 − 下游读数（m） */
export function calcFallM(obs: Pick<SlopeObservation, 'upstreamGaugeM' | 'downstreamGaugeM'>): number {
  return Number((obs.upstreamGaugeM - obs.downstreamGaugeM).toFixed(4))
}

/** 水面比降 = 落差 / 水尺间距（无量纲） */
export function calcSlope(obs: Pick<SlopeObservation, 'upstreamGaugeM' | 'downstreamGaugeM' | 'gaugeDistanceM'>): number {
  if (!(obs.gaugeDistanceM > 0)) return 0
  return calcFallM(obs) / obs.gaugeDistanceM
}

/** 比降以万分率（‱）展示 */
export function slopePerTenThousand(
  obs: Pick<SlopeObservation, 'upstreamGaugeM' | 'downstreamGaugeM' | 'gaugeDistanceM'>
): number {
  return Number((calcSlope(obs) * 10000).toFixed(2))
}

/**
 * 落差指数法改正到稳定流：Qc = Qm × ( Zk / Z )^β。
 * Z 必须为正；Zk 缺省或非正时返回 null（调用方按不可改正处理）。
 */
export function correctFlowByFall(params: {
  measuredFlow: number
  fallM: number
  baseFallM: number
  beta: number
}): number | null {
  const { measuredFlow, fallM, baseFallM, beta } = params
  if (!(measuredFlow > 0)) return null
  if (!(fallM >= MIN_FALL_M)) return null
  if (!(baseFallM >= MIN_FALL_M)) return null
  if (!Number.isFinite(beta)) return null
  const factor = Math.pow(baseFallM / fallM, beta)
  if (!Number.isFinite(factor) || factor <= 0) return null
  return Number((measuredFlow * factor).toFixed(2))
}

/** 一组观测的基准落差 Zk：取各测次落差均值（资料室定线缺省基准） */
export function meanFall(observations: Array<Pick<SlopeObservation, 'upstreamGaugeM' | 'downstreamGaugeM'>>): number {
  const falls = observations.map(calcFallM).filter((fall) => fall >= MIN_FALL_M)
  if (falls.length === 0) return 0
  return Number((falls.reduce((sum, fall) => sum + fall, 0) / falls.length).toFixed(4))
}

/**
 * 由已改正的稳定流点据试算落差指数 β：
 * 固定 Zk 后在 [BETA_MIN, BETA_MAX] 内逐步长搜索，
 * 取改正流量对幂函数单值线（这里以改正流量相对均值的离散度）最收敛的 β。
 *
 * 单值线在小区间内可视为 Q≈const 的近似判据并不严谨，因此这里以
 * 「改正流量与按水位排序的局部趋势残差」衡量绳套收敛程度：把改正后序列
 * 对水位做相邻点的一阶相对跳动求和，β 使跳动最小即点据最贴近单值线。
 */
export function trialBeta(params: {
  samples: Array<{ stageM: number; measuredFlow: number; fallM: number }>
  baseFallM: number
}): { beta: number; score: number } | null {
  const { samples, baseFallM } = params
  const usable = samples.filter(
    (sample) => sample.measuredFlow > 0 && sample.fallM >= MIN_FALL_M && Number.isFinite(sample.stageM)
  )
  if (usable.length < 2 || !(baseFallM >= MIN_FALL_M)) return null
  const ordered = [...usable].sort((a, b) => a.stageM - b.stageM)

  let best: { beta: number; score: number } | null = null
  const steps = Math.round((BETA_MAX - BETA_MIN) / BETA_STEP)
  for (let index = 0; index <= steps; index += 1) {
    const beta = Number((BETA_MIN + index * BETA_STEP).toFixed(2))
    const corrected = ordered
      .map((sample) => correctFlowByFall({ measuredFlow: sample.measuredFlow, fallM: sample.fallM, baseFallM, beta }))
      .filter((value): value is number => value !== null)
    if (corrected.length < 2) continue
    // 相邻改正流量的相对跳动量：越小说明涨落水点据越收拢到一条单值线
    let jump = 0
    for (let i = 1; i < corrected.length; i += 1) {
      const denom = Math.max(corrected[i - 1], MIN_FALL_M)
      jump += Math.abs(corrected[i] - corrected[i - 1]) / denom
    }
    // 同水位附近（涨/落一对）的改后差是绳套的直接度量，额外加权
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        if (Math.abs(ordered[i].stageM - ordered[j].stageM) <= 0.15) {
          const qi = corrected[i]
          const qj = corrected[j]
          if (qi !== undefined && qj !== undefined) {
            jump += Math.abs(qi - qj) / Math.max((qi + qj) / 2, MIN_FALL_M)
          }
        }
      }
    }
    if (!best || jump < best.score) best = { beta, score: Number(jump.toFixed(6)) }
  }
  return best
}

/** 匹配判定：当次比降观测与待改正点据是否同属一次测流 */
export interface MatchOptions {
  /** 水位核对容差（m） */
  stageToleranceM?: number
  /** 时间核对窗口（毫秒） */
  timeWindowMs?: number
}

/**
 * 按测次时间和水位把比降观测核对到点据：
 * 1) 同测站且测次号一致直接命中；
 * 2) 否则在时间窗口内取水位差最小且不超过容差的一次观测。
 */
export function matchObservation<T extends SlopeObservation>(
  rating: { stationId: string; measureNo: string; measuredAt: string; stageM: number },
  observations: T[],
  options: MatchOptions = {}
): T | null {
  const { stageToleranceM = 0.5, timeWindowMs = 12 * 60 * 60 * 1000 } = options
  const sameStation = observations.filter((obs) => obs.stationId === rating.stationId)
  if (sameStation.length === 0) return null

  if (rating.measureNo.trim()) {
    const byNo = sameStation
      .filter((obs) => obs.measureNo.trim() && obs.measureNo === rating.measureNo)
      .sort((a, b) => Math.abs(Date.parse(a.observedAt) - Date.parse(rating.measuredAt)) - Math.abs(Date.parse(b.observedAt) - Date.parse(rating.measuredAt)))[0]
    if (byNo) return byNo
  }

  const ratingTime = Date.parse(rating.measuredAt)
  let best: { obs: T; delta: number } | null = null
  sameStation.forEach((obs) => {
    const timeDelta = Math.abs(Date.parse(obs.observedAt) - ratingTime)
    if (timeDelta > timeWindowMs) return
    const stageMid = (obs.upstreamGaugeM + obs.downstreamGaugeM) / 2
    const stageDelta = Math.abs(stageMid - rating.stageM)
    if (stageDelta > stageToleranceM) return
    if (!best || timeDelta < best.delta) best = { obs, delta: timeDelta }
  })
  return best ? (best as { obs: T }).obs : null
}
