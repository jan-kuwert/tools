// Apply saved theme before first paint (external file so CSP can forbid inline scripts).
try {
  const t = JSON.parse(localStorage.getItem('tools:prefs') || '{}').theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {}
// Tool pages embedded by the home page drop zone hide the site chrome.
if (window !== top && new URLSearchParams(location.search).has('embed')) document.documentElement.dataset.embed = '';
