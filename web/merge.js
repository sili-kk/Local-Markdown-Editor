'use strict';

// 使用与正文一致的转换规则比较内容，避免列表符号等格式差异造成虚假冲突。
function normalizeMarkdown(markdown) {
  assertDocumentMemory(markdown);
  const host = document.createElement('div');
  host.hidden = true;
  document.body.append(host);
  let editor;
  try {
    editor = new toastui.Editor({
      el: host, height: '200px', initialEditType: 'wysiwyg',
      hideModeSwitch: true, autofocus: false, usageStatistics: false,
      frontMatter: true, toolbarItems: [], initialValue: prepareDocumentMarkdown(markdown),
      plugins: [...tableEditorPlugins(), () => ({ wysiwygNodeViews: {
        image: () => ({ dom: document.createElement('span') }),
      } })],
    });
    return editor.getMarkdown();
  } finally {
    editor?.destroy();
    host.remove();
  }
}

function mergeRegions(base, browser, disk) {
  return Diff3.diff3Merge(browser.split('\n'), base.split('\n'), disk.split('\n'), { excludeFalseConflicts: true });
}

function assembleMerge(regions, choices) {
  return regions.flatMap((region, index) => {
    if (region.ok) return region.ok;
    const { a, b } = region.conflict;
    if (choices.get(index) === 'browser') return a;
    if (choices.get(index) === 'disk') return b;
    if (choices.get(index) === 'both') return a.length && b.length ? [...a, '', ...b] : [...a, ...b];
    throw new Error('请为每处冲突选择保留方式');
  }).join('\n');
}

async function previewMergeFragment(markdown, container) {
  if (!markdown) { container.textContent = '此版本已删除这段内容'; return; }
  const data = await api('/api/render', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: markdown }),
  });
  // 后端禁用原始 HTML；移除预览中的外部资源，链接只用于展示。
  const template = document.createElement('template');
  template.innerHTML = data.html;
  template.content.querySelectorAll('img').forEach(img => {
    const label = document.createElement('span');
    label.textContent = '[图片：' + (img.alt || '未命名') + ']';
    img.replaceWith(label);
  });
  template.content.querySelectorAll('a').forEach(link => link.removeAttribute('href'));
  container.replaceChildren(template.content);
}

async function chooseMerge(regions) {
  const conflicts = regions.map((region, index) => ({ ...region, index })).filter(region => region.conflict);
  if (!conflicts.length) return assembleMerge(regions, new Map());
  const dialog = $('mergeDialog'), list = $('mergeConflicts'), apply = $('mergeApply');
  const choices = new Map();
  list.replaceChildren();
  apply.disabled = true;
  const progress = () => { $('mergeProgress').textContent = '已选择 ' + choices.size + ' / ' + conflicts.length + ' 处'; };
  progress();
  const previews = [];
  for (const { conflict, index } of conflicts) {
    const card = document.createElement('fieldset');
    card.className = 'merge-conflict';
    const legend = document.createElement('legend');
    legend.textContent = '冲突 ' + (list.children.length + 1);
    const versions = document.createElement('div');
    versions.className = 'merge-versions';
    for (const [title, lines] of [['网页中的修改', conflict.a], ['本地文件的修改', conflict.b]]) {
      const version = document.createElement('div'), heading = document.createElement('h3'), body = document.createElement('div');
      heading.textContent = title;
      body.className = 'merge-preview toastui-editor-contents';
      body.textContent = '正在生成预览…';
      version.append(heading, body); versions.append(version);
      previews.push(previewMergeFragment(lines.join('\n'), body).catch(() => {
        // 预览请求失败时仍允许查看全部文本并选择，草稿不会被丢弃。
        body.textContent = lines.join('\n') || '此版本已删除这段内容';
      }));
    }
    const options = document.createElement('div'); options.className = 'merge-options';
    for (const [value, text] of [['browser', '保留网页'], ['disk', '保留本地'], ['both', '两者都保留（网页在前）']]) {
      const label = document.createElement('label'), radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'conflict-' + index; radio.value = value;
      radio.onchange = () => { choices.set(index, value); apply.disabled = choices.size !== conflicts.length; progress(); };
      label.append(radio, document.createTextNode(text)); options.append(label);
    }
    card.append(legend, versions, options); list.append(card);
  }
  // 立即显示选择框，慢预览不会阻塞取消操作。
  void Promise.all(previews);
  return new Promise(resolve => {
    const finish = result => {
      dialog.removeEventListener('cancel', cancel);
      $('mergeCancel').onclick = null; apply.onclick = null;
      dialog.close(); resolve(result);
    };
    const cancel = event => { event.preventDefault(); finish(null); };
    dialog.addEventListener('cancel', cancel);
    $('mergeCancel').onclick = () => finish(null);
    apply.onclick = () => { if (!apply.disabled) finish(assembleMerge(regions, choices)); };
    dialog.showModal();
    $('mergeCancel').focus();
  });
}
