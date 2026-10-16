<script setup>
// 输入框右上角的「提示词优化 / 撤回」按钮组：样貌、妆造、最终三视图、场景描述、场景光影五处共用。
// 组件只管长什么样和转圈状态；优化请求、草稿覆盖由父组件（episode.vue）持有。
import { Loader2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

defineProps({
  field: { type: String, required: true }, // appearance | styling | final | sceneDesc | sceneLight
  active: { type: String, default: '' }, // 正在优化的字段，非空时禁用全部按钮
  canUndo: { type: Boolean, default: false }, // 该字段有上一版草稿可撤回
  disabled: { type: Boolean, default: false }, // 框里没字：没得优化，灰掉
})
const emit = defineEmits(['optimize', 'undo'])
</script>

<template>
  <button v-if="canUndo" class="asset-detail-undo-btn" @click="emit('undo', field)">{{ t('episode.asset.optimizeUndo') }}</button>
  <button class="btn btn-ghost btn-sm" :disabled="!!active || disabled" @click="emit('optimize', field)">
    <Loader2 v-if="active === field" :size="11" class="animate-spin" />
    {{ active === field ? t('episode.asset.optimizing') : t('episode.asset.optimizePrompt') }}
  </button>
</template>

<style scoped>
.asset-detail-undo-btn {
  border: 0;
  padding: 0;
  background: none;
  color: var(--text-3);
  font-size: 10px;
  text-decoration: underline;
  cursor: pointer;
}
.asset-detail-undo-btn:hover {
  color: var(--text-1);
}
</style>
