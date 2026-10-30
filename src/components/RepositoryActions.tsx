import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GitCommit, X } from '@phosphor-icons/react';
import { isFileInSection } from '../fileStatus';
import type { GitAction, GitActionPayload, Project } from '../types';

export default function RepositoryActions({ project, busy, pending, message, onMessageChange, onAction }: {
  project: Project;
  busy: boolean;
  pending: GitAction | null;
  message: string;
  onMessageChange: (message: string) => void;
  onAction: (action: GitAction, payload?: GitActionPayload) => Promise<boolean>;
}) {
  const remotes = project.remotes ?? [];
  const defaultRemote = project.upstreamRemote ?? (remotes.includes('origin') ? 'origin' : remotes[0] ?? '');
  const [remote, setRemote] = useState(defaultRemote);
  const [commitOpen, setCommitOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!remotes.includes(remote)) setRemote(defaultRemote); }, [remote, defaultRemote, remotes.join('\0')]);
  useEffect(() => {
    if (!commitOpen) return;
    textarea.current?.focus();
    const onPointer = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setCommitOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setCommitOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [commitOpen]);
  const unavailable = busy || typeof window.gitnest?.stage !== 'function';
  const stagedCount = project.files.filter((file) => isFileInSection(file, 'staged')).length;
  const hasConflicts = project.files.some((file) => file.kind === 'conflict');
  const remoteReady = !unavailable && Boolean(remote && project.branchName);
  const branches = project.branches ?? [];
  const localBranches = branches.filter((branch) => !branch.remote);
  const localNames = new Set(localBranches.map((branch) => branch.name));
  const remoteBranches = branches.filter((branch) => branch.remote === remote && !localNames.has(branch.name));
  const currentBranch = project.branchName ? `refs/heads/${project.branchName}` : '';

  return <div className="repository-toolbar" ref={root} aria-label="仓库操作">
    <select aria-label="远程仓库" title="选择拉取和推送的远程仓库" value={remote} disabled={unavailable || !remotes.length} onChange={(event) => setRemote(event.target.value)}>
      {!remotes.length && <option value="">未配置远程</option>}
      {remotes.map((name) => <option key={name} value={name}>{name}</option>)}
    </select>
    <select className="branch-select" aria-label="切换分支" title={pending === 'switch' ? '正在切换分支…' : `当前分支：${project.branch ?? '尚无分支'}`} value={currentBranch} disabled={unavailable || hasConflicts || project.mergeInProgress || !branches.length || typeof window.gitnest?.switchBranch !== 'function'} onChange={(event) => { if (event.target.value !== currentBranch) { setCommitOpen(false); void onAction('switch', { branch: event.target.value }); } }}>
      {!localBranches.some((branch) => branch.ref === currentBranch) && <option value={currentBranch} disabled>{project.branch ?? '尚无分支'}{!project.head ? '（尚无提交）' : ''}</option>}
      {localBranches.length > 0 && <optgroup label="本地分支">{localBranches.map((branch) => <option key={branch.ref} value={branch.ref} disabled={branch.checkedOutElsewhere}>{pending === 'switch' && branch.ref === currentBranch ? '切换中…' : branch.name}{branch.checkedOutElsewhere ? '（其他工作区使用中）' : ''}</option>)}</optgroup>}
      {remoteBranches.length > 0 && <optgroup label={`${remote} · 远程分支`}>{remoteBranches.map((branch) => <option key={branch.ref} value={branch.ref}>{branch.remote}/{branch.name}</option>)}</optgroup>}
    </select>
    <button className="button" disabled={!remoteReady} onClick={() => void onAction('pull', { remote })} title={`快进拉取 ${project.name} 的当前分支`}><ArrowDown size={15} />{pending === 'pull' ? '拉取中…' : '拉取'}{remote === project.upstreamRemote && Boolean(project.behind) && <small>{project.behind}</small>}</button>
    <button className="button" disabled={!remoteReady || !project.head} onClick={() => void onAction('push', { remote })} title={`推送 ${project.name} 的当前分支`}><ArrowUp size={15} />{pending === 'push' ? '推送中…' : '推送'}{remote === project.upstreamRemote && Boolean(project.ahead) && <small>{project.ahead}</small>}</button>
    <button className={`button commit-trigger ${commitOpen ? 'active' : ''}`} disabled={unavailable} aria-expanded={commitOpen} aria-controls="commit-popover" onClick={() => setCommitOpen(!commitOpen)}><GitCommit size={17} />{pending === 'commit' ? '提交中…' : '提交'}{stagedCount > 0 && <small>{stagedCount}</small>}</button>
    {commitOpen && <div id="commit-popover" className="commit-popover" role="dialog" aria-label="提交暂存区修改">
      <div className="commit-popover-heading"><strong>提交到 {project.name}</strong><button className="icon-button" aria-label="关闭提交面板" onClick={() => setCommitOpen(false)}><X size={15} /></button></div>
      <p className="commit-context">{project.branch} · {stagedCount} 个已暂存文件</p>
      <div className="commit-composer">
        {hasConflicts && <p className="commit-conflict">请先解决冲突并暂存，再提交。</p>}
        <textarea ref={textarea} aria-label="提交说明" placeholder="填写提交说明…" value={message} disabled={busy} onChange={(event) => onMessageChange(event.target.value)} />
        <button className="button commit-button" disabled={unavailable || !message.trim() || (!stagedCount && !project.mergeInProgress) || hasConflicts} onClick={async () => { if (await onAction('commit', { message })) setCommitOpen(false); }}><GitCommit size={17} />{pending === 'commit' ? '正在提交…' : project.mergeInProgress ? '提交并完成合并' : `提交 ${stagedCount} 个已暂存文件`}</button>
        {!stagedCount && !project.mergeInProgress && <p className="commit-context">请先暂存需要提交的文件。</p>}
      </div>
    </div>}
  </div>;
}
