// Persist native identifiers as decimal strings, never rounded JSON numbers.
const decimal = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value);

// Retained finite numbers remain inspectable; parsing state is not authorization.
export const validStoredWorkspaceIdentity = value => decimal(value) || Number.isFinite(value);

function exactIdentity(value) {
  if (decimal(value)) return value;
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  throw Error('workspace identity is imprecise or invalid; inspect and register a new task');
}

// Normalize representation only. Preserve every other field for strict grant
// comparisons, and never reconstruct a retained identity from its current path.
export function normalizeWorkspaceIdentity(workspace) {
  if (workspace === null) return null;
  return { ...workspace, device: exactIdentity(workspace.device), inode: exactIdentity(workspace.inode) };
}
