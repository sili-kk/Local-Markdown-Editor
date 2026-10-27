'use strict';

const externalChanges = {
  checking: null, changed: false, reloading: false, generation: 0, lastEdit: Date.now(),
};
const idleCheckDelay = 30000;

function resetExternalChanges() {
  externalChanges.generation++;
  externalChanges.checking = null;
  externalChanges.changed = false;
  externalChanges.lastEdit = Date.now();
  $('externalChangeDialog').close();
}

function showExternalChangeDialog() {
  if (!externalChanges.changed || externalChanges.reloading || state.composing || $('externalChangeDialog').open) return;
  clearTimeout(state.saveTimer);
  $('externalChangeDescription').textContent = dirty()
    ? '本地文件已被其他程序或设备修改，请重新加载最新内容。当前网页有未保存的修改，重新加载会丢弃这些修改；也可保留草稿，稍后点击“保存”进行合并。'
    : '本地文件已被其他程序或设备修改，请重新加载最新内容后继续编辑。';
  $('externalChangeDialog').showModal();
  status('本地文件已更新，等待重新加载', true);
}

async function checkExternalChanges(forSave = false) {
  if (externalChanges.reloading) return false;
  if (externalChanges.changed) {
    showExternalChangeDialog();
    return false;
  }
  if (externalChanges.checking) return externalChanges.checking;
  // A retained draft uses the existing three-way merge on the next manual save.
  if (!state.path || state.loading || state.merging || state.conflict) return true;
  if (!forSave && (state.navigating || state.saving || document.querySelector('dialog[open]'))) return true;
  const path = state.path, revision = state.revision, generation = externalChanges.generation;
  const task = (async () => {
    try {
      const latest = await api('/api/file?path=' + encodeURIComponent(path) + '&revision_only=1');
      // Ignore an old response after switching, reloading or saving a document.
      if (state.path !== path || state.revision !== revision || externalChanges.generation !== generation) return false;
      if (latest.access) applyDocumentAccess(latest.access);
      if (forSave && state.readOnly) return false;
      if (latest.revision === revision) return true;
      externalChanges.changed = true;
      clearTimeout(state.saveTimer);
      showExternalChangeDialog();
      return false;
    } catch (error) {
      if (state.path === path && state.revision === revision && externalChanges.generation === generation) {
        notice('检查本地文件失败：' + error.message + '。网页修改仍保留，请稍后重试保存或重新加载。');
        status('无法确认本地文件版本', true);
      }
      return false;
    }
  })();
  externalChanges.checking = task;
  try { return await task; } finally {
    if (externalChanges.checking === task) externalChanges.checking = null;
  }
}

function retainExternalDraft() {
  externalChanges.changed = false;
  state.conflict = true;
  clearTimeout(state.saveTimer);
  $('externalChangeDialog').close();
  notice('已保留网页内容并暂停自动保存。点击“保存”可合并本地修改，或点击“重新加载”读取最新文件。');
  status('网页内容已保留，等待重新加载或合并', true);
}

document.addEventListener('DOMContentLoaded', () => {
  $('externalChangeKeep').onclick = retainExternalDraft;
  $('externalChangeDialog').addEventListener('cancel', event => {
    event.preventDefault();
    retainExternalDraft();
  });
  $('externalChangeReload').onclick = async () => {
    // navigate retains its discard confirmation and preserves the draft if loading fails.
    externalChanges.reloading = true;
    $('externalChangeDialog').close();
    try { await navigate(state.path, true); } finally {
      externalChanges.reloading = false;
      showExternalChangeDialog();
    }
  };
  window.addEventListener('focus', () => { void checkExternalChanges(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void checkExternalChanges();
  });
  setInterval(() => {
    if (!document.hidden && Date.now() - externalChanges.lastEdit >= idleCheckDelay) {
      void checkExternalChanges();
    }
  }, 15000);
});
