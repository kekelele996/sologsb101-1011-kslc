<script setup lang="ts">
/**
 * 比降（落差）改正台 /slopes：
 * - 上：待资料室处理的点据（待复核改正失效 / 待挂接旧点据回填不到归属）；
 * - 下：比降观测档案（上下游水尺读数与时刻、水势、落差、比降）；
 * - 支持批量改正、β 试算、撤销改正、手工核对归属、自动回填、观测增删改。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Aim, Delete, Edit, MagicStick, Plus, RefreshLeft, ScaleToOriginal } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import CorrectionStatusTag from '@/components/common/CorrectionStatusTag.vue'
import SlopeObsDialog from '@/components/common/SlopeObsDialog.vue'
import CorrectionDialog from '@/components/common/CorrectionDialog.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSlopeStore } from '@/stores/slopeStore'
import { useRatingStore } from '@/stores/ratingStore'
import type { Rating } from '@/types/rating'
import type { SlopeObservation } from '@/types/slope'
import { SLOPE_TRENDS, calcFallM, slopePerTenThousand } from '@/types/slope'
import { initDatabase } from '@/utils/db'

const stationStore = useStationStore()
const slopeStore = useSlopeStore()
const ratingStore = useRatingStore()

const stationFilter = ref<string>('')
const trendFilter = ref<string>('')
const obsKeyword = ref('')

const obsDialogVisible = ref(false)
const editingObs = ref<SlopeObservation | null>(null)
const correctionVisible = ref(false)
const correctionTargets = ref<Rating[]>([])
const selectedPending = ref<string[]>([])
/** 待挂接点据手工核对归属时，选中的观测 id（按点据行临时记录） */
const linkChoice = ref<Record<string, string>>({})

onMounted(() => {
  void initDatabase()
  stationStore.start()
  slopeStore.start()
  ratingStore.start()
})

const activeStationId = computed(() => stationFilter.value || stationStore.stations[0]?.id || '')

const pendingRows = computed(() =>
  slopeStore.pendingRatings
    .filter((rating) => !activeStationId.value || rating.stationId === activeStationId.value)
    .map((rating) => {
      const obs = slopeStore.obsById(rating.slopeObsId)
      const linkCandidates = slopeStore.observationsOfStation(rating.stationId)
      return { rating, obs, linkCandidates }
    })
)

const obsRows = computed(() =>
  slopeStore.observations
    .filter((obs) => !activeStationId.value || obs.stationId === activeStationId.value)
    .filter((obs) => (trendFilter.value ? obs.trend === trendFilter.value : true))
    .filter((obs) => {
      const kw = obsKeyword.value.trim()
      if (!kw) return true
      return `${obs.measureNo}${obs.remark}${obs.trend}`.includes(kw)
    })
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
)

/** 已改正点据（供在本站撤销改正 / 查看） */
const correctedRows = computed(() =>
  slopeStore.ratings
    .filter((rating) => rating.stationId === activeStationId.value && rating.correctionStatus === '已改正')
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
)

function handlePendingSelection(rows: typeof pendingRows.value): void {
  selectedPending.value = rows.map((row) => row.rating.id)
}

function setLinkChoice(ratingId: string, obsId: string): void {
  linkChoice.value[ratingId] = obsId
}

/** 供模板内 el-select 事件绑定（预置 ratingId，事件值为观测 id） */
function linkChoiceBinder(ratingId: string): (obsId: string) => void {
  return (obsId: string) => setLinkChoice(ratingId, obsId)
}

function openObsCreate(): void {
  editingObs.value = null
  obsDialogVisible.value = true
}

function openObsEdit(obs: SlopeObservation): void {
  editingObs.value = obs
  obsDialogVisible.value = true
}

