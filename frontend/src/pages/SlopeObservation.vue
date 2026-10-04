<script setup lang="ts">
/**
 * 比降观测管理：/stations/:id/slope
 * 维护测站的比降观测配置（参考落差、落差指数、在用/撤掉），
 * 用已有关系点据试算落差指数 β，把实测流量改正到稳定流，
 * 并展示点据的比降归属（已匹配 / 待复核 / 未匹配）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Refresh, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSlopeStore } from '@/stores/slopeStore'
import { useRatingStore } from '@/stores/ratingStore'
import { DEFAULT_FALL_INDEX, ratingSlopeState, type SlopeObservation } from '@/types/slope'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const stationStore = useStationStore()
const slopeStore = useSlopeStore()
const ratingStore = useRatingStore()

const stationId = computed(() => String(route.params.id ?? ''))
const station = computed(() => stationStore.stationById(stationId.value))

const stats = computed(() => slopeStore.stationSlopeStats(stationId.value))
const observations = computed(() => slopeStore.observationsOfStation(stationId.value))
const activeObs = computed(() => slopeStore.activeObservationOfStation(stationId.value))

/** 该站点据（按水位排序），用于比降归属与改正展示 */
const stationRatings = computed(() =>
  ratingStore.ratings
    .filter((rating) => rating.stationId === stationId.value)
    .sort((a, b) => a.stageM - b.stageM)
)

/** 该站主导定线号（点据最多的定线号），用于落差指数试算 */
const dominantLineNo = computed(() => {
  const counts = new Map<string, number>()
  stationRatings.value.forEach((rating) => counts.set(rating.lineNo, (counts.get(rating.lineNo) ?? 0) + 1))
  let best = 'A'
  let bestCount = 0
  counts.forEach((count, lineNo) => {
    if (count > bestCount) {
      best = lineNo
      bestCount = count
    }
  })
  return best
})

const trialLineNo = ref('A')

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  name: '',
  refFallM: 0.8,
  fallIndex: DEFAULT_FALL_INDEX,
  remark: ''
})

function openCreate(): void {
  editingId.value = null
  form.name = '基本比降观测'
  form.refFallM = activeObs.value?.refFallM ?? 0.8
  form.fallIndex = activeObs.value?.fallIndex ?? DEFAULT_FALL_INDEX
  form.remark = ''
  dialogVisible.value = true
}

