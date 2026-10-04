/**
 * 比降观测与落差指数法改正。
 *
 * 涨水、落水同一水位测出的流量差出一截（绳套曲线），资料室照一条单值线定线时
 * 点据总往两边甩。巡测班在测次上补记往返比降（上、下比降水尺读数与时刻），
 * 资料室定线前照当次比降把实测流量改正到稳定流，落差指数 β 用已有关系点据试算。
 *
 * 改正公式（落差指数法）：
 *   Q_稳 = Q_测 × (ΔZ_稳 / ΔZ_测)^β
 * 其中 ΔZ_测 = 上比降水尺读数 − 下比降水尺读数（测次记录的落差），
 *      ΔZ_稳 = 比降观测配置的参考落差（稳定落差），
 *      β 为落差指数（理论上接近 0.5，可由点据试算）。
 */
import { fitPowerCurve } from '@/types/rating'
import type { Section } from '@/types/section'

/** 比降观测配置：一个测站可有多条配置，在用的一条参与改正 */
export interface SlopeObservation {
  id: string
  /** 所属测站 */
  stationId: string
  /** 配置名称，如「基本比降观测」「迁建后比降观测」 */
  name: string
  /** 参考落差 ΔZ_稳（m）：稳定流对应的落差 */
  refFallM: number
  /** 落差指数 β；null 表示尚未试算，改正时回退到 0.5 */
  fallIndex: number | null
  /** 是否在用：撤掉后置为 false，其下点据退回待复核 */
  active: boolean
  /** 备注（水尺位置、迁建说明等） */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 落差指数默认值（谢才公式 Q∝√S，β≈0.5） */
export const DEFAULT_FALL_INDEX = 0.5

/** 试算落差指数的搜索区间与步长 */
export const FALL_INDEX_SEARCH = { min: 0.2, max: 1.0, step: 0.02 }

/** 比降观测状态文案 */
export const SLOPE_STATUS_TEXT = {
  active: '在用',
  withdrawn: '已撤掉'
} as const

/** 由上、下比降水尺读数计算落差 ΔZ_测（m）；读数缺失或非正返回 null */
export function calcFallM(upStageM: number | null | undefined, downStageM: number | null | undefined): number | null {
  if (upStageM === null || upStageM === undefined || downStageM === null || downStageM === undefined) return null
  const fall = upStageM - downStageM
  if (!Number.isFinite(fall) || fall <= 0) return null
  return Number(fall.toFixed(3))
}

/**
 * 落差指数法改正：把实测流量改正到稳定流流量。
 * Q_稳 = Q_测 × (ΔZ_稳 / ΔZ_测)^β
 * 无落差或参考落差时不改正（原样返回）。
 */
export function correctToSteadyFlow(
  measuredFlow: number,
  fallM: number | null | undefined,
  refFallM: number | null | undefined,
  fallIndex: number | null | undefined
): number {
  if (!Number.isFinite(measuredFlow) || measuredFlow <= 0) return 0
  if (!fallM || fallM <= 0 || refFallM === null || refFallM === undefined || refFallM <= 0) {
    return Number(measuredFlow.toFixed(2))
  }
  const beta = fallIndex && fallIndex > 0 ? fallIndex : DEFAULT_FALL_INDEX
  const ratio = refFallM / fallM
  const corrected = measuredFlow * Math.pow(ratio, beta)
  return Number(corrected.toFixed(2))
}

/** 试算样本：点据的水位、实测流量与当次落差 */
export interface TrialFitSample {
  id: string
  stageM: number
  measuredFlowM3s: number
  fallM: number | null
}

/** 试算结果：最优落差指数与该指数下的改正流量 */
export interface TrialFitResult {
  /** 试算得到的最优落差指数 */
  fallIndex: number
  /** 最优指数下的定线平均残差（%） */
  meanResidualPct: number
  /** 最优指数下的定线决定系数 R² */
  r2: number
  valid: boolean
  message: string
  /** 各点据在最优指数下的改正流量 */
  corrected: Array<{ id: string; flowM3s: number }>
}

/**
 * 用已有关系点据试算落差指数 β：
 * 在 [0.2, 1.0] 内以 0.02 步长搜索，对每个 β 改正有落差的点据后做幂函数定线，
 * 取平均残差最小的 β 作为最优落差指数。
 */
export function trialFitFallIndex(samples: TrialFitSample[], refFallM: number, lineNo = 'A'): TrialFitResult {
  const base: TrialFitResult = {
    fallIndex: DEFAULT_FALL_INDEX,
    meanResidualPct: 0,
    r2: 0,
    valid: false,
    message: '',
    corrected: samples.map((sample) => ({
      id: sample.id,
      flowM3s: correctToSteadyFlow(sample.measuredFlowM3s, sample.fallM, refFallM, DEFAULT_FALL_INDEX)
    }))
  }
  const attributable = samples.filter(
    (sample) => sample.fallM !== null && sample.fallM > 0 && Number.isFinite(sample.measuredFlowM3s) && sample.measuredFlowM3s > 0
  )
  if (attributable.length < 3) {
    return { ...base, message: '有比降归属的点据少于 3 个，无法试算落差指数（至少需要 3 个带落差的点据）' }
  }

  let best: { beta: number; mean: number; r2: number; corrected: Array<{ id: string; flowM3s: number }> } | null = null
  const steps = Math.round((FALL_INDEX_SEARCH.max - FALL_INDEX_SEARCH.min) / FALL_INDEX_SEARCH.step)
  for (let index = 0; index <= steps; index += 1) {
    const beta = Number((FALL_INDEX_SEARCH.min + index * FALL_INDEX_SEARCH.step).toFixed(2))
    const corrected = samples.map((sample) => ({
      id: sample.id,
      flowM3s: correctToSteadyFlow(sample.measuredFlowM3s, sample.fallM, refFallM, beta)
    }))
    const fit = fitPowerCurve(
      corrected.map((item) => ({ stageM: samples.find((s) => s.id === item.id)?.stageM ?? 0, flowM3s: item.flowM3s })),
      lineNo
    )
    if (!fit.valid) continue
    if (!best || fit.meanResidualPct < best.mean) {
      best = { beta, mean: fit.meanResidualPct, r2: fit.r2, corrected }
    }
  }

  if (!best) {
    return { ...base, message: '各落差指数下均无法有效定线，请检查点据水位与流量的对应关系' }
  }
  return {
    fallIndex: best.beta,
    meanResidualPct: best.mean,
    r2: best.r2,
    valid: true,
    message: `试算完成：落差指数 β=${best.beta}，改正后定线平均残差 ${best.mean}%`,
    corrected: best.corrected
  }
}

/**
 * 按测次时间和水位核对匹配断面测次（比降归属）。
 * 优先取测次号一致的测次；否则在同测站内找时间差 ≤ 容差小时、水位差 ≤ 容差 m 的最近测次。
 * 对不上返回 null（升级时「先挂着」）。
 */
export function matchSectionForRating(
  rating: { stationId: string; measuredAt: string; stageM: number; measureNo?: string },
  sections: Section[],
  toleranceHours = 24,
  toleranceStageM = 0.1
): Section | null {
  const sameStation = sections.filter((section) => section.stationId === rating.stationId)
  if (sameStation.length === 0) return null
  if (rating.measureNo) {
    const byNo = sameStation.find((section) => section.measureNo === rating.measureNo)
    if (byNo) return byNo
  }
  const targetTime = Date.parse(rating.measuredAt)
  let best: Section | null = null
  let bestScore = Infinity
  for (const section of sameStation) {
    const dtHours = Math.abs(Date.parse(section.measuredAt) - targetTime) / 3_600_000
    const dStage = Math.abs(section.stageM - rating.stageM)
    if (dtHours <= toleranceHours && dStage <= toleranceStageM) {
      const score = dtHours + dStage * 10
      if (score < bestScore) {
        bestScore = score
        best = section
      }
    }
  }
  return best
}

/** 点据的比降归属状态（用于页面徽标） */
export type RatingSlopeState = 'pending' | 'unmatched' | 'attributed'

/** 判定点据的比降归属状态 */
export function ratingSlopeState(rating: {
  pendingReview: boolean
  sectionId?: string | null
  fallM?: number | null
}): RatingSlopeState {
  if (rating.pendingReview) return 'pending'
  if (!rating.sectionId) return 'unmatched'
  return 'attributed'
}
