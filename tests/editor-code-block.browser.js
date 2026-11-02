'use strict';

// Load via Chrome Bridge with the project's styles, TOAST UI and editor plugins.
// Creates an independent editor; it never reads or saves the user's document.
async function runEditorCodeBlockChecks() {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:680px;height:500px;z-index:3000';
  const root = document.getElementById('editor');
  if (!root) host.id = 'editor';
  (root || document.body).append(host);
  const plugins = [editorCodeBlockPlugin];
  for (const name of ['markdownShortcutsPlugin', 'editorEndClickPlugin', 'editorLineNumbersPlugin', 'editorSearchPlugin']) {
    if (typeof window[name] === 'function') plugins.push(window[name]);
  }
  const editor = new toastui.Editor({ el: host, height: '500px', initialEditType: 'wysiwyg',
    hideModeSwitch: true, autofocus: false, usageStatistics: false, plugins });
  const view = editor.getCurrentModeEditor().view;
  const results = [];
  let edits = 0;
  const assert = (condition, label) => { if (!condition) throw new Error(label); };
  const codeNode = () => view.state.doc.firstChild;
  const codeDOM = () => view.dom.querySelector('.toastui-editor-ww-code-block code');
  const setup = text => {
    editor.setMarkdown('```text\n' + text + '\n```\n\nPARAGRAPH KEEP', false);
    // Give each fixture independent native undo history.
    view.updateState(view.state.constructor.create({ schema: view.state.schema,
      doc: view.state.doc, plugins: view.state.plugins }));
  };
  const select = (from, to = from) => {
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.create(view.state.doc, from, to)));
    view.focus();
  };
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  const checkLayout = label => {
    const code = codeDOM(), pre = code.parentElement, block = pre.parentElement;
    const range = document.createRange(); range.selectNodeContents(code);
    const rects = [...range.getClientRects()];
    const lastBottom = Math.max(...rects.map(rect => rect.bottom));
    const following = view.dom.querySelector('p').getBoundingClientRect();
    assert(pre.scrollHeight <= pre.clientHeight + 1, label + ': pre clips rows');
    assert(code.scrollHeight <= code.clientHeight + 1, label + ': code clips rows');
    assert(lastBottom <= pre.getBoundingClientRect().bottom + 1, label + ': last row outside pre');
    assert(following.top >= block.getBoundingClientRect().bottom - 1, label + ': overlaps following paragraph');
    assert(getComputedStyle(pre).overflowY === 'visible', label + ': nested vertical scroll container');
    assert(code.textContent === codeNode().textContent, label + ': DOM/document mismatch');
    assert(editor.getMarkdown().endsWith('PARAGRAPH KEEP'), label + ': following content lost');
  };
  const insert = async (text, from, to = from) => {
    const old = codeNode().textContent;
    const expected = old.slice(0, from - 1) + text + old.slice(to - 1);
    select(from, to);
    assert(document.execCommand('insertText', false, text), 'native insert rejected');
    await flush();
    assert(codeNode().textContent === expected, 'native edit lost or replaced following code: ' + JSON.stringify({ edit: edits, from, to, expected, actual: codeNode().textContent }));
    checkLayout('edit ' + ++edits);
  };
  try {
    setup('FIRST\nMIDDLE\nLAST KEEP');
    select(10);
    codeDOM().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    assert(view.composing, 'code block swallowed compositionstart');
    codeDOM().dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '字' }));
    assert(view.composing, 'composition ended before IME committed');
    codeDOM().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '字' }));
    assert(!view.composing, 'composition did not end');
    results.push('输入法组合事件到达编辑器');

    for (const zoom of [0.5, 1, 1.5]) {
      host.style.zoom = zoom;
      for (const width of [340, 680]) {
        host.style.width = width + 'px';
        for (const line of ['short', 'x'.repeat(160), '中文与空格 '.repeat(30)]) {
          setup(Array.from({ length: 15 }, (_, i) => line + i).join('\n'));
          const initialHeight = codeDOM().getBoundingClientRect().height;
          for (let i = 0; i < 8; i++) {
            const pos = 1 + Math.floor(codeNode().content.size * (i + 1) / 10);
            await insert(i % 2 ? '新增文本 '.repeat(12) : '\nINSERTED\n', pos);
          }
          assert(codeDOM().getBoundingClientRect().height > initialHeight, 'code did not grow');
          await insert('改', 3, 30);
          select(2, 20);
          const beforeDelete = codeNode().textContent;
          assert(document.execCommand('delete'), 'native delete rejected');
          await flush();
          assert(codeNode().textContent === beforeDelete.slice(0, 1) + beforeDelete.slice(19), 'delete lost suffix');
          checkLayout('delete');
          const markdown = editor.getMarkdown(), expected = codeNode().textContent;
          editor.setMarkdown(markdown, false);
          assert(codeNode().textContent === expected, 'Markdown round trip lost code');
          checkLayout('round trip');
        }
      }
    }
    results.push('50%/100%/150% 缩放、窄宽窗口、长行折行及连续增删替换');

    setup('FIRST\nLAST KEEP');
    select(4);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13,
      bubbles: true, cancelable: true });
    codeDOM().dispatchEvent(enter);
    await flush();
    assert(enter.defaultPrevented && codeNode().textContent === 'FIR\nST\nLAST KEEP', 'Enter lost code suffix');
    checkLayout('Enter');
    results.push('正文回车插行保留后续代码');

    setup('FIRST\nLAST KEEP\n\n');
    await insert('尾部输入', codeNode().nodeSize - 1);
    editor.exec('undo');
    assert(codeNode().textContent === 'FIRST\nLAST KEEP\n\n', 'undo changed original code');
    editor.exec('redo');
    assert(codeNode().textContent.endsWith('\n\n尾部输入'), 'redo lost inserted text');
    checkLayout('undo/redo');
    results.push('末尾空行输入、撤销重做及 Markdown 往返保留');

    const block = codeDOM().parentElement.parentElement;
    block.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const languageInput = view.dom.parentElement.querySelector('.toastui-editor-ww-code-block-language input');
    assert(languageInput, 'native language picker missing');
    languageInput.value = 'javascript';
    languageInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert(codeNode().attrs.language === 'javascript', 'language edit failed');
    assert(!view.dom.parentElement.querySelector('.toastui-editor-ww-code-block-language'), 'language picker not closed');
    results.push('原生语言选择控件保留');

    const readonlyMarkdown = editor.getMarkdown();
    view.setProps({ editable: () => false });
    assert(!view.editable && view.dom.getAttribute('contenteditable') === 'false', 'read-only lost');
    codeDOM().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    assert(editor.getMarkdown() === readonlyMarkdown, 'read-only document changed');
    results.push('只读编辑保护');
    return { passed: results.length, nativeInsertions: edits, cases: results };
  } finally { editor.destroy(); host.remove(); }
}
