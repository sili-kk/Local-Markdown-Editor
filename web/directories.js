'use strict';

let librarySyncing = false;
let libraryGeneration = 0;
let pathsSaving = false;
let pathsLoading = false;
let pathsRevision = '';
let orphanedDraft = false;

function directoryLabel(directory) {
  const duplicates = state.directories.filter(item => item.name === directory.name);
  return duplicates.length > 1 ? directory.name + ' [' + directory.id + ']' : directory.name;
}

function displayLibraryPath(path) {
  const parts = path.split('/');
  const directory = state.directories.find(item => item.id === parts[0]);
  if (!directory) return path;
  parts[0] = directoryLabel(directory);
  if (directory.is_file && parts.length === 2) parts.splice(1, 1);
  return parts.join('/');
}

function applyLibraryData(data) {
  if (data.limits) state.limits = data.limits;
  libraryGeneration++;
  state.files = data.files;
  state.directories = data.directories;
  state.localAdmin = !!data.local_admin;
  state.fileOperations = state.localAdmin && !!data.file_operations;
  state.folders = data.folders || [];
  state.fileAccess = data.file_access || {};
  $('localPaths').hidden = !state.localAdmin;
  $('managePaths').disabled = !data.local_admin;
  syncFileOperationButtons();
  $('managePaths').title = '管理文档路径与远端访问权限';
  if (state.path) {
    if (!state.localAdmin && !state.files.includes(state.path)) revokeDocumentAccess();
    else applyDocumentAccess(state.localAdmin ? 'rw' : state.fileAccess[state.path] || 'r');
  }
  state.libraryWarning = [data.config_error, ...(data.warnings || [])].filter(Boolean).join('\n');
  const paths = state.directories.map(item => item.path);
  $('directory').textContent = paths.join(' · ') || '尚未添加目录';
  $('directory').title = paths.join('\n');
  if ($('search').value.trim()) searchDocuments(true);
}

async function refreshLibrary() {
  if (librarySyncing || pathsSaving || fileMutationBusy || $('pathsDialog').open || $('createDocumentDialog').open || state.navigating || state.saving || state.merging || document.hidden) return;
  librarySyncing = true;
  const previousPath = state.path;
  const previousGeneration = libraryGeneration;
  try {
    const data = await api('/api/files');
    if (pathsSaving || $('pathsDialog').open || state.navigating || state.saving || state.merging || previousPath !== state.path || previousGeneration !== libraryGeneration) return;
    const previous = JSON.stringify([state.files, state.directories, state.libraryWarning, state.fileOperations, state.folders]);
    applyLibraryData(data);
    const changed = previous !== JSON.stringify([state.files, state.directories, state.libraryWarning, state.fileOperations, state.folders]);
    if (changed) drawFiles();
    if (state.path && !state.files.includes(state.path) && dirty()) {
      if (!orphanedDraft) notice('当前文档所在路径已移除或文件不可用，网页草稿仍保留。恢复路径后可继续保存。');
      orphanedDraft = true;
      return;
    }
    if (orphanedDraft && state.files.includes(state.path)) {
      orphanedDraft = false;
      notice('文档路径已恢复，可点击“保存”保存草稿。');
    }
    if ((!state.path && !state.documentsClosed && state.files.length && !state.deletedDocument && !state.unavailablePath) || (state.path && !state.files.includes(state.path))) {
      await navigate(state.files[0] || '', true);
    } else if (changed && !dirty() && !state.conflict) {
      notice(state.libraryWarning);
    }
  } catch {
    // 短暂断开时保留当前文档，下一次刷新继续同步目录。
  } finally {
    librarySyncing = false;
  }
}

function setPathsBusy(busy) {
  $('pathsFields').disabled = busy || !pathsRevision;
  $('pathsReload').disabled = busy;
  $('pathsSave').disabled = busy || !pathsRevision;
  $('pathsCancel').disabled = pathsSaving;
  $('pathsSave').textContent = pathsSaving ? '正在保存…' : '保存并加载';
}

function addPathRow(value = '', focus = true, name = '') {
  const row = document.createElement('div');
  row.className = 'path-row';
  const label = document.createElement('input'); label.className = 'path-name'; label.type = 'text'; label.required = true; label.maxLength = 80;
  label.value = name; label.placeholder = '显示名称（必填）'; label.setAttribute('aria-label', '路径显示名称');
  const input = document.createElement('input');
  input.type = 'text'; input.required = true; input.value = value;
  input.className = 'path-location';
  input.placeholder = '例如 D:/notes 或 ./docs/note.md';
  input.setAttribute('aria-label', '目录或 Markdown 文件路径');
  input.autocomplete = 'off'; input.spellcheck = false;
  const remove = document.createElement('button');
  remove.className = 'button'; remove.type = 'button'; remove.textContent = '移除';
  remove.onclick = () => {
    row.remove();
    if (!$('pathsList').children.length) addPathRow();
    else $('pathsAdd').focus();
  };
  row.append(label, input, remove);
  $('pathsList').append(row);
  if (focus) label.focus();
}

