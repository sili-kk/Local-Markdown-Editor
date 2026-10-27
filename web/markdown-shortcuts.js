'use strict';

// Use the editor's input rules so conversion participates in native history
// and never reparses or replaces the rest of the document.
function markdownShortcutsPlugin({ pmRules, pmKeymap, pmState }) {
  const { InputRule, inputRules, undoInputRule } = pmRules;
  const isLiteral = state => {
    const { $from } = state.selection;
    const marks = [...$from.marks(), ...(state.storedMarks || [])];
    return $from.parent.type.spec.code || marks.some(mark => mark.type.spec.code || mark.type.name === 'code');
  };
  const paragraphAtCursor = state => {
    const { selection, schema } = state;
    return selection.empty && selection.$from.parent.type === schema.nodes.paragraph && !isLiteral(state);
  };
  const canReplaceParagraph = (state, type) => {
    const { $from } = state.selection;
    const parent = $from.node(-1), index = $from.index(-1);
    return parent.canReplaceWith(index, index + 1, type);
  };
  const blockTypeRule = (pattern, name, attrs = () => ({}), wholeLine = false) => new InputRule(pattern, (state, match, start, end) => {
    const { $from } = state.selection;
    const type = state.schema.nodes[name];
    if (!paragraphAtCursor(state) || start !== $from.start() || !canReplaceParagraph(state, type) ||
        (wholeLine && $from.parentOffset !== $from.parent.content.size)) return null;
    return state.tr.delete(start, end)
      .setBlockType(start, start, type, attrs(match)).setStoredMarks([]).scrollIntoView();
  });
  const wrapRule = (pattern, name, attrs = () => ({}), task = null) => new InputRule(pattern, (state, match, start, end) => {
    if (!paragraphAtCursor(state) || start !== state.selection.$from.start()) return null;
    const type = state.schema.nodes[name], attributes = attrs(match);
    const itemAttrs = task ? { task: true, checked: match[1].toLowerCase() === 'x' } : {};
    const { $from } = state.selection;
    // Typing [ ] / [x] inside a list changes that item instead of nesting a list.
    if (task && $from.node(-1).type === state.schema.nodes.listItem && $from.index(-1) === 0) {
      return state.tr.delete(start, end).setNodeMarkup($from.before(-1), null,
        { ...$from.node(-1).attrs, ...itemAttrs }).setStoredMarks([]).scrollIntoView();
    }
    if (!canReplaceParagraph(state, type)) return null;
    const tr = state.tr.delete(start, end);
    const range = tr.doc.resolve(start).blockRange();
    const wrappers = [{ type, attrs: attributes }];
    if (name !== 'blockQuote') wrappers.push({ type: state.schema.nodes.listItem, attrs: itemAttrs });
    tr.wrap(range, wrappers);
    const boundary = tr.doc.resolve(range.start), before = boundary.nodeBefore, after = boundary.nodeAfter;
    if (before?.type === type && before.canAppend(after) &&
        (name !== 'orderedList' || before.attrs.order + before.childCount === attributes.order)) {
      tr.join(range.start);
    }
    return tr.setStoredMarks([]).scrollIntoView();
  });
  const escaped = (text, offset) => {
    let slashes = 0;
    while (offset > 0 && text[--offset] === '\\') slashes++;
    return slashes % 2 === 1;
  };
  const markRule = (pattern, name, delimiterLength) => new InputRule(pattern, (state, match, start, end) => {
    const type = state.schema.marks[name];
    if (!state.selection.empty || isLiteral(state) || !state.selection.$from.parent.type.allowsMarkType(type)) return null;
    const from = start + match[1].length, markup = match[2], body = match[3];
    const $start = state.doc.resolve(from);
    const prefix = $start.parent.textBetween(0, $start.parentOffset);
    if (escaped(prefix, prefix.length) || escaped(markup, markup.length - delimiterLength)) return null;
    // Insert only the new input; retain existing marks and links inside the text.
    const inserted = match[0].slice(end - start);
    const tr = state.tr.insertText(inserted, end);
    tr.delete(from + markup.length - delimiterLength, from + markup.length);
    tr.delete(from, from + delimiterLength);
    return tr.addMark(from, from + body.length, type.create()).removeStoredMark(type).scrollIntoView();
  });
  const hrPattern = /^ {0,3}(?:---|\*\*\*|___)[ \t]$/;
  const horizontalRule = (state, match, start, end) => {
    const { $from } = state.selection;
    const { thematicBreak, paragraph } = state.schema.nodes;
    if (!paragraphAtCursor(state) || start !== $from.start() ||
        $from.parentOffset !== $from.parent.content.size) return null;
    const nodes = [thematicBreak.create(), paragraph.create()];
    const parent = $from.node(-1), index = $from.index(-1);
    // Validate both nodes, including list/table constraints, before replacing.
    const content = state.schema.nodes.doc.create(null, nodes).content;
    if (!parent.canReplace(index, index + 1, content)) return null;
    const pos = $from.before();
    const tr = state.tr.replaceWith(pos, $from.after(), nodes);
    return tr.setSelection(pmState.TextSelection.create(tr.doc, pos + nodes[0].nodeSize + 1))
      .setStoredMarks([]).scrollIntoView();
  };
  const rules = [
    blockTypeRule(/^ {0,3}```$/, 'codeBlock', () => ({}), true),
    blockTypeRule(/^ {0,3}(#{1,6})[ \t]$/, 'heading', match => ({ level: match[1].length })),
    wrapRule(/^ {0,3}>[ \t]$/, 'blockQuote'),
    wrapRule(/^ {0,3}(?:[-+*][ \t])?\[([ xX])\][ \t]$/, 'bulletList', () => ({}), true),
    wrapRule(/^ {0,3}[-+*][ \t]$/, 'bulletList'),
    wrapRule(/^ {0,3}(\d{1,9})[.)][ \t]$/, 'orderedList', match => ({ order: Number(match[1]) })),
    new InputRule(hrPattern, horizontalRule),
    markRule(/(^|[^*])(\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*)$/, 'strong', 2),
    markRule(/(^|[^\p{L}\p{N}_])(__([^\s_](?:[^_\n]*[^\s_])?)__)$/u, 'strong', 2),
    markRule(/(^|[^*])(\*([^\s*](?:[^*\n]*[^\s*])?)\*)$/, 'emph', 1),
    markRule(/(^|[^\p{L}\p{N}_])(_([^\s_](?:[^_\n]*[^\s_])?)_)$/u, 'emph', 1),
    markRule(/(^|[^~])(~~([^\s~](?:[^~\n]*[^\s~])?)~~)$/, 'strike', 2),
    markRule(/(^|[^`])(`([^`\n]+)`)$/, 'code', 1),
  ];
  const enterRule = (state, dispatch, view) => {
    if (view.composing) return false;
    const { $from } = state.selection;
    const match = hrPattern.exec($from.parent.textContent + ' ');
    if (!match) return false;
    const tr = horizontalRule(state, match, $from.start(), $from.pos);
    if (!tr) return false;
    if (dispatch) dispatch(tr);
    return true;
  };
  return {
    wysiwygPlugins: [
      () => inputRules({ rules }),
      () => pmKeymap.keymap({ Backspace: undoInputRule, Enter: enterRule }),
    ],
  };
}
