// Run on a fresh <BASE>/images/editor/ dev page: await tab.evaluate(checkImages).
export default async function checkImages() {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const wait = async (ready) => {
    const end = performance.now() + 5000;
    while (!ready()) {
      assert(performance.now() < end, 'Image operation timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const moduleUrl = new URL('src/lib/image.ts', document.querySelector('link[rel~="icon"]').href);
  const { svgSize, rasterizeSvg, MAX_PIXELS } = await import(moduleUrl.href);
  const svg = (attrs, body = '') => new Blob([`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`], { type: 'image/svg+xml' });
  for (const attrs of ['font-size="32"', 'font-size="12" style="font-size:32px"']) {
    for (const unit of ['em', 'rem']) {
      const file = svg(`width="10${unit}" height="5${unit}" ${attrs}`, '<rect x="300" y="140" width="20" height="20" fill="red"/>');
      const [w, h] = await svgSize(file);
      assert(w === 320 && h === 160, 'Root font size must resolve em/rem dimensions');
      const canvas = await rasterizeSvg(file, w, h);
      const pixel = canvas.getContext('2d').getImageData(310, 150, 1, 1).data;
      assert(pixel[0] === 255 && pixel[3] === 255, 'Synthesized viewBox must not clip font-relative SVG content');
      canvas.width = 0;
    }
  }
  for (const attrs of ['width="8000" height="6000"', 'width="1e20" height="1"', 'width="1" height="1e20"']) {
    const [w, h] = await svgSize(svg(attrs));
    assert(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w * h <= MAX_PIXELS, 'Fitted integer SVG dimensions must stay inside the pixel limit');
  }

  const root = document.querySelector('[data-image-editor]');
  assert(root?.hasAttribute('data-empty'), 'Use a fresh, empty image editor');
  const q = (selector) => root.querySelector(selector);
  const set = (name, value) => {
    const input = q(`[name="${name}"][value="${value}"]`) ?? q(`[name="${name}"]`);
    input.checked = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const stage = q('[data-canvas]');
  const status = () => q('[data-status]').textContent;
  const add = async (colour) => {
    const count = root.querySelectorAll('[data-thumbs] button').length;
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 400, 200);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], `${colour}.png`, { type: 'image/png' }));
    const input = q('[data-input]');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => root.querySelectorAll('[data-thumbs] button').length === count + 1 && !q('[data-cut]').disabled);
    canvas.width = 0;
  };
  set('ratio', '1:1');
  set('size', 'original');
  set('fit', 'fill');
  q('[name="format"]').value = 'image/png';
  q('[name="format"]').dispatchEvent(new Event('input', { bubbles: true }));
  await add('red');
  q('[data-cut]').click();
  await wait(() => status().startsWith('Cut out'));
  assert(q('[data-dims]').textContent === '400 × 200 px', 'Cut must retain the complete source frame');
  assert(q('[name="ratio"]:checked').value === 'free', 'Cut ratio UI must match its unrestricted full frame');
  q('[data-undo]').click();
  assert(status() === 'Undone.', 'Cut remains undoable');
  q('[data-redo]').click();
  assert(q('[data-dims]').textContent === '400 × 200 px', 'Redo must retain the complete cut frame');
  q('[data-undo]').click();
  set('ratio', '1:1');
  await add('blue');
  q('[data-arrange]').click();
  set('layout', 'row');
  set('overlap', 'on');
  assert(q('[data-arr-size]').textContent === '400 × 200 px', 'Merge fixture must contain two square crops');
  q('[data-merge]').click();
  stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
  stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(() => status().startsWith('Merged'));
  assert(q('[data-dims]').textContent === '400 × 200 px', 'Merge must retain its full resulting frame, not the input square ratio');
  assert(q('[name="ratio"]:checked').value === 'free', 'Merge ratio UI must match its full frame');

  const click = HTMLAnchorElement.prototype.click;
  let captured;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) captured = fetch(this.href).then((response) => response.blob());
    else click.call(this);
  };
  try {
    q('[data-download]').click();
    await wait(() => captured);
    const bitmap = await createImageBitmap(await captured);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const left = ctx.getImageData(0, 100, 1, 1).data;
    const right = ctx.getImageData(399, 100, 1, 1).data;
    assert(left[0] === 255 && left[3] === 255 && right[2] === 255 && right[3] === 255, 'Keyboard input during async merge must not shift, clip or discard images');
    bitmap.close();
    canvas.width = 0;
  } finally {
    HTMLAnchorElement.prototype.click = click;
  }
  await wait(() => !q('[data-download]').disabled);
  assert(q('[data-remove-bg]').getAttribute('aria-label') === 'Remove background', 'Background removal needs an operation name even when its visible label is hidden');
  window.dispatchEvent(new CustomEvent('tools:mode', { detail: 'svg' }));
  assert(q('[name="format"]').value === 'image/png', 'In-place SVG mode must update output format');
  window.dispatchEvent(new CustomEvent('tools:mode', { detail: null }));
  assert(q('[data-mode-hint]').hidden, 'Clearing an entry mode must clear its hint');
  window.dispatchEvent(new CustomEvent('tools:mode', { detail: 'merge' }));
  assert(root.hasAttribute('data-arranging') && q('[data-arr-count]').textContent === '3 of 3', 'In-place merge mode must use existing images without reloading');
  return 'PASS: SVG sizing/font units, cut/redo frame, merge frame/async keyboard safety, accessible cloud action, in-place entry modes';
}
