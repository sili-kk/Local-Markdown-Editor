'use strict';

let pathPickerTarget = null;
let pathPickerGeneration = 0;
let pathPickerSelected = '';
let pathPickerParent = '';

function selectPickerPath(path) {
  pathPickerSelected = path;
  $('pathPickerSelection').textContent = path || '尚未选择';
  $('pathPickerUse').disabled = !path;
  for (const item of $('pathPickerList').children) item.setAttribute('aria-pressed', String(item.dataset.path === path));
}

async function browsePickerPath(path = '', roots = false) {
  const generation = ++pathPickerGeneration;
  selectPickerPath('');
  pathPickerParent = '';
  $('pathPickerUp').disabled = true;
  $('pathPickerMessage').textContent = '正在读取路径…';
  $('pathPickerList').replaceChildren();
  try {
    const data = await api('/api/directories/browse?' + (roots ? 'roots=1' : 'path=' + encodeURIComponent(path)));
    if (generation !== pathPickerGeneration || !$('pathPickerDialog').open) return false;
    $('pathPickerAddress').value = data.path;
    pathPickerParent = data.parent;
    $('pathPickerUp').disabled = !data.parent;
    for (const entry of data.entries) {
      const button = document.createElement('button');
      button.className = 'button'; button.type = 'button'; button.dataset.path = entry.path;
      button.textContent = (entry.directory ? '文件夹 · ' : 'Markdown · ') + entry.name + (entry.directory ? ' ›' : '');
      button.onclick = () => { if (entry.directory) void browsePickerPath(entry.path); else selectPickerPath(entry.path); };
      $('pathPickerList').append(button);
    }
    selectPickerPath(data.selected);
    $('pathPickerMessage').textContent = data.truncated ? '此目录内容较多，仅显示部分结果；可在上方输入完整路径前往。' : data.entries.length ? '' : data.path ? '此文件夹没有子文件夹或 Markdown 文件，可以直接使用此文件夹。' : '未找到可用磁盘，请在上方输入完整路径。';
    return true;
  } catch (error) {
    if (generation !== pathPickerGeneration || !$('pathPickerDialog').open) return false;
    $('pathPickerMessage').textContent = error.message;
    return false;
  }
}

async function openPathPicker(input, label) {
  if (!state.localAdmin || pathsSaving || pathsLoading) return;
  pathPickerTarget = { input, label };
  $('pathPickerDialog').showModal();
  const initial = input.value.trim();
  $('pathPickerAddress').value = initial;
  const generation = pathPickerGeneration + 1;
  if (!await browsePickerPath(initial) && initial && generation === pathPickerGeneration && $('pathPickerDialog').open) {
    const error = $('pathPickerMessage').textContent;
    if (await browsePickerPath('')) $('pathPickerMessage').textContent = '原路径无法打开，已显示配置所在目录。' + error;
  }
}

function closePathPicker() {
  pathPickerGeneration++;
  pathPickerTarget = null;
  pathPickerSelected = '';
  $('pathPickerDialog').close();
}

function usePickerPath() {
  if (!pathPickerTarget || !pathPickerSelected || pathsSaving || pathsLoading || !state.localAdmin) return;
  const { input, label } = pathPickerTarget;
  input.value = pathPickerSelected;
  if (!label.value.trim()) label.value = (pathPickerSelected.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || pathPickerSelected).slice(0, 80);
  closePathPicker();
  input.focus();
}

document.addEventListener('DOMContentLoaded', () => {
  $('pathPickerForm').addEventListener('submit', event => { event.preventDefault(); void browsePickerPath($('pathPickerAddress').value.trim()); });
  $('pathPickerUp').onclick = () => { if (pathPickerParent) void browsePickerPath(pathPickerParent); };
  $('pathPickerRoots').onclick = () => { void browsePickerPath('', true); };
  $('pathPickerCancel').onclick = closePathPicker;
  $('pathPickerUse').onclick = usePickerPath;
  $('pathPickerDialog').addEventListener('cancel', event => { event.preventDefault(); closePathPicker(); });
  $('pathPickerDialog').addEventListener('close', () => { pathPickerGeneration++; pathPickerTarget = null; pathPickerSelected = ''; });
});
