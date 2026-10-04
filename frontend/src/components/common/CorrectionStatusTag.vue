<script setup lang="ts">
/**
 * <CorrectionStatusTag> 比降改正状态徽标。
 * 未改正 / 已改正 / 待复核 / 待挂接 四态配色，被关系点据页、比降改正页、导出页消费。
 */
import { computed } from 'vue'
import { CORRECTION_STATUS_META, type CorrectionStatus } from '@/types/slope'

const props = withDefaults(
  defineProps<{
    status: CorrectionStatus
    /** 是否在悬停时显示状态说明 */
    showTip?: boolean
    size?: 'default' | 'small' | 'large'
  }>(),
  { showTip: true, size: 'default' }
)

const meta = computed(() => CORRECTION_STATUS_META[props.status])
</script>

<template>
  <el-tooltip v-if="showTip" :content="meta.hint" placement="top">
    <el-tag :type="meta.type" effect="plain" :size="size" disable-transitions class="correction-status-tag">
      {{ meta.label }}
    </el-tag>
  </el-tooltip>
  <el-tag v-else :type="meta.type" effect="plain" :size="size" disable-transitions class="correction-status-tag">
    {{ meta.label }}
  </el-tag>
</template>

<style scoped>
.correction-status-tag {
  white-space: nowrap;
}
</style>
