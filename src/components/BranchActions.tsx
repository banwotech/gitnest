import { useEffect, useRef, useState } from 'react';
import { GitBranch, GitMerge, MagnifyingGlass, Plus, Trash, X } from '@phosphor-icons/react';
import type { Commit, GitAction, GitActionPayload, Project } from '../types';

function CommitPicker({ project, selected, onSelect, onError }: {
  project: Project;
  selected: Commit | null;
  onSelect: (commit: Commit | null) => void;
  onError: (message: string) => void;
}) {
  const [ref, setRef] = useState('');
  const [query, setQuery] = useState('');
  const [commits, setCommits] = useState<Commit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const sequence = useRef(0);

  useEffect(() => {
    const request = ++sequence.current;
    setLoading(true); setLoadingMore(false); setCommits([]); setHasMore(false); onSelect(null);
    const timer = window.setTimeout(() => {
      window.gitnest.readCommits(project.path, { ref, query }).then((page) => {
        if (request !== sequence.current) return;
        setCommits(page.commits); setHasMore(page.hasMore);
      }).catch((error) => { if (request === sequence.current) onError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (request === sequence.current) setLoading(false); });
    }, 180);
    return () => { window.clearTimeout(timer); sequence.current++; };
  }, [project.path, project.head, ref, query, onSelect, onError]);

  const loadMore = async () => {
    const request = sequence.current;
    setLoadingMore(true);
    try {
      const page = await window.gitnest.readCommits(project.path, { ref, query, offset: commits.length });
      if (request === sequence.current) { setCommits((previous) => [...previous, ...page.commits.filter((commit) => !previous.some((item) => item.id === commit.id))]); setHasMore(page.hasMore); }
    } catch (error) { if (request === sequence.current) onError(error instanceof Error ? error.message : String(error)); }
    finally { if (request === sequence.current) setLoadingMore(false); }
  };

  return <div className="commit-picker">
    <div className="commit-filters">
      <select aria-label="筛选提交所在分支" value={ref} onChange={(event) => setRef(event.target.value)}>
        <option value="">全部分支</option>
        {(project.branches ?? []).map((branch) => <option key={branch.ref} value={branch.ref}>{branch.remote ? `${branch.remote}/` : ''}{branch.name}</option>)}
      </select>
      <label className="commit-search"><MagnifyingGlass size={15} /><input aria-label="搜索提交说明" placeholder="搜索提交说明…" maxLength={300} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </div>
    <div className="commit-options" role="listbox" aria-label="选择要合并的提交" aria-busy={loading}>
      {loading ? <p className="commit-list-empty">正在读取提交…</p> : commits.length ? commits.map((commit) => <button type="button" role="option" aria-selected={selected?.id === commit.id} className={`commit-option ${selected?.id === commit.id ? 'selected' : ''}`} key={commit.id} onClick={() => onSelect(commit)} title={`${commit.subject}\n${commit.id}\n${commit.refs}`}>
        <div><strong>{commit.subject}</strong><time dateTime={commit.date}>{new Date(commit.date).toLocaleDateString('zh-CN')}</time></div>
        <div><code>{commit.shortId}</code><span>{commit.author}</span>{commit.refs && <span className="commit-refs">{commit.refs}</span>}</div>
      </button>) : <p className="commit-list-empty">没有匹配的提交</p>}
    </div>
    {hasMore && <button type="button" className="load-commits" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '正在读取…' : '加载更多提交'}</button>}
  </div>;
}

