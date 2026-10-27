'use strict';

// Match literal text within each rendered text block, across inline marks.
// Keep document positions separate from string offsets so inline atoms and
// nested inline nodes cannot shift the resulting decorations.
function findEditorTextMatches(doc, query, limit = 5000) {
  const matches = [];
  if (!query) return { matches, truncated: false };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  let truncated = false;
  doc.descendants((block, position) => {
    if (truncated) return false;
    if (!block.isTextblock) return;
    let text = '';
    const segments = [];
    block.descendants((node, offset) => {
      if (node.isText) {
        segments.push({ start: text.length, end: text.length + node.text.length, position: position + 1 + offset });
        text += node.text;
      } else if (node.isLeaf) text += '\uFFFC';
    });
    const documentPosition = (index, end = false) => {
      let low = 0, high = segments.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (segments[middle].end <= index) low = middle + 1;
        else high = middle;
      }
      const segment = segments[low];
      return segment && index >= segment.start ? segment.position + index - segment.start + (end ? 1 : 0) : null;
    };
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const from = documentPosition(match.index), to = documentPosition(match.index + match[0].length - 1, true);
      if (from === null || to === null) continue;
      if (matches.length === limit) { truncated = true; break; }
      matches.push({ from, to });
    }
    return false;
  });
  return { matches, truncated };
}

function editorSearchPlugin({ pmState, pmView }) {
  const key = new pmState.PluginKey('editorTextSearch');
  const { Decoration, DecorationSet } = pmView;
  return {
    wysiwygPlugins: [() => new pmState.Plugin({
      key,
      state: {
        init: () => ({ query: '', matches: [], index: -1, truncated: false, decorations: DecorationSet.empty }),
        apply(transaction, previous) {
          const request = transaction.getMeta(key);
          if (!transaction.docChanged && !request) return previous;
          const query = request?.query ?? previous.query;
          const result = transaction.docChanged || query !== previous.query ? findEditorTextMatches(transaction.doc, query) : previous;
          const index = result.matches.length ? Math.max(0, Math.min(request?.index ?? (query !== previous.query ? 0 : previous.index), result.matches.length - 1)) : -1;
          const decorations = result.matches.length ? DecorationSet.create(transaction.doc, result.matches.map((match, number) =>
            Decoration.inline(match.from, match.to, { class: 'editor-search-match' + (number === index ? ' is-search-current' : '') }))) : DecorationSet.empty;
          return { query, matches: result.matches, truncated: result.truncated, index, decorations };
        },
      },
      props: { decorations: state => key.getState(state).decorations },
      view(view) {
        const viewport = view.dom.parentElement, listeners = new Set();
        const search = {
          get state() { return key.getState(view.state); },
          subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          setQuery(query) {
            if (query === search.state.query) return;
            view.dispatch(view.state.tr.setMeta(key, { query }).setMeta('addToHistory', false));
          },
          move(direction = 1) {
            const current = search.state, count = current.matches.length;
            if (!count) return false;
            const index = (current.index + direction + count) % count;
            view.dispatch(view.state.tr.setMeta(key, { index }).setMeta('addToHistory', false));
            const rect = view.coordsAtPos(search.state.matches[index].from), bounds = viewport.getBoundingClientRect();
            const scale = bounds.width / viewport.offsetWidth || 1;
            viewport.scrollTo({ top: Math.max(0, viewport.scrollTop + (rect.top - bounds.top) / scale - viewport.clientHeight / 3), behavior: 'instant' });
            return true;
          },
        };
        viewport.editorTextSearch = search;
        return {
          update(next, previous) { if (key.getState(next.state) !== key.getState(previous)) listeners.forEach(listener => listener()); },
          destroy() { listeners.clear(); if (viewport.editorTextSearch === search) delete viewport.editorTextSearch; },
        };
      },
    })],
  };
}

