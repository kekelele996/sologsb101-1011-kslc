/**
 * 比降（落差）改正 store：
 * - 维护比降观测档案（巡测班补记的上下游比降水尺读数与时刻）；
 * - 资料室按测次时间和水位核对观测归属，用落差指数法把实测流量改正到稳定流；
 * - 比降观测改动或撤掉后，用它改过的点据立即失效、退回「待复核」，读数本身不回改；
 * - 旧点据按测次时间回填比降归属，对不上的先挂「待挂接」。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Station } from '@/types/station'
import type { Rating } from '@/types/rating'
import type { SlopeObservation, SlopeTrend } from '@/types/slope'
import {
  DEFAULT_BETA,
  calcFallM,
  correctFlowByFall,
  matchObservation,
  meanFall,
  trialBeta
} from '@/types/slope'

/** localStorage 键：按测站记忆上次改正用的基准落差 Zk 与落差指数 β */
const LS_PREFIX = 'gbhydrogaug:slope'

function readStationParams(stationId: string): { baseFallM: number | null; beta: number } {
  try {
    const raw = localStorage.getItem(`${LS_PREFIX}:${stationId}`)
    if (raw) {
      const parsed = JSON.parse(raw) as { baseFallM?: number; beta?: number }
      return {
        baseFallM: typeof parsed.baseFallM === 'number' ? parsed.baseFallM : null,
        beta: typeof parsed.beta === 'number' ? parsed.beta : DEFAULT_BETA
      }
    }
  } catch {
    // 忽略
  }
  return { baseFallM: null, beta: DEFAULT_BETA }
}

function writeStationParams(stationId: string, baseFallM: number, beta: number): void {
  try {
    localStorage.setItem(`${LS_PREFIX}:${stationId}`, JSON.stringify({ baseFallM, beta }))
  } catch {
    // 忽略
  }
}

/** 改正入参 */
export interface CorrectRatingPayload {
  baseFallM: number
  beta: number
  note?: string
}

