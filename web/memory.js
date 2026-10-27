'use strict';

function documentMemoryLimits() {
  return state.limits || { memory_bytes: 128 * 1024 * 1024, max_bytes: 1024 * 1024 };
}

function assertDocumentMemory(markdown, checkHeap = true) {
  const limits = documentMemoryLimits();
  let bytes = 0, lines = 1, markers = 0;
  for (let i = 0; i < markdown.length; i++) {
    const char = markdown.charCodeAt(i);
    if (char <= 0x7f) bytes++;
    else if (char <= 0x7ff) bytes += 2;
    else if (char >= 0xd800 && char <= 0xdbff && i + 1 < markdown.length && markdown.charCodeAt(i + 1) >= 0xdc00 && markdown.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
    if (char === 10) lines++;
    if (char === 124 || char === 91 || char === 96) markers++;
    if (bytes > limits.max_bytes || bytes * 128 + lines * 1024 + markers * 512 > limits.memory_bytes) {
      throw new Error('文档超过单篇 ' + Math.round(limits.memory_bytes / 1024 / 1024) + ' MB 的内存预算，已停止加载。请拆分文档或提高内存预算。');
    }
  }
  const estimate = bytes * 128 + lines * 1024 + markers * 512;
  // Chromium exposes this optional signal. Source/structure guards above also
  // apply in browsers without heap statistics; neither is a browser hard cap.
  const heap = globalThis.performance?.memory;
  if (checkHeap && heap?.jsHeapSizeLimit > 0 && heap.usedJSHeapSize + estimate > heap.jsHeapSizeLimit * 0.8) {
    throw new Error('浏览器可用内存不足，已停止加载。请关闭其他文档页面后重试。');
  }
  return estimate;
}

function assertTableMemory(rows, columns, tracker) {
  const slots = rows.reduce((sum, row) => sum + [...row.cells].reduce((count, cell) => count + cell.colSpan * Math.max(1, cell.rowSpan), 0), 0);
  const estimate = Math.max(slots, rows.length * columns) * 4096;
  if ((tracker?.used || 0) + estimate > documentMemoryLimits().memory_bytes) {
    throw new Error('表格展开后超过文档内存预算，已停止加载。请缩小表格或拆分合并单元格。');
  }
  if (tracker) tracker.used += estimate;
}
