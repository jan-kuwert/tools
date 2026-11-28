// Colour parsing, WCAG 2.2 contrast, CSS import/export and the theme model used by the Colors app.
export type RGB = [number, number, number];

/** `#rgb` or `#rrggbb`, the `#` optional; null when invalid. */
export const parseHex = (s: string): RGB | null => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
};

export const toHex = (c: RGB): string => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

const clamp255 = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
const opaque = (a: string | undefined) => a === undefined || (a.endsWith('%') ? parseFloat(a) >= 100 : parseFloat(a) >= 1);

/**
 * A CSS colour value: hex (alpha only if fully opaque), rgb()/rgba() or hsl()/hsla(), comma or space syntax.
 * Null for anything else, including translucent colours: their contrast depends on what is behind them.
 */
export const parseColor = (raw: string): RGB | null => {
  const s = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return h.length === 8 && h.slice(6) !== 'ff' ? null : parseHex(h.slice(0, 6));
  }
  const num = '([\\d.]+%?)';
  const rgb = new RegExp(`^rgba?\\(\\s*${num}[\\s,]+${num}[\\s,]+${num}\\s*(?:[,/]\\s*${num}\\s*)?\\)$`).exec(s);
  if (rgb) {
    if (!opaque(rgb[4])) return null;
    return rgb.slice(1, 4).map((v) => clamp255(v.endsWith('%') ? parseFloat(v) * 2.55 : parseFloat(v))) as RGB;
  }
  const hsl = new RegExp(`^hsla?\\(\\s*([\\d.]+)(?:deg)?[\\s,]+([\\d.]+)%[\\s,]+([\\d.]+)%\\s*(?:[,/]\\s*${num}\\s*)?\\)$`).exec(s);
  if (hsl) return opaque(hsl[4]) ? hslToRgb(parseFloat(hsl[1]) % 360, parseFloat(hsl[2]) / 100, parseFloat(hsl[3]) / 100) : null;
  return null;
};

export const hslToRgb = (h: number, s: number, l: number): RGB => {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min((n + h / 30) % 12 - 3, 9 - ((n + h / 30) % 12), 1));
  return [f(0), f(8), f(4)].map((v) => clamp255(v * 255)) as RGB;
};

/** Hue 0–360, saturation and value 0–1. */
export const hsvToRgb = (h: number, s: number, v: number): RGB => {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)].map((x) => clamp255(x * 255)) as RGB;
};

export const rgbToHsv = (c: RGB): [number, number, number] => {
  const [r, g, b] = c.map((v) => v / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = d === 0 ? 0 : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : d / max, max];
};

export const rgbToHsl = (c: RGB): [number, number, number] => {
  const [r, g, b] = c.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  return [rgbToHsv(c)[0], d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l];
};

export type ColorFormat = 'hex' | 'rgb' | 'hsl';

/** One decimal, trailing ".0" dropped: enough for HSL to map back to the same 8-bit colour. */
const dec = (n: number) => String(Math.round(n * 10) / 10);

/** A `#rrggbb` colour written in the chosen CSS notation. */
export const formatColor = (hex: string, f: ColorFormat): string => {
  if (f === 'hex') return hex;
  const c = parseHex(hex)!;
  if (f === 'rgb') return `rgb(${c.join(' ')})`;
  const [h, s, l] = rgbToHsl(c);
  return `hsl(${dec(h)} ${dec(s * 100)}% ${dec(l * 100)}%)`;
};

/** sRGB channel (0–255) to linear light, per WCAG 2.2. */
export const LINEAR = Array.from({ length: 256 }, (_, v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));

/** WCAG 2.2 relative luminance of an sRGB colour. */
export const luminance = ([r, g, b]: RGB): number => 0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b];

/** Contrast ratio of two relative luminances. */
export const ratioOf = (la: number, lb: number): number => (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);

/** WCAG contrast ratio, 1 to 21; order of the two colours does not matter. */
export const contrast = (a: RGB, b: RGB): number => ratioOf(luminance(a), luminance(b));

/** Two decimals, rounded down: a ratio must not reach a threshold by rounding (4.497 fails 4.5). */
export const formatRatio = (r: number): string => `${(Math.floor(r * 100) / 100).toFixed(2)}:1`;

export type CheckKind = 'text' | 'ui';

/** WCAG 2.2 success criteria 1.4.3 (AA), 1.4.6 (AAA) and 1.4.11 (non-text, AA). */
export const LEVELS: Record<CheckKind, { label: string; min: number; title: string }[]> = {
  text: [
    { label: 'AA', min: 4.5, title: 'AA, normal text: at least 4.5:1 (WCAG 1.4.3)' },
    { label: 'AA large', min: 3, title: 'AA, large text (24 px, or 18.66 px bold): at least 3:1 (WCAG 1.4.3)' },
    { label: 'AAA', min: 7, title: 'AAA, normal text: at least 7:1 (WCAG 1.4.6)' },
    { label: 'AAA large', min: 4.5, title: 'AAA, large text: at least 4.5:1 (WCAG 1.4.6)' },
  ],
  ui: [{ label: 'UI 3:1', min: 3, title: 'Non-text contrast, AA: control boundaries, icons and focus indicators need at least 3:1 (WCAG 1.4.11)' }],
};

