'use strict';

// Keep TOAST UI's node view and language picker, but let ProseMirror receive
// editing events from its contentDOM, especially IME composition events.
function editorCodeBlockPlugin({ pmState }) {
  return {
    wysiwygPlugins: [() => new pmState.Plugin({
      view(view) {
        const nodeViews = view.props.nodeViews;
        const original = nodeViews?.codeBlock;
        if (typeof original !== 'function' || original.editorCodeBlockEvents) return {};
        const codeBlock = (...args) => {
          const nodeView = original(...args);
          const stopEvent = nodeView.stopEvent;
          nodeView.stopEvent = event => {
            if (event.target && nodeView.contentDOM?.contains(event.target)) return false;
            return typeof stopEvent === 'function' ? stopEvent.call(nodeView, event) : false;
          };
          return nodeView;
        };
        codeBlock.editorCodeBlockEvents = true;
        view.setProps({ nodeViews: { ...nodeViews, codeBlock } });
        return {};
      },
    })],
  };
}
