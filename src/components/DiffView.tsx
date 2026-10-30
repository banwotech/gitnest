import { useCallback, useEffect, useRef, useState } from 'react';
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
import type { ChangedFile, Comparison, Project } from '../types';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.editor.defineTheme('gitnest', {
  base: 'vs', inherit: true, rules: [{ token: 'comment', foreground: '92958C', fontStyle: 'italic' }],
  colors: {
    'editor.background': '#FFFFFF', 'editor.foreground': '#363A36',
    'editorLineNumber.foreground': '#B3B6AE', 'editorLineNumber.activeForeground': '#6B7368',
    'editorGutter.background': '#FFFFFF', 'editor.selectionBackground': '#B8D7F2',
    'editor.inactiveSelectionBackground': '#8DB4D666',
    'diffEditor.insertedTextBackground': '#B8DEAA66', 'diffEditor.removedTextBackground': '#EFB6AC66',
    'diffEditor.insertedLineBackground': '#87CA6C26', 'diffEditor.removedLineBackground': '#F29A7F26',
    'diffEditor.diagonalFill': '#ECEEE8', 'diffEditor.border': '#E9EBE4',
    'scrollbarSlider.background': '#A8ADA333', 'scrollbarSlider.hoverBackground': '#A8ADA366',
  },
});

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
    options: { isWholeLine: true, className: 'diff-jump-highlight', zIndex: 20 },
  }];
}

