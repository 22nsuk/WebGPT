// CLI identity only: this never validates grants or changes the launch spelling.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function isCliEntry(meta) {
  // Available in Node 22.18+/24.2+. Keep the earlier Node 22 baseline supported.
  if (typeof meta.main === 'boolean') return meta.main;
  const entry = process.argv[1];
  if (typeof entry !== 'string' || !entry || entry === '-' || !entry.isWellFormed() || entry.includes('\0')) return false;
  // In eval/print mode argv[1] is user data, even if it names this module.
  if (process.execArgv.some(arg => /^--(?:eval|print)(?:=|$)/.test(arg) || ['-e', '-p', '-pe'].includes(arg))) return false;
  const url = new URL(meta.url);
  // A query/fragment identifies a separate imported module, not the CLI entry.
  if (url.protocol !== 'file:' || url.search || url.hash) return false;
  // --preserve-symlinks-main can preserve the module URL as well as argv[1].
  const entryPath = resolve(entry), modulePath = fileURLToPath(url);
  let realEntry, realModule;
  const errors = [];
  // JS realpath can decode link targets before producing even a Buffer result.
  // Native bytes distinguish invalid UTF-8 names from literal U+FFFD siblings.
  try { realEntry = realpathSync.native(entryPath, { encoding: 'buffer' }); } catch (error) { errors.push(error); }
  try { realModule = realpathSync.native(modulePath, { encoding: 'buffer' }); } catch (error) { errors.push(error); }
  if (errors.length) {
    // Only a known entry candidate owns a CLI diagnostic; ordinary imports stay quiet.
    const candidate = entryPath === modulePath || realEntry?.equals(Buffer.from(modulePath))
      || realModule?.equals(Buffer.from(entryPath));
    const failure = errors.find(error => error.code !== 'ENOENT' && error.code !== 'ENOTDIR');
    if (candidate && failure) throw failure;
    return false;
  }
  return realEntry.equals(realModule);
}
