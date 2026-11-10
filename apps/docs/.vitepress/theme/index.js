import './examples.css';
import DefaultTheme from 'vitepress/theme';
import ExampleVideo from './ExampleVideo.vue';
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) { app.component('ExampleVideo', ExampleVideo); },
};
