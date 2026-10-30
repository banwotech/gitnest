export interface ChangedFile {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';
  staged: boolean;
  unstaged: boolean;
  submodule: boolean;
}

export interface Project {
  name: string;
  path: string;
  isRepository: boolean;
  error: string | null;
  branch?: string;
  branchName?: string | null;
  remotes?: string[];
  branches?: { ref: string; name: string; remote: string | null; checkedOutElsewhere: boolean }[];
  mergeInProgress?: boolean;
  upstreamRemote?: string | null;
  upstreamBranch?: string | null;
  head?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  files: ChangedFile[];
  commit?: { subject: string; author: string; date: string } | null;
}

export interface Workspace {
  path: string;
  name: string;
  projects: Project[];
  scannedAt: string;
}

export interface Comparison {
  path: string;
  originalPath: string | null;
  original: string;
  modified: string;
  head: string | null;
  source: 'working' | 'staged';
  kind: 'text' | 'binary' | 'unsupported';
  message: string | null;
}

export interface WorkspaceResult { workspace: Workspace | null; recent: string[] }
export interface RepositoryActionResult { workspace: Workspace; message: string | null; error: string | null }
export interface Commit { id: string; shortId: string; subject: string; author: string; date: string; refs: string }
export interface CommitQuery { ref?: string; query?: string; offset?: number }
export interface CommitPage { commits: Commit[]; hasMore: boolean }
export type FileSection = 'unstaged' | 'staged';
export type GitAction = 'stage' | 'unstage' | 'commit' | 'pull' | 'push' | 'switch' | 'createBranch' | 'deleteBranch' | 'merge' | 'abortMerge';
export interface GitActionPayload { paths?: string[]; message?: string; remote?: string; branch?: string; name?: string; checkout?: boolean; force?: boolean; commit?: string; expectedHead?: string; noFastForward?: boolean }

declare global {
  interface Window {
    gitnest: {
      platform: string;
      getFullscreen(): Promise<boolean>;
      onFullscreenChange(callback: (fullscreen: boolean) => void): () => void;
      initialize(): Promise<WorkspaceResult>;
      chooseFolder(): Promise<WorkspaceResult | null>;
      openRecent(path: string): Promise<WorkspaceResult>;
      refresh(): Promise<Workspace | null>;
      compare(repository: string, file: string, source?: Comparison['source']): Promise<Comparison>;
      switchBranch(repository: string, branch: string): Promise<RepositoryActionResult>;
      readCommits(repository: string, options?: CommitQuery): Promise<CommitPage>;
      createBranch(repository: string, name: string, checkout?: boolean): Promise<RepositoryActionResult>;
      deleteBranch(repository: string, branch: string, force?: boolean): Promise<RepositoryActionResult>;
      merge(repository: string, commit: string, expectedHead: string, branch: string, noFastForward?: boolean): Promise<RepositoryActionResult>;
      abortMerge(repository: string): Promise<RepositoryActionResult>;
      stage(repository: string, paths?: string[]): Promise<RepositoryActionResult>;
      unstage(repository: string, paths?: string[]): Promise<RepositoryActionResult>;
      commit(repository: string, message: string): Promise<RepositoryActionResult>;
      pull(repository: string, remote: string): Promise<RepositoryActionResult>;
      push(repository: string, remote: string): Promise<RepositoryActionResult>;
      reveal(repository: string, file?: string): Promise<void>;
      onChooseFolder(callback: () => void): () => void;
    };
    MonacoEnvironment: { getWorker(moduleId: string, label: string): Worker };
  }
}
