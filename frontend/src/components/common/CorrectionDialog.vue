<script setup lang="ts">
/**
 * <CorrectionDialog> 落差指数法改正到稳定流。
 * Qc = Qm × (Zk/Z)^β；资料室按测次时间和水位核对当次比降，
 * 基准落差 Zk 缺省取该站各测次落差均值，落差指数 β 用已有关系点据试算。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useSlopeStore } from '@/stores/slopeStore'
import type { Rating } from '@/types/rating'
import { DEFAULT_BETA } from '@/types/slope'
import CorrectionStatusTag from './CorrectionStatusTag.vue'

const props = defineProps<{
  modelValue: boolean
  /** 待改正点据（一条或批量） */
  ratings: Rating[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  /** 确认改正，回传 Zk、β 与参与改正的点据 id */
  (e: 'apply', payload: { ratingIds: string[]; baseFallM: number; beta: number; note: string }): void
}>()

const slopeStore = useSlopeStore()

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const form = reactive({ baseFallM: 0.2, beta: DEFAULT_BETA, note: '' })
const trialResult = ref<string>('')

const stationId = computed(() => props.ratings[0]?.stationId ?? '')
const stationName = computed(() => (stationId.value ? slopeStore.stationNameOf(stationId.value) : ''))

/** 行预览：每条点据的归属观测、实测落差、改正系数与改后流量 */
const rows = computed(() =>
  props.ratings.map((rating) => {
    const obs = slopeStore.obsById(rating.slopeObsId)
    const preview = slopeStore.previewCorrection(rating, form.baseFallM, form.beta)
    return {
      rating,
      obs,
      fallM: preview.fallM,
      correctedFlow: preview.correctedFlow,
      factor: preview.factor
    }
  })
)

const linkedCount = computed(() => rows.value.filter((row) => row.obs).length)
const suggestedFall = computed(() => (stationId.value ? slopeStore.suggestBaseFall(stationId.value) : 0))

watch(visible, (open) => {
  if (!open || !stationId.value) return
  const defaults = slopeStore.defaultParams(stationId.value)
  form.baseFallM = defaults.baseFallM
  form.beta = defaults.beta
  form.note = ''
  trialResult.value = ''
})

function useSuggestedFall(): void {
  if (suggestedFall.value > 0) form.baseFallM = suggestedFall.value
}

function runTrial(): void {
  if (!(form.baseFallM > 0)) {
    ElMessage.warning('请先填写有效的基准落差 Zk')
    return
  }
  const beta = slopeStore.trialBetaForStation(stationId.value, form.baseFallM)
  if (beta === null) {
    trialResult.value = '该站带比降归属的点据不足，无法试算 β（至少需要 2 个点）'
    return
  }
  form.beta = beta
  trialResult.value = `试算结果 β=${beta.toFixed(2)}（使涨落水改正点据最贴近单值线）`
}

function handleApply(): void {
  if (!(form.baseFallM > 0)) {
    ElMessage.warning('基准落差 Zk 必须为正数')
    return
  }
  if (!Number.isFinite(form.beta) || form.beta <= 0) {
    ElMessage.warning('落差指数 β 必须为正数')
    return
  }
  const ids = rows.value.filter((row) => row.obs && row.correctedFlow !== null).map((row) => row.rating.id)
  if (ids.length === 0) {
    ElMessage.warning('所选点据均无比降归属或落差无效，无法改正；请先核对归属')
    return
  }
  emit('apply', { ratingIds: ids, baseFallM: form.baseFallM, beta: form.beta, note: form.note })
  visible.value = false
}
</script>

<template>
  <el-dialog v-model="visible" title="比降（落差）改正到稳定流" width="760px" :close-on-click-modal="false">
    <div class="gb-hint correction-dialog__intro">
      改正公式 Qc = Qm × (Zk / Z)^β；Qm 实测流量，Z 当次实测落差，Zk 基准落差，β 落差指数。
      改正后以稳定流流量参与单值线定线。当前测站：<b>{{ stationName }}</b>
    </div>

    <el-form label-width="120px" class="correction-dialog__form">
      <el-form-item label="基准落差 Zk">
        <el-input-number v-model="form.baseFallM" :min="0.001" :max="100" :step="0.005" :precision="4" controls-position="right" />
        <span class="correction-dialog__unit">m</span>
        <el-button text type="primary" size="small" @click="useSuggestedFall">
          取本站落差均值{{ suggestedFall > 0 ? `（${suggestedFall.toFixed(3)} m）` : '' }}
        </el-button>
      </el-form-item>
      <el-form-item label="落差指数 β">
        <el-input-number v-model="form.beta" :min="0.01" :max="2" :step="0.01" :precision="2" controls-position="right" />
        <el-button text type="primary" size="small" @click="runTrial">用已有关系点据试算 β</el-button>
        <span v-if="trialResult" class="correction-dialog__trial">{{ trialResult }}</span>
      </el-form-item>
      <el-form-item label="改正备注">
        <el-input v-model="form.note" placeholder="可记录改正依据（留空使用默认说明）" maxlength="120" />
      </el-form-item>
    </el-form>

    <el-table :data="rows" border size="small" class="correction-dialog__table">
      <el-table-column label="水位 (m)" width="92" align="right">
        <template #default="{ row }"><span class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span></template>
      </el-table-column>
      <el-table-column label="实测流量" width="100" align="right">
        <template #default="{ row }"><span class="gb-mono">{{ row.rating.rawFlowM3s.toFixed(1) }}</span></template>
      </el-table-column>
      <el-table-column label="状态" width="92" align="center">
        <template #default="{ row }"><CorrectionStatusTag :status="row.rating.correctionStatus" :show-tip="false" size="small" /></template>
      </el-table-column>
      <el-table-column label="实测落差 Z" width="110" align="right">
        <template #default="{ row }">
          <span v-if="row.fallM !== null" class="gb-mono">{{ row.fallM.toFixed(3) }} m</span>
          <el-tag v-else type="info" size="small">无归属</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="改正系数" width="96" align="right">
        <template #default="{ row }">
          <span v-if="row.factor !== null" class="gb-mono">{{ row.factor.toFixed(3) }}</span>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="改正流量 Qc" min-width="120" align="right">
        <template #default="{ row }">
          <b v-if="row.correctedFlow !== null" class="gb-mono correction-dialog__corrected">{{ row.correctedFlow.toFixed(1) }}</b>
          <el-tag v-else type="warning" size="small">挂起不改正</el-tag>
        </template>
      </el-table-column>
    </el-table>
    <p class="gb-hint">
      共 {{ rows.length }} 个点据，{{ linkedCount }} 个已挂接比降可改正；无归属点据请先在「比降改正」页核对归属。
    </p>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="handleApply">按 Zk={{ form.baseFallM.toFixed(3) }}、β={{ form.beta.toFixed(2) }} 改正</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.correction-dialog__intro {
  margin-bottom: 12px;
}

.correction-dialog__unit {
  margin: 0 8px 0 8px;
  font-size: 12px;
  color: #8194a2;
}

.correction-dialog__trial {
  margin-left: 10px;
  font-size: 12px;
  color: #1e8449;
}

.correction-dialog__table {
  margin-top: 4px;
}

.correction-dialog__corrected {
  color: #0f4c75;
}
</style>
