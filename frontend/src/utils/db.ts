/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbhydrogaug，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（测站 → 断面 → 垂线 → 测点 → 点据 → 比测）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Rating } from '@/types/rating'
import type { Compare } from '@/types/compare'
import type { SlopeObservation } from '@/types/slope'
import { matchObservation, meanFall, type CorrectionStatus } from '@/types/slope'
import { calcDeviationPct, judgeDeviation } from '@/types/compare'
import { fitPowerCurve, effectiveFlow, isFitableRating } from '@/types/rating'
import { calcMeanVelocity, round } from '@/utils/flow'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbhydrogaug'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbhydrogaug:db-version',
  lastBackupAt: 'gbhydrogaug:last-backup-at',
  lastStationId: 'gbhydrogaug:last-station-id'
} as const

/** 备份文件结构，供 utils/export.ts 与导出页使用 */
export interface BackupPayload {
  app: 'gbhydrogaug'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  ratings: Rating[]
  compares: Compare[]
  slopeObservations: SlopeObservation[]
}

class HydroGaugeDatabase extends Dexie {
  stations!: Table<Station, string>
  sections!: Table<Section, string>
  verticals!: Table<Vertical, string>
  points!: Table<Point, string>
  ratings!: Table<Rating, string>
  compares!: Table<Compare, string>
  slopeObservations!: Table<SlopeObservation, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      stations: 'id, name, river, sectionCode',
      sections: 'id, stationId, measureNo, method',
      verticals: 'id, sectionId, no',
      points: 'id, verticalId, relativeDepth',
      ratings: 'id, stationId, lineNo, stageM',
      compares: 'id, ratingId, verdict'
    })

    // v2：补齐筛选与统计需要的索引（河名/集水面积、水位、测法、偏差判定）
    this.version(2).stores({
      stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
      sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
      verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
      points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
      ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
      compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
    })

    // v3：比降（落差）改正——新增比降观测表，点据补改正归属字段。
    // 旧点据没有比降归属，升级时按测次时间回填，对不上的先挂「待挂接」。
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings:
          'id, stationId, lineNo, stageM, flowM3s, measuredAt, correctionStatus, slopeObsId, updatedAt',
        compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt',
        slopeObservations: 'id, stationId, sectionId, measureNo, observedAt, trend, updatedAt'
      })
      .upgrade(async (tx) => {
        // v3 只补本版新增的点据改正字段。
        // 注意：v1→v3 升级时 Dexie 会先执行 v2 的 upgrade（补时间戳等），
        // 这里绝不能重跑 v2 的默认值 Object.assign，否则会把已有的 measureNo / lineNo 覆盖成空值。
        const slopeRows = (await tx.table('slopeObservations').toArray()) as SlopeObservation[]
        await tx
          .table('ratings')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
            if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            const rawFlow = typeof row.flowM3s === 'number' ? row.flowM3s : 0
            if (typeof row.rawFlowM3s !== 'number') row.rawFlowM3s = rawFlow
            if (typeof row.correctionStatus !== 'string') row.correctionStatus = '待挂接'
            if (!('slopeObsId' in row)) row.slopeObsId = null
            if (!('baseFallM' in row)) row.baseFallM = null
            if (!('fallBeta' in row)) row.fallBeta = null
            if (typeof row.correctionNote !== 'string') row.correctionNote = ''
            const matched = matchObservation(
              {
                stationId: String(row.stationId ?? ''),
                measureNo: typeof row.measureNo === 'string' ? row.measureNo : '',
                measuredAt: typeof row.measuredAt === 'string' ? row.measuredAt : '',
                stageM: typeof row.stageM === 'number' ? row.stageM : NaN
              },
              slopeRows
            )
            if (matched) {
              // 只补比降归属，改正与否仍由资料室重新核对（状态保持可定线的待复核）
              row.slopeObsId = matched.id
              if (row.correctionStatus === '待挂接') row.correctionStatus = '待复核'
              if (!row.correctionNote) row.correctionNote = '升级时按测次时间回填比降归属，待资料室复核改正'
            }
          })
      })
  }
}

export const db = new HydroGaugeDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedStationBundle {
  station: Omit<Station, 'createdAt' | 'updatedAt'>
  sections: Array<Omit<Section, 'createdAt' | 'updatedAt'>>
  verticals: Array<Omit<Vertical, 'createdAt' | 'updatedAt'>>
  points: Array<Omit<Point, 'createdAt' | 'updatedAt'>>
}

