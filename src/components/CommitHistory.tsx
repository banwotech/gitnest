import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretDown, Copy, GitCommit, MagnifyingGlass, X } from '@phosphor-icons/react';
import type { Commit, CommitDetail, Comparison, Project } from '../types';
import DiffView from './DiffView';
import FileIcon from './FileIcon';
import ResizableSplit from './ResizableSplit';

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const dateLabel = (date: string) => new Date(date).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const statusLetter = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M', untracked: 'U', conflict: '!' };
const statusLabel = { added: '新增', deleted: '删除', renamed: '重命名', modified: '修改', untracked: '未跟踪', conflict: '冲突' };

export default function CommitHistory({ project, active, controlsHost, onError }: { project: Project; active: boolean; controlsHost: HTMLDivElement | null; onError: (message: string) => void }) {
  const [ref, setRef] = useState(project.branchName ? `refs/heads/${project.branchName}` : '');
  const [query, setQuery] = useState('');
  const [commits, setCommits] = useState<Commit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState<{ commit: Commit; parent?: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileQuery, setFileQuery] = useState('');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sequence = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!active || !pickerOpen) { element?.close(); return; }
    if (element && !element.open) element.showModal();
    searchInput.current?.focus();
    return () => element?.close();
  }, [active, pickerOpen]);

  useEffect(() => { if (!active) setPickerOpen(false); }, [active]);

  useEffect(() => {
    const request = ++sequence.current;
    setLoading(true); setLoadingMore(false); setListError(null);
    const timer = window.setTimeout(() => {
      window.gitnest.readCommits(project.path, { ref, query }).then((page) => {
        if (request !== sequence.current) return;
        setCommits(page.commits); setHasMore(page.hasMore);
        if (!query.trim()) setSelection((current) => current ?? (page.commits[0] ? { commit: page.commits[0] } : null));
      }).catch((error) => { if (request === sequence.current) setListError(messageOf(error)); })
        .finally(() => { if (request === sequence.current) setLoading(false); });
    }, 180);
    return () => { window.clearTimeout(timer); sequence.current++; };
  }, [project.path, project.head, ref, query, reload]);

  useEffect(() => {
    if (!selection) { setDetail(null); setDetailError(null); setDetailLoading(false); return; }
    let canceled = false;
    setDetailLoading(true); setDetailError(null); setCopied(false);
    window.gitnest.readCommitDetail(project.path, selection.commit.id, selection.parent).then((next) => {
      if (canceled) return;
      setDetail(next);
      setSelectedFile((current) => next.files.some((file) => file.path === current) ? current : next.files[0]?.path ?? null);
      setFileQuery('');
    }).catch((error) => { if (!canceled) { setDetail(null); setDetailError(messageOf(error)); } })
      .finally(() => { if (!canceled) setDetailLoading(false); });
    return () => { canceled = true; };
  }, [project.path, selection, reload]);

  const currentDetail = detail && detail.id === selection?.commit.id && (selection?.parent === undefined || detail.parent === selection.parent) ? detail : null;
  const file = currentDetail?.files.find((item) => item.path === selectedFile);
  useEffect(() => {
    if (!currentDetail || !file) { setComparison(null); setComparing(false); return; }
    let canceled = false;
    setComparing(true); setComparison(null); setComparisonError(null);
    window.gitnest.compareCommit(project.path, currentDetail.id, file.path, currentDetail.parent).then((next) => {
      if (!canceled) setComparison(next);
    }).catch((error) => { if (!canceled) setComparisonError(messageOf(error)); })
      .finally(() => { if (!canceled) setComparing(false); });
    return () => { canceled = true; };
  }, [project.path, currentDetail, file]);

  const loadMore = async () => {
    if (loadingMore || loading) return;
    const request = sequence.current;
    setLoadingMore(true);
    try {
      const page = await window.gitnest.readCommits(project.path, { ref, query, offset: commits.length });
      if (request === sequence.current) {
        setCommits((previous) => [...previous, ...page.commits.filter((commit) => !previous.some((item) => item.id === commit.id))]);
        setHasMore(page.hasMore);
      }
    } catch (error) { if (request === sequence.current) onError(messageOf(error)); }
    finally { if (request === sequence.current) setLoadingMore(false); }
  };
  const copyHash = async () => {
    if (!currentDetail) return;
    try { await navigator.clipboard.writeText(currentDetail.id); setCopied(true); }
    catch (error) { onError(`无法复制提交 Hash：${messageOf(error)}`); }
  };
  const branches = project.branches ?? [];
  const visibleFiles = currentDetail?.files.filter((item) => item.path.toLowerCase().includes(fileQuery.toLowerCase())) ?? [];

  return <>
    {controlsHost && createPortal(<>
        <select aria-label="筛选历史记录分支" value={ref} onChange={(event) => { setRef(event.target.value); setQuery(''); setSelection(null); }}>
          <option value="">全部分支</option>
          {ref && !branches.some((branch) => branch.ref === ref) && <option value={ref} disabled>分支已不存在</option>}
          {branches.map((branch) => <option key={branch.ref} value={branch.ref}>{branch.remote ? `${branch.remote}/` : ''}{branch.name}</option>)}
        </select>
        <button className="history-commit-trigger" aria-label={selection ? `选择提交记录：${selection.commit.subject}` : '选择提交记录'} aria-haspopup="dialog" aria-expanded={pickerOpen} aria-controls="history-commit-picker" onClick={() => { setQuery(''); setPickerOpen(true); }} title={selection ? `${selection.commit.shortId} · ${selection.commit.subject}` : undefined}>
          {selection && <code>{selection.commit.shortId}</code>}<span>{selection?.commit.subject ?? (loading ? '正在读取提交…' : '选择提交记录')}</span><CaretDown size={13} />
        </button>
    </>, controlsHost)}
    <section className="commit-detail" aria-label="历史提交详情" aria-busy={detailLoading}>
      {detailLoading ? <div className="history-detail-placeholder"><span className="spinner" />正在读取提交详情…</div> : detailError ? <div className="history-detail-placeholder" role="alert"><p>{detailError}</p><button className="button" onClick={() => setReload((value) => value + 1)}>重试</button></div> : currentDetail ? <>
        <header className="history-detail-heading">
          <div className="history-subject-row"><h2 title={currentDetail.subject}>{currentDetail.subject}</h2><button className="history-copy" onClick={() => void copyHash()} title={currentDetail.id} aria-label="复制提交 Hash"><Copy size={13} /><code>{currentDetail.shortId}</code><span aria-live="polite">{copied ? '已复制' : ''}</span></button></div>
          <div className="history-detail-meta"><span>{currentDetail.author}</span><time dateTime={currentDetail.date}>{dateLabel(currentDetail.date)}</time><span>{currentDetail.files.length} 个文件</span><span className="history-additions">+{currentDetail.additions}</span><span className="history-deletions">−{currentDetail.deletions}</span>
            {currentDetail.parents.length > 1 ? <label className="history-parent">对比父提交<select aria-label="选择对比的父提交" value={currentDetail.parent ?? ''} onChange={(event) => { const parent = event.target.value; setSelection((current) => current ? { ...current, parent } : null); }}>{currentDetail.parents.map((parent, index) => <option key={parent} value={parent}>父提交 {index + 1} · {parent.slice(0, 7)}</option>)}</select></label> : <span>对比 {currentDetail.parent ? `父提交 ${currentDetail.parent.slice(0, 7)}` : '空版本（首次提交）'}</span>}
          </div>
          {currentDetail.message !== currentDetail.subject && <details className="history-message"><summary>完整提交说明</summary><pre>{currentDetail.message}</pre></details>}
        </header>
        <ResizableSplit className="repository-layout" direction="vertical" label="调整历史文件列表宽度" initialSize={268} minFirst={200} minSecond={400}>
          <section className="changes-panel" aria-label="本次提交的变更文件">
            <label className="search-box"><MagnifyingGlass size={16} /><input aria-label="搜索提交中的文件" placeholder="搜索变更文件…" value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} /></label>
            <div className="file-group-heading"><strong>变更文件<span>{fileQuery ? `${visibleFiles.length}/${currentDetail.files.length}` : currentDetail.files.length}</span></strong></div>
            <div className="file-list" role="list" aria-label="提交变更文件列表">
              {visibleFiles.map((item) => <div className={`file-row ${item.path === selectedFile ? 'selected' : ''}`} role="listitem" key={item.path}>
                <button className="file-select" aria-pressed={item.path === selectedFile} onClick={() => setSelectedFile(item.path)} title={`${item.originalPath ? `${item.originalPath} → ` : ''}${item.path}\n${statusLabel[item.kind]}`}>
                  <FileIcon path={item.path} /><span className="file-row-text"><strong>{item.path.split('/').pop()}</strong><small>{item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '根目录'}</small></span><span className="history-file-stats">{item.additions === null ? '二进制' : `+${item.additions} −${item.deletions}`}</span><span className={`file-status status-${item.kind}`} aria-label={statusLabel[item.kind]}>{statusLetter[item.kind]}</span>
                </button>
              </div>)}
              {!visibleFiles.length && <div className="files-empty">{fileQuery ? '没有匹配的文件' : '没有文件变更'}</div>}
            </div>
          </section>
          <DiffView project={project} file={file} comparison={comparison} comparisonKey={JSON.stringify([project.path, currentDetail.id, currentDetail.parent, file?.path])} source="commit" commit={currentDetail} loading={comparing} error={comparisonError} />
        </ResizableSplit>
      </> : <div className="history-detail-placeholder"><GitCommit size={32} weight="light" /><p>{listError ?? (loading ? '正在读取提交记录…' : '点击右上角选择框，选择提交记录')}</p></div>}
    </section>
    <dialog ref={dialog} id="history-commit-picker" className="repository-dialog history-picker-dialog" aria-labelledby="history-picker-title" onCancel={(event) => { event.preventDefault(); setPickerOpen(false); }} onClick={(event) => { if (event.target === event.currentTarget) setPickerOpen(false); }}>
      <div className="repository-dialog-heading"><h2 id="history-picker-title">选择提交记录</h2><button className="icon-button" aria-label="关闭提交记录选择" onClick={() => setPickerOpen(false)}><X size={18} /></button></div>
      <p className="history-picker-context">{project.name} · {branches.find((branch) => branch.ref === ref)?.name ?? '全部分支'}</p>
      <div className="history-picker-filters"><label className="commit-search"><MagnifyingGlass size={15} /><input ref={searchInput} aria-label="搜索历史提交说明" placeholder="搜索提交说明…" maxLength={300} value={query} onChange={(event) => setQuery(event.target.value)} /></label><span className="history-loaded-count">已加载 {commits.length} 条</span></div>
      <div className="history-commits" aria-busy={loading}>
        {loading ? <p className="history-list-message">正在读取提交记录…</p> : listError ? <div className="history-list-message" role="alert">{listError}<button className="button" onClick={() => setReload((value) => value + 1)}>重试</button></div> : <table className="history-table" aria-label="历史提交">
          <colgroup><col className="history-icon-column" /><col /><col className="history-hash-column" /><col className="history-author-column" /><col className="history-date-column" /></colgroup>
          <thead><tr><th scope="col" aria-label="提交" /><th scope="col">提交说明</th><th scope="col">Hash</th><th scope="col">作者</th><th scope="col">提交时间</th></tr></thead>
          <tbody>{commits.length ? commits.map((commit) => <tr className={`history-commit ${selection?.commit.id === commit.id ? 'selected' : ''}`} key={commit.id} onClick={() => { if (selection?.commit.id !== commit.id) setSelection({ commit }); setPickerOpen(false); }}>
            <td><GitCommit size={16} aria-hidden="true" /></td><td><button className="history-commit-select" aria-pressed={selection?.commit.id === commit.id} title={`${commit.subject}\n${commit.id}\n${commit.refs}`}><span className="history-commit-subject">{commit.subject}{commit.refs && <small>{commit.refs}</small>}</span></button></td><td><code>{commit.shortId}</code></td><td className="history-commit-author">{commit.author}</td><td><time dateTime={commit.date}>{dateLabel(commit.date)}</time></td>
          </tr>) : <tr><td colSpan={5}><p className="history-list-message">{query ? '没有匹配的提交' : '这个分支还没有提交记录'}</p></td></tr>}</tbody>
        </table>}
        {!loading && !listError && hasMore && <button className="load-commits" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '正在读取…' : '加载更多提交'}</button>}
      </div>
    </dialog>
  </>;
}
