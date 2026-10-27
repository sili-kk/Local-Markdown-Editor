'use strict';

let permissionTargets = [];
let permissionDirectoryPaths = new Set();
let permissionExtraRules = [];

function permissionAccessLabel(access) {
  return { rw: '读写（rw）', r: '只读（r）', none: '隐藏（无权限）' }[access] || access;
}

function renderSavedPermissionList(data) {
  const list = $('permissionSavedList');
  list.replaceChildren();
  const append = (path, access, scope) => {
    const row = document.createElement('tr');
    for (const value of [path, permissionAccessLabel(access), scope]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    list.append(row);
  };
  append('全局默认', data.default, '所有未单独设置权限的目录和文件');
  for (const rule of data.rules) {
    const directory = permissionDirectoryPaths.has(rule.path);
    append(displayLibraryPath(rule.path), rule.access, directory ? '此目录、子目录和文件' : '此文件的独立权限');
  }
  $('permissionSavedMessage').textContent = data.rules.length
    ? '以上为已保存配置；下方修改需点击“保存并加载”生效。已有文件独立权限和更具体的目录规则优先。'
    : '尚未设置独立权限，所有目录和文件继承全局默认。';
}

function renderExtraPermissionRules() {
  const list = $('permissionExtraRules');
  list.replaceChildren();
  $('permissionExtraSection').hidden = !permissionExtraRules.length;
  for (const rule of permissionExtraRules) {
    const row = document.createElement('div'); row.className = 'permission-row';
    const label = document.createElement('span'); label.className = 'permission-extra-path';
    label.textContent = (permissionDirectoryPaths.has(rule.path) ? '子目录 · ' : '文件 · ') + displayLibraryPath(rule.path);
    const access = document.createElement('span'); access.className = 'permission-extra-access'; access.textContent = permissionAccessLabel(rule.access);
    const remove = document.createElement('button'); remove.className = 'button'; remove.type = 'button'; remove.textContent = '移除独立权限';
    remove.onclick = () => {
      permissionExtraRules = permissionExtraRules.filter(item => item !== rule);
      renderExtraPermissionRules();
      $('permissionsMessage').textContent = '点击“保存并加载”后，该项将继承上级目录或全局默认权限。';
    };
    row.append(label, access, remove); list.append(row);
  }
}

function currentPermissionScopes() {
  if (!state.path) return [];
  const root = permissionTargets.find(target => target.path === state.path.split('/')[0]);
  return root ? [{ path: root.path, label: '当前配置目录' }] : [];
}

function selectPermissionTarget(path) {
  if (!permissionTargets.some(target => target.path === path)) return;
  const rows = [...$('permissionRules').children];
  let row = rows.find(item => item.children[0].value === path);
  if (!row) {
    const inherited = rows
      .filter(item => permissionTargets.some(target => target.kind === 'directory' && target.path === item.children[0].value) && path.startsWith(item.children[0].value + '/'))
      .sort((a, b) => b.children[0].value.length - a.children[0].value.length)[0];
    row = addPermissionRow(path, inherited ? inherited.children[1].value : $('permissionDefault').value);
  }
  row.scrollIntoView({ block: 'nearest' });
  row.children[1].focus();
  $('permissionsMessage').textContent = '已选中 ' + displayLibraryPath(path) + '，选择权限后点击“保存并加载”生效。';
}

function renderPermissionShortcuts() {
  const container = $('permissionShortcuts');
  container.replaceChildren();
  for (const scope of currentPermissionScopes()) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'button permission-shortcut';
    button.textContent = scope.label + ' · ' + displayLibraryPath(scope.path);
    button.title = button.textContent;
    button.onclick = () => selectPermissionTarget(scope.path);
    container.append(button);
  }
  container.hidden = !container.children.length;
}

function applyDocumentAccess(access) {
  if (access === 'r' && !state.readOnly && state.path && dirty()) {
    state.revokedDraft = { path: state.path, content: content(), saved: state.saved, revision: state.revision };
    const loading = state.loading;
    state.loading = true;
    try { state.editor.setMarkdown(state.saved, false); } finally { state.loading = loading; }
    count();
    notice('文档已改为只读，未保存的草稿保留在本页面，恢复读写权限后可重新打开并恢复。');
  }
  state.readOnly = access !== 'rw';
  $('save').disabled = state.readOnly || state.navigating || !state.path;
  $('save').title = state.readOnly ? '当前文档为只读' : '保存文档';
  if (state.readOnly) clearTimeout(state.saveTimer);
  const view = state.editor?.getCurrentModeEditor().view;
  if (view) view.setProps({ editable: () => !state.readOnly });
  $('editor').dataset.readonly = String(state.readOnly);
  $('editor').querySelectorAll('.toastui-editor-toolbar-group').forEach(group => { group.inert = state.readOnly; });
}

