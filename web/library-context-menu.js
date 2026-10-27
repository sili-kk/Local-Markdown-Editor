'use strict';

let libraryContextTarget = null;

function libraryManagementBusy() {
  return fileMutationBusy || pathsSaving || pathsLoading || state.navigating || state.merging ||
    $('pathsDialog').open || workspaceSortBusy();
}

function libraryMenuTarget(path, kind, anchor = null) {
  if (!state.localAdmin || !path) return null;
  const root = state.directories.find(item => item.id === path.split('/')[0]);
  if (!root) return null;
  if (kind === 'file-root' && root.is_file && path === root.id) {
    const documentPath = state.files.find(item => item.startsWith(root.id + '/'));
    return { path, kind: 'file', documentPath, anchor };
  }
  if (kind === 'file' && state.files.includes(path)) return { path, kind, documentPath: path, anchor };
  if (kind === 'directory' && !root.is_file && (path === root.id || state.folders.includes(path) ||
      state.files.some(item => item.startsWith(path + '/')))) return { path, kind, anchor };
  return null;
}

function closeLibraryContextMenu(restoreFocus = false) {
  const target = libraryContextTarget;
  libraryContextTarget = null;
  $('libraryContextMenu').hidden = true;
  if (restoreFocus && target?.anchor?.isConnected) target.anchor.focus({ preventScroll: true });
}

function syncLibraryContextMenu() {
  if (libraryContextTarget && (!state.localAdmin || libraryManagementBusy() || !libraryContextTarget.anchor?.isConnected ||
      $('libraryContextMenu').dataset.fileOperations !== String(state.fileOperations))) closeLibraryContextMenu();
}

function openLibraryContextMenu(event, keyboard = false) {
  if (!keyboard && event.shiftKey) return;
  const anchor = event.target.closest('[data-library-kind]');
  if (!anchor || !state.localAdmin || libraryManagementBusy()) return;
  const target = libraryMenuTarget(anchor.dataset.path, anchor.dataset.libraryKind, anchor);
  if (!target) return;
  event.preventDefault(); event.stopPropagation();
  closeLibraryContextMenu(); libraryContextTarget = target;
  const menu = $('libraryContextMenu');
  menu.dataset.fileOperations = String(state.fileOperations);
  $('libraryContextTitle').textContent = displayLibraryPath(target.path);
  $('libraryContextTitle').title = displayLibraryPath(target.path);
  $('libraryContextCreate').hidden = !state.fileOperations || target.kind !== 'directory' || !state.folders.includes(target.path);
  $('libraryContextDelete').hidden = !state.fileOperations || target.kind !== 'file' || !target.documentPath;
  $('libraryContextSeparator').hidden = $('libraryContextCreate').hidden && $('libraryContextDelete').hidden;
  menu.hidden = false;
  const bounds = anchor.getBoundingClientRect(), size = menu.getBoundingClientRect();
  const useAnchor = keyboard || (!event.clientX && !event.clientY);
  const x = useAnchor ? bounds.left + 12 : event.clientX, y = useAnchor ? bounds.bottom : event.clientY;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - size.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - size.height - 8)) + 'px';
  [...menu.querySelectorAll('button')].find(button => !button.hidden && !button.disabled)?.focus({ preventScroll: true });
}

// Compare canonical local paths from the same configuration revision so an
// overlapping configured root cannot keep a writable exception inside a lock.
// These absolute paths stay local to this comparison and are never displayed.
function libraryPermissionIdentity(path, directories) {
  const [id, ...parts] = path.split('/');
  const root = directories.find(item => item.id === id);
  if (!root?.path) throw new Error('文档路径已变化，请刷新列表后重试。');
  let value = root.path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root.is_file && parts.length) value += '/' + parts.join('/');
  return /^(?:[a-z]:(?:\/|$)|\/\/)/i.test(value) ? value.toLowerCase() : value;
}

