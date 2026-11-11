(() => {
  const key = 'magpie-claude-code-ua.theme';
  const normalize = (value) => value === 'dark' || value === 'light' ? value : 'system';
  let controls = [];

  function read() {
    try { return normalize(window.localStorage.getItem(key)); }
    catch { return 'system'; }
  }

  function apply(value) {
    const mode = normalize(value);
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    for (const control of controls) control.value = mode;
    return mode;
  }

  let mode = apply(read());
  function initialize() {
    controls = [...document.querySelectorAll('[data-theme-control]')];
    apply(mode);
    for (const control of controls) {
      control.addEventListener('change', () => {
        mode = apply(control.value);
        try {
          if (mode === 'system') window.localStorage.removeItem(key);
          else window.localStorage.setItem(key, mode);
        } catch { /* A blocked preference store does not prevent switching. */ }
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) mode = apply(read());
  });
})();
