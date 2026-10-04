/**
 * 比降观测 store：维护测站的比降观测配置（参考落差、落差指数、在用/撤掉），
 * 并负责点据的比降归属回填、落差指数试算、稳定流改正与失效待复核。
 * 数据经 utils/db.ts 的 Dexie 表订阅实时刷新，页面只读消费。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { SlopeObservation } from '@/types/slope'
import {
  calcFallM,
  correctToSteadyFlow,
  matchSectionForRating,
  trialFitFallIndex,
  DEFAULT_FALL_INDEX,
  type TrialFitResult
} from '@/types/slope'
import type { Rating } from '@/types/rating'
import type { Section } from '@/types/section'

export const useSlopeStore = defineStore('slope', () => {
  const observations = ref<SlopeObservation[]>([])
  const sections = ref<Section[]>([])
  const ratings = ref<Rating[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<SlopeObservation>(() => db.slopeObservations).subscribe((rows) => {
      observations.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Section>(() => db.sections).subscribe((rows) => {
      sections.value = rows
    })
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
    })
  }

  /** 某测站的比降观测配置（按更新时间倒序） */
  function observationsOfStation(stationId: string): SlopeObservation[] {
    return observations.value
      .filter((obs) => obs.stationId === stationId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 某测站当前在用的比降观测配置 */
  function activeObservationOfStation(stationId: string): SlopeObservation | null {
    return observations.value.find((obs) => obs.stationId === stationId && obs.active) ?? null
  }

  /** 某测站的点据比降归属统计 */
  function stationSlopeStats(stationId: string): { total: number; attributed: number; pending: number; unmatched: number } {
    const list = ratings.value.filter((rating) => rating.stationId === stationId)
    const pending = list.filter((rating) => rating.pendingReview).length
    const attributed = list.filter((rating) => !rating.pendingReview && rating.sectionId).length
    return {
      total: list.length,
      attributed,
      pending,
      unmatched: list.length - pending - attributed
    }
  }

  /* ------------------------------ 配置增改与撤掉 ------------------------------ */

  async function createObservation(
    payload: Omit<SlopeObservation, 'id' | 'createdAt' | 'updatedAt' | 'active'> & { active?: boolean }
  ): Promise<SlopeObservation> {
    const now = Date.now()
    const row: SlopeObservation = {
      ...payload,
      id: createId('slo'),
      active: payload.active ?? true,
      createdAt: now,
      updatedAt: now
    }
    await db.transaction('rw', [db.slopeObservations, db.ratings], async () => {
      // 新配置在用时，撤掉该站旧的在用配置
      if (row.active) {
        const old = await db.slopeObservations
          .where('stationId')
          .equals(row.stationId)
          .filter((obs) => obs.active)
          .toArray()
        await db.slopeObservations.bulkPut(old.map((obs) => ({ ...obs, active: false, updatedAt: now })))
      }
      await db.slopeObservations.put(row)
    })
    return row
  }

  async function updateObservation(id: string, patch: Partial<SlopeObservation>): Promise<void> {
    const now = Date.now()
    const current = observations.value.find((obs) => obs.id === id)
    await db.slopeObservations.update(id, { ...patch, updatedAt: now } as never)
    // 参考落差或落差指数改动后，用它改正过的点据失效，退回待复核由资料室自己重来
    if (current && (patch.refFallM !== undefined || patch.fallIndex !== undefined)) {
      await invalidateByObservation(id)
    }
  }

  /** 撤掉比降观测：配置置为停用，其下点据退回待复核（比降水尺读数不动） */
  async function withdrawObservation(id: string): Promise<void> {
    const now = Date.now()
    await db.slopeObservations.update(id, { active: false, updatedAt: now } as never)
    await invalidateByObservation(id)
  }

  /** 删除配置（物理删除，仅用于误建） */
  async function removeObservation(id: string): Promise<void> {
    await db.transaction('rw', [db.slopeObservations, db.ratings], async () => {
      await invalidateByObservation(id)
      await db.slopeObservations.delete(id)
    })
  }

  /** 把某配置下的点据全部标记为待复核（读数不动，只改点据状态） */
  async function invalidateByObservation(observationId: string): Promise<number> {
    const now = Date.now()
    const targets = await db.ratings.where('slopeObservationId').equals(observationId).toArray()
    if (targets.length === 0) return 0
    await db.ratings.bulkPut(targets.map((rating) => ({ ...rating, pendingReview: true, updatedAt: now })))
    return targets.length
  }

  /* ------------------------------ 比降归属与改正 ------------------------------ */

  /**
   * 回填点据比降归属：按测次时间和水位核对匹配测次，取落差与在用配置。
   * 对不上的点据不改正、不挂起归属（保持 sectionId 为空，即「先挂着」）。
   * 返回新匹配上的点据数。
   */
  async function backfillRatings(): Promise<number> {
    const now = Date.now()
    let matchedCount = 0
    const rows: Rating[] = []
    for (const rating of ratings.value) {
      if (rating.sectionId) {
        rows.push(rating)
        continue
      }
      const matched = matchSectionForRating(
        {
          stationId: rating.stationId,
          measuredAt: rating.measuredAt,
          stageM: rating.stageM,
          measureNo: rating.measureNo
        },
        sections.value
      )
      if (!matched) {
        rows.push(rating)
        continue
      }
      matchedCount += 1
      const fall = calcFallM(matched.upStageM, matched.downStageM)
      const obs = activeObservationOfStation(rating.stationId)
      rows.push({
        ...rating,
        sectionId: matched.id,
        fallM: fall,
        slopeObservationId: obs?.id ?? null,
        fallIndex: obs?.fallIndex ?? null,
        updatedAt: now
      })
    }
    if (matchedCount > 0) await db.ratings.bulkPut(rows)
    return matchedCount
  }

  /** 取点据匹配测次的落差（读数缺失返回 null） */
  function fallOfRating(rating: Rating): number | null {
    if (rating.fallM !== null && rating.fallM !== undefined) return rating.fallM
    const section = sections.value.find((item) => item.id === rating.sectionId)
    return section ? calcFallM(section.upStageM, section.downStageM) : null
  }

  /** 测次比降读数改动后，刷新匹配该测次的点据落差（读数不动，只同步点据的 fallM 展示） */
  async function refreshSectionFalls(sectionId: string): Promise<number> {
    const now = Date.now()
    const section = sections.value.find((item) => item.id === sectionId)
    if (!section) return 0
    const fall = calcFallM(section.upStageM, section.downStageM)
    const targets = ratings.value.filter((rating) => rating.sectionId === sectionId)
    if (targets.length === 0) return 0
    await db.ratings.bulkPut(targets.map((rating) => ({ ...rating, fallM: fall, updatedAt: now })))
    return targets.length
  }

  /**
   * 重算单个点据：按当前在用比降观测把实测流量改正到稳定流，
   * 清除待复核标记（资料室自己重来）。无落差或无配置时不改正。
   */
  async function recorrectRating(ratingId: string): Promise<void> {
    const now = Date.now()
    const rating = ratings.value.find((item) => item.id === ratingId)
    if (!rating) return
    const obs = activeObservationOfStation(rating.stationId)
    const fall = fallOfRating(rating)
    const flowM3s = correctToSteadyFlow(rating.measuredFlowM3s, fall, obs?.refFallM, obs?.fallIndex)
    await db.ratings.update(ratingId, {
      flowM3s,
      fallM: fall,
      slopeObservationId: obs?.id ?? null,
      fallIndex: obs?.fallIndex ?? null,
      pendingReview: false,
      updatedAt: now
    } as never)
  }

  /** 按当前在用配置重算某测站全部点据（已匹配的改正，未匹配的保持实测） */
  async function recorrectStation(stationId: string): Promise<number> {
    const now = Date.now()
    const obs = activeObservationOfStation(stationId)
    const targets = ratings.value.filter((rating) => rating.stationId === stationId)
    if (targets.length === 0) return 0
    const rows = targets.map((rating) => {
      const fall = fallOfRating(rating)
      const flowM3s = correctToSteadyFlow(rating.measuredFlowM3s, fall, obs?.refFallM, obs?.fallIndex)
      return {
        ...rating,
        flowM3s,
        fallM: fall,
        slopeObservationId: obs?.id ?? null,
        fallIndex: obs?.fallIndex ?? null,
        pendingReview: false,
        updatedAt: now
      }
    })
    await db.ratings.bulkPut(rows)
    return rows.length
  }

  /**
   * 试算落差指数：用某测站带落差的点据在 [0.2, 1.0] 内搜索使定线残差最小的 β，
   * 写回配置并按该指数改正全站点据。
   */
  async function trialFitStation(stationId: string, lineNo = 'A'): Promise<TrialFitResult> {
    const obs = activeObservationOfStation(stationId)
    const refFallM = obs?.refFallM ?? 0
    const samples = ratings.value
      .filter((rating) => rating.stationId === stationId)
      .map((rating) => ({
        id: rating.id,
        stageM: rating.stageM,
        measuredFlowM3s: rating.measuredFlowM3s,
        fallM: fallOfRating(rating)
      }))
    const result = trialFitFallIndex(samples, refFallM, lineNo)
    if (result.valid && obs) {
      const now = Date.now()
      await db.slopeObservations.update(obs.id, { fallIndex: result.fallIndex, updatedAt: now } as never)
      const correctedMap = new Map(result.corrected.map((item) => [item.id, item.flowM3s]))
      const rows = ratings.value
        .filter((rating) => rating.stationId === stationId)
        .map((rating) => ({
          ...rating,
          flowM3s: correctedMap.get(rating.id) ?? rating.measuredFlowM3s,
          fallIndex: result.fallIndex,
          slopeObservationId: obs.id,
          pendingReview: false,
          updatedAt: now
        }))
      await db.ratings.bulkPut(rows)
    }
    return result
  }

  return {
    observations,
    sections,
    ratings,
    ready,
    error,
    start,
    observationsOfStation,
    activeObservationOfStation,
    stationSlopeStats,
    createObservation,
    updateObservation,
    withdrawObservation,
    removeObservation,
    invalidateByObservation,
    backfillRatings,
    fallOfRating,
    refreshSectionFalls,
    recorrectRating,
    recorrectStation,
    trialFitStation
  }
})
