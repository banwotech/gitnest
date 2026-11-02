import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/minimapRuler.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { attachMinimapRuler } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function fixture(t, pixelRatio = 2) {
  const previousGlobals = { window: globalThis.window, document: globalThis.document, PointerEvent: globalThis.PointerEvent };
  t.after(() => {
    for (const [name, value] of Object.entries(previousGlobals)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
  const frames = new Map();
  const events = new Map();
  const listeners = new Map();
  const draws = [];
  const pointers = [];
  let nextFrame = 0;
  const state = {
    model: null, attached: false, rendered: 0,
    source: { width: 120, height: 1600 },
    layout: { height: 800, verticalScrollbarWidth: 8, minimap: { minimapCanvasOuterHeight: 400 } },
  };
  const canvas = {
    style: {}, setAttribute() {},
    getContext: () => ({ drawImage: (...args) => draws.push(args) }),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
    remove: () => { state.attached = false; },
  };
  const root = {
    appendChild: () => { state.attached = true; },
    querySelector: selector => selector === '.minimap' ? { dispatchEvent: event => pointers.push(event) } : state.source,
  };
  globalThis.window = {
    devicePixelRatio: pixelRatio,
    requestAnimationFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  globalThis.document = { createElement: () => canvas };
  globalThis.PointerEvent = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
  const editor = {
    getContainerDomNode: () => root,
    getLayoutInfo: () => state.layout,
    getModel: () => state.model,
    render: () => { state.rendered++; },
  };
  for (const name of ['onDidLayoutChange', 'onDidScrollChange', 'onDidContentSizeChange', 'onDidChangeConfiguration', 'onDidChangeViewZones', 'onDidChangeModel', 'onDidChangeModelDecorations']) {
    editor[name] = callback => {
      events.set(name, callback);
      return { dispose: () => events.delete(name) };
    };
  }
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  return { editor, canvas, state, draws, pointers, frames, events, listeners, flush };
}

test('can mount the ruler before a file model exists', (t) => {
  const f = fixture(t);
  const dispose = attachMinimapRuler(f.editor);
  f.flush();
  assert.equal(f.state.attached, true);
  assert.equal(f.draws.length, 0);
  f.state.model = {};
  f.events.get('onDidChangeModel')();
  f.flush();
  assert.equal(f.draws.length, 1);
  dispose();
});

test('keeps the minimap scale and blank space on a high DPI display', (t) => {
  const f = fixture(t, 2);
  f.state.model = {};
  const dispose = attachMinimapRuler(f.editor);
  f.flush();
  assert.equal(f.canvas.width, 16);
  assert.equal(f.canvas.height, 1600);
  assert.deepEqual(f.draws[0], [f.state.source, 2, 0, 2, 1600, 0, 0, 16, 800]);
  dispose();
});

test('coalesces layout and decoration changes and redraws with the latest scale', (t) => {
  const f = fixture(t, 1);
  f.state.model = {};
  const dispose = attachMinimapRuler(f.editor);
  f.flush();
  f.state.layout.minimap.minimapCanvasOuterHeight = 600;
  f.state.source.height = 1200;
  f.events.get('onDidLayoutChange')();
  f.events.get('onDidChangeModelDecorations')();
  f.events.get('onDidScrollChange')();
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.state.rendered, 2);
  assert.deepEqual(f.draws[1], [f.state.source, 2, 0, 2, 1200, 0, 0, 8, 600]);
  dispose();
});

test('forwards pointer navigation to the minimap and removes all resources on disposal', (t) => {
  const f = fixture(t);
  const dispose = attachMinimapRuler(f.editor);
  let prevented = false;
  let stopped = false;
  f.listeners.get('pointerdown')({ button: 0, buttons: 1, pointerId: 7, pointerType: 'mouse', clientX: 500, clientY: 320,
    preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  assert.equal(prevented && stopped, true);
  assert.equal(f.pointers[0].pointerId, 7);
  assert.equal(f.pointers[0].clientY, 320);
  dispose();
  assert.equal(f.state.attached, false);
  assert.equal(f.frames.size, 0);
  assert.equal(f.events.size, 0);
  assert.equal(f.listeners.size, 0);
});