function libraryPermissionUpdate(target, readOnly, directories, permissions) {
  const root = directories.find(item => item.id === target.path.split('/')[0]);
  const path = root?.is_file ? root.id : target.path;
  const option = permissions.targets.find(item => item.path === path && item.kind === target.kind);
  if (!option) throw new Error('文件或目录已不存在，权限未修改。');
  const identity = libraryPermissionIdentity(path, directories);
  const targetKinds = new Map(permissions.targets.map(item => [item.path, item.kind]));
  const rules = [];
  let inherited = permissions.default, specificity = -1;
  for (const rule of permissions.rules) {
    const candidate = libraryPermissionIdentity(rule.path, directories);
    const directoryRule = targetKinds.get(rule.path) === 'directory';
    if ((candidate === identity || (directoryRule && identity.startsWith(candidate + '/'))) && candidate.length > specificity) {
      inherited = rule.access; specificity = candidate.length;
    }
    if (candidate === identity) continue;
    const child = target.kind === 'directory' && candidate.startsWith(identity + '/');
    rules.push({ path: rule.path, access: readOnly && child && rule.access === 'rw' ? 'r' : rule.access });
  }
  // Locking must never make a previously hidden scope readable.
  rules.push({ path, access: readOnly ? (inherited === 'none' ? 'none' : 'r') : 'rw' });
  return { default: permissions.default, rules, config_revision: permissions.config_revision };
}

async function setLibraryReadOnly(target, readOnly) {
  if (!target || !state.localAdmin || libraryManagementBusy()) return;
  fileMutationBusy = true; libraryGeneration++; syncFileOperationButtons();
  let persisted = false;
  try {
    if (!await flush()) throw new Error('当前文档尚未保存，权限未修改。');
    if (!state.localAdmin) throw new Error('当前访问不具备本机管理权限。');
    const [configuration, permissions] = await Promise.all([api('/api/directories'), api('/api/permissions')]);
    if (!configuration.config_revision || configuration.config_revision !== permissions.config_revision) {
      throw new Error('配置正在变化，请重新打开菜单后重试。');
    }
    const payload = libraryPermissionUpdate(target, readOnly, configuration.directories, permissions);
    if (!state.localAdmin || state.navigating || state.merging) throw new Error('当前状态已变化，权限未修改。');
    await api('/api/permissions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    persisted = true;
    applyLibraryData(await api('/api/files')); drawFiles();
    notice((readOnly ? '已限制远端写入：' : '已允许此项远端读写：') + displayLibraryPath(target.path) +
      (target.kind === 'directory' ? (readOnly ? '。子项读写规则已收紧，隐藏权限保留。' : '。子项单独规则保持有效。') : '。'));
  } catch (error) { notice((persisted ? '权限已保存，但列表刷新失败：' : '权限未修改：') + error.message); }
  finally { fileMutationBusy = false; syncFileOperationButtons(); }
}

document.addEventListener('DOMContentLoaded', () => {
  const menu = $('libraryContextMenu');
  $('fileList').addEventListener('contextmenu', openLibraryContextMenu);
  $('fileList').addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openLibraryContextMenu(event, true);
  });
  for (const [id, action] of [
    ['libraryContextCreate', target => { if (state.fileOperations && target.kind === 'directory' && state.folders.includes(target.path)) openCreateDocument(target.path); }],
    ['libraryContextDelete', target => { if (state.fileOperations && target.documentPath && state.files.includes(target.documentPath)) void deleteDocument(target.documentPath); }],
    ['libraryContextLock', target => { void setLibraryReadOnly(target, true); }],
    ['libraryContextUnlock', target => { void setLibraryReadOnly(target, false); }],
  ]) {
    $(id).onclick = event => {
      event.preventDefault(); event.stopPropagation();
      const target = libraryContextTarget;
      closeLibraryContextMenu(true);
      if (target && state.localAdmin && !libraryManagementBusy()) action(target);
    };
  }
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeLibraryContextMenu(true); }
    else if (event.key === 'Tab') closeLibraryContextMenu();
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = [...menu.querySelectorAll('button')].filter(button => !button.hidden && !button.disabled);
      const index = buttons.indexOf(document.activeElement);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
  });
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) closeLibraryContextMenu(); });
  document.addEventListener('scroll', event => { if (!menu.contains(event.target)) closeLibraryContextMenu(); }, true);
  window.addEventListener('resize', () => closeLibraryContextMenu());
  window.addEventListener('blur', () => closeLibraryContextMenu());
});
