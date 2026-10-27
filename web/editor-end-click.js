'use strict';

// The document's bottom padding has no text position for the browser to place
// a caret in. Use one native transaction rather than editing the DOM/Markdown.
function editorEndClickPlugin({ pmState }) {
  const { Plugin, TextSelection } = pmState;
  const handleBottomClick = (view, event) => {
    const viewport = view.dom.parentElement;
    if (event.defaultPrevented || event.button !== 0 || event.detail > 1 ||
        event.shiftKey || event.ctrlKey || event.metaKey || event.altKey ||
        view.composing || !view.editable || view.dom.closest('[inert], [hidden]')) return false;
    // Text, links, images, tables and code keep their normal click behavior.
    if (event.target !== view.dom && event.target !== viewport) return false;
    const { doc, schema } = view.state;
    const paragraph = schema.nodes.paragraph, last = doc.lastChild;
    if (!paragraph || !last) return false;
    const lastDOM = view.nodeDOM(doc.content.size - last.nodeSize);
    if (!lastDOM?.getBoundingClientRect) return false;
    const lastBounds = lastDOM.getBoundingClientRect(), contentBounds = view.dom.getBoundingClientRect();
    const viewportBounds = viewport.getBoundingClientRect();
    if (event.clientY < lastBounds.bottom || event.clientY < viewportBounds.top || event.clientY >= viewportBounds.bottom ||
        event.clientX < contentBounds.left || event.clientX >= contentBounds.right) return false;
    let tr = view.state.tr;
    let position;
    if (last.type === paragraph && last.content.size === 0) {
      position = doc.content.size - last.nodeSize + 1;
    } else {
      if (!doc.canReplaceWith(doc.childCount, doc.childCount, paragraph)) return false;
      position = doc.content.size + 1;
      tr = tr.insert(doc.content.size, paragraph.create());
    }
    event.preventDefault();
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, position))
      .setStoredMarks([]).setMeta('uiEvent', 'pointer').scrollIntoView());
    view.focus();
    return true;
  };
  return {
    wysiwygPlugins: [() => new Plugin({
      props: { handleDOMEvents: { mousedown: handleBottomClick } },
      view(view) {
        // Short documents can leave extra space in the scrolling wrapper too.
        const viewport = view.dom.parentElement;
        const listener = event => { if (event.target === viewport) handleBottomClick(view, event); };
        viewport.addEventListener('mousedown', listener);
        return { destroy() { viewport.removeEventListener('mousedown', listener); } };
      },
    })],
  };
}
