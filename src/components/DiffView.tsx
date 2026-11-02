import { useCallback, useEffect, useId, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import 'monaco-editor/codicon.css';
import 'monaco-editor/languages/definitions/typescript/register.js';
import 'monaco-editor/languages/definitions/javascript/register.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';
import 'monaco-editor/languages/definitions/python/register.js';
import 'monaco-editor/languages/definitions/php/register.js';
import 'monaco-editor/languages/definitions/go/register.js';
import 'monaco-editor/languages/definitions/rust/register.js';
import 'monaco-editor/languages/definitions/shell/register.js';
import { ArrowDown, ArrowUp, Check, FileDashed, Minus, Plus } from '@phosphor-icons/react';
import type { ChangedFile, CommitDetail, Comparison, Project } from '../types';
import { attachMinimapRuler } from '../minimapRuler';
import { changeIndexAtScroll } from '../diffPosition';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.editor.defineTheme('gitnest', {
  base: 'vs', inherit: true, rules: [{ token: 'comment', foreground: '92958C', fontStyle: 'italic' }],
  colors: {
    'editor.background': '#FFFFFF', 'editor.foreground': '#363A36',
    'editorLineNumber.foreground': '#B3B6AE', 'editorLineNumber.activeForeground': '#6B7368',
    'editorGutter.background': '#FFFFFF', 'editor.selectionBackground': '#B8D7F2',
    'editor.inactiveSelectionBackground': '#8DB4D666',
    'diffEditor.insertedTextBackground': '#00000000', 'diffEditor.removedTextBackground': '#00000000',
    'diffEditor.insertedLineBackground': '#E6F4E7', 'diffEditor.removedLineBackground': '#FCE6E2',
    'diffEditorGutter.insertedLineBackground': '#EDF7ED', 'diffEditorGutter.removedLineBackground': '#FDECE9',
    'diffEditor.diagonalFill': '#ECEEE8', 'diffEditor.border': '#E9EBE4',
    'scrollbarSlider.background': '#A8ADA333', 'scrollbarSlider.hoverBackground': '#A8ADA366',
    'minimapSlider.background': '#A8ADA333', 'minimapSlider.hoverBackground': '#A8ADA355',
    'minimapSlider.activeBackground': '#A8ADA377',
  },
});

const minimapOptions: monaco.editor.IEditorMinimapOptions = {
  enabled: true, side: 'right', size: 'fit', showSlider: 'always', renderCharacters: true, maxColumn: 100,
};

function configureDiffEditors(instance: monaco.editor.IStandaloneDiffEditor) {
  const models = instance.getModel();
  const lineNumbersMinChars = Math.max(3, String(Math.max(models?.original.getLineCount() ?? 1, models?.modified.getLineCount() ?? 1)).length);
  // Allow 8px on either side of the number, plus the 4px marker and 2px divider.
  const gutterOptions = { glyphMargin: false, lineNumbersMinChars, lineDecorationsWidth: 22 };
  // Monaco restores the original glyph margin and disables minimaps when diff options change.
  instance.getOriginalEditor().updateOptions(gutterOptions);
  instance.getModifiedEditor().updateOptions({ ...gutterOptions, minimap: minimapOptions });
}

function languageFor(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', css: 'css', scss: 'scss', html: 'html', vue: 'html', md: 'markdown', py: 'python', php: 'php', php4: 'php', php5: 'php', phtml: 'php', ctp: 'php', go: 'go', rs: 'rust', sh: 'shell', json: 'json' } as Record<string, string>)[ext] ?? 'plaintext';
}

function changeIndexAtLine(changes: monaco.editor.ILineChange[], side: 'original' | 'modified', line: number, lineCount: number) {
  let active = 0;
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    const start = side === 'original' ? change.originalStartLineNumber : change.modifiedStartLineNumber;
    const end = side === 'original' ? change.originalEndLineNumber : change.modifiedEndLineNumber;
    const targetLine = Math.min(lineCount, Math.max(1, start + Number(end === 0)));
    if (targetLine <= line) active = index;
    else break;
  }
  return changes.length ? active : -1;
}

function jumpDecoration(model: monaco.editor.ITextModel, start: number, end: number): monaco.editor.IModelDeltaDecoration[] {
  if (end === 0 || model.getValueLength() === 0) return [];
  const last = Math.min(end, model.getLineCount());
  return [{
    range: new monaco.Range(Math.max(1, start), 1, last, model.getLineMaxColumn(last)),
    options: { isWholeLine: true, className: 'diff-jump-highlight', marginClassName: 'diff-jump-gutter', zIndex: 20 },
  }];
}

