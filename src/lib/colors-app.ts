// Colors app: edit a theme (built-in roles or colours imported from a CSS file), with a picker that shades
// where contrast is too low and contrast values that update while picking. Markup: src/pages/colors/index.astro.
// Colours live in memory only (documents are never persisted).
import {
  CHECKS, LEVELS, PRESETS, ROLES, THRESHOLDS, formatColor, formatRatio, hslToRgb, hsvToRgb, luminance, paletteCss, parseColor, parseCssColors, parseHex, ratioOf, rgbToHsl, rgbToHsv, toHex,
  type Check, type CheckKind, type ColorFormat, type ImportedPalette, type Variant,
} from './color';
import { resizable } from './resize';
import { downloadBlob } from './tool';

type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };

interface Model {
  names: string[];
  labels: Record<string, string>;
  values: Record<Variant, Record<string, string>>;
  /** Fixed pairs for the built-in theme; null for imports, which check the selected colour against every other one. */
  checks: Check[] | null;
  hasDark: boolean;
  file?: string;
}

const MAX_CSS = 5 * 1024 * 1024;

const builtIn = (): Model => ({
  names: ROLES.map((r) => r.id),
  labels: Object.fromEntries(ROLES.map((r) => [r.id, r.label])),
  values: { light: { ...PRESETS.light }, dark: { ...PRESETS.dark } },
  checks: CHECKS,
  hasDark: true,
});

