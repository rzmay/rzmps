import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import reportWebVitals from './reportWebVitals';
import './index.css';

if (new URLSearchParams(location.search).has('preview')) {
  import('../../../scripts/preview/harness.js').then(({ installPreview }) => installPreview());
} else {
const root = createRoot(document.getElementById('root'));

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

reportWebVitals();

}
