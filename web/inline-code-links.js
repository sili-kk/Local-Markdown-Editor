'use strict';

// Inline code remains code in the Markdown model. Only complete web URLs get
// a clickable display decoration; commands and fenced code stay editable text.
function inlineCodeURL(text) {
  const reference = text.trim();
  if (!/^https?:\/\/[^\s<>]+$/i.test(reference)) return null;
  try { return new URL(reference).href; } catch { return null; }
}

function inlineCodeLinkAttributes(url) {
  return { class: 'inline-code-link', 'data-external-url': url, role: 'link', tabindex: '0',
    title: '单击在浏览器新标签页打开：' + url };
}

function inlineCodeLinksPlugin({ pmState, pmView }) {
  const key = new pmState.PluginKey('inlineCodeLinks');
  const { Decoration, DecorationSet } = pmView;
  function decorations(doc) {
    const links = [];
    doc.descendants((node, position) => {
      if (node.type.name === 'codeBlock') return false;
      if (!node.isText || !node.marks.some(mark => mark.type.name === 'code') ||
        node.marks.some(mark => mark.type.name === 'link')) return;
      const url = inlineCodeURL(node.text);
      if (!url) return;
      const reference = node.text.trim(), from = position + node.text.indexOf(reference);
      links.push(Decoration.inline(from, from + reference.length, inlineCodeLinkAttributes(url)));
    });
    return links.length ? DecorationSet.create(doc, links) : DecorationSet.empty;
  }
  return { wysiwygPlugins: [() => new pmState.Plugin({
    key,
    state: {
      init: (_, state) => decorations(state.doc),
      apply: (transaction, previous) => transaction.docChanged ? decorations(transaction.doc) : previous,
    },
    props: { decorations: state => key.getState(state) },
  })] };
}

function decorateReaderCodeLinks(root) {
  for (const code of root.querySelectorAll('code')) {
    if (code.closest('pre, a')) continue;
    const url = inlineCodeURL(code.textContent);
    if (!url) continue;
    for (const [name, value] of Object.entries(inlineCodeLinkAttributes(url))) {
      if (name === 'class') code.classList.add(value);
      else code.setAttribute(name, value);
    }
  }
}

function installInlineCodeLinkInteractions(root) {
  const follow = event => {
    if (event.defaultPrevented || event.altKey || event.shiftKey) return;
    if (event.type === 'click' ? event.button !== 0 : event.key !== 'Enter') return;
    const link = event.target.closest?.('[data-external-url]');
    const url = link && inlineCodeURL(link.getAttribute('data-external-url') || '');
    if (!url) return;
    event.preventDefault(); event.stopPropagation();
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  root.addEventListener('click', follow, true);
  root.addEventListener('keydown', follow, true);
}
