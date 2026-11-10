/** Retry Vite's cold-cache dependency reloads without hiding fixture or GPU errors. */
export async function openFixture(page, url, errors) {
  let outdated = false;
  const response = value => {
    if (value.status() === 504 && /Outdated Optimize Dep/i.test(value.statusText())) outdated = true;
  };
  page.on('response', response);

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      outdated = false;
      const start = errors.length;
      try {
        await page.goto(url, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => window.ready, { timeout: 10000 });
        return;
      } catch (error) {
        if (!outdated || attempt === 2) throw new Error(`${error.message}\n${errors.join('\n')}`);
        errors.splice(start);
      }
    }
  } finally {
    page.off('response', response);
  }
}
