'use strict';

function tableEditorPlugins() {
  return [toastui.Editor.plugin.tableMergedCell];
}

function markdownLiteralRanges(markdown) {
  const ranges = [];
  let offset = 0, fence = null;
  for (const line of markdown.split(/(?<=\n)/)) {
    const marker = line.match(/^[ \t>]*(?:[-+*] |\d+[.)] )?(`{3,}|~{3,})([^\r\n]*)/);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) {
        ranges.push([fence.start, offset + line.length]); fence = null;
      }
    } else if (marker) {
      fence = { start: offset, char: marker[1][0], length: marker[1].length };
    } else if (/^(?: {4}|\t)/.test(line)) ranges.push([offset, offset + line.length]);
    offset += line.length;
  }
  if (fence) ranges.push([fence.start, markdown.length]);
  // HTML 中明确表示代码的内容、注释均原样保留。
  const htmlLiterals = /<!--[^]*?-->|<(pre|code|script|style|textarea)\b[^>]*>[^]*?<\/\1\s*>/gi;
  for (const match of markdown.matchAll(htmlLiterals)) ranges.push([match.index, match.index + match[0].length]);
  const protectedAt = index => ranges.some(([start, end]) => start <= index && index < end);
  const ticks = /`+/g;
  let match;
  while ((match = ticks.exec(markdown))) {
    if (protectedAt(match.index) || isMarkdownEscaped(markdown, match.index)) continue;
    const closing = new RegExp('(?<!`)' + match[0] + '(?!`)', 'g');
    closing.lastIndex = ticks.lastIndex;
    const end = closing.exec(markdown);
    if (end) { ranges.push([match.index, closing.lastIndex]); ticks.lastIndex = closing.lastIndex; }
  }
  return ranges;
}

function isMarkdownEscaped(markdown, index) {
  let slashes = 0;
  while (index > 0 && markdown[--index] === '\\') slashes++;
  return slashes % 2 === 1;
}

// Some documents separate groups of table rows with blank lines. Only join
// explicit pipe rows back to an established table with the same column count.
function joinMarkdownTableContinuations(markdown) {
  if (!markdown.includes('|')) return markdown;
  const ranges = markdownLiteralRanges(markdown);
  const frontMatter = markdown.match(/^---\n[^]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/);
  if (frontMatter) ranges.push([0, frontMatter[0].length]);
  ranges.sort((a, b) => a[0] - b[0]);
  const lines = markdown.split('\n');
  const rows = [];
  let offset = 0, rangeIndex = 0;
  for (const line of lines) {
    while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= offset) rangeIndex++;
    const protectedLine = rangeIndex < ranges.length && ranges[rangeIndex][0] <= offset;
    const cells = [];
    let start = 0;
    if (!protectedLine && !/^(?: {4}|\t)/.test(line)) {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '|' && !isMarkdownEscaped(line, i)) {
          cells.push(line.slice(start, i).trim());
          start = i + 1;
        }
      }
    }
    if (cells.length) {
      cells.push(line.slice(start).trim());
      if (!cells[0]) cells.shift();
      if (!cells[cells.length - 1]) cells.pop();
      rows.push(cells);
    } else rows.push(null);
    offset += line.length + 1;
  }
  const separator = index => rows[index]?.length && rows[index].every(cell => /^:?-+:?$/.test(cell));
  const header = index => rows[index]?.length && separator(index + 1) && rows[index].length === rows[index + 1].length;
  const output = [];
  let columns = 0;
  for (let i = 0; i < lines.length; i++) {
    if (header(i)) {
      columns = rows[i].length;
      output.push(lines[i], lines[++i]);
      continue;
    }
    if (columns && !lines[i].trim()) {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      // A new header/delimiter pair is a separate table, even with equal width.
      const explicitRow = next < lines.length && /^ {0,3}\|/.test(lines[next]) && /\|[ \t]*$/.test(lines[next]) &&
        !isMarkdownEscaped(lines[next], lines[next].lastIndexOf('|'));
      if (explicitRow && rows[next]?.length === columns && !separator(next) && !header(next)) {
        i = next - 1;
        continue;
      }
      columns = 0;
    } else if (columns && rows[i]?.length !== columns) columns = 0;
    output.push(lines[i]);
  }
  return output.join('\n');
}

