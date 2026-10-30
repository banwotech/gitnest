import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CaretUpDown, Check, Code, Folder, FolderOpen, GitBranch, Plus, SidebarSimple } from '@phosphor-icons/react';
import type { Comparison, FileSection, GitAction, GitActionPayload, Project, RepositoryActionResult, Workspace, WorkspaceResult } from './types';
import DiffView from './components/DiffView';
import ChangesPanel from './components/ChangesPanel';
import RepositoryActions from './components/RepositoryActions';
import BranchActions from './components/BranchActions';
import Toast, { type ToastMessage } from './components/Toast';
import { isFileInSection } from './fileStatus';

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function Brand({ large = false }: { large?: boolean }) {
  return <div className={`brand ${large ? 'large' : ''}`}><span className="brand-mark"><GitBranch size={large ? 35 : 21} weight="bold" /></span><span>GitNest<span className="brand-period">.</span></span></div>;
}

export default function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedSection, setSelectedSection] = useState<FileSection>('unstaged');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [pendingAction, setPendingAction] = useState<{ repository: string; action: GitAction } | null>(null);
  const [commitMessages, setCommitMessages] = useState<Record<string, string>>({});
  const busy = useRef(false);
  const mutating = useRef(false);
  const currentWorkspace = useRef<Workspace | null>(null);
  const comparisonRequest = useRef(0);
  const loadedComparisonKey = useRef('');
  const activeRepository = useRef<string | null>(null);
  const showError = useCallback((message: string) => setToast({ kind: 'error', message }), []);
  const dismissToast = useCallback(() => setToast(null), []);

  const applyWorkspace = useCallback((result: WorkspaceResult) => {
    currentWorkspace.current = result.workspace;
    setWorkspace(result.workspace);
    setRecent(result.recent);
    const projects = result.workspace?.projects.filter((item) => item.isRepository) ?? [];
    const first = projects.find((item) => item.files.length > 0) ?? projects[0];
    setSelectedRepo(first?.path ?? null);
    const firstFile = first?.files.find((file) => isFileInSection(file, 'unstaged')) ?? first?.files[0];
    setSelectedFile(firstFile?.path ?? null);
    setSelectedSection(firstFile && isFileInSection(firstFile, 'unstaged') ? 'unstaged' : 'staged');
    setToast(null); setShowRecent(false);
  }, []);

  useEffect(() => {
    if (!window.gitnest) { showError('请在 GitNest 桌面应用中打开，以访问本地 Git 仓库。'); setLoading(false); return; }
    window.gitnest.initialize().then(applyWorkspace).catch((error) => showError(messageOf(error))).finally(() => setLoading(false));
  }, [applyWorkspace, showError]);

  useEffect(() => {
    if (!window.gitnest?.onFullscreenChange) return;
    let active = true;
    const unsubscribe = window.gitnest.onFullscreenChange(setIsFullscreen);
    window.gitnest.getFullscreen().then((fullscreen) => {
      if (active) setIsFullscreen(fullscreen);
    }).catch((error) => { if (active) showError(messageOf(error)); });
    return () => { active = false; unsubscribe(); };
  }, [showError]);

  const chooseFolder = useCallback(async () => {
    if (busy.current || mutating.current || !window.gitnest) return;
    busy.current = true;
    try {
      const result = await window.gitnest.chooseFolder();
      if (result) applyWorkspace(result);
    } catch (error) { showError(messageOf(error)); }
    finally { busy.current = false; }
  }, [applyWorkspace, showError]);

  useEffect(() => window.gitnest?.onChooseFolder(chooseFolder), [chooseFolder]);

  const refresh = useCallback(async () => {
    if (busy.current || mutating.current || !currentWorkspace.current) return;
    busy.current = true;
    try {
      const next = await window.gitnest.refresh();
      if (next) {
        currentWorkspace.current = next;
        setWorkspace(next);
      }
    } catch (error) { showError(messageOf(error)); }
    finally { busy.current = false; }
  }, [showError]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5000);
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') { event.preventDefault(); void refresh(); }
      if (event.key === 'Escape') setShowRecent(false);
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('focus', onFocus); clearInterval(interval); window.removeEventListener('keydown', onKey); };
  }, [refresh]);

  const projects = workspace?.projects ?? [];
  const repositories = projects.filter((item) => item.isRepository);
  const totalChanges = repositories.reduce((sum, item) => sum + item.files.length, 0);
  const project = repositories.find((item) => item.path === selectedRepo) ?? repositories[0];
  activeRepository.current = project?.path ?? null;
  const file = project?.files.find((item) => item.path === selectedFile && isFileInSection(item, selectedSection));
  const source = selectedSection === 'staged' ? 'staged' : 'working';

  useEffect(() => {
    if (!project || project.files.some((item) => item.path === selectedFile && isFileInSection(item, selectedSection))) return;
    const currentFiles = project.files.filter((item) => isFileInSection(item, selectedSection));
    const otherSection = selectedSection === 'staged' ? 'unstaged' : 'staged';
    const sameFile = project.files.find((item) => item.path === selectedFile && isFileInSection(item, otherSection));
    if (sameFile) { setSelectedSection(otherSection); return; }
    const next = currentFiles[0] ?? project.files.find((item) => isFileInSection(item, otherSection));
    setSelectedFile(next?.path ?? null);
    if (!currentFiles.length && next) setSelectedSection(otherSection);
  }, [project, selectedFile, selectedSection]);

  useEffect(() => {
    const request = ++comparisonRequest.current;
    setComparisonError(null);
    if (!project || !file) { setComparison(null); setComparing(false); return; }
    const comparisonKey = JSON.stringify([project.path, project.head, project.branchName, file.path, source]);
    if (loadedComparisonKey.current !== comparisonKey) setComparing(true);
    window.gitnest.compare(project.path, file.path, source).then((next) => {
      if (request !== comparisonRequest.current) return;
      loadedComparisonKey.current = comparisonKey;
      setComparison((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    }).catch((error) => {
      if (request === comparisonRequest.current) { setComparison(null); setComparisonError(messageOf(error)); }
    }).finally(() => { if (request === comparisonRequest.current) setComparing(false); });
  }, [project, file, source, workspace?.scannedAt]);

  const selectProject = (item: Project) => {
    const first = item.files.find((file) => isFileInSection(file, 'unstaged')) ?? item.files[0];
    setSelectedRepo(item.path); setSelectedFile(first?.path ?? null); setSelectedSection(first && isFileInSection(first, 'unstaged') ? 'unstaged' : 'staged');
  };
  const openRecent = async (folder: string) => {
    if (busy.current || mutating.current) return;
    busy.current = true; setLoading(true);
    try { applyWorkspace(await window.gitnest.openRecent(folder)); }
    catch (error) { showError(messageOf(error)); }
    finally { busy.current = false; setLoading(false); }
  };

  const runAction = async (action: GitAction, payload: GitActionPayload = {}): Promise<boolean> => {
    if (mutating.current || !project || typeof window.gitnest?.stage !== 'function') return false;
    const repository = project;
    mutating.current = true;
    setPendingAction({ repository: repository.path, action });
    setToast(null);
    try {
      let result: RepositoryActionResult;
      switch (action) {
        case 'createBranch': result = await window.gitnest.createBranch(repository.path, payload.name ?? '', payload.checkout); break;
        case 'deleteBranch': result = await window.gitnest.deleteBranch(repository.path, payload.branch ?? '', payload.force); break;
        case 'merge': result = await window.gitnest.merge(repository.path, payload.commit ?? '', payload.expectedHead ?? '', payload.branch ?? '', payload.noFastForward); break;
        case 'abortMerge': result = await window.gitnest.abortMerge(repository.path); break;
        case 'switch': result = await window.gitnest.switchBranch(repository.path, payload.branch ?? ''); break;
        case 'stage': result = await window.gitnest.stage(repository.path, payload.paths); break;
        case 'unstage': result = await window.gitnest.unstage(repository.path, payload.paths); break;
        case 'commit': result = await window.gitnest.commit(repository.path, payload.message ?? ''); break;
        case 'pull': result = await window.gitnest.pull(repository.path, payload.remote ?? ''); break;
        case 'push': result = await window.gitnest.push(repository.path, payload.remote ?? ''); break;
      }
      currentWorkspace.current = result.workspace;
      setWorkspace(result.workspace);
      if (result.error) { showError(`${repository.name}：${result.error}`); return false; }
      if (action === 'commit') setCommitMessages((messages) => ({ ...messages, [repository.path]: '' }));
      if ((action === 'stage' || action === 'unstage') && activeRepository.current === repository.path) {
        setSelectedSection(action === 'stage' ? 'staged' : 'unstaged');
        if (payload.paths?.length === 1) setSelectedFile(payload.paths[0]);
      }
      if (action !== 'stage' && action !== 'unstage') setToast({ kind: 'success', message: `${repository.name}：${result.message ?? '操作完成'}` });
      return true;
    } catch (failure) { showError(`${repository.name}：${messageOf(failure)}`); return false; }
    finally { mutating.current = false; setPendingAction(null); }
  };

  return <div className={`app-shell platform-${window.gitnest?.platform ?? 'darwin'} ${isFullscreen ? 'is-fullscreen' : ''} ${sidebarVisible ? '' : 'sidebar-hidden'}`}>
    <header className="titlebar">
      <div className="titlebar-navigation">
        {sidebarVisible && <Brand />}
        <button className="icon-button sidebar-toggle" title={sidebarVisible ? '隐藏侧边栏' : '展开侧边栏'} aria-label={sidebarVisible ? '隐藏侧边栏' : '展开侧边栏'} aria-expanded={sidebarVisible} aria-controls="workspace-sidebar" disabled={!workspace} onClick={() => { setSidebarVisible((visible) => !visible); setShowRecent(false); }}><SidebarSimple size={20} weight={sidebarVisible ? 'duotone' : 'regular'} /></button>
      </div>
      {project && !loading && <RepositoryActions key={project.path} project={project} busy={Boolean(pendingAction)} pending={pendingAction?.repository === project.path ? pendingAction.action : null} message={commitMessages[project.path] ?? ''} onMessageChange={(message) => setCommitMessages((messages) => ({ ...messages, [project.path]: message }))} onAction={runAction} />}
      {project && !loading && <BranchActions key={`branches:${project.path}`} project={project} busy={Boolean(pendingAction)} pending={pendingAction?.repository === project.path ? pendingAction.action : null} onAction={runAction} onError={showError} />}
    </header>
    {toast && <Toast toast={toast} onDismiss={dismissToast} />}
    {loading ? <div className="loading-screen"><span className="spinner" />正在打开工作区…</div> : !workspace ? <main className="welcome">
      <span className="eyebrow">A LITTLE HOME FOR YOUR REPOSITORIES</span><Brand large /><h1>一个文件夹，<br />看见整个项目。</h1><p>前端、后端，还有每一次未提交的修改。<br />打开它们共同的父文件夹，从这里开始。</p><button className="button primary" onClick={chooseFolder}><FolderOpen size={20} />选择工作区文件夹<ArrowRight size={18} /></button><span className="welcome-note">支持普通文件夹 · 自动识别一级子仓库</span>
      {recent.length > 0 && <div className="welcome-recent"><span className="section-label">最近打开</span>{recent.map((folder) => <button key={folder} onClick={() => openRecent(folder)}><Folder size={17} /><span>{folder}</span><ArrowRight size={15} /></button>)}</div>}
    </main> : <div className="workspace-layout">
      <aside className="sidebar" id="workspace-sidebar" hidden={!sidebarVisible}>
        <div className="workspace-picker"><div className="workspace-avatar"><FolderOpen size={23} weight="duotone" /></div><div><strong title={workspace.path}>{workspace.name}</strong><span title={workspace.path}>{workspace.path}</span></div><button className={`icon-button ${showRecent ? 'active' : ''}`} title="切换工作区" aria-label="切换工作区" aria-expanded={showRecent} onClick={() => setShowRecent(!showRecent)}><CaretUpDown size={18} /></button>
          {showRecent && <div className="recent-menu"><span className="section-label">最近打开</span>{recent.map((folder) => <button key={folder} title={folder} onClick={() => openRecent(folder)}><Folder size={16} /><span>{folder.split('/').pop()}</span>{workspace.path === folder && <Check size={14} />}</button>)}<button onClick={chooseFolder}><Plus size={16} />打开其他文件夹</button></div>}
        </div>
        <div className="section-label projects-label">项目仓库<span>{repositories.length}</span></div>
        <nav className="project-list" aria-label="项目仓库">
          {repositories.map((item) => <button key={item.path} className={`project-nav ${project?.path === item.path ? 'selected' : ''}`} onClick={() => selectProject(item)}>
            <span className={`project-nav-icon ${item.files.length ? 'has-changes' : ''}`}><Code size={18} weight="bold" /></span><span className="project-nav-text"><strong title={item.name}>{item.name}</strong><span><GitBranch size={12} />{item.branch}</span></span><span className={`change-count ${item.files.length ? 'dirty' : 'clean'}`}>{item.files.length}</span>
          </button>)}
          {!repositories.length && <p className="no-repos">没有发现 Git 仓库</p>}
        </nav>
        <div className="sidebar-bottom"><div><span className="status-dot" />{repositories.length} 个仓库<span>·</span>{totalChanges} 个变更</div><p>仅扫描当前目录及一级子文件夹</p></div>
      </aside>
      <main className="main-area">
        {project ? <div className="repository-layout">
          <ChangesPanel key={project.path} project={project} selectedFile={selectedFile} selectedSection={selectedSection} onSelectFile={(next, section) => { setSelectedFile(next.path); setSelectedSection(section); }} onAction={runAction} busy={Boolean(pendingAction)} />
          <DiffView project={project} file={file} comparison={comparison} source={source} loading={comparing} error={comparisonError} stagingDisabled={!file || Boolean(pendingAction) || typeof window.gitnest?.stage !== 'function'} onToggleStage={() => { if (file) void runAction(selectedSection === 'staged' ? 'unstage' : 'stage', { paths: [file.path] }); }} />
        </div> : <div className="empty-workspace"><FolderOpen size={40} weight="light" /><h3>这里还没有 Git 仓库</h3><p>选择包含前端、后端等独立 Git 仓库的父文件夹，<br />或直接打开一个 Git 仓库。</p><button className="button" onClick={chooseFolder}>选择其他文件夹<ArrowRight size={16} /></button></div>}
      </main>
    </div>}
  </div>;
}
