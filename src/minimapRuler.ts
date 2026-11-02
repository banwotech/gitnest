import type { editor } from 'monaco-editor/editor/editor.api.js';

export function attachMinimapRuler(codeEditor: editor.IStandaloneCodeEditor) {
  const root = codeEditor.getContainerDomNode();
  const canvas = document.createElement('canvas');
  canvas.className = 'minimap-change-ruler';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '文件变更位置标尺，可点击或拖动定位');
  root.appendChild(canvas);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建文件变更标尺：Canvas 不可用。');
  let frame = 0;

  const render = () => {
    frame = 0;
    codeEditor.render();
    const layout = codeEditor.getLayoutInfo();
    const pixelRatio = window.devicePixelRatio;
    canvas.style.width = `${layout.verticalScrollbarWidth}px`;
    canvas.style.height = `${layout.height}px`;
    canvas.width = Math.round(layout.verticalScrollbarWidth * pixelRatio);
    canvas.height = Math.round(layout.height * pixelRatio);
    const source = root.querySelector<HTMLCanvasElement>('.minimap-decorations-layer');
    if (!codeEditor.getModel() || !source?.width || !source.height) return;
    context.imageSmoothingEnabled = false;
    // Reuse Monaco's gutter pixels so wrapping, sampling and diff gaps cannot change the ruler's scale.
    context.drawImage(source, 2, 0, 2, source.height, 0, 0, canvas.width, layout.minimap.minimapCanvasOuterHeight * pixelRatio);
  };
  const scheduleRender = () => {
    if (!frame) frame = window.requestAnimationFrame(render);
  };
  const forwardPointer = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const minimap = root.querySelector<HTMLElement>('.minimap');
    if (!minimap) return;
    event.preventDefault();
    event.stopPropagation();
    minimap.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: event.pointerId, pointerType: event.pointerType,
      button: event.button, buttons: event.buttons, clientX: event.clientX, clientY: event.clientY,
    }));
  };
  canvas.addEventListener('pointerdown', forwardPointer);
  const subscriptions = [
    codeEditor.onDidLayoutChange(scheduleRender),
    codeEditor.onDidScrollChange(scheduleRender),
    codeEditor.onDidContentSizeChange(scheduleRender),
    codeEditor.onDidChangeConfiguration(scheduleRender),
    codeEditor.onDidChangeViewZones(scheduleRender),
    codeEditor.onDidChangeModel(scheduleRender),
    codeEditor.onDidChangeModelDecorations(scheduleRender),
  ];
  scheduleRender();
  return () => {
    subscriptions.forEach((subscription) => subscription.dispose());
    window.cancelAnimationFrame(frame);
    canvas.removeEventListener('pointerdown', forwardPointer);
    canvas.remove();
  };
}
