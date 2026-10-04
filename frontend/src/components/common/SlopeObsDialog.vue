<script setup lang="ts">
/**
 * <SlopeObsDialog> 比降观测录入 / 编辑弹窗。
 * 巡测班一趟测流补记上下游比降水尺读数与时刻、往返水势；可预设测站与测次。
 * 保存由父页面完成（store 会在读数改动时让改正点据失效）。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { SlopeObservation, SlopeTrend } from '@/types/slope'
import { SLOPE_TRENDS, calcFallM, slopePerTenThousand } from '@/types/slope'

const props = defineProps<{
  modelValue: boolean
  stations: Station[]
  /** 预设测站（断面测次页带入），不传时在弹窗内选择 */
  presetStationId?: string | null
  /** 预设断面（用于自动回填归属） */
  presetSection?: Section | null
  /** 编辑中的观测 */
  editing?: SlopeObservation | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (
    e: 'submit',
    payload: {
      id?: string
      stationId: string
      sectionId: string | null
      measureNo: string
      upstreamGaugeM: number
      downstreamGaugeM: number
      gaugeDistanceM: number
      observedAt: string
      trend: SlopeTrend
      remark: string
    }
  ): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

function defaultTime(): string {
  return new Date().toISOString().slice(0, 16)
}

const form = reactive({
  stationId: '',
  measureNo: '',
  upstreamGaugeM: 0,
  downstreamGaugeM: 0,
  gaugeDistanceM: 800,
  observedAt: defaultTime(),
  trend: '涨水' as SlopeTrend,
  remark: ''
})

const editingId = ref<string | null>(null)

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    if (props.editing) {
      editingId.value = props.editing.id
      form.stationId = props.editing.stationId
      form.measureNo = props.editing.measureNo
      form.upstreamGaugeM = props.editing.upstreamGaugeM
      form.downstreamGaugeM = props.editing.downstreamGaugeM
      form.gaugeDistanceM = props.editing.gaugeDistanceM
      form.observedAt = props.editing.observedAt.slice(0, 16)
      form.trend = props.editing.trend
      form.remark = props.editing.remark
    } else {
      editingId.value = null
      form.stationId = props.presetStationId ?? props.stations[0]?.id ?? ''
      form.measureNo = props.presetSection?.measureNo ?? ''
      form.upstreamGaugeM = props.presetSection ? Number((props.presetSection.stageM + 0.2).toFixed(2)) : 0
      form.downstreamGaugeM = props.presetSection ? props.presetSection.stageM : 0
      form.gaugeDistanceM = 800
      form.observedAt = props.presetSection ? props.presetSection.measuredAt.slice(0, 16) : defaultTime()
      form.trend = '涨水'
      form.remark = ''
    }
  }
)

const fallM = computed(() => calcFallM(form))
const slopePerMyriad = computed(() =>
  slopePerTenThousand({
    upstreamGaugeM: form.upstreamGaugeM,
    downstreamGaugeM: form.downstreamGaugeM,
    gaugeDistanceM: form.gaugeDistanceM
  })
)

const stationSelectable = computed(() => !props.presetStationId && !props.editing)

function handleSubmit(): void {
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!(form.gaugeDistanceM > 0)) {
    ElMessage.warning('上下游水尺间距应大于 0（m）')
    return
  }
  if (fallM.value <= 0) {
    ElMessage.warning('上游水尺读数应高于下游，落差须为正')
    return
  }
  if (!form.observedAt) {
    ElMessage.warning('请选择比降观测时刻')
    return
  }
  emit('submit', {
    ...(editingId.value ? { id: editingId.value } : {}),
    stationId: form.stationId,
    sectionId: props.editing?.sectionId ?? props.presetSection?.id ?? null,
    measureNo: form.measureNo.trim(),
    upstreamGaugeM: form.upstreamGaugeM,
    downstreamGaugeM: form.downstreamGaugeM,
    gaugeDistanceM: form.gaugeDistanceM,
    observedAt: new Date(form.observedAt).toISOString(),
    trend: form.trend,
    remark: form.remark.trim()
  })
  visible.value = false
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="editing ? '编辑比降观测' : '补记往返比降'"
    width="560px"
    :close-on-click-modal="false"
  >
    <el-form label-width="130px">
      <el-form-item label="所属测站" required>
        <el-select v-model="form.stationId" :disabled="!stationSelectable" class="slope-dialog__full" placeholder="选择测站">
          <el-option v-for="station in stations" :key="station.id" :label="station.name" :value="station.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="测次号">
        <el-input v-model="form.measureNo" placeholder="如：2024-06-001，用于按测次核对点据" maxlength="32" />
      </el-form-item>
      <el-form-item label="水势（往返）" required>
        <el-radio-group v-model="form.trend">
          <el-radio-button v-for="trend in SLOPE_TRENDS" :key="trend" :value="trend">{{ trend }}</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="上游水尺读数" required>
        <el-input-number v-model="form.upstreamGaugeM" :min="-50" :max="200" :step="0.01" :precision="3" controls-position="right" />
        <span class="slope-dialog__unit">m</span>
      </el-form-item>
      <el-form-item label="下游水尺读数" required>
        <el-input-number v-model="form.downstreamGaugeM" :min="-50" :max="200" :step="0.01" :precision="3" controls-position="right" />
        <span class="slope-dialog__unit">m</span>
      </el-form-item>
      <el-form-item label="水尺间距" required>
        <el-input-number v-model="form.gaugeDistanceM" :min="1" :max="100000" :step="10" :precision="0" controls-position="right" />
        <span class="slope-dialog__unit">m</span>
      </el-form-item>
      <el-form-item label="观测时刻" required>
        <el-date-picker v-model="form.observedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="与测流同时刻" />
      </el-form-item>
      <el-form-item label="比降成果">
        <el-tag type="success" effect="plain">落差 {{ fallM.toFixed(3) }} m</el-tag>
        <el-tag type="info" effect="plain" class="slope-dialog__tag">水面比降 {{ slopePerMyriad.toFixed(1) }} ‱</el-tag>
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="河床变化、回水、读数异常说明等" maxlength="120" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="handleSubmit">{{ editing ? '保存修改' : '保存比降观测' }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.slope-dialog__full {
  width: 100%;
}

.slope-dialog__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.slope-dialog__tag {
  margin-left: 8px;
}
</style>