function revokeDocumentAccess() {
  state.unavailablePath = state.path;
  $('editor').dispatchEvent(new Event('resourcehide'));
  if ($('mergeDialog').open) $('mergeCancel').click();
  $('mergeConflicts').replaceChildren();
  if (dirty()) state.revokedDraft = { path: state.path, content: content(), saved: state.saved, revision: state.revision };
  clearTimeout(state.saveTimer);
  applyDocumentAccess('none');
  const loading = state.loading;
  state.loading = true;
  try { state.editor?.setMarkdown('', false); } finally { state.loading = loading; }
  state.path = ''; state.saved = ''; state.revision = ''; state.conflict = false;
  resetExternalChanges();
  $('editor').hidden = true; $('empty').hidden = false;
  $('empty').textContent = '当前文档已删除或不可访问，请选择其他文档。';
  $('currentFolder').textContent = '文档库';
  document.title = '屿墨笺 · 本地 Markdown';
  $('charCount').textContent = '0 字符 · UTF-8';
  history.replaceState(null, '', location.pathname);
  setDocumentOutlineOpen(false);
  syncDocumentViewers();
  status('文档不可访问');
}

function permissionAccessSelect(value) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', '远端访问权限');
  for (const [access, label] of [['rw', '读写（rw）'], ['r', '只读（r）'], ['none', '隐藏（无权限）']]) {
    const option = document.createElement('option'); option.value = access; option.textContent = label; select.append(option);
  }
  select.value = value;
  return select;
}

function addPermissionRow(path = '', access = 'r') {
  const row = document.createElement('div'); row.className = 'permission-row';
  const target = document.createElement('select'); target.className = 'permission-target'; target.required = true;
  target.setAttribute('aria-label', '文档路径中已配置的目录');
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择已配置目录（包含子目录和文件）'; target.append(placeholder);
  for (const item of permissionTargets) {
    const option = document.createElement('option'); option.value = item.path;
    option.textContent = '目录 · ' + displayLibraryPath(item.path);
    target.append(option);
  }
  target.value = path;
  const permission = permissionAccessSelect(access);
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button'; remove.textContent = '移除';
  remove.onclick = () => row.remove();
  row.append(target, permission, remove);
  $('permissionRules').append(row);
  return row;
}

function populatePermissionForm(data, directories = state.directories) {
  permissionDirectoryPaths = new Set(data.targets.filter(target => target.kind === 'directory').map(target => target.path));
  const configuredPaths = new Set(directories.filter(root => !root.is_file).map(root => root.id));
  permissionTargets = data.targets.filter(target => target.kind === 'directory' && configuredPaths.has(target.path));
  const directoryPaths = new Set(permissionTargets.map(target => target.path));
  permissionExtraRules = data.rules.filter(rule => !directoryPaths.has(rule.path)).map(rule => ({ ...rule }));
  renderSavedPermissionList(data);
  $('permissionDefault').value = data.default;
  $('permissionRules').replaceChildren();
  data.rules.filter(rule => directoryPaths.has(rule.path)).forEach(rule => addPermissionRow(rule.path, rule.access));
  renderExtraPermissionRules();
  renderPermissionShortcuts();
  $('permissionAdd').disabled = !permissionTargets.length;
  $('permissionsMessage').textContent = permissionTargets.length
    ? '仅可选择“文档路径”中已配置的目录，权限自动作用于全部子目录和文件。'
    : '当前只配置了单个文件，不能选择其父目录；可修改全局默认，或添加文档目录后设置目录权限。';
}

function readPermissionForm() {
  const rules = [...$('permissionRules').children].map(row => ({ path: row.children[0].value, access: row.children[1].value }));
  if (rules.some(rule => !permissionTargets.some(target => target.path === rule.path))) throw new Error('请为每一条权限选择有效目录。');
  if (new Set(rules.map(rule => rule.path)).size !== rules.length) throw new Error('同一目录只能设置一条权限，请修改已有规则。');
  return { default: $('permissionDefault').value, rules: [...rules, ...permissionExtraRules] };
}

document.addEventListener('DOMContentLoaded', () => {
  $('permissionAdd').onclick = () => addPermissionRow();
});