/**
 * 播种演示数据：3 个测站 → 4 个断面测次 → 8 条垂线 → 16 个流速测点，
 * 并据此生成水位流量关系点据与比测记录，保证父 → 子 → 孙三层链路可点开。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const iso = new Date(now).toISOString()

  const stationBundles: SeedStationBundle[] = [
    {
      station: {
        id: 'stn_lh01',
        name: '龙门水文站',
        river: '澜沧江',
        catchmentKm2: 45200,
        sectionCode: 'CS-LM-01',
        remark: '基本水文站，缆道测流，断面稳定'
      },
      sections: [
        {
          id: 'sec_lh_2406',
          stationId: 'stn_lh01',
          measureNo: '2024-06-001',
          startDistanceM: 12.5,
          stageM: 5.42,
          method: '流速仪',
          measuredAt: '2024-06-12T08:30:00.000Z'
        },
        {
          id: 'sec_lh_2407',
          stationId: 'stn_lh01',
          measureNo: '2024-07-002',
          startDistanceM: 12.5,
          stageM: 6.15,
          method: 'ADCP',
          measuredAt: '2024-07-18T09:10:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_lh_1', sectionId: 'sec_lh_2406', no: 1, startDistanceM: 6.5, depthM: 1.4, pointCount: 2, bedNote: '左岸浅滩，砾石河床' },
        { id: 'vrt_lh_2', sectionId: 'sec_lh_2406', no: 2, startDistanceM: 14.0, depthM: 3.2, pointCount: 3, bedNote: '主流，砂卵石' },
        { id: 'vrt_lh_3', sectionId: 'sec_lh_2406', no: 3, startDistanceM: 22.0, depthM: 2.1, pointCount: 2, bedNote: '右岸缓流，细砂' },
        { id: 'vrt_lh_4', sectionId: 'sec_lh_2407', no: 1, startDistanceM: 8.0, depthM: 3.8, pointCount: 3, bedNote: 'ADCP 走航断面，主槽' }
      ],
      points: [
        { id: 'pnt_lh_11', verticalId: 'vrt_lh_1', relativeDepth: 0.2, velocityMs: 0.62, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_12', verticalId: 'vrt_lh_1', relativeDepth: 0.8, velocityMs: 0.48, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_21', verticalId: 'vrt_lh_2', relativeDepth: 0.2, velocityMs: 1.42, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_22', verticalId: 'vrt_lh_2', relativeDepth: 0.6, velocityMs: 1.18, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_23', verticalId: 'vrt_lh_2', relativeDepth: 0.8, velocityMs: 0.96, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_31', verticalId: 'vrt_lh_3', relativeDepth: 0.2, velocityMs: 0.82, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_32', verticalId: 'vrt_lh_3', relativeDepth: 0.8, velocityMs: 0.64, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_41', verticalId: 'vrt_lh_4', relativeDepth: 0.2, velocityMs: 1.86, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_42', verticalId: 'vrt_lh_4', relativeDepth: 0.6, velocityMs: 1.64, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_43', verticalId: 'vrt_lh_4', relativeDepth: 0.8, velocityMs: 1.32, weight: 1 / 3, durationS: 120 }
      ]
    },
    {
      station: {
        id: 'stn_qj02',
        name: '青矶水位站',
        river: '沅江',
        catchmentKm2: 1860,
        sectionCode: 'CS-QJ-02',
        remark: '小河站，浮标法为主，洪水期加测'
      },
      sections: [
        {
          id: 'sec_qj_2405',
          stationId: 'stn_qj02',
          measureNo: '2024-05-003',
          startDistanceM: 4.2,
          stageM: 3.18,
          method: '浮标',
          measuredAt: '2024-05-22T07:50:00.000Z'
        },
        {
          id: 'sec_qj_2408',
          stationId: 'stn_qj02',
          measureNo: '2024-08-004',
          startDistanceM: 4.2,
          stageM: 4.36,
          method: '流速仪',
          measuredAt: '2024-08-09T06:40:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_qj_1', sectionId: 'sec_qj_2405', no: 1, startDistanceM: 2.4, depthM: 1.1, pointCount: 2, bedNote: '浮标上断面' },
        { id: 'vrt_qj_2', sectionId: 'sec_qj_2405', no: 2, startDistanceM: 6.8, depthM: 1.9, pointCount: 2, bedNote: '浮标中泓' },
        { id: 'vrt_qj_3', sectionId: 'sec_qj_2408', no: 1, startDistanceM: 3.1, depthM: 1.6, pointCount: 3, bedNote: '涨水期，流速仪三点法' },
        { id: 'vrt_qj_4', sectionId: 'sec_qj_2408', no: 2, startDistanceM: 7.6, depthM: 2.4, pointCount: 3, bedNote: '主槽，卵石夹砂' }
      ],
      points: [
        { id: 'pnt_qj_11', verticalId: 'vrt_qj_1', relativeDepth: 0.2, velocityMs: 0.54, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_12', verticalId: 'vrt_qj_1', relativeDepth: 0.8, velocityMs: 0.42, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_21', verticalId: 'vrt_qj_2', relativeDepth: 0.2, velocityMs: 0.88, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_22', verticalId: 'vrt_qj_2', relativeDepth: 0.8, velocityMs: 0.7, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_31', verticalId: 'vrt_qj_3', relativeDepth: 0.2, velocityMs: 1.06, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_32', verticalId: 'vrt_qj_3', relativeDepth: 0.6, velocityMs: 0.92, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_33', verticalId: 'vrt_qj_3', relativeDepth: 0.8, velocityMs: 0.78, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_41', verticalId: 'vrt_qj_4', relativeDepth: 0.2, velocityMs: 1.34, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_42', verticalId: 'vrt_qj_4', relativeDepth: 0.6, velocityMs: 1.2, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_43', verticalId: 'vrt_qj_4', relativeDepth: 0.8, velocityMs: 1.04, weight: 1 / 3, durationS: 100 }
      ]
    },
    {
      station: {
        id: 'stn_bs03',
        name: '白沙滩巡测站',
        river: '澜沧江',
        catchmentKm2: 51200,
        sectionCode: 'CS-BS-03',
        remark: '巡测断面，与龙门站比测'
      },
      sections: [
        {
          id: 'sec_bs_2406',
          stationId: 'stn_bs03',
          measureNo: '2024-06-005',
          startDistanceM: 18.0,
          stageM: 5.36,
          method: 'ADCP',
          measuredAt: '2024-06-20T10:05:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_bs_1', sectionId: 'sec_bs_2406', no: 1, startDistanceM: 10.0, depthM: 2.6, pointCount: 3, bedNote: 'ADCP 左半断面' },
        { id: 'vrt_bs_2', sectionId: 'sec_bs_2406', no: 2, startDistanceM: 24.0, depthM: 3.4, pointCount: 3, bedNote: 'ADCP 右半断面' }
      ],
      points: [
        { id: 'pnt_bs_11', verticalId: 'vrt_bs_1', relativeDepth: 0.2, velocityMs: 1.22, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_12', verticalId: 'vrt_bs_1', relativeDepth: 0.6, velocityMs: 1.08, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_13', verticalId: 'vrt_bs_1', relativeDepth: 0.8, velocityMs: 0.9, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_21', verticalId: 'vrt_bs_2', relativeDepth: 0.2, velocityMs: 1.46, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_22', verticalId: 'vrt_bs_2', relativeDepth: 0.6, velocityMs: 1.3, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_23', verticalId: 'vrt_bs_2', relativeDepth: 0.8, velocityMs: 1.1, weight: 1 / 3, durationS: 120 }
      ]
    }
  ]

  // 水位流量关系点据：A 线为龙门站主定线，B 线为青矶站定线
  const ratingSeeds: Array<Omit<Rating, 'createdAt' | 'updatedAt'>> = [
    { id: 'rat_lh_a1', stationId: 'stn_lh01', stageM: 4.01, flowM3s: 97.5, rawFlowM3s: 97.5, lineNo: 'A', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z', correctionStatus: '未改正', slopeObsId: null, baseFallM: null, fallBeta: null, correctionNote: '' },
    { id: 'rat_lh_a2', stationId: 'stn_lh01', stageM: 4.52, flowM3s: 138.7, rawFlowM3s: 138.7, lineNo: 'A', measureNo: '2024-05-002', measuredAt: '2024-05-16T08:00:00.000Z', correctionStatus: '未改正', slopeObsId: null, baseFallM: null, fallBeta: null, correctionNote: '' },
    { id: 'rat_lh_a3', stationId: 'stn_lh01', stageM: 5.42, flowM3s: 217.2, rawFlowM3s: 217.2, lineNo: 'A', measureNo: '2024-06-001', measuredAt: '2024-06-12T08:30:00.000Z', correctionStatus: '未改正', slopeObsId: null, baseFallM: null, fallBeta: null, correctionNote: '' },
    { id: 'rat_lh_a4', stationId: 'stn_lh01', stageM: 6.15, flowM3s: 298.5, rawFlowM3s: 298.5, lineNo: 'A', measureNo: '2024-07-002', measuredAt: '2024-07-18T09:10:00.000Z', correctionStatus: '未改正', slopeObsId: null, baseFallM: null, fallBeta: null, correctionNote: '' },
    { id: 'rat_lh_a5', stationId: 'stn_lh01', stageM: 7.03, flowM3s: 428.1, rawFlowM3s: 428.1, lineNo: 'A', measureNo: '2024-08-006', measuredAt: '2024-08-21T08:20:00.000Z', correctionStatus: '未改正', slopeObsId: null, baseFallM: null, fallBeta: null, correctionNote: '' },
    { id: 'rat_qj_b1', stationId: 'stn_qj02', stageM: 2.84, flowM3s: 42.3, rawFlowM3s: 42.3, lineNo: 'B', measureNo: '2023-05-001', measuredAt: '2023-05-11T07:30:00.000Z', correctionStatus: '未改正', slopeObsId: null, baseFallM: null, fallBeta: null, correctionNote: '' },
    { id: 'rat_qj_b2', stationId: 'stn_qj02', stageM: 3.18, flowM3s: 56.1, rawFlowM3s: 56.1, lineNo: 'B', measureNo: '2024-05-003', measuredAt: '2024-05-22T07:50:00.000Z', correctionStatus: '未改正', slopeObsId: null, baseFallM: null, fallBeta: null, correctionNote: '' },
    { id: 'rat_qj_b3', stationId: 'stn_qj02', stageM: 3.72, flowM3s: 78.4, rawFlowM3s: 78.4, lineNo: 'B', measureNo: '2024-07-001', measuredAt: '2024-07-02T08:10:00.000Z', correctionStatus: '未改正', slopeObsId: null, baseFallM: null, fallBeta: null, correctionNote: '' },
    { id: 'rat_qj_b4', stationId: 'stn_qj02', stageM: 4.36, flowM3s: 115.6, rawFlowM3s: 115.6, lineNo: 'B', measureNo: '2024-08-004', measuredAt: '2024-08-09T06:40:00.000Z', correctionStatus: '未改正', slopeObsId: null, baseFallM: null, fallBeta: null, correctionNote: '' },
    // C 线：含两个明显偏离点，用于演示超限挂红与偏差分析
    { id: 'rat_bs_c1', stationId: 'stn_bs03', stageM: 4.9, flowM3s: 168.0, rawFlowM3s: 168.0, lineNo: 'C', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z', correctionStatus: '未改正', slopeObsId: null, baseFallM: null, fallBeta: null, correctionNote: '' },
    { id: 'rat_bs_c2', stationId: 'stn_bs03', stageM: 5.36, flowM3s: 203.5, rawFlowM3s: 203.5, lineNo: 'C', measureNo: '2024-06-005', measuredAt: '2024-06-20T10:05:00.000Z', correctionStatus: '未改正', slopeObsId: null, baseFallM: null, fallBeta: null, correctionNote: '' },
    { id: 'rat_bs_c3', stationId: 'stn_bs03', stageM: 5.88, flowM3s: 325.0, rawFlowM3s: 325.0, lineNo: 'C', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z', correctionStatus: '未改正', slopeObsId: null, baseFallM: null, fallBeta: null, correctionNote: '' },
    { id: 'rat_bs_c4', stationId: 'stn_bs03', stageM: 6.44, flowM3s: 288.0, rawFlowM3s: 288.0, lineNo: 'C', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z', correctionStatus: '未改正', slopeObsId: null, baseFallM: null, fallBeta: null, correctionNote: '' }
  ]

  // 比降观测：巡测班一趟测流补记上下游比降水尺读数与时刻（含涨/落/平衡水势）
  const slopeSeeds: Array<Omit<SlopeObservation, 'createdAt' | 'updatedAt'>> = [
    // 龙门站（比降水尺间距 800 m）：A 线 5 个点据 + 2 个建档测次
    { id: 'slp_lh_a1', stationId: 'stn_lh01', sectionId: null, measureNo: '2024-04-001', upstreamGaugeM: 4.26, downstreamGaugeM: 4.01, gaugeDistanceM: 800, observedAt: '2024-04-08T08:00:00.000Z', trend: '平衡', remark: '枯水平稳' },
    { id: 'slp_lh_a2', stationId: 'stn_lh01', sectionId: null, measureNo: '2024-05-002', upstreamGaugeM: 4.82, downstreamGaugeM: 4.52, gaugeDistanceM: 800, observedAt: '2024-05-16T08:00:00.000Z', trend: '涨水', remark: '初涨' },
    { id: 'slp_lh_2406', stationId: 'stn_lh01', sectionId: 'sec_lh_2406', measureNo: '2024-06-001', upstreamGaugeM: 5.65, downstreamGaugeM: 5.42, gaugeDistanceM: 800, observedAt: '2024-06-12T08:30:00.000Z', trend: '涨水', remark: '缆道测流同时刻比降' },
    { id: 'slp_lh_2407', stationId: 'stn_lh01', sectionId: 'sec_lh_2407', measureNo: '2024-07-002', upstreamGaugeM: 6.35, downstreamGaugeM: 6.15, gaugeDistanceM: 800, observedAt: '2024-07-18T09:10:00.000Z', trend: '落水', remark: '洪峰回落' },
    { id: 'slp_lh_a5', stationId: 'stn_lh01', sectionId: null, measureNo: '2024-08-006', upstreamGaugeM: 7.26, downstreamGaugeM: 7.03, gaugeDistanceM: 800, observedAt: '2024-08-21T08:20:00.000Z', trend: '落水', remark: '退水段' },
    // 青矶站（比降水尺间距 600 m）：B 线 4 个点据
    { id: 'slp_qj_b1', stationId: 'stn_qj02', sectionId: null, measureNo: '2023-05-001', upstreamGaugeM: 3.01, downstreamGaugeM: 2.84, gaugeDistanceM: 600, observedAt: '2023-05-11T07:30:00.000Z', trend: '平衡', remark: '' },
    { id: 'slp_qj_2405', stationId: 'stn_qj02', sectionId: 'sec_qj_2405', measureNo: '2024-05-003', upstreamGaugeM: 3.37, downstreamGaugeM: 3.18, gaugeDistanceM: 600, observedAt: '2024-05-22T07:50:00.000Z', trend: '涨水', remark: '浮标法同时刻比降' },
    { id: 'slp_qj_b3', stationId: 'stn_qj02', sectionId: null, measureNo: '2024-07-001', upstreamGaugeM: 3.84, downstreamGaugeM: 3.72, gaugeDistanceM: 600, observedAt: '2024-07-02T08:10:00.000Z', trend: '落水', remark: '' },
    { id: 'slp_qj_2408', stationId: 'stn_qj02', sectionId: 'sec_qj_2408', measureNo: '2024-08-004', upstreamGaugeM: 4.5, downstreamGaugeM: 4.36, gaugeDistanceM: 600, observedAt: '2024-08-09T06:40:00.000Z', trend: '涨水', remark: '洪期加测' },
    // 白沙滩（比降水尺间距 900 m）：C 线 4 个点据
    { id: 'slp_bs_c1', stationId: 'stn_bs03', sectionId: null, measureNo: '2024-05-004', upstreamGaugeM: 5.13, downstreamGaugeM: 4.9, gaugeDistanceM: 900, observedAt: '2024-05-28T09:00:00.000Z', trend: '涨水', remark: '' },
    { id: 'slp_bs_2406', stationId: 'stn_bs03', sectionId: 'sec_bs_2406', measureNo: '2024-06-005', upstreamGaugeM: 5.61, downstreamGaugeM: 5.36, gaugeDistanceM: 900, observedAt: '2024-06-20T10:05:00.000Z', trend: '涨水', remark: 'ADCP 走航同时刻比降' },
    { id: 'slp_bs_c3', stationId: 'stn_bs03', sectionId: null, measureNo: '2024-07-007', upstreamGaugeM: 6.1, downstreamGaugeM: 5.88, gaugeDistanceM: 900, observedAt: '2024-07-25T09:30:00.000Z', trend: '落水', remark: '' },
    { id: 'slp_bs_c4', stationId: 'stn_bs03', sectionId: null, measureNo: '2024-08-008', upstreamGaugeM: 6.69, downstreamGaugeM: 6.44, gaugeDistanceM: 900, observedAt: '2024-08-15T09:40:00.000Z', trend: '落水', remark: '' }
  ]

  /**
   * 资料室改正成果（演示）：A 线按落差指数改正到稳定流；
   * 其中 rat_lh_a2 因其比降观测随后被改动而退回「待复核」（改正失效、恢复实测流量）；
   * rat_bs_c3 升级前为没有比降归属的旧点据，回填不上先「挂着」并不参与 C 线定线。
   */
  const correctionSeeds: Record<
    string,
    { flowM3s: number; status: CorrectionStatus; slopeObsId: string | null; note?: string }
  > = {
    rat_lh_a1: { flowM3s: 95.93, status: '已改正', slopeObsId: 'slp_lh_a1' },
    rat_lh_a2: { flowM3s: 138.7, status: '待复核', slopeObsId: 'slp_lh_a2', note: '其比降观测（上游水尺读数）已改动，改正失效，退回资料室重新改正' },
    rat_lh_a3: { flowM3s: 222.79, status: '已改正', slopeObsId: 'slp_lh_2406' },
    rat_lh_a4: { flowM3s: 328.35, status: '已改正', slopeObsId: 'slp_lh_2407' },
    rat_lh_a5: { flowM3s: 439.13, status: '已改正', slopeObsId: 'slp_lh_a5' },
    rat_bs_c3: { flowM3s: 325.0, status: '待挂接', slopeObsId: null, note: '旧点据按测次时间回填不到比降归属，先挂着' }
  }

  // 套用资料室改正成果到点据（Zk/β 按对应测站比降观测回填，供页面回显）
  const stationFalls = new Map<string, number>()
  const stationOf = (id: string): string => slopeSeeds.find((item) => item.id === id)?.stationId ?? ''
  new Set(slopeSeeds.map((obs) => obs.stationId)).forEach((stationId) => {
    stationFalls.set(stationId, meanFall(slopeSeeds.filter((obs) => obs.stationId === stationId)))
  })

  const finalRatingSeeds: Array<Omit<Rating, 'createdAt' | 'updatedAt'>> = ratingSeeds.map((rating) => {
    const seeded = correctionSeeds[rating.id]
    if (!seeded) return rating
    const stationId = seeded.slopeObsId ? stationOf(seeded.slopeObsId) : rating.stationId
    const corrected = seeded.status === '已改正'
    return {
      ...rating,
      flowM3s: seeded.flowM3s,
      correctionStatus: seeded.status,
      slopeObsId: seeded.slopeObsId,
      baseFallM: corrected ? stationFalls.get(stationId) ?? null : null,
      fallBeta: corrected ? 0.5 : null,
      correctionNote: seeded.note ?? (corrected ? '按当次比降改正到稳定流' : '')
    }
  })

  await db.transaction(
    'rw',
    [db.stations, db.sections, db.verticals, db.points, db.ratings, db.compares, db.slopeObservations],
    async () => {
      const stamp = (row: { id: string }): { createdAt: number; updatedAt: number } => ({
        createdAt: now + row.id.length,
        updatedAt: now + row.id.length
      })

      await db.stations.bulkPut(
        stationBundles.map((bundle) => ({ ...bundle.station, ...stamp(bundle.station) }))
      )
      await db.sections.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.sections.map((section) => ({ ...section, ...stamp(section) }))
        )
      )
      await db.verticals.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.verticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
        )
      )
      await db.points.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.points.map((point) => ({ ...point, ...stamp(point) }))
        )
      )
      await db.ratings.bulkPut(finalRatingSeeds.map((rating) => ({ ...rating, ...stamp(rating) })))
      await db.slopeObservations.bulkPut(slopeSeeds.map((obs) => ({ ...obs, ...stamp(obs) })))

      // 比测记录：按可定线点据（剔除待挂接）拟合曲线流量后计算偏差与判定
      const compares: Compare[] = []
      const lineGroups = new Map<string, Array<{ stageM: number; flowM3s: number }>>()
      finalRatingSeeds.forEach((rating) => {
        if (!isFitableRating(rating)) return
        const list = lineGroups.get(rating.lineNo) ?? []
        list.push({ stageM: rating.stageM, flowM3s: effectiveFlow(rating) })
        lineGroups.set(rating.lineNo, list)
      })
      finalRatingSeeds.forEach((rating) => {
        const fit = fitPowerCurve(lineGroups.get(rating.lineNo) ?? [], rating.lineNo)
        if (!fit.valid) return
        const measured = effectiveFlow(rating)
        const predicted = round(fit.a * Math.pow(Math.max(rating.stageM - fit.h0, 1e-6), fit.b), 2)
        const deviationPct = calcDeviationPct(measured, predicted)
        compares.push({
          id: `cmp_${rating.id}`,
          ratingId: rating.id,
          measuredFlow: measured,
          curveFlow: predicted,
          deviationPct,
          verdict: judgeDeviation(deviationPct),
          operator: rating.lineNo === 'C' ? '周渝' : '林昭',
          comparedAt: rating.measuredAt,
          createdAt: now,
          updatedAt: now
        })
      })
      await db.compares.bulkPut(compares)
      if (compares.length === 0) {
        await db.compares.put({
          id: 'cmp_fallback',
          ratingId: 'rat_lh_a1',
          measuredFlow: 97.5,
          curveFlow: 100.2,
          deviationPct: calcDeviationPct(97.5, 100.2),
          verdict: judgeDeviation(calcDeviationPct(97.5, 100.2)),
          operator: '林昭',
          comparedAt: iso,
          createdAt: now,
          updatedAt: now
        })
      }
    }
  )
}

