// Run on the home page with browser automation: await tab.evaluate(checkEyes).
export default async function checkEyes() {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const eyes = document.querySelector('.word-eyes');
  const pupils = eyes.querySelector('.eye-pupils');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const drag = (type, x, y, files = true) => {
    const dataTransfer = new DataTransfer();
    if (files) dataTransfer.items.add(new File([''], 'eyes.txt', { type: 'text/plain' }));
    else dataTransfer.setData('text/plain', 'not a file');
    document.dispatchEvent(new DragEvent(type, { clientX: x, clientY: y, dataTransfer, bubbles: true, cancelable: true }));
  };
  const reset = () => assert(!pupils.hasAttribute('transform'), 'Eyes must reset after a drag ends');
  drag('dragover', 0, 0, false);
  reset();
  for (const direction of [-1, 1]) {
    drag('dragover', direction * 10000, direction * 10000);
    if (reduced) reset();
    else {
      const matrix = pupils.transform.baseVal.consolidate().matrix;
      assert(matrix.e * direction > 0 && matrix.f * direction > 0, 'Eyes must follow the file');
      assert(Math.hypot(matrix.e, matrix.f) <= 2.5, 'Pupils must stay inside the eyes');
    }
  }
  document.dispatchEvent(new DragEvent('dragleave'));
  reset();
  drag('dragover', 1000, 500);
  document.dispatchEvent(new DragEvent('drop', { dataTransfer: new DataTransfer() }));
  reset();
  drag('dragover', 1000, 500);
  await new Promise((resolve) => setTimeout(resolve, 700));
  reset();
  const wandering = pupils.getAnimations()[0];
  if (reduced) assert(!wandering, 'Reduced motion must disable wandering');
  else {
    assert(wandering, 'Idle eyes must wander');
    const time = wandering.currentTime;
    try {
      wandering.pause();
      wandering.currentTime = 0;
      const first = new DOMMatrix(getComputedStyle(pupils).transform);
      wandering.currentTime = 5100;
      const next = new DOMMatrix(getComputedStyle(pupils).transform);
      assert(first.e !== next.e && next.e !== 0, 'Idle eyes must look around, not straight ahead');
      assert(Math.hypot(next.e, next.f) <= 2.5, 'Wandering pupils must stay inside the eyes');
    } finally {
      wandering.currentTime = time;
      wandering.play();
    }
  }
  const animation = eyes.getAnimations()[0];
  if (reduced) assert(!animation, 'Reduced motion must disable blinking');
  else {
    assert(animation, 'Eyes must blink occasionally');
    const time = animation.currentTime;
    try {
      animation.pause();
      animation.currentTime = 0;
      assert(new DOMMatrix(getComputedStyle(eyes).transform).d === 1, 'Eyes must normally stay open');
      animation.currentTime = 4005;
      assert(new DOMMatrix(getComputedStyle(eyes).transform).d < 0.1, 'Blink must close the eyes');
    } finally {
      animation.currentTime = time;
      animation.play();
    }
  }
  return 'PASS: file-only tracking, bounded pupils, leave/drop/cancel reset, blinking, idle wandering';
}
