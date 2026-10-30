import { useState } from 'react';
import { Check, GitCommit, MagnifyingGlass, X } from '@phosphor-icons/react';
import type { ChangedFile, FileSection, GitAction, GitActionPayload, Project } from '../types';
import FileIcon from './FileIcon';
import { isFileInSection } from '../fileStatus';

const kindLabel: Record<ChangedFile['kind'], string> = { modified: '已修改', added: '已新增', deleted: '已删除', renamed: '已重命名', untracked: '未跟踪', conflict: '有冲突' };
const kindLetter: Record<ChangedFile['kind'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflict: '!' };

function kindInSection(file: ChangedFile, section: FileSection): ChangedFile['kind'] {
  if (file.kind === 'conflict' || file.kind === 'untracked') return file.kind;
  const status = section === 'staged' ? file.indexStatus : file.worktreeStatus;
  return status === 'A' ? 'added' : status === 'D' ? 'deleted' : status === 'R' ? 'renamed' : 'modified';
}

export default function ChangesPanel({ project, selectedFile, selectedSection, onSelectFile, onAction, busy }: {
  project: Project;
  selectedFile: string | null;
  selectedSection: FileSection;
  onSelectFile: (file: ChangedFile, section: FileSection) => void;
  onAction: (action: GitAction, payload?: GitActionPayload) => Promise<boolean>;
  busy: boolean;
}) {
  const [query, setQuery] = useState('');
  const ready = typeof window.gitnest?.stage === 'function';
  const unavailable = busy || !ready;
  const stagedFiles = project.files.filter((file) => isFileInSection(file, 'staged'));
  const unstagedFiles = project.files.filter((file) => isFileInSection(file, 'unstaged'));

  return <section className="changes-panel" aria-label="变更文件">
    <label className="search-box"><MagnifyingGlass size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件…" aria-label="搜索变更文件" />{query && <button className="icon-button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={13} /></button>}</label>
    <div className="file-groups">
      {(['unstaged', 'staged'] as const).map((section) => {
        const staged = section === 'staged';
        const files = staged ? stagedFiles : unstagedFiles;
        const visible = files.filter((file) => file.path.toLowerCase().includes(query.toLowerCase()));
        const action = staged ? 'unstage' : 'stage';
        const groupLabel = staged ? '已暂存' : '未暂存';
        return <section key={section} className="file-group" aria-label={`${groupLabel}文件`}>
          <div className="file-group-heading"><strong>{groupLabel}<span>{query ? `${visible.length}/${files.length}` : files.length}</span></strong><button disabled={unavailable || !visible.length} onClick={() => void onAction(action, query ? { paths: visible.map((file) => file.path) } : undefined)}>{staged ? query ? '取消匹配项暂存' : '全部取消' : query ? '暂存匹配文件' : '全部暂存'}</button></div>
          <div className="file-list" role="list" aria-label={`${groupLabel}文件列表`}>
            {visible.map((file) => {
              const kind = kindInSection(file, section);
              return <div role="listitem" key={file.path} className={`file-row ${selectedFile === file.path && selectedSection === section ? 'selected' : ''}`}>
                <button className="file-select" aria-pressed={selectedFile === file.path && selectedSection === section} onClick={() => onSelectFile(file, section)} title={`${file.originalPath ? `${file.originalPath} → ` : ''}${file.path}\n${kindLabel[kind]} · ${groupLabel}`}>
                  <FileIcon path={file.path} /><span className="file-row-text"><strong>{file.path.split('/').pop()}</strong><small>{file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '根目录'}</small></span><span className={`file-status status-${kind}`}>{kindLetter[kind]}</span>
                </button>
              </div>;
            })}
            {!visible.length && <div className="files-empty">{query ? '没有匹配的文件' : <><Check size={20} /><span>{staged ? '暂无已暂存文件' : '没有未暂存的修改'}</span></>}</div>}
          </div>
        </section>;
      })}
    </div>
    {project.commit && <div className="commit-summary" title={`${project.commit.subject}\n${project.commit.author} · ${project.commit.date}`}><GitCommit size={14} /><code>{project.head?.slice(0, 7)}</code><span>{project.commit.subject}</span></div>}
  </section>;
}
