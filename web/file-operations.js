'use strict';

let fileMutationBusy = false, documentEventSource = null, documentEventPath = '', documentEventGeneration = 0;
let deletionPrompt = null;

function confirmDocumentDelete(path, final = false) {
  const dialog = $('deleteConfirmDialog');
  dialog.dataset.final = String(final);
  $('deleteConfirmStep').textContent = final ? '最后确认 · 2 / 2' : '删除确认 · 1 / 2';
  $('deleteConfirmTitle').textContent = final ? '确定永久删除？' : '删除这篇文档？';
  $('deleteConfirmPath').textContent = displayLibraryPath(path);
  $('deleteConfirmDescription').textContent = final ? '删除后无法撤销，正在阅读的用户会收到文件已删除通知，并停止读取。' : '确认后还需再次确认。文档中的未保存修改也会丢弃，请确认已保留需要的内容。';
  $('deleteConfirmProceed').textContent = final ? '确认永久删除' : '继续确认';
  return new Promise(resolve => {
    const finish = confirmed => {
      dialog.removeEventListener('cancel', cancel);
      $('deleteConfirmCancel').onclick = null; $('deleteConfirmProceed').onclick = null;
      deletionPrompt = null; dialog.close(); resolve(confirmed);
    };
    const cancel = event => { event?.preventDefault(); finish(false); };
    deletionPrompt = { path, cancel };
    $('deleteConfirmCancel').onclick = () => finish(false);
    $('deleteConfirmProceed').onclick = () => finish(true);
    dialog.addEventListener('cancel', cancel); dialog.showModal();
    $('deleteConfirmCancel').focus({ preventScroll: true });
  });
}

function syncFileOperationButtons() {
  const enabled = state.localAdmin && state.fileOperations;
  $('createDocument').hidden = !enabled || !state.folders.length;
  $('createDocument').disabled = fileMutationBusy || state.navigating || !enabled;
  if (typeof syncLibraryContextMenu === 'function') syncLibraryContextMenu();
}

function openCreateDocument(directory = '') {
  if (!state.localAdmin || !state.fileOperations || fileMutationBusy || state.navigating) return;
  $('createDirectory').replaceChildren();
  for (const path of state.folders) {
    const option = document.createElement('option'); option.value = path; option.textContent = displayLibraryPath(path); $('createDirectory').append(option);
  }
  const current = state.path.slice(0, state.path.lastIndexOf('/'));
  $('createDirectory').value = state.folders.includes(directory) ? directory : state.folders.includes(current) ? current : state.folders[0] || '';
  $('createName').value = ''; $('createMessage').textContent = '';
  $('createDocumentDialog').showModal(); $('createName').focus();
}

function showDeletedDocument(path) {
  if (deletionPrompt?.path === path) deletionPrompt.cancel();
  if (state.path !== path && state.unavailablePath !== path) return;
  libraryGeneration++;
  documentEventGeneration++;
  state.deletedDocument = path;
  if (state.path === path) revokeDocumentAccess();
  state.files = state.files.filter(item => item !== path);
  $('empty').textContent = '文件已被服务端删除，当前文档不可读取。请选择其他文档。';
  notice('文件已删除，已停止读取和保存。'); status('文件已删除 · 不可读取', true);
  $('deletedDocumentMessage').textContent = displayLibraryPath(path) + ' 已被服务端删除，当前文档不可读取。';
  if (!$('deletedDocumentDialog').open) $('deletedDocumentDialog').showModal();
  drawFiles();
}

function syncDocumentEvents() {
  if (documentEventPath === state.path) return;
  documentEventSource?.close(); documentEventSource = null; documentEventPath = state.path;
  if (!state.path || typeof EventSource !== 'function') return;
  const path = state.path;
  const source = new EventSource('/api/document-events?path=' + encodeURIComponent(path));
  documentEventSource = source;
  source.addEventListener('deleted', () => { source.close(); showDeletedDocument(path); });
  source.addEventListener('unavailable', () => {
    source.close();
    if (state.path === path) { libraryGeneration++; state.files = state.files.filter(item => item !== path); revokeDocumentAccess(); drawFiles(); }
  });
  source.addEventListener('error', async () => {
    if (state.path !== path) return;
    try { await api('/api/file?path=' + encodeURIComponent(path) + '&revision_only=1'); }
    catch (error) {
      if (error.status === 404 && state.path === path) {
        libraryGeneration++;
        source.close(); state.files = state.files.filter(item => item !== path);
        revokeDocumentAccess(); drawFiles(); notice('文件已删除或不可访问，已停止读取和保存。');
      }
    }
  });
}

async function deleteDocument(path) {
  if (!state.localAdmin || !state.fileOperations || fileMutationBusy || state.navigating) return;
  const label = displayLibraryPath(path);
  fileMutationBusy = true; syncFileOperationButtons();
  try {
    if (!await confirmDocumentDelete(path)) return;
    if (state.saving) await state.saving;
    const ticket = await api('/api/documents/delete-confirmation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    if (!await confirmDocumentDelete(path, true)) return;
    await api('/api/documents', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, token: ticket.token }) });
    showDeletedDocument(path);
    applyLibraryData(await api('/api/files')); drawFiles();
    notice('已删除文档：' + label);
  } catch (error) { notice('删除未完成：' + error.message); }
  finally { fileMutationBusy = false; syncFileOperationButtons(); }
}

document.addEventListener('DOMContentLoaded', () => {
  $('createDocument').onclick = () => openCreateDocument();
  $('createCancel').onclick = () => $('createDocumentDialog').close();
  $('deletedDocumentClose').onclick = () => $('deletedDocumentDialog').close();
  $('createDocumentDialog').addEventListener('cancel', event => { if (fileMutationBusy) event.preventDefault(); });
  $('createDocumentForm').onsubmit = async event => {
    event.preventDefault();
    if (!state.localAdmin || !state.fileOperations || fileMutationBusy) return;
    let name = $('createName').value.trim();
    if (!/\.(md|markdown)$/i.test(name)) name += '.md';
    fileMutationBusy = true; $('createFields').disabled = true; $('createSave').disabled = true; $('createCancel').disabled = true; syncFileOperationButtons();
    try {
      if (!await flush()) throw new Error('请先处理当前文档未保存的修改。');
      const data = await api('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory: $('createDirectory').value, name }) });
      $('createDocumentDialog').close();
      applyLibraryData(await api('/api/files'));
      const parts = data.path.split('/'); parts.pop();
      while (parts.length) { state.expandedFolders.add(parts.join('/')); parts.pop(); }
      writeBrowsingPaths('mojian.expandedFolders', [...state.expandedFolders]);
      drawFiles(); await navigate(data.path); notice('已新建文档：' + displayLibraryPath(data.path));
    } catch (error) { $('createMessage').textContent = error.message; notice(error.message); }
    finally { fileMutationBusy = false; $('createFields').disabled = false; $('createSave').disabled = false; $('createCancel').disabled = false; syncFileOperationButtons(); }
  };
  window.addEventListener('pagehide', () => { documentEventSource?.close(); documentEventPath = ''; });
  window.addEventListener('pageshow', syncDocumentEvents);
});