function cleanTableHTML(source, memoryTracker) {
  // 在惰性 template 中解析，不把原 HTML 插入当前页面。
  const template = document.createElement('template');
  template.innerHTML = source;
  const table = template.content.querySelector('table');
  if (!table || table.querySelector('table, caption')) return null;
  let looseText = '';
  for (const node of template.content.childNodes) {
    if (node === table || node.nodeType === Node.COMMENT_NODE) continue;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    looseText += node.textContent;
  }
  // 浏览器会将混在 HTML 表格中的 Markdown 分隔线移出表格，只忽略这种残留。
  if (looseText.trim() && !/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(looseText)) return null;
  const rows = [...table.rows];
  if (!rows.length || !rows[0].cells.length) return null;
  const columns = Math.max(...rows.map(row => [...row.cells].reduce((sum, cell) => sum + cell.colSpan, 0)));
  assertTableMemory(rows, columns, memoryTracker);
  // 旧文档中的“人工填写”只有一格，恢复其横跨整行的含义。
  for (const row of rows.slice(1)) {
    if (row.cells.length === 1 && row.cells[0].colSpan === 1 && /人工填写/.test(row.textContent)) row.cells[0].colSpan = columns;
  }
  const allowedTags = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'P', 'BR',
    'B', 'STRONG', 'I', 'EM', 'DEL', 'S', 'STRIKE', 'CODE', 'PRE', 'A', 'IMG', 'UL', 'OL', 'LI', 'SPAN', 'DIV', 'BLOCKQUOTE']);
  for (const element of [table, ...table.querySelectorAll('*')]) {
    if (!allowedTags.has(element.tagName)) return null;
    if (['TH', 'TD'].includes(element.tagName) && ['left', 'center', 'right'].includes(element.style.textAlign)) element.setAttribute('align', element.style.textAlign);
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      const permitted = (['TH', 'TD'].includes(element.tagName) && ['colspan', 'rowspan', 'align'].includes(name)) ||
        (element.tagName === 'A' && ['href', 'title'].includes(name)) ||
        (element.tagName === 'IMG' && ['src', 'alt', 'title'].includes(name));
      if (!permitted) element.removeAttribute(attr.name);
      else if (['href', 'src'].includes(name)) {
        const value = attr.value.replace(/[\u0000-\u0020]/g, '');
        if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^(?:https?|mailto):/i.test(value)) element.removeAttribute(attr.name);
      }
    }
  }
  // Markdown 强调标记紧贴“中文冒号 + 正文”时无法闭合，补足排版边界。
  for (const mark of table.querySelectorAll('b, strong, i, em, del, s, strike')) {
    const punctuation = /[\p{P}\p{S}]/u;
    const first = [...mark.textContent][0], last = [...mark.textContent].pop();
    const before = mark.previousSibling?.textContent?.slice(-1), after = mark.nextSibling?.textContent?.[0];
    if (first && punctuation.test(first) && before && !/\s/.test(before) && !punctuation.test(before)) mark.before(document.createTextNode(' '));
    if (last && punctuation.test(last) && after && !/\s/.test(after) && !punctuation.test(after)) mark.after(document.createTextNode(' '));
  }
  return table.outerHTML;
}

// 只在编辑器内修复分段表格和 HTML/Markdown 混排；只阅读不写回原文档。
function prepareDocumentMarkdown(markdown) {
  const tableMemory = { used: assertDocumentMemory(markdown) };
  markdown = markdown.replace(/\r+\n|\r/g, '\n');
  markdown = joinMarkdownTableContinuations(markdown);
  if (!/<table\b/i.test(markdown)) return markdown;
  const literals = markdownLiteralRanges(markdown);
  const tables = /<table\b[^>]*>[^]*?<\/table\s*>/gi;
  let host, converter;
  try {
    const prepared = markdown.replace(tables, (source, index) => {
      if (isMarkdownEscaped(markdown, index) || literals.some(([start, end]) => start <= index && index < end)) return source;
      const html = cleanTableHTML(source, tableMemory);
      if (!html) return source;
      if (!converter) {
        host = document.createElement('div'); host.hidden = true; document.body.append(host);
        converter = new toastui.Editor({
          el: host, height: '200px', initialEditType: 'wysiwyg', hideModeSwitch: true,
          autofocus: false, usageStatistics: false, frontMatter: true, toolbarItems: [],
          plugins: [...tableEditorPlugins(), () => ({ wysiwygNodeViews: {
            image: () => ({ dom: document.createElement('span') }),
          } })],
        });
      }
      converter.setHTML(html, false);
      return '\n\n' + converter.getMarkdown().trim() + '\n\n';
    });
    assertDocumentMemory(prepared, false);
    return prepared;
  } finally {
    converter?.destroy(); host?.remove();
  }
}
