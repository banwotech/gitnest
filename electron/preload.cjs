const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};

contextBridge.exposeInMainWorld('gitnest', {
  platform: process.platform,
  getFullscreen: () => invoke('window:is-fullscreen'),
  onFullscreenChange: (callback) => {
    const listener = (_event, fullscreen) => callback(fullscreen);
    ipcRenderer.on('window:fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('window:fullscreen-changed', listener);
  },
  initialize: () => invoke('workspace:initialize'),
  chooseFolder: () => invoke('workspace:choose'),
  openRecent: (folder) => invoke('workspace:recent', folder),
  refresh: () => invoke('workspace:refresh'),
  compare: (repository, file, source) => invoke('file:compare', repository, file, source),
  switchBranch: (repository, branch) => invoke('repository:action', repository, 'switch', { branch }),
  readCommits: (repository, options) => invoke('repository:commits', repository, options),
  createBranch: (repository, name, checkout) => invoke('repository:action', repository, 'createBranch', { name, checkout }),
  deleteBranch: (repository, branch, force) => invoke('repository:action', repository, 'deleteBranch', { branch, force }),
  merge: (repository, commit, expectedHead, branch, noFastForward) => invoke('repository:action', repository, 'merge', { commit, expectedHead, branch, noFastForward }),
  abortMerge: (repository) => invoke('repository:action', repository, 'abortMerge'),
  stage: (repository, paths) => invoke('repository:action', repository, 'stage', { paths }),
  unstage: (repository, paths) => invoke('repository:action', repository, 'unstage', { paths }),
  commit: (repository, message) => invoke('repository:action', repository, 'commit', { message }),
  pull: (repository, remote) => invoke('repository:action', repository, 'pull', { remote }),
  push: (repository, remote) => invoke('repository:action', repository, 'push', { remote }),
  reveal: (repository, file) => invoke('file:reveal', repository, file),
  onChooseFolder: (callback) => {
    ipcRenderer.on('menu:choose-folder', callback);
    return () => ipcRenderer.removeListener('menu:choose-folder', callback);
  },
});
