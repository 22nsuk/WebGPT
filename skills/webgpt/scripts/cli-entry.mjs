// CLI identity only: this never validates grants or changes the launch spelling.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isCliEntry(meta) {
  // Available in Node 22.18+/24.2+. Keep the earlier Node 22 baseline supported.
  if (typeof meta.main === 'boolean') return meta.main;
  const entry = process.argv[1];
  if (typeof entry !== 'string' || !entry || entry === '-' || !entry.isWellFormed() || entry.includes('\0')) return false;
  // In eval/print mode argv[1] is user data, even if it names this module.
  if (process.execArgv.some(arg => /^--(?:eval|print)(?:=|$)/.test(arg) || /^-[ep](?:[^-]|$)/.test(arg))) return false;
  const url = new URL(meta.url);
  // A query/fragment identifies a separate imported module, not the CLI entry.
  if (url.protocol !== 'file:' || url.search || url.hash) return false;
  try {
    // --preserve-symlinks-main can preserve the module URL as well as argv[1].
    return realpathSync(entry) === realpathSync(fileURLToPath(url));
  } catch (error) {
    // An eval argument or a renamed importer need not name an existing file.
    // Do not hide permission/I/O failures behind an apparent successful no-op.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}
