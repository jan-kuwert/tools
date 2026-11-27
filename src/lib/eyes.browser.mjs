// Run on the home page with browser automation: await tab.evaluate(checkEyes).
export default async function checkEyes() {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const eyes = document.querySelector('.word-eyes');
  const pupils = eyes.querySelector('.eye-pupils');
  const mouth = document.querySelector('[data-hero-drop]');
  const snack = document.querySelector('[data-snack]');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const drag = (type, x, y, files = true) => {
    const dataTransfer = new DataTransfer();
    if (files) dataTransfer.items.add(new File([''], 'eyes.txt', { type: 'text/plain' }));
    else dataTransfer.setData('text/plain', 'not a file');
    document.dispatchEvent(new DragEvent(type, { clientX: x, clientY: y, dataTransfer, bubbles: true, cancelable: true }));
  };
  const reset = () => {
    assert(!pupils.hasAttribute('transform'), 'Eyes must reset after a drag ends');
    assert(!snack.hasAttribute('data-on'), 'Snack must disappear after a drag ends');
    assert(!mouth.querySelector('.mouth-shape').style.transform, 'Mouth must stop reaching after a drag ends');
    assert([...mouth.querySelectorAll(':scope > span')].every((s) => getComputedStyle(s).visibility === 'visible'), 'Mouth controls must return when the drag ends');
  };
  drag('dragover', 0, 0, false);
  reset();
  for (const direction of [-1, 1]) {
    drag('dragover', direction * 10000, direction * 10000);
    if (reduced) assert(!pupils.hasAttribute('transform') && !mouth.querySelector('.mouth-shape').style.transform, 'Reduced motion must disable eye and mouth tracking');
    else {
      const matrix = pupils.transform.baseVal.consolidate().matrix;
      assert(matrix.e * direction > 0 && matrix.f * direction > 0, 'Eyes must follow the file');
      assert(Math.hypot(matrix.e, matrix.f) <= 2.5, 'Pupils must stay inside the eyes');
      await new Promise((resolve) => setTimeout(resolve, 220));
      const reaction = new DOMMatrix(getComputedStyle(mouth.querySelector('.mouth-shape')).transform);
      assert(reaction.e * direction > 0 && reaction.f * direction > 0, 'Mouth must lean toward the file');
      assert(reaction.d > 1, 'Mouth must open while reaching for a file');
    }
    assert(snack.hasAttribute('data-on') === !reduced, 'The dragged file must show as a snack, respecting reduced motion');
    assert([...mouth.querySelectorAll(':scope > span')].every((s) => getComputedStyle(s).visibility === 'hidden'), 'Mouth must be empty while a file is dragged');
    assert(getComputedStyle(snack).pointerEvents === 'none', 'Snack must not intercept file drops');
    if (!reduced) assert(snack.style.transform === `translate(${direction * 10000}px, ${direction * 10000}px)`, 'Snack must sit on the pointer');
  }
  if (!reduced) {
    const box = mouth.getBoundingClientRect();
    drag('dragover', box.left + box.width / 2, box.top + box.height / 2);
    assert(new DOMMatrix(mouth.querySelector('.mouth-shape').style.transform).d > 1.15, 'Mouth must open wider with the snack over it');
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
  const shape = mouth.querySelector('.mouth-shape');
  const breathing = shape.getAnimations().find((a) => a.animationName === 'mouth-breathe');
  if (reduced) assert(!breathing, 'Reduced motion must disable mouth movement');
  else {
    assert(breathing, 'Mouth must move gently while idle');
    const time = breathing.currentTime;
    try {
      breathing.pause();
      await breathing.ready;
      breathing.currentTime = 0;
      const first = new DOMMatrix(getComputedStyle(shape).transform).d;
      breathing.currentTime = 3000;
      assert(new DOMMatrix(getComputedStyle(shape).transform).d !== first, 'Mouth must visibly breathe');
    } finally {
      breathing.currentTime = time;
      breathing.play();
    }
  }
  const field = document.querySelector('.extension-field');
  assert(getComputedStyle(field).pointerEvents === 'none' && field.getAttribute('aria-hidden') === 'true', 'Background debris must not interfere with interaction or reading');
  const drifting = [...field.querySelectorAll('span')].flatMap((s) => s.getAnimations());
  if (reduced) assert(!drifting.length, 'Reduced motion must stop the background debris');
  else {
    assert(new Set(drifting.map((a) => a.effect.getTiming().duration)).size > 1, 'Background debris must drift at varied speeds');
    const drift = drifting[0];
    const time = drift.currentTime;
    try {
      drift.pause();
      await drift.ready;
      drift.currentTime = 0;
      const first = getComputedStyle(drift.effect.target).transform;
      drift.currentTime = 10000;
      assert(getComputedStyle(drift.effect.target).transform !== first, 'Background debris must move');
    } finally {
      drift.currentTime = time;
      drift.play();
    }
  }
  const labels = [...field.querySelectorAll('span')].map((s) => ({ text: s.textContent, box: s.getBoundingClientRect() }));
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i].box, b = labels[j].box;
      assert(a.right + 2 <= b.left || b.right + 2 <= a.left || a.bottom + 2 <= b.top || b.bottom + 2 <= a.top, `Debris labels must stay separated: ${labels[i].text}, ${labels[j].text}`);
    }
  }
  if (!reduced) {
    // Last: a real drop opens a tool screen.
    drag('dragover', 1000, 500);
    assert([...snack.querySelectorAll('svg')].filter((s) => getComputedStyle(s).display !== 'none').length === 1, 'Exactly one snack must show');
    drag('drop', 1000, 500);
    assert([...mouth.querySelectorAll(':scope > span')].every((s) => getComputedStyle(s).visibility === 'hidden'), 'Mouth controls must stay hidden after a successful drop');
  }
  return 'PASS: eye tracking, snack drag, drag cleanup, mouth reaction, reduced motion, spaced readable-format debris, hidden controls on drop';
}
