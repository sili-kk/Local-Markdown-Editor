'use strict';

(() => {
  const storageKey = 'mojian.theme';
  const themes = new Set(['green', 'light', 'dark']);
  const normalize = value => themes.has(value) ? value : 'green';
  const apply = value => {
    const theme = normalize(value);
    document.documentElement.dataset.theme = theme;
    const select = document.getElementById('themeSelect');
    if (select) select.value = theme;
  };

  // 在样式和页面绘制前恢复主题，避免黑暗主题刷新时闪白。
  let storedTheme;
  try { storedTheme = localStorage.getItem(storageKey); } catch {}
  apply(storedTheme);

  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('themeSelect');
    select.value = document.documentElement.dataset.theme;
    select.addEventListener('change', () => {
      apply(select.value);
      try { localStorage.setItem(storageKey, document.documentElement.dataset.theme); } catch {}
    });
  });

  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) {
      apply(event.newValue);
    }
  });
})();