function minimapChangeDecorations(original: monaco.editor.ITextModel, model: monaco.editor.ITextModel, changes: monaco.editor.ILineChange[]): monaco.editor.IModelDeltaDecoration[] {
  return changes.map((change) => {
    const deleted = change.modifiedEndLineNumber === 0 || model.getValueLength() === 0;
    const added = change.originalEndLineNumber === 0 || original.getValueLength() === 0;
    const color = deleted ? '#CB7867' : added ? '#78A956' : '#5A91C5';
    const start = Math.min(model.getLineCount(), Math.max(1, change.modifiedStartLineNumber + Number(deleted)));
    const end = deleted ? start : Math.min(model.getLineCount(), change.modifiedEndLineNumber);
    return {
      range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)),
      options: {
        isWholeLine: true, showIfCollapsed: true,
        minimap: { color, position: monaco.editor.MinimapPosition.Gutter },
      },
    };
  });
}

type DiffViewSnapshot = {
  state: monaco.editor.IDiffEditorViewState | null;
  original: monaco.editor.INewScrollPosition;
  modified: monaco.editor.INewScrollPosition;
};

function restoreDiffView(instance: monaco.editor.IStandaloneDiffEditor, snapshot: DiffViewSnapshot) {
  if (snapshot.state) instance.restoreViewState(snapshot.state);
  instance.getOriginalEditor().setScrollPosition(snapshot.original, monaco.editor.ScrollType.Immediate);
  instance.getModifiedEditor().setScrollPosition(snapshot.modified, monaco.editor.ScrollType.Immediate);
}

