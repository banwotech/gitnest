import type { ChangedFile, FileSection } from './types';

export function isFileInSection(file: ChangedFile, section: FileSection) {
  return section === 'staged' ? file.staged && file.kind !== 'conflict' : file.unstaged || file.kind === 'conflict';
}
