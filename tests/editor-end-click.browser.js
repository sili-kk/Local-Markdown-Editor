'use strict';

// Load through Chrome Bridge on the application page, then call
// await runEditorEndClickChecks(). Uses an isolated editor, never the open file.
async function runEditorEndClickChecks() {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:450px;z-index:3000';
  document.body.append(host);
  const editor = new toastui.Editor({ el: host, height: '450px', initialEditType: 'wysiwyg',
    autofocus: false, usageStatistics: false, hideModeSwitch: true, plugins: [editorEndClickPlugin] });
  const view = editor.getCurrentModeEditor().view;
  const results = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); };
  const clickBottom = () => {
    view.dom.style.cssText = 'min-height:100%;box-sizing:border-box;padding-bottom:90px';
    const last = view.nodeDOM(view.state.doc.content.size - view.state.doc.lastChild.nodeSize);
    const bounds = last.getBoundingClientRect(), root = view.dom.getBoundingClientRect();
    view.dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0,
      clientX: root.left + 20, clientY: bounds.bottom + 15 }));
  };
  try {
    for (const markdown of ['最后一行', '## 末尾标题', '- 最后一个列表项', '```js\nconst x = 1;\n```', '| A |\n|---|\n| B |']) {
      editor.setMarkdown(markdown, false);
      const original = view.state.doc;
      // Ensure this case actually has no empty paragraph already at its end.
      const last = original.lastChild;
      if (last.type.name === 'paragraph' && last.content.size === 0 && original.childCount > 1) {
        view.dispatch(view.state.tr.delete(original.content.size - last.nodeSize, original.content.size));
      }
      const before = view.state.doc;
      clickBottom();
      assert(view.state.doc.lastChild.type.name === 'paragraph' && view.state.doc.lastChild.content.size === 0, 'missing editable paragraph');
      assert(view.state.doc.childCount === before.childCount + 1, 'wrong paragraph count');
      assert(view.state.selection.$from.parent === view.state.doc.lastChild, 'caret not in final paragraph');
      clickBottom(); assert(view.state.doc.childCount === before.childCount + 1, 'repeated click added another empty paragraph');
      view.dispatch(view.state.tr.insertText('继续编辑'));
      assert(view.state.doc.lastChild.textContent === '继续编辑', 'typing failed');
      const content = editor.getMarkdown();
      view.setProps({ editable: () => false }); clickBottom();
      assert(editor.getMarkdown() === content, 'read-only document changed');
      view.setProps({ editable: () => true });
      results.push(markdown.split('\n')[0]);
    }
    return { passed: results.length, cases: results };
  } finally { editor.destroy(); host.remove(); }
}