export default function DiffView({ project, file, comparison, comparisonKey, source, loading, error, stagingDisabled, onToggleStage, commit }: {
  project: Project; file: ChangedFile | undefined; comparison: Comparison | null; comparisonKey: string; source: Comparison['source']; loading: boolean; error: string | null; stagingDisabled?: boolean; onToggleStage?: () => void; commit?: CommitDetail;
}) {
  const historical = source === 'commit';
  const wrapTooltipId = useId();
  const container = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [wrap, setWrap] = useState(false);
  const [changeCount, setChangeCount] = useState(0);
  const [diffReady, setDiffReady] = useState(false);
  const [activeChange, setActiveChange] = useState(0);
  const revealInitialChange = useRef(false);
  const comparisonModels = useRef<(monaco.editor.IDiffEditorModel & { key: string }) | null>(null);
  const pendingViewState = useRef<DiffViewSnapshot | null>(null);
  const restoreViewFrame = useRef(0);
  const jumpDecorations = useRef<{ original: monaco.editor.IEditorDecorationsCollection; modified: monaco.editor.IEditorDecorationsCollection } | null>(null);
  const jumpTimeout = useRef<number | null>(null);
  const revealingChange = useRef(false);

  const revealChange = useCallback((instance: monaco.editor.IStandaloneDiffEditor, changes: monaco.editor.ILineChange[], index: number) => {
    const change = changes[index];
    const models = instance.getModel();
    if (!change || !models) return;
    const deleted = change.modifiedEndLineNumber === 0;
    const codeEditor = deleted ? instance.getOriginalEditor() : instance.getModifiedEditor();
    const start = deleted ? change.originalStartLineNumber : change.modifiedStartLineNumber;
    const end = deleted ? change.originalEndLineNumber : change.modifiedEndLineNumber;
    revealingChange.current = true;
    try {
      instance.getModifiedEditor().setPosition({ lineNumber: Math.min(models.modified.getLineCount(), Math.max(1, change.modifiedStartLineNumber + Number(deleted))), column: 1 });
      codeEditor.revealRangeInCenter(new monaco.Range(start, 1, end, 1), monaco.editor.ScrollType.Immediate);
      setActiveChange(index + 1);
    } finally {
      revealingChange.current = false;
    }
  }, []);

  const clearJumpHighlight = useCallback(() => {
    if (jumpTimeout.current !== null) {
      window.clearTimeout(jumpTimeout.current);
      jumpTimeout.current = null;
    }
    jumpDecorations.current?.original.clear();
    jumpDecorations.current?.modified.clear();
  }, []);

  useEffect(() => {
    if (!container.current) return;
    const instance = monaco.editor.createDiffEditor(container.current, {
      theme: 'gitnest', readOnly: true, originalEditable: false,
      automaticLayout: true, renderSideBySide: true, useInlineViewWhenSpaceIsLimited: false,
      enableSplitViewResizing: false,
      fontFamily: '"SF Mono", Menlo, Consolas, monospace', fontSize: 12, lineHeight: 22,
      minimap: { enabled: false }, scrollBeyondLastLine: false,
      renderOverviewRuler: false, overviewRulerBorder: false, overviewRulerLanes: 0,
      lineNumbersMinChars: 3, glyphMargin: false, folding: false,
      renderLineHighlight: 'none', renderIndicators: false, ignoreTrimWhitespace: false,
      hideUnchangedRegions: { enabled: false }, padding: { top: 16, bottom: 24 },
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      originalAriaLabel: '最近已提交的完整文件', modifiedAriaLabel: '当前未提交的完整文件',
      stickyScroll: { enabled: false }, links: false, contextmenu: false,
    });
    editor.current = instance;
    const modifiedEditor = instance.getModifiedEditor();
    configureDiffEditors(instance);
    let layoutFrame = 0;
    const alignColumns = () => {
      const width = container.current?.clientWidth ?? 0;
      if (!width) return;
      const originalLayout = instance.getOriginalEditor().getLayoutInfo();
      const modifiedLayout = modifiedEditor.getLayoutInfo();
      const previewWidth = modifiedLayout.minimap.minimapWidth + modifiedLayout.verticalScrollbarWidth;
      const originalWidth = Math.floor((width - previewWidth) / 2);
      if (Math.abs(originalLayout.width - originalWidth) > 1) {
        instance.updateOptions({ splitViewDefaultRatio: originalWidth / width });
        configureDiffEditors(instance);
      }
      const layout = modifiedEditor.getLayoutInfo();
      labels.current?.style.setProperty('--diff-original-width', `${instance.getOriginalEditor().getLayoutInfo().width}px`);
      labels.current?.style.setProperty('--diff-minimap-width', `${layout.minimap.minimapWidth + layout.verticalScrollbarWidth}px`);
    };
    const layoutSubscription = modifiedEditor.onDidLayoutChange(() => {
      window.cancelAnimationFrame(layoutFrame);
      layoutFrame = window.requestAnimationFrame(alignColumns);
    });
    jumpDecorations.current = {
      original: instance.getOriginalEditor().createDecorationsCollection(),
      modified: instance.getModifiedEditor().createDecorationsCollection(),
    };
    const minimapDecorations = modifiedEditor.createDecorationsCollection();
    const disposeMinimapRuler = attachMinimapRuler(modifiedEditor);
    const updateActiveChange = (side: 'original' | 'modified', line: number) => {
      const changes = instance.getLineChanges() ?? [];
      const codeEditor = side === 'original' ? instance.getOriginalEditor() : instance.getModifiedEditor();
      const lineCount = codeEditor.getModel()?.getLineCount() ?? 1;
      setActiveChange(changeIndexAtLine(changes, side, line, lineCount) + 1);
    };
    const updateActiveChangeFromScroll = () => {
      setActiveChange(changeIndexAtScroll(instance.getLineChanges() ?? [], instance.getOriginalEditor(), modifiedEditor) + 1);
    };
    const cursorSubscriptions = [
      instance.getOriginalEditor().onDidChangeCursorPosition((event) => updateActiveChange('original', event.position.lineNumber)),
      instance.getModifiedEditor().onDidChangeCursorPosition((event) => updateActiveChange('modified', event.position.lineNumber)),
    ];
    const scrollSubscriptions = [instance.getOriginalEditor(), modifiedEditor].map((codeEditor) => codeEditor.onDidScrollChange((event) => {
      if (event.scrollTopChanged && !revealingChange.current && !pendingViewState.current) updateActiveChangeFromScroll();
    }));
    const subscription = instance.onDidUpdateDiff(() => {
      clearJumpHighlight();
      const changes = instance.getLineChanges();
      if (changes === null) return;
      const models = instance.getModel();
      minimapDecorations.set(models ? minimapChangeDecorations(models.original, models.modified, changes) : []);
      setChangeCount(changes.length);
      setDiffReady(true);
      if (pendingViewState.current) {
        const state = pendingViewState.current;
        window.cancelAnimationFrame(restoreViewFrame.current);
        restoreViewFrame.current = window.requestAnimationFrame(() => {
          restoreViewFrame.current = 0;
          pendingViewState.current = null;
          restoreDiffView(instance, state);
          updateActiveChangeFromScroll();
        });
      }
      if (revealInitialChange.current && changes.length > 0) {
        revealInitialChange.current = false;
        revealChange(instance, changes, 0);
      } else if (!pendingViewState.current) {
        updateActiveChangeFromScroll();
      }
    });
    return () => {
      window.cancelAnimationFrame(restoreViewFrame.current);
      disposeMinimapRuler();
      window.cancelAnimationFrame(layoutFrame);
      layoutSubscription.dispose();
      clearJumpHighlight();
      jumpDecorations.current = null;
      subscription.dispose();
      cursorSubscriptions.forEach((item) => item.dispose());
      scrollSubscriptions.forEach((item) => item.dispose());
      instance.setModel(null);
      comparisonModels.current?.original.dispose();
      comparisonModels.current?.modified.dispose();
      comparisonModels.current = null;
      pendingViewState.current = null;
      instance.dispose();
      editor.current = null;
    };
  }, [clearJumpHighlight, revealChange]);

  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    const current = comparisonModels.current;
    const refreshing = comparison?.kind === 'text' && current?.key === comparisonKey;
    if (refreshing && current.original.getValue() === comparison.original && current.modified.getValue() === comparison.modified) return;
    const originalEditor = instance.getOriginalEditor();
    const modifiedEditor = instance.getModifiedEditor();
    const viewState: DiffViewSnapshot | null = refreshing ? {
      state: instance.saveViewState(),
      original: { scrollTop: originalEditor.getScrollTop(), scrollLeft: originalEditor.getScrollLeft() },
      modified: { scrollTop: modifiedEditor.getScrollTop(), scrollLeft: modifiedEditor.getScrollLeft() },
    } : null;
    window.cancelAnimationFrame(restoreViewFrame.current);
    restoreViewFrame.current = 0;
    clearJumpHighlight();
    setChangeCount(0);
    setDiffReady(false);
    setActiveChange(0);
    pendingViewState.current = viewState;
    revealInitialChange.current = !refreshing;
    if (refreshing) {
      if (current.original.getValue() !== comparison.original) current.original.setValue(comparison.original);
      if (current.modified.getValue() !== comparison.modified) current.modified.setValue(comparison.modified);
    } else {
      instance.setModel(null);
      current?.original.dispose();
      current?.modified.dispose();
      comparisonModels.current = null;
      if (!comparison || comparison.kind !== 'text') return;
      const language = languageFor(comparison.path);
      const original = monaco.editor.createModel(comparison.original, language);
      const modified = monaco.editor.createModel(comparison.modified, language);
      comparisonModels.current = { key: comparisonKey, original, modified };
      instance.setModel({ original, modified });
    }
    configureDiffEditors(instance);
    originalEditor.updateOptions({ ariaLabel: historical ? '父提交中的完整文件' : '最近已提交的完整文件' });
    modifiedEditor.updateOptions({ ariaLabel: historical ? '所选提交中的完整文件' : comparison.source === 'staged' ? '已暂存的完整文件' : '当前工作区的完整文件' });
    if (viewState) restoreDiffView(instance, viewState);
  }, [comparison, comparisonKey, historical, clearJumpHighlight]);

  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    instance.updateOptions({ wordWrap: wrap ? 'on' : 'off' });
    configureDiffEditors(instance);
  }, [wrap]);

  const isText = comparison?.kind === 'text';
  const canNavigate = Boolean(isText && diffReady && !loading && !error && changeCount);
  const currentChange = canNavigate ? activeChange : 0;
  const totalChanges = canNavigate ? changeCount : 0;
  const navigateDiff = (direction: 'previous' | 'next') => {
    const instance = editor.current;
    const decorations = jumpDecorations.current;
    if (!instance || !decorations || !canNavigate || (direction === 'previous' ? currentChange <= 1 : currentChange >= totalChanges)) return;
    const models = instance.getModel();
    if (!models) return;
    const changes = instance.getLineChanges() ?? [];
    const target = currentChange - 1 + (direction === 'next' ? 1 : -1);
    const change = changes[target];
    clearJumpHighlight();
    if (!change) return;
    revealChange(instance, changes, target);
    decorations.original.set(jumpDecoration(models.original, change.originalStartLineNumber, change.originalEndLineNumber));
    decorations.modified.set(jumpDecoration(models.modified, change.modifiedStartLineNumber, change.modifiedEndLineNumber));
    jumpTimeout.current = window.setTimeout(clearJumpHighlight, 500);
  };
  return <section className="diff-panel" aria-label="文件对比">
    <div className="diff-toolbar">
      <span className="file-full-path" title={file?.path}>{file?.originalPath ? `${file.originalPath} → ${file.path}` : file?.path ?? '选择一个文件查看完整内容'}</span>
      <div className="diff-actions">
        {!historical && <><button className="button stage-current-button" disabled={stagingDisabled} aria-label={source === 'staged' ? '取消暂存当前文件' : '暂存当前文件'} onClick={onToggleStage}>{source === 'staged' ? <Minus size={14} /> : <Plus size={14} />}{source === 'staged' ? '取消暂存' : '暂存'}</button><span className="toolbar-divider" /></>}
        <span className="wrap-control">
          <button className={`icon-button ${wrap ? 'active' : ''}`} aria-pressed={wrap} aria-label="自动换行" aria-describedby={wrapTooltipId} onClick={() => setWrap(!wrap)}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 5h18M3 10h13a4 4 0 0 1 0 8h-4m3-3-3 3 3 3M3 15h4M3 20h4" /></svg>
          </button>
          <span className="toolbar-tooltip" id={wrapTooltipId} role="tooltip">自动换行</span>
        </span>
        <span className="toolbar-divider" />
        <button className="icon-button" title="上一处差异" aria-label="上一处差异" disabled={!canNavigate || currentChange <= 1} onClick={() => navigateDiff('previous')}><ArrowUp size={16} /></button>
        <span className="diff-position" role="status" aria-live="polite" aria-label={totalChanges ? `当前第 ${currentChange} 处差异，共 ${totalChanges} 处` : '没有可定位的差异'}>{currentChange}/{totalChanges}</span>
        <button className="icon-button" title="下一处差异" aria-label="下一处差异" disabled={!canNavigate || currentChange >= totalChanges} onClick={() => navigateDiff('next')}><ArrowDown size={16} /></button>
      </div>
    </div>
    <div ref={labels} className="comparison-labels">
      <div><span className="version-dot original" /><strong>{historical ? commit?.parent ? '父提交' : '提交前' : '最近已提交'}</strong><code>{historical ? commit?.parent?.slice(0, 7) ?? '空版本' : project.head?.slice(0, 7) ?? '尚无提交'}</code><span className="version-hint">{historical ? 'BEFORE' : 'HEAD'}</span></div>
      <div><span className="version-dot modified" /><strong>{historical ? '所选提交' : source === 'staged' ? '暂存区' : '当前工作区'}</strong>{historical ? <code>{commit?.shortId}</code> : <span className="uncommitted-label">{source === 'staged' ? '已暂存' : '未提交'}</span>}<span className="version-hint">{historical ? 'AFTER' : source === 'staged' ? 'INDEX' : 'WORKING TREE'}</span></div>
    </div>
    <div className="editor-area">
      <div ref={container} className={`monaco-container ${!isText || loading ? 'concealed' : ''}`} />
      {loading ? <div className="panel-placeholder"><span className="spinner" />正在读取完整文件…</div> : error ? <div className="panel-placeholder error"><FileDashed size={34} /><strong>无法读取文件</strong><p>{error}</p></div> : !file ? <div className="panel-placeholder"><Check size={38} weight="light" /><strong>{historical ? '这次提交没有文件变更' : '工作区很干净'}</strong><p>{historical ? '可以在上方选择其他提交，继续查看修改。' : '这个项目目前没有未提交的文件。'}</p></div> : comparison && !isText ? <div className="panel-placeholder"><FileDashed size={38} weight="light" /><strong>无法显示文本差异</strong><p>{comparison.message}</p></div> : null}
    </div>
    <div className="diff-footer"><span><span className="legend-dot deletion" />删除<span className="legend-dot addition" />新增<span className="legend-dot modification" />修改</span><span>{isText && diffReady ? changeCount ? `${changeCount} 处差异` : comparison.original !== comparison.modified ? '换行符或编码标记不同' : historical ? '与父提交内容相同' : '当前文件与 HEAD 内容相同' : '完整文件对比'}<span className="footer-dot">·</span>只读</span></div>
  </section>;
}