async function handleObsSubmit(payload: {
  id?: string
  stationId: string
  sectionId: string | null
  measureNo: string
  upstreamGaugeM: number
  downstreamGaugeM: number
  gaugeDistanceM: number
  observedAt: string
  trend: SlopeObservation['trend']
  remark: string
}): Promise<void> {
  if (payload.id) {
    const { invalidated } = await slopeStore.updateObservation(payload.id, payload)
    if (invalidated > 0) {
      ElMessage.warning(`比降观测已更新，${invalidated} 个改正点据失效并退回待复核`)
    } else {
      ElMessage.success('比降观测已更新')
    }
  } else {
    const { id: _id, ...rest } = payload
    await slopeStore.createObservation(rest)
    const linked = await slopeStore.autoLinkPending()
    ElMessage.success(linked > 0 ? `比降观测已保存，并自动回填 ${linked} 个待挂接点据` : '比降观测已保存')
  }
  await ratingStore.rebuildCompares()
}

async function removeObs(obs: SlopeObservation): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `撤掉测次「${obs.measureNo || '未编号'}」的比降观测后，用它改正过的点据将失效退回待复核（水尺读数档案一并删除）。确认撤掉？`,
      '撤掉比降观测',
      { type: 'warning', confirmButtonText: '撤掉', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const { invalidated } = await slopeStore.removeObservation(obs.id)
  ElMessage.warning(invalidated > 0 ? `已撤掉，${invalidated} 个点据退回待复核` : '比降观测已撤掉')
  await ratingStore.rebuildCompares()
}

function openBatchCorrection(): void {
  const targets = slopeStore.ratings.filter(
    (rating) =>
      rating.stationId === activeStationId.value &&
      (rating.correctionStatus === '未改正' || rating.correctionStatus === '待复核') &&
      rating.slopeObsId
  )
  if (targets.length === 0) {
    ElMessage.warning('当前测站没有可改正的已挂接点据')
    return
  }
  correctionTargets.value = targets
  correctionVisible.value = true
}

function openCorrectionFor(rows: Rating[]): void {
  if (rows.length === 0) return
  correctionTargets.value = rows
  correctionVisible.value = true
}

async function handleApply(payload: { ratingIds: string[]; baseFallM: number; beta: number; note: string }): Promise<void> {
  const done = await slopeStore.applyCorrections(payload.ratingIds, {
    baseFallM: payload.baseFallM,
    beta: payload.beta,
    note: payload.note
  })
  await ratingStore.rebuildCompares()
  ElMessage.success(`已按落差指数改正 ${done} 个点据到稳定流`)
}

async function autoLink(): Promise<void> {
  const linked = await slopeStore.autoLinkPending()
  if (linked === 0) {
    ElMessage.info('没有能按测次时间和水位核对上的待挂接点据')
  } else {
    ElMessage.success(`已回填 ${linked} 个待挂接点据的比降归属，请继续复核改正`)
  }
}

async function manualLink(rating: Rating): Promise<void> {
  const obsId = linkChoice.value[rating.id]
  if (!obsId) {
    ElMessage.warning('请先选择要核对到的比降观测')
    return
  }
  const ok = await slopeStore.linkRating(rating.id, obsId)
  if (ok) ElMessage.success('比降归属已核对，点据转入待复核改正')
  else ElMessage.error('核对失败：观测与点据不属于同一测站')
}

async function revertOne(rating: Rating): Promise<void> {
  const done = await slopeStore.revertCorrection([rating.id])
  await ratingStore.rebuildCompares()
  if (done > 0) ElMessage.success('已撤销改正，恢复实测流量')
}

async function revertSelected(): Promise<void> {
  if (selectedPending.value.length === 0) {
    ElMessage.warning('请先勾选要处理的点据')
    return
  }
  const done = await slopeStore.revertCorrection(selectedPending.value)
  selectedPending.value = []
  await ratingStore.rebuildCompares()
  ElMessage.success(`已处理 ${done} 个点据`)
}

