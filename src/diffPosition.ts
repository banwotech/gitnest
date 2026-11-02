import type { editor } from 'monaco-editor/editor/editor.api.js';

type ScrollEditor = Pick<editor.IStandaloneCodeEditor,
  'getTopForLineNumber' | 'getBottomForLineNumber' | 'getScrollTop' | 'getScrollHeight' | 'getLayoutInfo'>;

export function changeIndexAtScroll(changes: editor.ILineChange[], original: ScrollEditor, modified: ScrollEditor) {
  if (!changes.length) return -1;
  const top = modified.getScrollTop();
  const height = modified.getLayoutInfo().height;
  if (top <= 0) return 0;
  if (top + height >= modified.getScrollHeight() - 1) return changes.length - 1;
  const center = top + height / 2;
  let active = 0;
  let closest = Infinity;
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    const deleted = change.modifiedEndLineNumber === 0;
    const codeEditor = deleted ? original : modified;
    const start = deleted ? change.originalStartLineNumber : change.modifiedStartLineNumber;
    const end = deleted ? change.originalEndLineNumber : change.modifiedEndLineNumber;
    const distance = Math.max(codeEditor.getTopForLineNumber(start) - center, center - codeEditor.getBottomForLineNumber(end), 0);
    if (distance < closest) {
      active = index;
      closest = distance;
    }
  }
  return active;
}
