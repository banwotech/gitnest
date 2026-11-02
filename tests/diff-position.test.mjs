import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/diffPosition.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { changeIndexAtScroll } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const change = (start, end = start) => ({ originalStartLineNumber: start, originalEndLineNumber: end, modifiedStartLineNumber: start, modifiedEndLineNumber: end });
function viewport(top, overrides = {}) {
  return {
    getScrollTop: () => top,
    getScrollHeight: () => 3000,
    getLayoutInfo: () => ({ height: 200 }),
    getTopForLineNumber: line => (line - 1) * 20,
    getBottomForLineNumber: line => line * 20,
    ...overrides,
  };
}

test('follows scrolling in both directions without a cursor position', () => {
  const changes = [change(10, 12), change(40, 42), change(70, 72)];
  for (const [top, expected] of [[100, 0], [700, 1], [1300, 2], [700, 1], [100, 0]]) {
    assert.equal(changeIndexAtScroll(changes, viewport(top), viewport(top)), expected);
  }
});

test('uses the nearest difference between blocks and stays on a long visible block', () => {
  const changes = [change(10, 40), change(70, 72)];
  assert.equal(changeIndexAtScroll(changes, viewport(500), viewport(500)), 0);
  assert.equal(changeIndexAtScroll(changes, viewport(800), viewport(800)), 0);
  assert.equal(changeIndexAtScroll(changes, viewport(1100), viewport(1100)), 1);
});

test('uses rendered geometry for wrapped lines', () => {
  const changes = [change(10, 12), change(20, 22)];
  const editor = viewport(750, {
    getTopForLineNumber: line => line === 10 ? 180 : 1200,
    getBottomForLineNumber: line => line === 12 ? 1040 : 1260,
  });
  assert.equal(changeIndexAtScroll(changes, editor, editor), 0);
});

test('tracks pure deletions using their original-side range', () => {
  const deletion = { originalStartLineNumber: 60, originalEndLineNumber: 80, modifiedStartLineNumber: 59, modifiedEndLineNumber: 0 };
  const changes = [change(10), deletion, change(90)];
  assert.equal(changeIndexAtScroll(changes, viewport(1300), viewport(1300)), 1);
});

test('handles the file edges, a short file, and no differences', () => {
  const changes = [change(10), change(20), change(30)];
  assert.equal(changeIndexAtScroll(changes, viewport(0), viewport(0)), 0);
  assert.equal(changeIndexAtScroll(changes, viewport(2800), viewport(2800)), 2);
  assert.equal(changeIndexAtScroll(changes, viewport(0), viewport(0, { getScrollHeight: () => 200 })), 0);
  assert.equal(changeIndexAtScroll([], viewport(0), viewport(0)), -1);
});