export default function BranchActions({ project, busy, pending, onAction, onError }: {
  project: Project;
  busy: boolean;
  pending: GitAction | null;
  onAction: (action: GitAction, payload?: GitActionPayload) => Promise<boolean>;
  onError: (message: string) => void;
}) {
  const [panel, setPanel] = useState<'new' | 'delete' | 'merge' | null>(null);
  const [name, setName] = useState('');
  const [checkout, setCheckout] = useState(true);
  const [deleteRef, setDeleteRef] = useState('');
  const [force, setForce] = useState(false);
  const [selected, setSelected] = useState<Commit | null>(null);
  const [noFastForward, setNoFastForward] = useState(false);
  const [mergeBase, setMergeBase] = useState({ head: '', branch: '' });
  const dialog = useRef<HTMLDialogElement>(null);
  const hasConflicts = project.files.some((file) => file.kind === 'conflict');
  const hasTrackedChanges = project.files.some((file) => file.staged || (file.unstaged && file.kind !== 'untracked'));
  const unavailable = busy || typeof window.gitnest?.createBranch !== 'function';
  const branchDisabled = unavailable || !project.head || project.mergeInProgress || hasConflicts;
  const localBranches = (project.branches ?? []).filter((branch) => !branch.remote);
  const deleting = localBranches.find((branch) => branch.ref === deleteRef);
  const canDelete = deleting && deleting.name !== project.branchName && !deleting.checkedOutElsewhere;

  useEffect(() => {
    if (!dialog.current) return;
    if (panel) {
      if (!dialog.current.open) dialog.current.showModal();
      dialog.current.querySelector<HTMLInputElement>('input:not([type="checkbox"])')?.focus();
    } else dialog.current.close();
  }, [panel]);

  const close = () => { if (!busy) setPanel(null); };
  const submit = async () => {
    if (unavailable) return;
    let success = false;
    if (panel === 'new') success = await onAction('createBranch', { name: name.trim(), checkout });
    else if (panel === 'delete' && canDelete) success = await onAction('deleteBranch', { branch: deleteRef, force });
    else if (panel === 'merge' && selected && !hasTrackedChanges) success = await onAction('merge', { commit: selected.id, expectedHead: mergeBase.head, branch: mergeBase.branch, noFastForward });
    if (success) { setPanel(null); setName(''); setForce(false); setDeleteRef(''); }
  };

  return <>
    <div className="branch-toolbar" aria-label="分支与合并操作">
      <button className="button" disabled={Boolean(branchDisabled)} onClick={() => setPanel('new')}><GitBranch size={16} />分支</button>
      <button className={`button ${project.mergeInProgress ? 'merge-active' : ''}`} disabled={unavailable || (!project.mergeInProgress && (!project.head || !project.branchName || hasConflicts))} onClick={() => { setMergeBase({ head: project.head ?? '', branch: project.branchName ?? '' }); setSelected(null); setPanel('merge'); }}><GitMerge size={16} />{project.mergeInProgress ? '合并中' : '合并'}</button>
    </div>
    <dialog className={`repository-dialog ${panel === 'merge' && !project.mergeInProgress ? 'merge-dialog' : ''}`} ref={dialog} aria-labelledby="repository-dialog-title" onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      {panel && <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="repository-dialog-heading"><h2 id="repository-dialog-title">{panel === 'merge' ? (project.mergeInProgress ? '完成合并' : '合并提交') : '分支管理'}</h2><button type="button" className="icon-button" aria-label="关闭操作弹窗" disabled={busy} onClick={close}><X size={18} /></button></div>
        <p className="repository-dialog-context">{project.name} · {panel === 'merge' && !project.mergeInProgress ? `合并到 ${mergeBase.branch}` : `当前分支 ${project.branch}`}</p>
        {panel !== 'merge' ? <>
          <div className="branch-tabs" role="tablist" aria-label="分支操作">
            <button type="button" role="tab" aria-selected={panel === 'new'} disabled={busy} onClick={() => setPanel('new')}>新建分支</button>
            <button type="button" role="tab" aria-selected={panel === 'delete'} disabled={busy} onClick={() => setPanel('delete')}>删除分支</button>
          </div>
          {panel === 'new' ? <div className="branch-form">
            <label className="dialog-field">分支名称<input aria-label="新分支名称" placeholder="如 feature/new-feature" maxLength={1024} required value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
            <p className="dialog-note">从当前提交 {project.head?.slice(0, 7)} 创建</p>
            <label className="dialog-checkbox"><input type="checkbox" checked={checkout} disabled={busy} onChange={(event) => setCheckout(event.target.checked)} />创建后切换到新分支</label>
          </div> : <div className="branch-form">
            <label className="dialog-field">本地分支<select aria-label="选择要删除的本地分支" value={deleteRef} disabled={busy} onChange={(event) => { setDeleteRef(event.target.value); setForce(false); }}>
              <option value="" disabled>选择分支</option>
              {localBranches.map((branch) => <option key={branch.ref} value={branch.ref} disabled={branch.name === project.branchName || branch.checkedOutElsewhere}>{branch.name}{branch.name === project.branchName ? '（当前分支）' : branch.checkedOutElsewhere ? '（其他工作区使用中）' : ''}</option>)}
            </select></label>
            <p className="dialog-note">仅删除本地分支，远程分支保留。</p>
            <label className="dialog-checkbox"><input type="checkbox" checked={force} disabled={busy} onChange={(event) => setForce(event.target.checked)} />强制删除未合并分支</label>
          </div>}
          <div className="repository-dialog-footer"><button className="button" type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className={`button ${panel === 'delete' ? 'danger' : 'primary'}`} disabled={Boolean(branchDisabled) || (panel === 'new' ? !name.trim() : !canDelete)}>{panel === 'new' ? <Plus size={16} /> : <Trash size={16} />}{pending === 'createBranch' ? '创建中…' : pending === 'deleteBranch' ? '删除中…' : panel === 'new' ? '创建分支' : '删除分支'}</button></div>
        </> : project.mergeInProgress ? <>
          <p className="merge-state">{hasConflicts ? '合并存在冲突。请在文件中解决冲突，暂存后点击右上角「提交」。' : '合并尚未提交。可点击右上角「提交」完成合并。'}</p>
          <div className="repository-dialog-footer"><button type="button" className="button" disabled={busy} onClick={close}>关闭</button><button type="button" className="button danger" disabled={unavailable} onClick={async () => { if (await onAction('abortMerge')) setPanel(null); }}>{pending === 'abortMerge' ? '正在中止…' : '中止合并'}</button></div>
        </> : <>
          <CommitPicker project={project} selected={selected} onSelect={setSelected} onError={onError} />
          <label className="dialog-checkbox"><input type="checkbox" checked={noFastForward} disabled={busy} onChange={(event) => setNoFastForward(event.target.checked)} />即使可以快进，也创建合并提交</label>
          {hasTrackedChanges && <p className="dialog-note">当前有未提交的文件修改，处理后即可合并。</p>}
          <div className="repository-dialog-footer"><span className="merge-selection">{selected ? <><code>{selected.shortId}</code> → {mergeBase.branch}</> : '选择一个提交'}</span><button type="button" className="button" disabled={busy} onClick={close}>取消</button><button type="submit" className="button primary" disabled={unavailable || !selected || hasTrackedChanges || hasConflicts}><GitMerge size={16} />{pending === 'merge' ? '合并中…' : '合并'}</button></div>
        </>}
      </form>}
    </dialog>
  </>;
}