/** 打开数据库并幂等播种：仅当测站表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.stations.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.sections, db.verticals, db.points, db.ratings, db.compares, db.slopeObservations],
    async () => {
      await Promise.all([
        db.stations.clear(),
        db.sections.clear(),
        db.verticals.clear(),
        db.points.clear(),
        db.ratings.clear(),
        db.compares.clear(),
        db.slopeObservations.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/**
 * 归一化点据的比降改正字段：旧备份 / 手工写入的数据补齐缺省值。
 * 缺比降归属的旧点据一律先挂「待挂接」，由导入后的回填逻辑再核对。
 */
export function normalizeRating(row: Partial<Rating> & Pick<Rating, 'id' | 'stationId' | 'stageM' | 'flowM3s'>): Rating {
  const rawFlow = typeof row.rawFlowM3s === 'number' ? row.rawFlowM3s : row.flowM3s
  const hasStatus = typeof row.correctionStatus === 'string'
  return {
    ...(row as Rating),
    rawFlowM3s: rawFlow,
    correctionStatus: hasStatus ? (row.correctionStatus as CorrectionStatus) : '待挂接',
    slopeObsId: 'slopeObsId' in row ? (row.slopeObsId ?? null) : null,
    baseFallM: typeof row.baseFallM === 'number' ? row.baseFallM : null,
    fallBeta: typeof row.fallBeta === 'number' ? row.fallBeta : null,
    correctionNote: typeof row.correctionNote === 'string' ? row.correctionNote : ''
  }
}

