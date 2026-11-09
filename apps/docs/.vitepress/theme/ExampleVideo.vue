<script setup>
import { ref, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { withBase } from 'vitepress';
const props = defineProps({ source: String, poster: String, label: String, width: Number, height: Number });
const video = ref(null);
const loaded = ref(false);
const reduced = ref(true);
const playing = ref(false);
let observer, preference, visible = false;
const motionChange = () => {
  reduced.value = preference.matches;
  if (reduced.value) video.value.pause();
  else if (visible) play();
};
function play() {
  loaded.value = true;
  // Vue installs the source before attempting playback.
  nextTick(() => video.value?.play().catch(() => {}));
}
function toggle() {
  if (video.value.paused) play();
  else video.value.pause();
}
onMounted(() => {
  preference = matchMedia('(prefers-reduced-motion: reduce)');
  reduced.value = preference.matches;
  preference.addEventListener('change', motionChange);
  observer = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (!visible) video.value.pause();
    else if (!reduced.value) play();
  }, { threshold: 0.1 });
  observer.observe(video.value);
});
onBeforeUnmount(() => { observer?.disconnect(); preference?.removeEventListener('change', motionChange); });
</script>

<template>
  <figure class="example-preview">
    <video ref="video" :src="loaded ? withBase(source) : undefined" :poster="withBase(poster)"
      :width="width" :height="height" :aria-label="label" :autoplay="!reduced" muted loop playsinline
      controls preload="none" @play="playing = true" @pause="playing = false" />
    <button type="button" :aria-label="`${playing ? 'Pause' : 'Play'} ${label}`" @click="toggle">{{ playing ? 'Pause' : 'Play' }} preview</button>
  </figure>
</template>

<style scoped>
video { display: block; width: 100%; height: auto; border-radius: 8px; }
button { margin-top: .5rem; text-decoration: underline; }
</style>