export function initColorsApp(): void {
  const app = document.querySelector<HTMLElement>('[data-colors-app]')!;
  const $ = <T extends HTMLElement = HTMLElement>(s: string) => app.querySelector<T>(s)!;
  const $$ = <T extends HTMLElement = HTMLElement>(s: string) => [...app.querySelectorAll<T>(s)];

  const hexInput = $<HTMLInputElement>('[data-picker-hex]');
  const hueInput = $<HTMLInputElement>('[data-hue]');
  const sv = $('[data-sv]');
  const canvas = $<HTMLCanvasElement>('[data-sv-canvas]');
  const knob = $('[data-knob]');
  const rows = $('[data-rows]');
  const againstSelect = $<HTMLSelectElement>('[data-against]');
  const panel = $('[data-panel]');
  const msg = $('[data-msg]');
  const fileInput = $<HTMLInputElement>('[data-import]');

  let m = builtIn();
  const siteTheme = document.documentElement.dataset.theme;
  let variant: Variant = siteTheme === 'light' || siteTheme === 'dark' ? siteTheme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  let sel = 'primary';
  let against = '';
  /** The selected colour's picker is shown below it in the list. */
  let open = true;
  /** Notation for the value field, the list and the CSS export; colours are stored as hex. */
  let fmt: ColorFormat = 'hex';
  const formatSelect = $<HTMLSelectElement>('[data-format]');
  /** The CSS text field holds edits that are not applied yet; it stops mirroring the colours until applied or discarded. */
  let dirty = false;
  /** Picker position; kept separately so the hue survives greys, black and white. */
  let hsv: [number, number, number] = [0, 0, 0];

  const cur = () => m.values[variant];
  const lum = (hex: string) => luminance(parseHex(hex)!);
  const ratio = (a: string, b: string) => ratioOf(lum(a), lum(b));
  const other = (c: Check, id: string) => (c.fg === id ? c.bg : c.fg);
  const pairsFor = (id: string): Check[] =>
    m.checks ? m.checks.filter((c) => c.fg === id || c.bg === id) : m.names.filter((n) => n !== id).map((n) => ({ fg: id, bg: n, kind: 'text', label: m.labels[n] }));
  const tableChecks = () => m.checks ?? pairsFor(sel);
  const againstCheck = () => pairsFor(sel).find((c) => other(c, sel) === against);
  const exportCss = () => paletteCss(m.names, m.values.light, m.values.dark, m.hasDark, fmt);
  const variants = (): Variant[] => (m.hasDark ? ['light', 'dark'] : ['light']);
  const vName = (v: Variant) => (v === 'light' ? 'Light' : 'Dark');

  function syncHsv() {
    const [h, s, v] = rgbToHsv(parseHex(cur()[sel])!);
    hsv = [s === 0 || v === 0 ? hsv[0] : h, s, v];
  }

  // ---------- Structure: rebuilt when the colour set or the selection changes ----------
  const h = (tag: string, attrs: Record<string, string | boolean> = {}, ...kids: (Node | string)[]) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== false) n.setAttribute(k, v === true ? '' : v);
    n.append(...kids);
    return n;
  };
  const levelBadges = (levels: (typeof LEVELS)[CheckKind]) =>
    h('span', { class: 'co-levels' }, ...levels.map((l) => h('span', { class: 'co-lv', title: l.title, 'data-min': String(l.min) }, l.label, h('span', { class: 'visually-hidden' }))));

  function buildRoles() {
    // Keep the picker in the document while the rows it lives in are replaced; structure() puts it back under a row.
    const list = $('[data-roles]');
    list.after(panel);
    list.replaceChildren(
      ...m.names.map((n) =>
        h('li', {}, h('button', { type: 'button', class: 'co-role', title: m.labels[n], 'aria-expanded': 'false', 'aria-controls': 'co-panel', 'data-role': n },
          h('span', { class: 'co-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'co-role-name' }, m.labels[n]),
        )),
      ),
    );
    for (const b of $$('[data-role]')) b.insertAdjacentHTML('beforeend', '<svg class="co-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" /></svg>');
  }

  function buildTable() {
    rows.replaceChildren(
      ...tableChecks().map((c) =>
        h('tr', {},
          h('th', { scope: 'row' }, h('span', { class: 'co-pair' },
            h('span', {}, m.checks ? c.label : m.labels[c.bg]),
            h('small', {}, m.checks ? (c.kind === 'text' ? 'Text' : 'UI component') : `with ${m.labels[sel]}`),
          )),
          ...(['light', 'dark'] as const).map((v) =>
            h('td', { 'data-v': v }, h('span', { class: 'co-cell' },
              h('span', { class: `co-sample${c.kind === 'ui' ? ' ui' : ''}`, 'aria-hidden': 'true' }, c.kind === 'text' ? 'Aa' : ''),
              h('span', { class: 'co-ratio' }),
              levelBadges(LEVELS[c.kind]),
            )),
          ),
        ),
      ),
    );
    $('[data-checks-sub]').textContent = m.checks ? '' : `${m.labels[sel]} with every other color`;
  }

  function buildAgainst() {
    const list = pairsFor(sel);
    if (!list.some((c) => other(c, sel) === against)) against = list[0] ? other(list[0], sel) : '';
    againstSelect.replaceChildren(...(list.length ? list.map((c) => h('option', { value: other(c, sel) })) : [h('option', {}, 'No other color')]));
    againstSelect.value = against;
    againstSelect.disabled = !list.length;
    buildResult();
  }

  /** Ratio and badges per variant for the pair chosen in the dropdown; levels depend on whether it is text or a UI component. */
  function buildResult() {
    const c = againstCheck();
    $('[data-against-result]').replaceChildren(
      ...(c ? variants().map((v) => h('div', { 'data-v': v }, h('span', { class: 'co-vname' }, vName(v)), h('span', { class: 'co-ratio' }), levelBadges(LEVELS[c.kind]))) : []),
    );
  }

  function structure() {
    buildTable();
    buildAgainst();
    const li = $(`[data-role="${CSS.escape(sel)}"]`).parentElement!;
    if (panel.parentElement !== li) li.append(panel);
    panel.hidden = !open;
    syncHsv();
    render();
  }

  // ---------- Values: updated on every change, including while dragging in the picker ----------
  function setLevels(scope: Element, r: number) {
    scope.querySelectorAll<HTMLElement>('[data-min]').forEach((lv) => {
      const pass = r >= Number(lv.dataset.min);
      lv.dataset.pass = String(pass);
      lv.lastElementChild!.textContent = pass ? ' passes' : ' fails';
    });
  }

  function render() {
    const t = cur();
    const { light, dark } = m.values;
    if (m.checks) for (const p of $$('[data-preview]')) for (const n of m.names) p.style.setProperty(`--t-${n}`, m.values[p.dataset.preview as Variant][n]);
    for (const b of $$('[data-role]')) {
      const id = b.dataset.role!;
      b.ariaExpanded = String(id === sel && open);
      b.style.setProperty('--swatch', light[id]);
      b.style.setProperty('--swatch-dark', dark[id]);
    }
    for (const v of $$<HTMLInputElement>('input[name="variant"]')) v.checked = v.value === variant;
    for (const c of $$('[data-chip]')) c.style.setProperty('--swatch', m.values[c.dataset.chip as Variant][sel]);

    // Picker (edits the variant chosen above it)
    if (document.activeElement !== hexInput) hexInput.value = formatColor(t[sel], fmt);
    hexInput.removeAttribute('aria-invalid');
    // Channel fields: left alone while one of them is being typed in, so a half-typed number is not overwritten.
    if (!channels.contains(document.activeElement)) {
      const vals = channelValues(t[sel]);
      channelInputs().forEach((input, i) => {
        input.value = String(vals[i]);
        input.removeAttribute('aria-invalid');
      });
    }
    hueInput.value = String(Math.round(hsv[0]));
    hueInput.ariaValueText = `Hue ${Math.round(hsv[0])} degrees`;
    knob.style.left = `${hsv[1] * 100}%`;
    knob.style.top = `${(1 - hsv[2]) * 100}%`;
    knob.style.background = t[sel];
    sv.ariaValueNow = String(Math.round(hsv[2] * 100));
    sv.ariaValueText = `${vName(variant)} value: saturation ${Math.round(hsv[1] * 100)}%, brightness ${Math.round(hsv[2] * 100)}%`;
    const ac = againstCheck();
    const ref = `${m.labels[against]}${m.hasDark ? ` (${vName(variant).toLowerCase()})` : ''}`;
    $('[data-legend]').textContent = !ac
      ? 'No other color to compare with.'
      : ac.kind === 'text'
        ? `Shaded against ${ref}: striped grey fails every level (below 3:1), light grey is large text only (3 to 4.5:1); lines mark 3, 4.5 and 7:1.`
        : `Shaded against ${ref}: striped grey is below the 3:1 needed for UI components; the line marks 3:1.`;
    drawZones();

    // Contrast with (dropdown under the picker): ratios for every variant
    const list = pairsFor(sel);
    [...againstSelect.options].forEach((o, i) => {
      const c = list[i];
      if (!c) return;
      const id = other(c, sel);
      o.textContent = `${m.labels[id]}${c.kind === 'ui' ? ' (UI)' : ''} · ${variants().map((v) => formatRatio(ratio(m.values[v][sel], m.values[v][id]))).join(' / ')}`;
    });
    for (const row of $$('[data-against-result] > [data-v]')) {
      const v = row.dataset.v as Variant;
      const r = ratio(m.values[v][sel], m.values[v][against]);
      row.querySelector('.co-ratio')!.textContent = formatRatio(r);
      setLevels(row, r);
    }
    $('[data-vs-white]').textContent = formatRatio(ratio(t[sel], '#ffffff'));
    $('[data-vs-black]').textContent = formatRatio(ratio(t[sel], '#000000'));

    // Overview table: one column per variant
    const ok: Record<Variant, number> = { light: 0, dark: 0 };
    const rowChecks = tableChecks();
    [...rows.children].forEach((row, i) => {
      const c = rowChecks[i];
      row.toggleAttribute('data-related', !!m.checks && (c.fg === sel || c.bg === sel));
      for (const cell of row.querySelectorAll<HTMLElement>('td[data-v]')) {
        const vals = m.values[cell.dataset.v as Variant];
        const r = ratio(vals[c.fg], vals[c.bg]);
        const sample = cell.querySelector<HTMLElement>('.co-sample')!;
        sample.style.color = vals[c.fg];
        sample.style.background = vals[c.bg];
        cell.querySelector('.co-ratio')!.textContent = formatRatio(r);
        setLevels(cell, r);
        if (r >= LEVELS[c.kind][0].min) ok[cell.dataset.v as Variant]++;
      }
    });
    $('[data-summary]').textContent = rowChecks.length ? `${variants().map((v) => `${vName(v)}: ${ok[v]} of ${rowChecks.length}`).join(' · ')} pairs meet AA` : '';
    if (!dirty) cssBox.value = exportCss();
    applyAppTheme();
  }

  // ---------- This view in the user's colours (follows the site's light or dark mode); the rest of the page keeps the site's ----------
  /** Site custom property ← theme colour; imported palettes are matched by common names. */
  const APP_VARS: [string, RegExp][] = [
    ['--bg', /^(background|bg|page|page-bg)$/],
    ['--surface', /^(surface|card|panel)$/],
    ['--fg', /^(text|fg|foreground|ink)$/],
    ['--muted', /^(muted|text-muted|muted-text|muted-fg|subtle)$/],
    ['--accent', /^(primary|accent|brand)$/],
    ['--accent-fg', /^(on-primary|accent-fg|on-accent|primary-fg|primary-foreground)$/],
    ['--border', /^(border|line|divider)$/],
  ];
  function applyAppTheme() {
    for (const [prop, re] of APP_VARS) {
      const n = m.names.find((name) => re.test(name));
      if (n) app.style.setProperty(prop, m.hasDark && m.values.light[n] !== m.values.dark[n] ? `light-dark(${m.values.light[n]}, ${m.values.dark[n]})` : m.values.light[n]);
      else app.style.removeProperty(prop);
    }
  }

  // ---------- Picker canvas: saturation × brightness for the current hue, shaded by contrast against `against` ----------
  let zoneKey = '';
  function drawZones() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const ac = againstCheck();
    const ref = ac ? cur()[against] : '';
    const kind: CheckKind = ac?.kind ?? 'text';
    const dpr = Math.min(devicePixelRatio || 1, 3);
    const key = `${hsv[0]}|${ref}|${kind}|${w}x${h}@${dpr}`;
    if (key === zoneKey) return;
    zoneKey = key;
    // Shading at device resolution so zone edges and stripes stay crisp.
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const d = img.data;
    const th = ref ? THRESHOLDS[kind] : [];
    const lr = ref ? lum(ref) : 0;
    for (let y = 0; y < H; y++) {
      const v = 1 - y / (H - 1);
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const [r, g, b] = hsvToRgb(hsv[0], x / (W - 1), v);
        let k = 0;
        const cr = ratioOf(luminance([r, g, b]), lr);
        while (k < th.length && cr >= th[k]) k++;
        // Below the lowest threshold: mostly grey with stripes; text between 3 and 4.5: partly grey (large text only).
        const fade = !ref ? 0 : k === 0 ? 0.85 : kind === 'text' && k === 1 ? 0.5 : 0;
        const grey = 0.3 * r + 0.59 * g + 0.11 * b;
        const stripe = ref && k === 0 && ((x + y) / dpr) % 9 < 3 ? 0.82 : 1;
        d[o] = (r + (grey - r) * fade) * stripe;
        d[o + 1] = (g + (grey - g) * fade) * stripe;
        d[o + 2] = (b + (grey - b) * fade) * stripe;
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    if (!ref) return;

    // Contours as vector lines: luminance rises with brightness, so each threshold is met at most once above the
    // reference luminance (lighter branch) and once below it (darker branch); bisect brightness per column.
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const lumAt = (s: number, v: number) => {
      const f = (n: number) => { const k = (n + hsv[0] / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
      return 0.2126 * lin(f(5)) + 0.7152 * lin(f(3)) + 0.0722 * lin(f(1));
    };
    const solve = (s: number, target: number) => {
      if (target <= 0 || lumAt(s, 1) < target) return null;
      let lo = 0, hi = 1;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (lumAt(s, mid) < target) lo = mid;
        else hi = mid;
      }
      return (1 - hi) * h;
    };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const t of th) {
      for (const target of [t * (lr + 0.05) - 0.05, (lr + 0.05) / t - 0.05]) {
        const segs: [number, number][][] = [];
        let seg: [number, number][] | null = null;
        for (let x = 0; x <= w; x += 1) {
          const y = solve(x / w, target);
          if (y === null) seg = null;
          else (seg ??= segs[segs.push([]) - 1]).push([x, y]);
        }
        for (const [width, style] of [[3.5, 'rgb(0 0 0 / 0.35)'], [1.75, '#fff']] as const) {
          ctx.lineWidth = width;
          ctx.strokeStyle = style;
          for (const s of segs) {
            ctx.beginPath();
            s.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
            ctx.stroke();
          }
        }
        // One label per line, near the right edge.
        const pts = segs.flat();
        if (!pts.length) continue;
        const [lx, ly0] = pts.reduce((a, p) => (Math.abs(p[0] - (w - 26)) < Math.abs(a[0] - (w - 26)) ? p : a));
        const text = `${t}:1`;
        const tw = ctx.measureText(text).width + 8;
        const x0 = Math.min(w - tw - 2, Math.max(2, lx - tw / 2));
        const ly = Math.min(h - 8, Math.max(8, ly0));
        ctx.fillStyle = 'rgb(0 0 0 / 0.65)';
        ctx.beginPath();
        ctx.roundRect(x0, ly - 7, tw, 14, 7);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(text, x0 + 4, ly + 0.5);
      }
    }
  }
  new ResizeObserver(() => drawZones()).observe(canvas);

  // ---------- Editing ----------
  function setColor(hex: string, fromPicker = false) {
    cur()[sel] = hex.toLowerCase();
    if (!m.hasDark) m.values.dark[sel] = cur()[sel];
    if (!fromPicker) syncHsv();
    render();
  }
  const pick = () => setColor(toHex(hsvToRgb(...hsv)), true);
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

  sv.addEventListener('pointerdown', (e) => {
    sv.setPointerCapture(e.pointerId);
    sv.focus();
    const move = (ev: PointerEvent) => {
      const r = sv.getBoundingClientRect();
      hsv = [hsv[0], clamp01((ev.clientX - r.left) / r.width), 1 - clamp01((ev.clientY - r.top) / r.height)];
      pick();
    };
    move(e);
    sv.addEventListener('pointermove', move);
    sv.addEventListener('lostpointercapture', () => sv.removeEventListener('pointermove', move), { once: true });
  });
  sv.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const [ds, dv] = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] } as Record<string, [number, number]>)[e.key] ?? [0, 0];
    if (!ds && !dv) return;
    e.preventDefault();
    hsv = [hsv[0], clamp01(hsv[1] + ds), clamp01(hsv[2] + dv)];
    pick();
  });
  hueInput.addEventListener('input', () => {
    hsv = [Number(hueInput.value) % 360, hsv[1], hsv[2]];
    pick();
  });
  hexInput.addEventListener('input', () => {
    const rgb = parseColor(hexInput.value) ?? parseHex(hexInput.value);
    if (!rgb) return hexInput.setAttribute('aria-invalid', 'true');
    setColor(toHex(rgb));
  });
  hexInput.addEventListener('blur', () => render());

  app.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-role], [data-pick]');
    if (!b) return;
    const id = (b.dataset.role ?? b.dataset.pick)!;
    const fromPreview = b.closest<HTMLElement>('[data-preview]')?.dataset.preview as Variant | undefined;
    if (fromPreview) variant = fromPreview;
    // A swatch in the collapsed sidebar opens the sidebar with its picker; a second click on an open colour closes it.
    open = b.dataset.role && id === sel && sideOpen ? !open : true;
    if (b.dataset.role) setSide(true);
    sel = id;
    structure();
  });
  app.addEventListener('change', (e) => {
    if (e.target === formatSelect) {
      fmt = formatSelect.value as ColorFormat;
      buildChannels();
      render();
      return;
    }
    const t = e.target as HTMLInputElement;
    if (t.name === 'variant') {
      variant = t.value as Variant;
      syncHsv();
      render();
    } else if (e.target === againstSelect) {
      against = againstSelect.value;
      buildResult();
      render();
    }
  });

  // ---------- One field per channel for RGB and HSL ----------
  const channels = $('[data-channels]');
  const CHANNELS: Record<Exclude<ColorFormat, 'hex'>, [short: string, name: string, max: number][]> = {
    rgb: [['R', 'Red', 255], ['G', 'Green', 255], ['B', 'Blue', 255]],
    hsl: [['H', 'Hue, degrees', 360], ['S', 'Saturation, percent', 100], ['L', 'Lightness, percent', 100]],
  };
  const channelInputs = () => [...channels.querySelectorAll('input')];
  /** RGB as 0–255 integers; HSL as degrees and percentages with one decimal. */
  const channelValues = (hex: string): number[] => {
    const c = parseHex(hex)!;
    if (fmt !== 'hsl') return c;
    const [hh, s, l] = rgbToHsl(c);
    return [hh, s * 100, l * 100].map((v) => Math.round(v * 10) / 10);
  };
  function buildChannels() {
    channels.hidden = fmt === 'hex';
    channels.replaceChildren(
      ...(fmt === 'hex' ? [] : CHANNELS[fmt].map(([short, name, max]) =>
        h('label', {}, h('span', { 'aria-hidden': 'true' }, short), h('input', { type: 'number', min: '0', max: String(max), step: 'any', inputmode: 'decimal', 'aria-label': name })),
      )),
    );
  }
  channels.addEventListener('input', () => {
    if (fmt === 'hex') return;
    const inputs = channelInputs();
    const vals = inputs.map((i) => i.valueAsNumber);
    const bad = vals.map((v, i) => !Number.isFinite(v) || v < 0 || v > CHANNELS[fmt as 'rgb' | 'hsl'][i][2]);
    inputs.forEach((input, i) => (bad[i] ? input.setAttribute('aria-invalid', 'true') : input.removeAttribute('aria-invalid')));
    if (bad.some(Boolean)) return;
    setColor(toHex(fmt === 'rgb' ? (vals.map(Math.round) as [number, number, number]) : hslToRgb(vals[0] % 360, vals[1] / 100, vals[2] / 100)));
  });
  channels.addEventListener('focusout', (e) => {
    if (!channels.contains(e.relatedTarget as Node | null)) render();
  });
  buildChannels();

  // Chromium only; no lib.dom type yet.
  const EyeDropper = 'EyeDropper' in window ? (window.EyeDropper as EyeDropperCtor) : undefined;
  const dropper = $<HTMLButtonElement>('[data-eyedropper]');
  dropper.hidden = !EyeDropper;
  dropper.addEventListener('click', async () => {
    try {
      setColor((await new EyeDropper!().open()).sRGBHex);
    } catch {
      // Cancelled with Esc.
    }
  });

  // ---------- Import and export ----------
  function useModel(next: Model) {
    m = next;
    sel = m.names.includes(sel) ? sel : m.names[0];
    if (!m.hasDark) variant = 'light';
    app.toggleAttribute('data-imported', !m.checks);
    app.toggleAttribute('data-no-dark', !m.hasDark);
    $('[data-builtin]').hidden = !!m.checks;
    $('[data-list-title]').textContent = m.file ?? 'Theme colors';
    zoneKey = '';
    buildRoles();
    structure();
  }

  const skippedNote = (p: ImportedPalette) => (p.skipped.length ? ` Skipped ${p.skipped.length} that are not plain opaque colors: ${p.skipped.map((n) => `--${n}`).join(', ')}.` : '');
  const colorCount = (n: number) => `${n} color${n === 1 ? '' : 's'}`;
  const openPalette = (p: ImportedPalette, file: string) =>
    useModel({ names: p.names, labels: Object.fromEntries(p.names.map((n) => [n, `--${n}`])), values: { light: p.light, dark: p.dark }, checks: null, hasDark: p.hasDark, file });

  async function importFile(file: File) {
    if (!/\.css$/i.test(file.name) && file.type !== 'text/css') return void (msg.textContent = `${file.name} is not a CSS file.`);
    if (file.size > MAX_CSS) return void (msg.textContent = `${file.name} is larger than 5 MB.`);
    const p = parseCssColors(await file.text());
    if (!p.names.length) return void (msg.textContent = `No color custom properties (--name: color) found in ${file.name}.`);
    setDirty(false);
    openPalette(p, file.name);
    msg.textContent = `Imported ${colorCount(p.names.length)} from ${file.name}.` + skippedNote(p);
  }

  // ---------- CSS text field: free editing; changes apply only on "Apply CSS" ----------
  const cssBox = $<HTMLTextAreaElement>('[data-css]');
  const applyBtn = $<HTMLButtonElement>('[data-apply]');
  const discardBtn = $<HTMLButtonElement>('[data-discard]');
  function setDirty(d: boolean) {
    dirty = d;
    cssBox.toggleAttribute('data-dirty', d);
    applyBtn.disabled = discardBtn.disabled = !d;
    $('[data-css-hint]').textContent = d
      ? 'Not applied yet. Apply CSS (Ctrl/Cmd+Enter) to use these values, or discard to show the current colors.'
      : 'Edit or paste custom properties, then apply. Names that match the current colors update them; other names open as a new palette.';
    if (!d) cssBox.value = exportCss();
  }
  function applyCss() {
    const p = parseCssColors(cssBox.value);
    if (!p.names.length) return void (msg.textContent = 'No color custom properties (--name: color) found. Nothing was applied.');
    // Known names update the current colors in place (the built-in theme keeps its preview and checks).
    if (p.names.every((n) => m.names.includes(n))) {
      for (const n of p.names) {
        m.values.light[n] = p.light[n];
        m.values.dark[n] = p.dark[n];
      }
      m.hasDark ||= p.hasDark;
      setDirty(false);
      useModel(m);
    } else {
      setDirty(false);
      openPalette(p, 'pasted.css');
    }
    msg.textContent = `Applied ${colorCount(p.names.length)}.` + skippedNote(p);
  }
  cssBox.addEventListener('input', () => dirty || setDirty(true));
  cssBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      applyCss();
    }
  });
  applyBtn.addEventListener('click', applyCss);
  discardBtn.addEventListener('click', () => {
    setDirty(false);
    msg.textContent = '';
  });

  $('[data-import-btn]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) void importFile(fileInput.files[0]);
    fileInput.value = '';
  });
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  app.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    app.classList.add('co-over');
  });
  app.addEventListener('dragleave', (e) => {
    if (!app.contains(e.relatedTarget as Node | null)) app.classList.remove('co-over');
  });
  app.addEventListener('drop', (e) => {
    app.classList.remove('co-over');
    const f = e.dataTransfer?.files[0];
    if (!f) return;
    e.preventDefault();
    void importFile(f);
  });
  $('[data-builtin]').addEventListener('click', () => {
    if (!confirm('Close the imported colors? Changes are lost unless you downloaded them.')) return;
    msg.textContent = '';
    useModel(builtIn());
  });

  $('[data-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(exportCss());
      msg.textContent = 'CSS copied.';
    } catch {
      msg.textContent = 'Could not copy. Select the CSS below and copy it.';
    }
  });
  $('[data-download]').addEventListener('click', () => {
    downloadBlob(new Blob([exportCss()], { type: 'text/css' }), m.file ?? 'theme.css');
    msg.textContent = '';
  });

  // ---------- Sidebar: resizable, and collapsible to swatches only ----------
  const body = $('.co-body');
  const sideToggle = $<HTMLButtonElement>('[data-toggle-side]');
  let sideOpen = true;
  function setSide(show: boolean) {
    sideOpen = show;
    app.toggleAttribute('data-side-collapsed', !show);
    sideToggle.ariaExpanded = String(show);
    sideToggle.ariaLabel = show ? 'Collapse sidebar' : 'Expand sidebar';
    sideToggle.title = show ? 'Collapse the sidebar to swatches' : 'Expand the sidebar';
  }
  sideToggle.addEventListener('click', () => setSide(!sideOpen));
  resizable($('[data-resize-side]'), {
    key: 'colors.side',
    min: () => 260,
    max: () => Math.max(260, Math.round(app.clientWidth / 2)),
    initial: 340,
    apply: (v) => app.style.setProperty('--co-sw', `${v}px`),
    // The handle sits on the sidebar's left edge and the sidebar ends at the app's right edge.
    fromPointer: (e) => body.getBoundingClientRect().right - e.clientX,
    growKey: 'ArrowLeft',
    shrinkKey: 'ArrowRight',
    container: app,
  });

  useModel(m);
}
