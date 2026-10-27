'use strict';

// Run in a page with TOAST UI and markdownShortcutsPlugin loaded, via
// await runMarkdownShortcutChecks(). Uses a separate editor, not the open file.
async function runMarkdownShortcutChecks() {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:400px';
  document.body.append(host);
  const editor = new toastui.Editor({ el: host, initialEditType: 'wysiwyg', hideModeSwitch: true,
    autofocus: false, usageStatistics: false, plugins: [markdownShortcutsPlugin] });
  const view = editor.getCurrentModeEditor().view;
  const results = [];
  const assert = (condition, label) => {
    if (!condition) throw new Error(label + ': ' + JSON.stringify(view.state.doc.toJSON()));
  };
  const setup = (html = '<p></p>') => {
    editor.setHTML(html, false);
    // Isolate each fixture's history so a fast test run cannot undo setup from
    // a previous scenario as part of the same native history group.
    view.updateState(view.state.constructor.create({
      schema: view.state.schema, doc: view.state.doc, plugins: view.state.plugins,
    }));
    editor.moveCursorToEnd(false);
    view.dispatch(view.state.tr.setStoredMarks([]));
  };
  const type = text => {
    for (const char of text) {
      const { from, to } = view.state.selection;
      if (!view.someProp('handleTextInput', handler => handler(view, from, to, char))) {
        view.dispatch(view.state.tr.insertText(char, from, to));
      }
    }
  };
  const key = (key, modifiers = {}) => view.someProp('handleKeyDown', handler =>
    handler(view, new KeyboardEvent('keydown', { key, ...modifiers })));
  const check = (name, fn) => { fn(); results.push(name); };
  const first = () => view.state.doc.firstChild;
  const roundtrip = () => {
    const markdown = editor.getMarkdown();
    editor.setMarkdown(markdown, false);
    return markdown;
  };
  try {
    check('headings 1 through 6, body suffix and undo', () => {
      for (let level = 1; level <= 6; level++) {
        setup(); type('#'.repeat(level) + ' 标题');
        assert(first().type.name === 'heading' && first().attrs.level === level && first().textContent === '标题', 'heading conversion');
        assert(roundtrip().startsWith('#'.repeat(level) + ' '), 'heading serialization');
      }
      setup('<p>existing</p>'); editor.moveCursorToStart(false); type('## ');
      assert(first().type.name === 'heading' && first().textContent === 'existing', 'heading lost suffix');
      key('Backspace');
      assert(first().type.name === 'paragraph' && first().textContent === '## existing', 'heading backspace');
      setup(); type('####### ');
      assert(first().type.name === 'paragraph', 'seven hashes converted');
    });
    check('bullet lists, native continuation and adjacent joining', () => {
      for (const marker of ['- ', '+ ', '* ']) {
        setup(); type(marker + 'item');
        assert(first().type.name === 'bulletList' && first().textContent === 'item', 'bullet conversion');
        key('Enter'); type('next');
        assert(first().childCount === 2 && first().lastChild.textContent === 'next', 'list continuation');
      }
      setup('<ul><li><p>previous</p></li></ul><p></p>'); type('- next');
      assert(view.state.doc.childCount === 1 && first().childCount === 2, 'adjacent lists did not join');
      setup(); type('- '); key('Backspace');
      assert(first().type.name === 'paragraph' && first().textContent === '- ', 'list undo input');
    });
    check('ordered list starts, continuation and nonmatching numbering', () => {
      for (const marker of ['1. ', '3) ', '0. ']) {
        setup(); type(marker + 'item');
        assert(first().type.name === 'orderedList' && first().attrs.order === Number(marker[0]), 'ordered conversion');
        roundtrip(); assert(first().type.name === 'orderedList', 'ordered roundtrip');
      }
      setup('<ol start="3"><li><p>previous</p></li></ol><p></p>'); type('4. next');
      assert(view.state.doc.childCount === 1 && first().childCount === 2 && first().attrs.order === 3, 'ordered join');
      setup('<ol start="3"><li><p>previous</p></li></ol><p></p>'); type('8. next');
      assert(view.state.doc.childCount === 2 && view.state.doc.lastChild.attrs.order === 8, 'distinct numbering merged');
    });
    check('quotes preserve content and allow headings inside', () => {
      setup(); type('> quote');
      assert(first().type.name === 'blockQuote' && first().textContent === 'quote', 'quote conversion');
      assert(roundtrip().startsWith('> '), 'quote roundtrip');
      setup(); type('> ## title');
      assert(first().firstChild.type.name === 'heading', 'heading in quote');
    });
    check('task lists including checked, shorthand and existing items', () => {
      for (const marker of ['- [ ] ', '- [x] ', '[ ] ', '[X] ']) {
        setup(); type(marker + 'task');
        assert(first().type.name === 'bulletList' && first().firstChild.attrs.task &&
          first().firstChild.attrs.checked === /x/i.test(marker), 'task conversion');
        roundtrip(); assert(first().firstChild.attrs.task, 'task roundtrip');
      }
      setup(); type('- [x] '); key('Backspace');
      assert(first().type.name === 'bulletList' && !first().firstChild.attrs.task && first().textContent === '[x] ', 'task undo');
    });
    check('bold, italic, strike and code convert at closing delimiter', () => {
      for (const [marker, mark] of [['**', 'strong'], ['__', 'strong'], ['*', 'emph'], ['_', 'emph'], ['~~', 'strike'], ['`', 'code']]) {
        setup(); type(marker + '中文 text' + marker);
        assert(first().textContent === '中文 text' && first().firstChild.marks.some(m => m.type.name === mark), 'inline ' + mark);
        type(' plain');
        assert(!first().lastChild.marks.some(m => m.type.name === mark), 'mark leaked to following input: ' + mark);
        roundtrip(); assert(first().firstChild.marks.some(m => m.type.name === mark), 'inline roundtrip ' + mark);
        setup(); type(marker + 'text' + marker); key('Backspace');
        assert(first().textContent === marker + 'text' + marker && !first().firstChild.marks.length, 'inline undo ' + mark);
      }
    });
    check('inline conversions preserve prior formatting, text and links', () => {
      setup('<p>prefix **<em>text</em>*</p>'); type('*');
      assert(first().textContent === 'prefix text', 'prefix lost');
      assert(first().lastChild.marks.some(m => m.type.name === 'strong') && first().lastChild.marks.some(m => m.type.name === 'emph'), 'existing emphasis lost');
      setup('<p>**<a href="https://example.com">link</a>*</p>'); type('*');
      assert(first().firstChild.marks.some(m => m.type.name === 'link') && first().firstChild.marks.some(m => m.type.name === 'strong'), 'existing link lost');
    });
    check('literal text, escapes, identifiers and code are not reformatted', () => {
      for (const literal of ['snake_case_name_', 'foo__bar__', '\\**text**', '\\*text*', '\\`text`', '** text**', 'prefix # ', 'x > ']) {
        setup(); type(literal);
        assert(first().type.name === 'paragraph' && first().textContent === literal && !first().firstChild.marks.length, 'literal changed: ' + literal);
      }
      setup('<pre><code></code></pre>'); type('# **code** - [x] `text`');
      assert(first().type.name === 'codeBlock' && first().textContent === '# **code** - [x] `text`', 'code block reformatted');
      setup(); view.dispatch(view.state.tr.setStoredMarks([view.state.schema.marks.code.create()])); type('**literal**');
      assert(first().textContent === '**literal**', 'inline code reformatted');
    });
    check('table cells reject invalid blocks but accept inline formatting', () => {
      const table = '<table><thead><tr><th>head</th></tr></thead><tbody><tr><td></td></tr></tbody></table>';
      const setupCell = () => {
        setup(table);
        let position;
        view.state.doc.descendants((node, pos) => { if (node.type.name === 'tableBodyCell') position = pos + 2; });
        const TextSelection = view.state.selection.constructor;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)));
      };
      for (const marker of ['# ', '> ', '```']) {
        setupCell(); type(marker);
        assert(view.state.selection.$from.parent.type.name === 'paragraph' && view.state.selection.$from.parent.textContent === marker, 'table structure changed');
      }
      setupCell(); type('**bold**'); assert(editor.getHTML().includes('<strong>bold</strong>'), 'table inline missing');
    });
    check('horizontal rule converts on space or Enter and keeps typing position', () => {
      for (const marker of ['---', '***', '___']) {
        for (const trigger of ['space', 'enter']) {
          setup(); type(marker);
          if (trigger === 'space') type(' '); else key('Enter');
          assert(first().type.name === 'thematicBreak' && view.state.doc.lastChild.type.name === 'paragraph', 'horizontal rule');
          type('after'); assert(view.state.doc.lastChild.textContent === 'after', 'horizontal rule cursor');
          roundtrip(); assert(first().type.name === 'thematicBreak', 'horizontal rule roundtrip');
        }
      }
    });
    check('code fence, undo and redo remain available', () => {
      setup(); type('``'); assert(first().type.name === 'paragraph', 'fence early'); type('`');
      assert(first().type.name === 'codeBlock' && !first().textContent, 'code fence');
      key('Backspace'); assert(first().type.name === 'paragraph' && first().textContent === '```', 'fence restore');
      setup(); type('## '); key('z', { ctrlKey: true });
      assert(first().type.name === 'paragraph', 'undo');
      key('z', { ctrlKey: true, shiftKey: true }); assert(first().type.name === 'heading', 'redo');
    });
    for (const [input, node] of [['## ', 'heading'], ['```', 'codeBlock'], ['**中文**', 'paragraph']]) {
      setup(); view.focus(); view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); type(input);
      assert(view.composing && first().type.name === 'paragraph' && first().textContent === input, 'composition interrupted');
      view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: input }));
      await new Promise(resolve => setTimeout(resolve, 60));
      assert(first().type.name === node, 'composition commit failed');
      if (input.includes('中文')) assert(first().textContent === '中文' && first().firstChild.marks[0].type.name === 'strong', 'composition inline');
    }
    results.push('IME input converts only after composition commits');
    return results;
  } finally { editor.destroy(); host.remove(); }
}
