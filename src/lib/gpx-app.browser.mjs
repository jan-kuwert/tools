// On a fresh /gpx/ page, move the real mouse over the map, then await tab.evaluate(checkGpxUi).
export default async function checkGpxUi() {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const root = document.querySelector('[data-gpx-app]');
  const $ = (selector) => root.querySelector(selector);
  const waitFor = async (condition) => {
    for (let i = 0; i < 100; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(false, 'GPX UI did not settle');
  };
  const add = async (name, points, expected) => {
    const files = new DataTransfer();
    files.items.add(new File([`<gpx version="1.1"><trk><name>${name}</name><trkseg>${points.map(([lat, lon]) => `<trkpt lat="${lat}" lon="${lon}"/>`).join('')}</trkseg></trk></gpx>`], `${name}.gpx`, { type: 'application/gpx+xml' }));
    $('[data-input]').files = files.files;
    $('[data-input]').dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => $('[data-list]').children.length === expected);
  };
  assert(root && !$('[data-list]').children.length, 'Use a fresh GPX page');
  const points = Array.from({ length: 10 }, (_, i) => [47 + i * 0.0001, i === 5 ? 8.005 : 8]);
  await add('A', points.slice(0, 3), 1);
  await add('B', points, 2);
  const next = $('[data-outlier-next]');
  const map = $('[data-map]');
  $('[data-toggle="points"]').click();
  await waitFor(() => !next.disabled);
  next.click();
  assert(!next.disabled, 'Selecting an outlier must retain the ready cache');
  assert($('[data-point]').textContent.includes('6 of 10'), 'The fixture must select B’s sixth point');

  $('[data-list] .gx-item-main').click();
  assert(next.disabled && !$('[data-outlier-info]').textContent, 'Switching tracks must immediately invalidate outliers');
  next.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert($('[data-point-sec]').hidden, 'A pending outlier result must not select a stale index');
  await waitFor(() => $('[data-outlier-info]').textContent.includes('None found'));
  assert(next.disabled, 'The short clean track has no outliers');
  $('[data-list]').children[1].querySelector('.gx-item-main').click();
  await waitFor(() => !next.disabled);
  next.click();

  const pointer = (type, dx = 0) => {
    const r = map.getBoundingClientRect();
    map.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + map.clientWidth / 2 + dx, clientY: r.top + map.clientHeight / 2 }));
  };
  await new Promise(requestAnimationFrame);
  pointer('pointerdown');
  pointer('pointermove', 20);
  $('[data-undo]').click();
  assert($('[data-list]').children.length === 1, 'Undo must restore A before the drag ends');
  pointer('pointermove', 30);
  pointer('pointerup', 30);
  assert(!$('[data-redo]').disabled && $('[data-msg-text]').textContent === 'Undone.', 'A cancelled B drag must not edit A or clear redo');
  $('[data-redo]').click();
  await waitFor(() => !next.disabled);
  next.click();
  await new Promise(requestAnimationFrame);
  pointer('pointerdown');
  pointer('pointermove', 20);
  $('[data-undo]').click();
  $('[data-redo]').click();
  pointer('pointermove', 30);
  pointer('pointerup', 30);
  assert($('[data-msg-text]').textContent === 'Redone.', 'Redo must also cancel the pending drag');

  await waitFor(() => !next.disabled);
  next.click();
  await new Promise(requestAnimationFrame);
  pointer('pointerdown');
  pointer('pointermove', 20);
  pointer('pointerup', 20);
  assert($('[data-msg-text]').textContent === 'Point moved.', 'Normal point dragging must still commit');
  $('[data-undo]').click();
  await waitFor(() => !next.disabled);
  const distance = $('[data-clean="outliers"] [name="dist"]');
  distance.value = '1000';
  distance.dispatchEvent(new Event('input', { bubbles: true }));
  assert(next.disabled, 'Threshold changes must immediately invalidate outliers');
  await waitFor(() => $('[data-outlier-info]').textContent.includes('None found'));

  for (const mode of ['clean', 'merge', null]) {
    window.dispatchEvent(new CustomEvent('tools:mode', { detail: mode }));
    assert($('[data-list]').children.length === 2, 'Live mode changes must preserve tracks');
    assert($('[data-clean-sec]').hasAttribute('data-highlight') === (mode === 'clean'), 'Clean highlighting must follow the mode');
    assert($('[data-merge-sec]').hasAttribute('data-highlight') === (mode === 'merge'), 'Merge highlighting must follow the mode');
    if (mode === 'merge') assert($('input[name="gx-scope"][value="ticked"]').checked, 'Merge mode must select ticked export scope');
  }
  return 'PASS: track-keyed outliers, threshold invalidation, undo/redo gesture cancellation, normal dragging, live modes preserve tracks';
}