export default function DiffView({ project, file, comparison, source, loading, error, stagingDisabled, onToggleStage }: {
  project: Project; file: ChangedFile | undefined; comparison: Comparison | null; source: Comparison['source']; loading: boolean; error: string | null; stagingDisabled: boolean; onToggleStage: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [wrap, setWrap] = useState(false);
  const [changeCount, setChangeCount] = useState(0);
  const [diffReady, setDiffReady] = useState(false);
  const [activeChange, setActiveChange] = useState(0);
  const revealInitialChange = useRef(false);
  const jumpDecorations = useRef<{ original: monaco.editor.IEditorDecorationsCollection; modified: monaco.editor.IEditorDecorationsCollection } | null>(null);
  const jumpTimeout = useRef<number | null>(null);

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
      fontFamily: '"SF Mono", Menlo, Consolas, monospace', fontSize: 12, lineHeight: 22,
      minimap: { enabled: false }, scrollBeyondLastLine: false,
      renderOverviewRuler: false, overviewRulerBorder: false,
      lineNumbersMinChars: 3, glyphMargin: false, folding: false,
      renderLineHighlight: 'none', renderIndicators: true, ignoreTrimWhitespace: false,
      hideUnchangedRegions: { enabled: false }, padding: { top: 16, bottom: 24 },
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      originalAriaLabel: '最近已提交的完整文件', modifiedAriaLabel: '当前未提交的完整文件',
      stickyScroll: { enabled: false }, links: false, contextmenu: false,
    });
    editor.current = instance;
    jumpDecorations.current = {
      original: instance.getOriginalEditor().createDecorationsCollection(),
      modified: instance.getModifiedEditor().createDecorationsCollection(),
    };
    const updateActiveChange = (side: 'original' | 'modified', line: number) => {
      const changes = instance.getLineChanges() ?? [];
      const codeEditor = side === 'original' ? instance.getOriginalEditor() : instance.getModifiedEditor();
      const lineCount = codeEditor.getModel()?.getLineCount() ?? 1;
      setActiveChange(changeIndexAtLine(changes, side, line, lineCount) + 1);
    };
    const cursorSubscriptions = [
      instance.getOriginalEditor().onDidChangeCursorPosition((event) => updateActiveChange('original', event.position.lineNumber)),
      instance.getModifiedEditor().onDidChangeCursorPosition((event) => updateActiveChange('modified', event.position.lineNumber)),
    ];
    const subscription = instance.onDidUpdateDiff(() => {
      clearJumpHighlight();
      const changes = instance.getLineChanges() ?? [];
      setChangeCount(changes.length);
      updateActiveChange('modified', instance.getModifiedEditor().getPosition()?.lineNumber ?? 1);
      setDiffReady(true);
      if (revealInitialChange.current && changes.length > 0) {
        revealInitialChange.current = false;
        instance.revealFirstDiff();
      }
    });
    return () => { clearJumpHighlight(); jumpDecorations.current = null; subscription.dispose(); cursorSubscriptions.forEach((item) => item.dispose()); instance.setModel(null); instance.dispose(); editor.current = null; };
  }, [clearJumpHighlight]);

  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    clearJumpHighlight();
    setChangeCount(0);
    setDiffReady(false);
    setActiveChange(0);
    revealInitialChange.current = true;
    if (!comparison || comparison.kind !== 'text') { instance.setModel(null); return; }
    const language = languageFor(comparison.path);
    const original = monaco.editor.createModel(comparison.original, language);
    const modified = monaco.editor.createModel(comparison.modified, language);
    instance.getModifiedEditor().updateOptions({ ariaLabel: comparison.source === 'staged' ? '已暂存的完整文件' : '当前工作区的完整文件' });
    instance.setModel({ original, modified });
    return () => { clearJumpHighlight(); if (editor.current === instance) instance.setModel(null); original.dispose(); modified.dispose(); };
  }, [comparison, clearJumpHighlight]);

  useEffect(() => {
    editor.current?.updateOptions({ wordWrap: wrap ? 'on' : 'off' });
  }, [wrap]);

  const isText = comparison?.kind === 'text';
  const canNavigate = Boolean(isText && diffReady && !loading && !error && changeCount);
  const currentChange = canNavigate ? activeChange : 0;
  const totalChanges = canNavigate ? changeCount : 0;
  const navigateDiff = (direction: 'previous' | 'next') => {
    const instance = editor.current;
    const decorations = jumpDecorations.current;
    if (!instance || !decorations || !canNavigate || (direction === 'previous' ? currentChange <= 1 : currentChange >= totalChanges)) return;
    instance.goToDiff(direction);
    const models = instance.getModel();
    if (!models) return;
    const changes = instance.getLineChanges() ?? [];
    const line = instance.getModifiedEditor().getPosition()?.lineNumber ?? 1;
    const change = changes[changeIndexAtLine(changes, 'modified', line, models.modified.getLineCount())];
    clearJumpHighlight();
    if (!change) return;
    decorations.original.set(jumpDecoration(models.original, change.originalStartLineNumber, change.originalEndLineNumber));
    decorations.modified.set(jumpDecoration(models.modified, change.modifiedStartLineNumber, change.modifiedEndLineNumber));
    jumpTimeout.current = window.setTimeout(clearJumpHighlight, 1000);
  };
  return <section className="diff-panel" aria-label="文件对比">
    <div className="diff-toolbar">
      <span className="file-full-path" title={file?.path}>{file?.originalPath ? `${file.originalPath} → ${file.path}` : file?.path ?? '选择一个文件查看完整内容'}</span>
      <div className="diff-actions">
        <button className="button stage-current-button" disabled={stagingDisabled} aria-label={source === 'staged' ? '取消暂存当前文件' : '暂存当前文件'} onClick={onToggleStage}>{source === 'staged' ? <Minus size={14} /> : <Plus size={14} />}{source === 'staged' ? '取消暂存' : '暂存'}</button>
        <span className="toolbar-divider" />
        <span className="wrap-control">
          <button className={`icon-button ${wrap ? 'active' : ''}`} aria-pressed={wrap} aria-label="自动换行" aria-describedby="word-wrap-tooltip" onClick={() => setWrap(!wrap)}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 5h18M3 10h13a4 4 0 0 1 0 8h-4m3-3-3 3 3 3M3 15h4M3 20h4" /></svg>
          </button>
          <span className="toolbar-tooltip" id="word-wrap-tooltip" role="tooltip">自动换行</span>
        </span>
        <span className="toolbar-divider" />
        <button className="icon-button" title="上一处差异" aria-label="上一处差异" disabled={!canNavigate || currentChange <= 1} onClick={() => navigateDiff('previous')}><ArrowUp size={16} /></button>
        <span className="diff-position" role="status" aria-live="polite" aria-label={totalChanges ? `当前第 ${currentChange} 处差异，共 ${totalChanges} 处` : '没有可定位的差异'}>{currentChange}/{totalChanges}</span>
        <button className="icon-button" title="下一处差异" aria-label="下一处差异" disabled={!canNavigate || currentChange >= totalChanges} onClick={() => navigateDiff('next')}><ArrowDown size={16} /></button>
      </div>
    </div>
    <div className="comparison-labels">
      <div><span className="version-dot original" /><strong>最近已提交</strong><code>{project.head?.slice(0, 7) ?? '尚无提交'}</code><span className="version-hint">HEAD</span></div>
      <div><span className="version-dot modified" /><strong>{source === 'staged' ? '暂存区' : '当前工作区'}</strong><span className="uncommitted-label">{source === 'staged' ? '已暂存' : '未提交'}</span><span className="version-hint">{source === 'staged' ? 'INDEX' : 'WORKING TREE'}</span></div>
    </div>
    <div className="editor-area">
      <div ref={container} className={`monaco-container ${!isText || loading ? 'concealed' : ''}`} />
      {loading ? <div className="panel-placeholder"><span className="spinner" />正在读取完整文件…</div> : error ? <div className="panel-placeholder error"><FileDashed size={34} /><strong>无法读取文件</strong><p>{error}</p></div> : !file ? <div className="panel-placeholder"><Check size={38} weight="light" /><strong>工作区很干净</strong><p>这个项目目前没有未提交的文件。</p></div> : comparison && !isText ? <div className="panel-placeholder"><FileDashed size={38} weight="light" /><strong>无法显示文本差异</strong><p>{comparison.message}</p></div> : null}
    </div>
    <div className="diff-footer"><span><span className="legend-dot deletion" />删除<span className="legend-dot addition" />新增</span><span>{isText && diffReady ? changeCount ? `${changeCount} 处差异` : comparison.original !== comparison.modified ? '换行符或编码标记不同' : '当前文件与 HEAD 内容相同' : '完整文件对比'}<span className="footer-dot">·</span>只读</span></div>
  </section>;
}
