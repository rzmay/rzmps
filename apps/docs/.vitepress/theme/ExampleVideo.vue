<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { withBase } from 'vitepress';
const props = defineProps({ source: String, poster: String, label: String, width: Number, height: Number });
const video = ref(null);
const reduced = ref(true);
const failed = ref(false);
const visible = ref(false);
let observer, preference;
const play = () => video.value?.play().catch(() => {});
const motionChange = () => {
  reduced.value = preference.matches;
  if (reduced.value) video.value?.pause();
  else if (visible.value) play();
};
onMounted(() => {
  preference = matchMedia('(prefers-reduced-motion: reduce)');
  reduced.value = preference.matches;
  preference.addEventListener('change', motionChange);
  observer = new IntersectionObserver(entries => {
    visible.value = entries[0].isIntersecting;
    if (!visible.value) video.value?.pause();
    else if (!reduced.value) play();
  }, { threshold: 0.1 });
  observer.observe(video.value);
});
onBeforeUnmount(() => { observer?.disconnect(); preference?.removeEventListener('change', motionChange); });
</script>

<template>
  <figure class="example-preview">
    <video ref="video" :src="withBase(props.source)" :poster="withBase(props.poster)"
      :width="width" :height="height" :aria-label="label" :autoplay="!reduced && visible" muted loop playsinline
      controls preload="none" @error="failed = true" @loadeddata="failed = false" />
    <figcaption v-if="failed" role="status">Video preview unavailable. Try the live demo above.</figcaption>
  </figure>
</template>

<style scoped>
video { display: block; width: 100%; height: auto; border-radius: 12px; background: var(--vp-c-bg-soft); }
figcaption { margin-top: .5rem; font-size: .875rem; color: var(--vp-c-text-2); }
</style>