export const useSlopeStore = defineStore('slope', () => {
  const observations = ref<SlopeObservation[]>([])
  const ratings = ref<Rating[]>([])
  const stations = ref<Station[]>([])
  const ready = ref(false)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<SlopeObservation>(() => db.slopeObservations).subscribe((rows) => {
      observations.value = rows
      ready.value = true
    })
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })
  }

  const obsById = (id: string | null | undefined): SlopeObservation | null =>
    id ? observations.value.find((obs) => obs.id === id) ?? null : null

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 某测站的比降观测（按观测时刻升序，涨落水成对核对） */
  function observationsOfStation(stationId: string): SlopeObservation[] {
    return observations.value
      .filter((obs) => obs.stationId === stationId)
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
  }

  /** 某测站基准落差 Zk 的缺省建议值（该站各测次落差均值） */
  function suggestBaseFall(stationId: string): number {
    return meanFall(observationsOfStation(stationId))
  }

  /** 改正参数缺省值：优先取记忆值，其次该站落差均值，β 缺省 0.5 */
  function defaultParams(stationId: string): { baseFallM: number; beta: number } {
    const remembered = readStationParams(stationId)
    const suggested = suggestBaseFall(stationId)
    return {
      baseFallM: remembered.baseFallM ?? (suggested > 0 ? suggested : 0.2),
      beta: remembered.beta
    }
  }

  /** 待复核 + 待挂接点据（资料室工作清单） */
  const pendingRatings = computed<Rating[]>(() =>
    ratings.value
      .filter((rating) => rating.correctionStatus === '待复核' || rating.correctionStatus === '待挂接')
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  )

  const pendingCount = computed(() => pendingRatings.value.length)

  const reviewCount = computed(
    () => ratings.value.filter((rating) => rating.correctionStatus === '待复核').length
  )
  const unlinkedCount = computed(
    () => ratings.value.filter((rating) => rating.correctionStatus === '待挂接').length
  )
  const correctedCount = computed(
    () => ratings.value.filter((rating) => rating.correctionStatus === '已改正').length
  )

  /** 点据当前的实测落差（来自归属观测），无归属返回 null */
  function fallOfRating(rating: Rating): number | null {
    const obs = obsById(rating.slopeObsId)
    if (!obs) return null
    const fall = calcFallM(obs)
    return fall > 0 ? fall : null
  }

  /** 已改正点据的改正系数与改后流量预览（不改库） */
  function previewCorrection(
    rating: Rating,
    baseFallM: number,
    beta: number
  ): { fallM: number | null; correctedFlow: number | null; factor: number | null } {
    const obs = obsById(rating.slopeObsId)
    if (!obs) return { fallM: null, correctedFlow: null, factor: null }
    const fallM = calcFallM(obs)
    const correctedFlow = correctFlowByFall({ measuredFlow: rating.rawFlowM3s, fallM, baseFallM, beta })
    const factor = correctedFlow !== null && rating.rawFlowM3s > 0 ? correctedFlow / rating.rawFlowM3s : null
    return { fallM, correctedFlow, factor }
  }

  /** 试算落差指数 β：用该站已有归属、带落差的点据求绳套最收敛的 β */
  function trialBetaForStation(stationId: string, baseFallM: number): number | null {
    const samples = ratings.value
      .filter((rating) => rating.stationId === stationId && rating.slopeObsId)
      .map((rating) => {
        const obs = obsById(rating.slopeObsId)!
        return { stageM: rating.stageM, measuredFlow: rating.rawFlowM3s, fallM: calcFallM(obs) }
      })
      .filter((sample) => sample.fallM > 0)
    const result = trialBeta({ samples, baseFallM })
    return result ? result.beta : null
  }

  /**
   * 把一批点据改正到稳定流：Qc = Qm×(Zk/Z)^β。
   * 已挂接（含待复核、未改正、已改正）的点据方可改正；待挂接点据先核对归属。
   */
  async function applyCorrections(ratingIds: string[], payload: CorrectRatingPayload): Promise<number> {
    const { baseFallM, beta, note } = payload
    if (!(baseFallM > 0) || !Number.isFinite(beta)) return 0
    const now = Date.now()
    let done = 0
    let stationId = ''
    await db.transaction('rw', [db.ratings], async () => {
      for (const id of ratingIds) {
        const rating = ratings.value.find((item) => item.id === id)
        const obs = rating ? obsById(rating.slopeObsId) : null
        if (!rating || !obs) continue
        const corrected = correctFlowByFall({
          measuredFlow: rating.rawFlowM3s,
          fallM: calcFallM(obs),
          baseFallM,
          beta
        })
        if (corrected === null) continue
        await db.ratings.update(rating.id, {
          flowM3s: corrected,
          correctionStatus: '已改正',
          baseFallM,
          fallBeta: beta,
          correctionNote: note?.trim() || '按当次比降改正到稳定流',
          updatedAt: now
        } as never)
        stationId = rating.stationId
        done += 1
      }
    })
    if (done > 0 && stationId) writeStationParams(stationId, baseFallM, beta)
    return done
  }

  /** 撤销改正：恢复实测流量、退回未改正（读数与归属保留，供资料室重来） */
  async function revertCorrection(ratingIds: string[]): Promise<number> {
    const now = Date.now()
    let done = 0
    await db.transaction('rw', [db.ratings], async () => {
      for (const id of ratingIds) {
        const rating = ratings.value.find((item) => item.id === id)
        if (!rating) continue
        await db.ratings.update(rating.id, {
          flowM3s: rating.rawFlowM3s,
          correctionStatus: '未改正',
          baseFallM: null,
          fallBeta: null,
          correctionNote: '',
          updatedAt: now
        } as never)
        done += 1
      }
    })
    return done
  }

  /**
   * 让用某比降观测改正过的点据失效：恢复实测流量、退回「待复核」。
   * 比降水尺读数不在此回改（读数是观测事实，改动由观测档案的更新负责）。
   */
  async function invalidateRatingsByObs(slopeObsId: string, reason: string): Promise<number> {
    const targets = ratings.value.filter(
      (rating) => rating.slopeObsId === slopeObsId && rating.correctionStatus === '已改正'
    )
    if (targets.length === 0) return 0
    const now = Date.now()
    await db.transaction('rw', [db.ratings], async () => {
      for (const rating of targets) {
        await db.ratings.update(rating.id, {
          flowM3s: rating.rawFlowM3s,
          correctionStatus: '待复核',
          baseFallM: null,
          fallBeta: null,
          correctionNote: reason,
          updatedAt: now
        } as never)
      }
    })
    return targets.length
  }

  /** 给待挂接点据核对并回填一次比降归属（回填上 → 待复核，对不上继续挂着） */
  async function linkRating(ratingId: string, obsId: string): Promise<boolean> {
    const rating = ratings.value.find((item) => item.id === ratingId)
    const obs = observations.value.find((item) => item.id === obsId)
    if (!rating || !obs || rating.stationId !== obs.stationId) return false
    await db.ratings.update(ratingId, {
      slopeObsId: obs.id,
      correctionStatus: rating.correctionStatus === '待挂接' ? '待复核' : rating.correctionStatus,
      correctionNote: '资料室手工核对比降归属，待复核改正',
      updatedAt: Date.now()
    } as never)
    return true
  }

  /** 自动核对：把待挂接的点据按测次时间和水位回填到现有观测，返回回填条数 */
  async function autoLinkPending(): Promise<number> {
    const now = Date.now()
    let linked = 0
    await db.transaction('rw', [db.ratings], async () => {
      for (const rating of ratings.value) {
        if (rating.correctionStatus !== '待挂接' || rating.slopeObsId) continue
        const matched = matchObservation(rating, observations.value)
        if (!matched) continue
        await db.ratings.update(rating.id, {
          slopeObsId: matched.id,
          correctionStatus: '待复核',
          correctionNote: '按测次时间回填比降归属，待资料室复核改正',
          updatedAt: now
        } as never)
        linked += 1
      }
    })
    return linked
  }

  /* ------------------------------ 比降观测 ------------------------------ */

  async function createObservation(
    payload: Omit<SlopeObservation, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<SlopeObservation> {
    const now = Date.now()
    const row: SlopeObservation = { ...payload, id: createId('slp'), createdAt: now, updatedAt: now }
    await db.slopeObservations.put(row)
    return row
  }

  /**
   * 更新比降观测（改动水尺读数 / 时刻 / 水势）：
   * 读数照新值保存；凡用它改正过的点据立即失效退回待复核，由资料室自己重来。
   */
  async function updateObservation(
    id: string,
    patch: Partial<SlopeObservation>
  ): Promise<{ invalidated: number }> {
    const before = observations.value.find((obs) => obs.id === id)
    if (!before) return { invalidated: 0 }
    const readingChanged =
      ('upstreamGaugeM' in patch && patch.upstreamGaugeM !== before.upstreamGaugeM) ||
      ('downstreamGaugeM' in patch && patch.downstreamGaugeM !== before.downstreamGaugeM) ||
      ('observedAt' in patch && patch.observedAt !== before.observedAt)
    await db.slopeObservations.update(id, { ...patch, updatedAt: Date.now() } as never)
    if (!readingChanged) return { invalidated: 0 }
    const invalidated = await invalidateRatingsByObs(id, '比降观测（水尺读数 / 时刻）已改动，改正失效，退回资料室重新改正')
    return { invalidated }
  }

  /**
   * 撤掉比降观测：读数档案删除；用它改正过的点据失效退回待复核，
   * 归属指针清空（读数已不存在，无法再据以改正）。
   */
  async function removeObservation(id: string): Promise<{ invalidated: number }> {
    const targets = ratings.value.filter((rating) => rating.slopeObsId === id)
    const now = Date.now()
    let invalidated = 0
    await db.transaction('rw', [db.slopeObservations, db.ratings], async () => {
      for (const rating of targets) {
        if (rating.correctionStatus === '已改正') {
          await db.ratings.update(rating.id, {
            flowM3s: rating.rawFlowM3s,
            correctionStatus: '待复核',
            baseFallM: null,
            fallBeta: null,
            correctionNote: '比降观测已撤掉，改正失效，退回资料室重新改正',
            updatedAt: now
          } as never)
          invalidated += 1
        }
        await db.ratings.update(rating.id, { slopeObsId: null, updatedAt: now } as never)
      }
      await db.slopeObservations.delete(id)
    })
    return { invalidated }
  }

  /** 新建点据后尝试按测次时间自动挂一次比降归属（挂不上保持未改正） */
  async function autoLinkRatingOnCreate(rating: Rating): Promise<void> {
    const matched = matchObservation(rating, observations.value)
    if (matched) {
      await db.ratings.update(rating.id, { slopeObsId: matched.id, updatedAt: Date.now() } as never)
    }
  }

  const trendOptions = computed<SlopeTrend[]>(() => ['涨水', '落水', '平衡'])

  return {
    observations,
    ratings,
    stations,
    ready,
    pendingRatings,
    pendingCount,
    reviewCount,
    unlinkedCount,
    correctedCount,
    trendOptions,
    start,
    obsById,
    stationNameOf,
    observationsOfStation,
    suggestBaseFall,
    defaultParams,
    fallOfRating,
    previewCorrection,
    trialBetaForStation,
    applyCorrections,
    revertCorrection,
    invalidateRatingsByObs,
    linkRating,
    autoLinkPending,
    autoLinkRatingOnCreate,
    createObservation,
    updateObservation,
    removeObservation
  }
})
