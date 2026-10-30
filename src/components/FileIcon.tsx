export default function FileIcon({ path }: { path: string }) {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const labels: Record<string, string> = { ts: 'TS', tsx: 'TS', js: 'JS', jsx: 'JS', json: '{}', css: '#', scss: '#', md: 'M↓', py: 'PY', go: 'GO', rs: 'RS', vue: 'V', html: '<>', yml: 'Y', yaml: 'Y', mjs: 'JS', cjs: 'JS' };
  return <span className={`file-icon ext-${extension}`} aria-hidden="true">{labels[extension] ?? '·'}</span>;
}