async function loadPathForm() {
  if (pathsLoading || pathsSaving) return;
  pathsLoading = true;
  pathsRevision = '';
  setPathsBusy(true);
  $('pathsMessage').textContent = '正在读取路径与权限…';
  try {
    const [data, permissions] = await Promise.all([api('/api/directories'), api('/api/permissions')]);
    if (!$('pathsDialog').open) return;
    if (!data.config_revision || data.config_revision !== permissions.config_revision) throw new Error('配置正在变化，请点击“重新读取”后再编辑。');
    populatePermissionForm(permissions, data.directories);
    pathsRevision = data.config_revision;
    $('pathsList').replaceChildren();
    data.directories.forEach(directory => addPathRow(directory.path, false, directory.name));
    if (!$('pathsList').children.length) addPathRow('', false);
    $('pathsMessage').textContent = data.config_error || '';
  } catch (error) {
    pathsRevision = '';
    $('pathsMessage').textContent = error.message;
  } finally {
    pathsLoading = false;
    setPathsBusy(false);
    $('pathsSave').disabled = !pathsRevision;
  }
}

async function savePathForm(event) {
  event.preventDefault();
  if (pathsSaving || pathsLoading || !pathsRevision || !state.localAdmin) return;
  const rows = [...$('pathsList').children];
  const paths = rows.map(row => row.querySelector('.path-location').value.trim());
  const names = rows.map(row => row.querySelector('.path-name').value.trim());
  if (!paths.length || paths.length > 64 || paths.some(path => !path) || names.some(name => !name)) {
    $('pathsMessage').textContent = '请填写 1–64 个路径，每个路径都需要显示名称。';
    return;
  }
  pathsSaving = true;
  libraryGeneration++;
  setPathsBusy(true);
  let persisted = false;
  let submitting = false;
  try {
    const permissions = readPermissionForm();
    $('pathsMessage').textContent = '正在保存当前文档…';
    if (!await flush()) throw new Error('当前文档尚未保存，路径配置未修改。请先处理文档保存问题。');
    $('pathsMessage').textContent = '正在保存路径与权限配置…';
    submitting = true;
    const config = await api('/api/directories', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, names, permissions, config_revision: pathsRevision }),
    });
    persisted = true;
    pathsRevision = config.config_revision;
    renderSavedPermissionList({ ...permissions, rules: permissions.rules.filter(rule => !config.directories || config.directories.some(root => root.id === rule.path.split('/')[0])) });
    $('pathsSave').textContent = '正在加载…';
    $('pathsMessage').textContent = '路径与权限已保存，正在加载文件列表…';
    // 保存前已经完成 flush，保留仍存在的当前文档及其编辑历史。
    const data = await api('/api/files');
    applyLibraryData(data);
    drawFiles();
    if (!state.path || !state.files.includes(state.path)) {
      if (!await navigate(state.documentsClosed ? '' : state.files[0] || '')) throw new Error('文件加载失败，请点击“重新加载”重试。');
    }
    $('pathsDialog').close();
    notice(state.libraryWarning || '路径与访问权限已保存，目录和文件列表已更新。');
  } catch (error) {
    if (submitting && !persisted && !error.status) pathsRevision = '';
    $('pathsMessage').textContent = (persisted ? '路径与权限已保存，但加载列表失败：' : submitting && !error.status ? '尚未确认配置是否保存，请重新读取后确认：' : '') + error.message;
  } finally {
    pathsSaving = false;
    setPathsBusy(false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('managePaths').onclick = () => {
    if (!state.localAdmin || state.navigating || state.merging || fileMutationBusy) return;
    $('pathsDialog').showModal();
    void loadPathForm();
  };
  $('pathsAdd').onclick = () => addPathRow();
  $('pathsReload').onclick = () => { void loadPathForm(); };
  $('pathsCancel').onclick = () => $('pathsDialog').close();
  $('pathsDialog').addEventListener('cancel', event => { if (pathsSaving) event.preventDefault(); });
  $('pathsForm').addEventListener('submit', savePathForm);
  setInterval(() => { void refreshLibrary(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshLibrary(); });
});
