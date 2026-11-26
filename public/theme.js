// Apply saved theme before first paint (external file so CSP can forbid inline scripts).
try {
  const t = JSON.parse(localStorage.getItem('tools:prefs') || '{}').theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {}