function fallText(obs: SlopeObservation): string {
  return calcFallM(obs).toFixed(3)
}
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">比降（落差）改正</h2>
        <p class="gb-hint">
          巡测班补记上下游比降水尺读数与时刻；资料室按测次时间和水位核对归属，用落差指数法 Qc = Qm×(Zk/Z)^β
          把实测流量改正到稳定流后再定单值线。
        </p>
      </div>
      <div class="page__actions">
        <el-select v-model="stationFilter" class="page__station-select" placeholder="选择测站" clearable>
          <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
        </el-select>
        <el-button :icon="Aim" @click="autoLink">自动回填归属</el-button>
        <el-button :icon="ScaleToOriginal" @click="openBatchCorrection">本站批量改正</el-button>
        <el-button type="primary" :icon="Plus" @click="openObsCreate">补记比降</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="已改正点据" :value="slopeStore.correctedCount" suffix="点" tone="success" icon="DataLine" />
      <StatBadge label="待复核（失效）" :value="slopeStore.reviewCount" suffix="点" tone="warning" icon="WarningFilled" />
      <StatBadge label="待挂接（无归属）" :value="slopeStore.unlinkedCount" suffix="点" tone="danger" icon="Connection" />
      <StatBadge label="比降观测" :value="slopeStore.observations.length" suffix="次" tone="info" icon="Histogram" />
    </div>

    <!-- 待资料室处理的点据 -->
    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>待资料室处理</h3>
        <span class="gb-hint">比降观测改动 / 撤掉后改正失效退回待复核；旧点据回填不到归属先挂着，不参与定线</span>
      </div>
      <EmptyPanel
        v-if="pendingRows.length === 0"
        title="没有待处理点据"
        description="待复核与待挂接的点据会在这里集中，由资料室核对比降后重新改正。"
        compact
      />
      <el-table v-else :data="pendingRows" border stripe class="gb-table-compact" @selection-change="handlePendingSelection">
        <el-table-column type="selection" width="42" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }"><CorrectionStatusTag :status="row.rating.correctionStatus" size="small" /></template>
        </el-table-column>
        <el-table-column label="测站 / 测次" min-width="170">
          <template #default="{ row }">
            <div>{{ slopeStore.stationNameOf(row.rating.stationId) }}</div>
            <div class="gb-hint gb-mono">{{ row.rating.measureNo || '未标记测次' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="96" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span></template>
        </el-table-column>
        <el-table-column label="实测流量" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.rating.rawFlowM3s.toFixed(1) }}</span></template>
        </el-table-column>
        <el-table-column label="当前流量" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.rating.flowM3s.toFixed(1) }}</span></template>
        </el-table-column>
        <el-table-column label="比降归属 / 落差" min-width="200">
          <template #default="{ row }">
            <template v-if="row.obs">
              <el-tag size="small" type="success" effect="plain">{{ row.obs.trend }} · {{ fallText(row.obs) }} m</el-tag>
              <span class="gb-hint gb-mono">{{ new Date(row.obs.observedAt).toLocaleString('zh-CN') }}</span>
            </template>
            <el-select
              v-else
              :model-value="linkChoice[row.rating.id] ?? ''"
              size="small"
              placeholder="选择比降观测核对归属"
              class="page__link-select"
              @update:model-value="setLinkChoice(row.rating.id, $event as string)"
            >
              <el-option
                v-for="candidate in row.linkCandidates"
                :key="candidate.id"
                :label="`${candidate.measureNo || '未编号'} · ${fallText(candidate)} m · ${new Date(candidate.observedAt).toLocaleDateString('zh-CN')}`"
                :value="candidate.id"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="失效原因" min-width="180" show-overflow-tooltip>
          <template #default="{ row }"><span class="gb-hint">{{ row.rating.correctionNote || '—' }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="!row.obs"
              size="small"
              type="primary"
              plain
              :icon="Aim"
              @click="manualLink(row.rating)"
            >核对归属</el-button>
            <el-button v-else size="small" type="primary" :icon="MagicStick" @click="openCorrectionFor([row.rating])">改正</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="pendingRows.length > 0" class="page__bulkbar">
        <el-button size="small" :icon="RefreshLeft" :disabled="selectedPending.length === 0" @click="revertSelected">
          撤销所选改正（恢复实测）
        </el-button>
        <el-button
          size="small"
          type="primary"
          :icon="MagicStick"
          :disabled="selectedPending.length === 0"
          @click="openCorrectionFor(slopeStore.ratings.filter((r) => selectedPending.includes(r.id)))"
        >批量改正所选</el-button>
      </div>
    </el-card>

    <!-- 已改正点据 -->
    <el-card v-if="correctedRows.length > 0" shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>本站已改正点据</h3>
        <span class="gb-hint">以稳定流流量参与定线；撤销改正即恢复实测流量</span>
      </div>
      <el-table :data="correctedRows" border size="small">
        <el-table-column label="测次" min-width="140">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.measureNo || '未标记测次' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.stageM.toFixed(2) }}</span></template>
        </el-table-column>
        <el-table-column label="实测 → 改正" min-width="180" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rawFlowM3s.toFixed(1) }} → <b>{{ row.flowM3s.toFixed(1) }}</b></span>
          </template>
        </el-table-column>
        <el-table-column label="Zk / β" width="140" align="center">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.baseFallM !== null ? row.baseFallM.toFixed(3) : '—' }} / {{ row.fallBeta ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button size="small" :icon="RefreshLeft" @click="revertOne(row)">撤销改正</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 比降观测档案 -->
    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>比降观测档案</h3>
        <div class="page__obs-filters">
          <el-input v-model="obsKeyword" size="small" placeholder="搜索测次号 / 备注" clearable class="page__obs-kw" />
          <el-select v-model="trendFilter" size="small" placeholder="全部水势" clearable class="page__obs-trend">
            <el-option v-for="trend in SLOPE_TRENDS" :key="trend" :label="trend" :value="trend" />
          </el-select>
        </div>
      </div>
      <EmptyPanel
        v-if="obsRows.length === 0"
        title="还没有比降观测"
        description="巡测班一趟测流补记上下游比降水尺读数与时刻后，即可在此查看并用于落差改正。"
        action-text="补记比降"
        compact
        @action="openObsCreate"
      />
      <el-table v-else :data="obsRows" border stripe class="gb-table-compact">
        <el-table-column label="测次号" min-width="140">
          <template #default="{ row }"><span class="gb-mono">{{ row.measureNo || '未编号' }}</span></template>
        </el-table-column>
        <el-table-column label="水势" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.trend === '涨水' ? 'danger' : row.trend === '落水' ? 'warning' : 'info'" effect="plain">
              {{ row.trend }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="上游读数" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.upstreamGaugeM.toFixed(3) }}</span></template>
        </el-table-column>
        <el-table-column label="下游读数" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.downstreamGaugeM.toFixed(3) }}</span></template>
        </el-table-column>
        <el-table-column label="落差 (m)" width="100" align="right">
          <template #default="{ row }"><b class="gb-mono">{{ fallText(row) }}</b></template>
        </el-table-column>
        <el-table-column label="比降 (‱)" width="100" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ slopePerTenThousand(row).toFixed(1) }}</span></template>
        </el-table-column>
        <el-table-column label="间距 (m)" width="96" align="right">
          <template #default="{ row }"><span class="gb-mono">{{ row.gaugeDistanceM }}</span></template>
        </el-table-column>
        <el-table-column label="观测时刻" min-width="168">
          <template #default="{ row }"><span class="gb-mono">{{ new Date(row.observedAt).toLocaleString('zh-CN') }}</span></template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openObsEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeObs(row)">撤掉</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p class="gb-hint">
        读数为观测事实：改动水尺读数 / 时刻后，凡用它改正过的点据立即失效退回待复核，由资料室重新改正；撤掉观测不影响其它读数。
      </p>
    </el-card>

    <SlopeObsDialog v-model="obsDialogVisible" :stations="stationStore.stations" :editing="editingObs" :preset-station-id="activeStationId" @submit="handleObsSubmit" />
    <CorrectionDialog v-model="correctionVisible" :ratings="correctionTargets" @apply="handleApply" />
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__station-select {
  width: 160px;
}

.page__link-select {
  width: 100%;
}

.page__bulkbar {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.page__obs-filters {
  display: flex;
  gap: 8px;
}

.page__obs-kw {
  width: 180px;
}

.page__obs-trend {
  width: 110px;
}
</style>