function openEdit(obs: SlopeObservation): void {
  editingId.value = obs.id
  form.name = obs.name
  form.refFallM = obs.refFallM
  form.fallIndex = obs.fallIndex ?? DEFAULT_FALL_INDEX
  form.remark = obs.remark
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('请填写配置名称')
    return
  }
  if (!Number.isFinite(form.refFallM) || form.refFallM <= 0) {
    ElMessage.warning('参考落差应为大于 0 的数字（m）')
    return
  }
  if (!Number.isFinite(form.fallIndex) || form.fallIndex <= 0) {
    ElMessage.warning('落差指数应为大于 0 的数字')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: stationId.value,
      name: form.name.trim(),
      refFallM: form.refFallM,
      fallIndex: form.fallIndex,
      remark: form.remark.trim()
    }
    if (editingId.value) {
      await slopeStore.updateObservation(editingId.value, payload)
      ElMessage.success('比降观测配置已更新，其下点据已退回待复核')
    } else {
      await slopeStore.createObservation(payload)
      ElMessage.success('比降观测配置已新增并在用')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function withdraw(obs: SlopeObservation): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `撤掉「${obs.name}」后，用它改正过的点据将失效并退回待复核（比降水尺读数不动），确认撤掉？`,
      '撤掉比降观测',
      { type: 'warning', confirmButtonText: '撤掉', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await slopeStore.withdrawObservation(obs.id)
  ElMessage.success('比降观测已撤掉，相关点据退回待复核')
}

async function trialFit(): Promise<void> {
  if (!activeObs.value) {
    ElMessage.warning('请先新增一条在用比降观测配置')
    return
  }
  const result = await slopeStore.trialFitStation(stationId.value, trialLineNo.value)
  if (result.valid) {
    ElMessage.success(result.message)
  } else {
    ElMessage.warning(result.message || '落差指数试算失败')
  }
}

async function backfill(): Promise<void> {
  const count = await slopeStore.backfillRatings()
  if (count > 0) ElMessage.success(`已按测次时间和水位回填 ${count} 条点据的比降归属`)
  else ElMessage.info('没有新的可匹配点据（对不上的先挂着）')
}

async function recorrect(ratingId: string): Promise<void> {
  await slopeStore.recorrectRating(ratingId)
  ElMessage.success('点据已按当前比降观测重算')
}

function stateTagType(state: string): 'success' | 'warning' | 'info' {
  if (state === 'attributed') return 'success'
  if (state === 'pending') return 'warning'
  return 'info'
}

function stateText(state: string): string {
  if (state === 'attributed') return '已匹配'
  if (state === 'pending') return '待复核'
  return '未匹配'
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  trialLineNo.value = dominantLineNo.value
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!stationStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!station"
      entity-label="测站"
      :missing-id="stationId"
      fallback-path="/stations"
      fallback-text="返回测站台账"
      :candidates="
        stationStore.stations.slice(0, 3).map((item) => ({
          id: item.id,
          label: `${item.name} 的比降观测`,
          path: `/stations/${item.id}/slope`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/stations' }">测站台账</el-breadcrumb-item>
            <el-breadcrumb-item>{{ station.name }}</el-breadcrumb-item>
            <el-breadcrumb-item>比降观测</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            {{ station.name }} · 比降观测与落差改正
            <el-tag size="small" effect="plain" class="page__tag">{{ station.sectionCode }}</el-tag>
          </h2>
          <p class="gb-hint">
            巡测班在测次上补记往返比降（上、下比降水尺读数与时刻）；定线前照当次比降把实测流量改正到稳定流，
            落差指数 β 用已有关系点据试算。比降观测改动或撤掉后，用它改过的点据退回待复核，比降水尺读数不动。
          </p>
        </div>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增比降观测</el-button>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="在用配置" :value="activeObs ? 1 : 0" suffix="条" icon="Odometer" tone="success" />
        <StatBadge label="已匹配点据" :value="stats.attributed" suffix="点" icon="DataLine" tone="info" />
        <StatBadge label="待复核点据" :value="stats.pending" suffix="点" icon="WarningFilled" :tone="stats.pending > 0 ? 'danger' : 'default'" />
        <StatBadge label="未匹配（挂着）" :value="stats.unmatched" suffix="点" icon="Files" tone="warning" />
      </div>

      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>比降观测配置</h3>
          <span class="gb-hint">参考落差 ΔZ_稳 与落差指数 β 是改正到稳定流的依据</span>
        </div>
        <el-table :data="observations" border stripe class="gb-table-compact">
          <el-table-column prop="name" label="配置名称" min-width="160" />
          <el-table-column label="参考落差 (m)" width="130" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.refFallM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="落差指数 β" width="120" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.fallIndex ?? '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="row.active ? 'success' : 'info'" effect="plain">
                {{ row.active ? '在用' : '已撤掉' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="200" show-overflow-tooltip />
          <el-table-column label="更新时间" width="170">
            <template #default="{ row }">
              <span class="gb-mono">{{ new Date(row.updatedAt).toLocaleString('zh-CN') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="160" fixed="right">
            <template #default="{ row }">
              <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
              <el-button
                v-if="row.active"
                size="small"
                type="warning"
                plain
                :icon="Warning"
                @click="withdraw(row)"
              >撤掉</el-button>
            </template>
          </el-table-column>
          <template #empty>
            <EmptyPanel title="暂无比降观测配置" description="新增一条在用配置后即可试算落差指数并改正点据。" compact />
          </template>
        </el-table>
      </el-card>

      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>落差指数试算与点据改正</h3>
          <div class="page__trial">
            <el-select v-model="trialLineNo" size="small" class="page__line-select">
              <el-option v-for="lineNo in Array.from(new Set(stationRatings.map((r) => r.lineNo)))" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
            </el-select>
            <el-button size="small" type="primary" :icon="Refresh" @click="trialFit">试算落差指数</el-button>
            <el-button size="small" @click="backfill">回填比降归属</el-button>
          </div>
        </div>
        <p class="gb-hint">
          试算：在 β∈[0.2, 1.0] 内搜索使定线残差最小的落差指数，写回配置并按该指数改正全站点据。
        </p>
        <el-table :data="stationRatings" border stripe class="gb-table-compact">
          <el-table-column label="水位 (m)" width="100" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="实测流量 (m³/s)" width="130" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.measuredFlowM3s.toFixed(1) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="改正流量 (m³/s)" width="130" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.flowM3s.toFixed(1) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="落差 ΔZ (m)" width="110" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.fallM ? row.fallM.toFixed(2) : '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="采用 β" width="90" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.fallIndex ?? '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="比降归属" width="110" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="stateTagType(ratingSlopeState(row))" effect="plain">
                {{ stateText(ratingSlopeState(row)) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="测次号" min-width="150">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.measureNo || '未标记测次' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }">
              <el-button size="small" type="primary" plain @click="recorrect(row.id)">重算</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑比降观测' : '新增比降观测'" width="520px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="配置名称" required>
          <el-input v-model="form.name" placeholder="如：基本比降观测" maxlength="32" />
        </el-form-item>
        <el-form-item label="参考落差" required>
          <el-input-number v-model="form.refFallM" :min="0.01" :max="50" :step="0.05" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="落差指数 β" required>
          <el-input-number v-model="form.fallIndex" :min="0.1" :max="2" :step="0.02" :precision="2" controls-position="right" />
          <span class="page__unit">可用「试算落差指数」自动率定</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="水尺位置、迁建说明等" maxlength="100" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存并退回待复核' : '新增并在用' }}
        </el-button>
      </template>
    </el-dialog>
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

.page__tag {
  font-weight: 400;
}

.page__trial {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.page__line-select {
  width: 110px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}
</style>
