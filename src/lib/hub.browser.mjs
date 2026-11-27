// Run on a fresh hub page: await tab.evaluate(checkHub).
export default async function checkHub() {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const wait = async (predicate) => {
    const until = performance.now() + 5000;
    while (!predicate()) {
      if (performance.now() > until) throw new Error('Timed out waiting for the hub');
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  };
  const canvas = Object.assign(document.createElement('canvas'), { width: 4, height: 2 });
  canvas.getContext('2d').fillRect(0, 0, 4, 2);
  const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const input = document.querySelector('[data-hero-input]');
  const files = new DataTransfer();
  files.items.add(new File([png], 'extensionless', { type: '' }));
  input.files = files.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const frame = () => document.querySelector('[data-screen="images"] iframe');
  await wait(() => frame()?.contentDocument?.querySelector('[data-name]')?.textContent === 'extensionless');
  const original = frame();
  const doc = original.contentDocument;
  assert(doc.querySelectorAll('[data-thumbs] li').length === 1, 'The content-recognized image must load once');
  let deliveries = 0;
  doc.querySelector('[data-input]').addEventListener('change', () => deliveries++);
  const start = () => {
    doc.querySelector('.ab-current').click();
    doc.querySelector('[data-app-go="centre"]').click();
  };
  start();
  await wait(() => document.querySelector('.home').dataset.at === 'centre');
  document.querySelector('[data-go="images"]').click();
  await wait(() => document.querySelector('.home').dataset.at === 'images');
  assert(deliveries === 0, 'Returning to an app must not replay its delivered drop');
  start();
  await wait(() => document.querySelector('.home').dataset.at === 'centre');
  document.querySelector('[data-open-slug="images/crop"]').click();
  await wait(() => document.querySelector('.home').dataset.at === 'images');
  assert(frame() === original && frame().contentDocument === doc, 'Changing entry modes must retain the live document');
  assert(deliveries === 0 && doc.querySelectorAll('[data-thumbs] li').length === 1, 'Changing entry modes must preserve images without duplication');
  return 'PASS: content-recognized drop, single delivery, app return, live mode document preservation';
}