function installEditorSearch(root) {
  if (root.editorSearch) return root.editorSearch;
  const viewport = root.querySelector('.toastui-editor-ww-container > .toastui-editor');
  const search = viewport.editorTextSearch, lines = viewport.editorLineNumbers;
  const bar = document.createElement('div'); bar.className = 'editor-search-bar';
  const form = document.createElement('form'); form.className = 'editor-text-search'; form.setAttribute('role', 'search');
  form.setAttribute('aria-label', '搜索本页文档');
  const searchIcon = icon('search'); searchIcon.classList.add('editor-search-symbol');
  const input = document.createElement('input'); input.type = 'search'; input.placeholder = '搜索本页';
  input.setAttribute('aria-label', '搜索当前文档文字'); input.autocomplete = 'off'; input.spellcheck = false;
  input.maxLength = 1000;
  const count = document.createElement('span'); count.className = 'editor-search-count'; count.setAttribute('aria-live', 'polite');
  const button = (label, name, className) => {
    const element = document.createElement('button'); element.type = 'button'; element.className = className;
    element.append(icon(name));
    element.setAttribute('aria-label', label); element.title = label; return element;
  };
  const clear = button('清除搜索（Esc）', 'close', 'editor-search-clear');
  const previous = button('上一个匹配（Shift + Enter）', 'chevron', 'editor-search-previous');
  const next = button('下一个匹配（Enter）', 'chevron', 'editor-search-next');
  const navigation = document.createElement('div'); navigation.className = 'editor-search-navigation';
  navigation.setAttribute('role', 'group'); navigation.setAttribute('aria-label', '切换搜索匹配');
  navigation.append(previous, next);
  const lineForm = document.createElement('form'); lineForm.className = 'editor-line-search'; lineForm.noValidate = true;
  lineForm.setAttribute('aria-label', '跳转到行号');
  const lineSymbol = document.createElement('span'); lineSymbol.className = 'editor-line-symbol'; lineSymbol.textContent = '#'; lineSymbol.setAttribute('aria-hidden', 'true');
  const line = document.createElement('input'); line.type = 'text'; line.inputMode = 'numeric'; line.placeholder = '行号';
  line.setAttribute('aria-label', '跳转行号'); line.autocomplete = 'off';
  const go = button('跳转到指定行（Enter）', 'chevron', 'editor-line-go'); go.type = 'submit';
  const goLabel = document.createElement('span'); goLabel.textContent = '跳转'; go.append(goLabel);
  const message = document.createElement('span'); message.className = 'editor-search-message'; message.setAttribute('role', 'status'); message.hidden = true;
  message.id = 'editor-line-search-message'; line.setAttribute('aria-describedby', message.id);
  form.append(searchIcon, input, count, clear, navigation); lineForm.append(lineSymbol, line, go); bar.append(form, lineForm, message);
  root.querySelector('.toastui-editor-toolbar').append(bar);
  let available = false, timer = null, navigated = false;
  const clearMessage = () => { message.textContent = ''; message.hidden = true; line.removeAttribute('aria-invalid'); lineForm.removeAttribute('data-invalid'); };
  const update = () => {
    const state = search.state, total = state.matches.length;
    count.textContent = state.query ? (total ? state.index + 1 : 0) + '/' + total + (state.truncated ? '+' : '') : '本页';
    count.title = state.truncated ? '匹配较多，仅显示前 5000 项' : state.query ? '共 ' + total + ' 处匹配' : '只搜索当前打开的文档';
    count.setAttribute('aria-label', state.query ? (total ? '第 ' + (state.index + 1) + ' 项，' : '') + count.title : count.title);
    form.setAttribute('data-empty', String(!!state.query && !total));
    bar.setAttribute('data-disabled', String(!available));
    clear.hidden = !input.value; clear.disabled = !available;
    input.disabled = line.disabled = go.disabled = !available;
    previous.disabled = next.disabled = !available || !total;
    line.title = lines.count ? '输入 1–' + lines.count + '，按回车跳转' : '输入行号，按回车跳转';
  };
  const applyQuery = () => {
    clearTimeout(timer); timer = null;
    if (!available) return;
    if (search.state.query !== input.value) { navigated = false; search.setQuery(input.value); }
    update();
  };
  const move = direction => {
    if (!available) return;
    applyQuery();
    search.move(navigated ? direction : direction < 0 ? search.state.matches.length - 1 : 0);
    navigated = true;
  };
  input.addEventListener('input', () => { clear.hidden = !input.value; clearTimeout(timer); timer = setTimeout(applyQuery, 120); });
  clear.addEventListener('click', () => { if (!available) return; input.value = ''; navigated = false; applyQuery(); input.focus({ preventScroll: true }); });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
    if (event.key === 'Escape') { event.preventDefault(); input.value = ''; navigated = false; applyQuery(); }
  });
  form.addEventListener('submit', event => { event.preventDefault(); move(1); });
  previous.addEventListener('click', () => move(-1)); next.addEventListener('click', () => move(1));
  line.addEventListener('input', clearMessage);
  lineForm.addEventListener('submit', event => {
    event.preventDefault(); if (!available) return;
    const result = lines.jump(line.value);
    clearMessage();
    if (!result.ok) {
      line.setAttribute('aria-invalid', 'true');
      lineForm.setAttribute('data-invalid', 'true');
      message.textContent = result.count ? '请输入 1–' + result.count + ' 之间的整数行号' : '当前没有可跳转的行';
      message.hidden = false;
    } else line.value = String(result.line);
  });
  const unsubscribeSearch = search.subscribe(update), unsubscribeLines = lines.subscribe(update);
  const controls = {
    setAvailable(value) { available = value; update(); },
    reset() { clearTimeout(timer); timer = null; input.value = line.value = ''; navigated = false; search.setQuery(''); clearMessage(); update(); },
    destroy() { clearTimeout(timer); unsubscribeSearch(); unsubscribeLines(); bar.remove(); delete root.editorSearch; },
  };
  root.editorSearch = controls; update(); return controls;
}