/** Distinct thresholds per kind, ascending: the zone boundaries in the picker. */
export const THRESHOLDS: Record<CheckKind, number[]> = { text: [3, 4.5, 7], ui: [3] };

export const ROLES = [
  { id: 'background', label: 'Background' },
  { id: 'surface', label: 'Surface' },
  { id: 'text', label: 'Text' },
  { id: 'muted', label: 'Muted text' },
  { id: 'primary', label: 'Primary' },
  { id: 'on-primary', label: 'Text on primary' },
  { id: 'border', label: 'Border' },
] as const;
export type Role = (typeof ROLES)[number]['id'];
export type Theme = Record<Role, string>;
export type Variant = 'light' | 'dark';

/** Starting point: this site's own palette (src/styles/global.css). */
export const PRESETS: Record<Variant, Theme> = {
  light: { background: '#f7f7f5', surface: '#ffffff', text: '#17181a', muted: '#5d6168', primary: '#4f46e5', 'on-primary': '#ffffff', border: '#e2e2de' },
  dark: { background: '#111214', surface: '#1a1b1e', text: '#ececee', muted: '#a0a3aa', primary: '#8b85ff', 'on-primary': '#0d0d12', border: '#2e3035' },
};

export interface Check { fg: string; bg: string; kind: CheckKind; label: string }

/** The pairs the built-in theme is checked on; `kind` picks the WCAG thresholds. */
export const CHECKS: Check[] = [
  { fg: 'text', bg: 'background', kind: 'text', label: 'Text on background' },
  { fg: 'text', bg: 'surface', kind: 'text', label: 'Text on surface' },
  { fg: 'muted', bg: 'background', kind: 'text', label: 'Muted text on background' },
  { fg: 'muted', bg: 'surface', kind: 'text', label: 'Muted text on surface' },
  { fg: 'primary', bg: 'surface', kind: 'text', label: 'Links on surface' },
  { fg: 'on-primary', bg: 'primary', kind: 'text', label: 'Button text on primary' },
  { fg: 'primary', bg: 'background', kind: 'ui', label: 'Primary button on background' },
  { fg: 'border', bg: 'surface', kind: 'ui', label: 'Input border on surface' },
];

/** Custom properties; `light-dark()` where the two variants differ (with `dark` off, light values only). */
export const paletteCss = (names: readonly string[], light: Record<string, string>, dark: Record<string, string>, withDark: boolean, f: ColorFormat = 'hex'): string =>
  `:root {\n${withDark ? '  color-scheme: light dark;\n' : ''}${names
    .map((n) => `  --${n}: ${withDark && light[n] !== dark[n] ? `light-dark(${formatColor(light[n], f)}, ${formatColor(dark[n], f)})` : formatColor(light[n], f)};`)
    .join('\n')}\n}\n`;

/** Split at commas outside parentheses. */
const splitTop = (s: string): string[] => {
  const out = [''];
  let depth = 0;
  for (const ch of s) {
    if (ch === ',' && depth === 0) out.push('');
    else {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      out[out.length - 1] += ch;
    }
  }
  return out;
};

export interface ImportedPalette {
  names: string[];
  light: Record<string, string>;
  dark: Record<string, string>;
  /** Some colour differs between light and dark. */
  hasDark: boolean;
  /** Custom properties that are not a plain opaque colour (var() references, gradients, translucent colours …). */
  skipped: string[];
}

/**
 * Colour custom properties from a stylesheet. Dark values come from `light-dark()`, from rules whose selector
 * mentions "dark" (e.g. `[data-theme='dark']`) and from `@media (prefers-color-scheme: dark)`; everything else is light.
 */
export function parseCssColors(css: string): ImportedPalette {
  let text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: [string, boolean][] = [];
  text = text.replace(/@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/gi, (_, inner: string) => {
    blocks.push([inner, true]);
    return '';
  });
  blocks.push([text, false]);

  const names: string[] = [];
  const base: Record<string, [string, string]> = {};
  const darkOnly: Record<string, string> = {};
  const skipped = new Set<string>();
  for (const [chunk, inDarkMedia] of blocks) {
    for (const [, selector, body] of chunk.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const dark = inDarkMedia || /dark/i.test(selector);
      for (const [, name, raw] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+)/g)) {
        const v = raw.trim().replace(/\s*!important$/i, '');
        const ld = /^light-dark\((.*)\)$/is.exec(v);
        const args = ld ? splitTop(ld[1]) : [v, v];
        const pair = args.length === 2 ? args.map(parseColor) : [null, null];
        if (!pair[0] || !pair[1]) {
          if (!names.includes(name)) skipped.add(name);
          continue;
        }
        const [l, d] = pair.map((c) => toHex(c!));
        if (!names.includes(name)) names.push(name);
        skipped.delete(name);
        if (dark) darkOnly[name] = ld ? d : l;
        else base[name] = [l, d];
      }
    }
  }
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const n of names) {
    light[n] = base[n]?.[0] ?? darkOnly[n];
    dark[n] = darkOnly[n] ?? base[n][1];
  }
  return { names, light, dark, hasDark: names.some((n) => light[n] !== dark[n]), skipped: [...skipped] };
}