/**
 * 旧点据按测次时间回填比降归属：同测站先按测次号、再按时间窗口与水位核对。
 * 仅给「待挂接」且尚无归属的点据补 obsId，已挂接 / 已改正的点据不动。
 * 对不上的点据继续挂着。
 */
export async function backfillRatingSlopeLinks(): Promise<number> {
  const [ratings, observations] = await Promise.all([db.ratings.toArray(), db.slopeObservations.toArray()])
  let linked = 0
  const now = Date.now()
  await db.transaction('rw', [db.ratings], async () => {
    for (const rating of ratings) {
      if (rating.slopeObsId || rating.correctionStatus !== '待挂接') continue
      const matched = matchObservation(rating, observations)
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

/** 统计各表行数，供页脚概览与导出页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [stations, sections, verticals, points, ratings, compares, slopeObservations] = await Promise.all([
    db.stations.count(),
    db.sections.count(),
    db.verticals.count(),
    db.points.count(),
    db.ratings.count(),
    db.compares.count(),
    db.slopeObservations.count()
  ])
  return { stations, sections, verticals, points, ratings, compares, slopeObservations }
}

/** 写入结构版本号到 localStorage，便于导出页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastStationId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastStationId)
  } catch {
    return null
  }
}

export function writeLastStationId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastStationId)
    else localStorage.setItem(LS_KEYS.lastStationId, id)
  } catch {
    // 忽略
  }
}

/** 计算某垂线的平均流速（页面与播种共用同一套算法） */
export function verticalMeanVelocity(points: Point[]): number {
  return calcMeanVelocity(points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
}
