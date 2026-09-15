<template>
    <img :src="url" :alt="$t('预览图片加载失败')" class="custom-face-tooltip">
</template>

<script setup lang="ts">
const { url } = defineProps<{ url: string }>()
</script>

<style scoped lang="css">
.tooltip-enter-active, .tooltip-leave-active {
    transform-origin: bottom;
}
/* 浮层出场/退场沿用全应用统一的那一对令牌（进入慢、离开快）。这里没为提示
 * 单独开一档时长：多一档就要多解释一次「什么时候该用哪档」，收益不值。 */
.tooltip-enter-active {
    transition: opacity var(--md-motion-enter), transform var(--md-motion-enter);
}
.tooltip-leave-active {
    transition: opacity var(--md-motion-exit), transform var(--md-motion-exit);
}
.tooltip-enter-from, .tooltip-leave-to {
    opacity: 0;
    transform: translate(-50%, calc(-100% - 0.8rem)) scale(0.5) scaleY(0);
}
.tooltip-enter-to, .tooltip-leave-from {
    opacity: 1;
    transform: translate(-50%, calc(-100% - 0.8rem)) scale(0.5) scaleY(1);
}
</style>
