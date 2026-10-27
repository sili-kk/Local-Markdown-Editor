'use strict';

const viewerSession = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
const viewerState = { path: '', ips: [], viewers: [], self: '', pending: false, leaving: false, expanded: false, ready: false };

// Derive identity colours from the IP, so polling, reordering and reloads keep
// the same colour. Mix the hash to separate neighbouring IPv4/IPv6 addresses.
function viewerIPColor(ip) {
  let hash = 2166136261;
  for (const char of ip) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return 'hsl(' + (hash % 3600) / 10 + ' ' + (66 + (hash >>> 12) % 14) + '% ' + (46 + (hash >>> 20) % 10) + '%)';
}

function renderDocumentViewers() {
  const list = $('viewerList');
  const focusedIP = list.contains(document.activeElement) ? document.activeElement.dataset.ip : '';
  const byIP = new Map(viewerState.viewers.map(viewer => [viewer.ip, viewer]));
  list.replaceChildren();
  for (const ip of viewerState.ips) {
    const viewer = byIP.get(ip);
    const documents = (viewer?.documents || []).map(path => displayLibraryPath(path));
    if (viewer?.unavailable) documents.push('其他不可访问的文档');
    const activity = documents.length ? documents.join('\n') : '未打开文档';
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'viewer-dot';
    dot.dataset.ip = ip;
    dot.style.setProperty('--viewer-color', viewerIPColor(ip));
    const identity = ip + (ip === viewerState.self ? '（当前 IP）' : '');
    dot.title = identity + '\n正在查看：\n' + activity;
    dot.setAttribute('aria-label', identity + '，正在查看：' + activity);
    const detail = document.createElement('span'); detail.className = 'viewer-details';
    const label = document.createElement('strong'); label.className = 'viewer-ip'; label.textContent = identity;
    const reading = document.createElement('span'); reading.className = 'viewer-documents'; reading.textContent = activity;
    detail.append(label, reading); dot.append(detail);
    dot.onclick = () => { viewerState.expanded = true; layoutDocumentViewers(); };
    list.append(dot);
    if (ip === focusedIP) dot.focus({ preventScroll: true });
  }
  $('viewerCount').textContent = '共 ' + viewerState.ips.length + ' 人查看';
  $('viewerCount').title = '所有文档合计，按访问 IP 去重；同一 IP 的多个标签页只计 1 人';
  layoutDocumentViewers();
}

function layoutDocumentViewers() {
  const bar = $('documentViewers'), list = $('viewerList'), toggle = $('toggleViewers');
  // Calculate capacity from the whole row, independently of expanded layout.
  const style = getComputedStyle(bar);
  const gap = parseFloat(style.columnGap) || 0;
  const dotWidth = parseFloat(style.getPropertyValue('--viewer-dot-width'));
  const dotGap = parseFloat(style.getPropertyValue('--viewer-dot-gap'));
  const toggleWidth = parseFloat(style.getPropertyValue('--viewer-toggle-width'));
  const available = Math.max(0, bar.clientWidth - $('viewerCount').offsetWidth - gap);
  const capacity = Math.max(0, Math.floor((available - (viewerState.ips.length ? toggleWidth + gap : 0) + dotGap) / (dotWidth + dotGap)));
  if (!viewerState.ips.length) viewerState.expanded = false;
  toggle.hidden = !viewerState.ips.length;
  const hidden = Math.max(0, viewerState.ips.length - capacity);
  toggle.textContent = viewerState.expanded ? '收起' : hidden ? '+' + hidden + ' 展开' : '详情';
  toggle.setAttribute('aria-expanded', String(viewerState.expanded));
  bar.dataset.expanded = String(viewerState.expanded);
  [...list.children].forEach((dot, index) => { dot.hidden = !viewerState.expanded && index >= capacity; });
}

function leaveDocumentViewers() {
  const body = JSON.stringify({ session: viewerSession, action: 'leave' });
  if (!navigator.sendBeacon?.('/api/viewers', new Blob([body], { type: 'application/json' }))) {
    void fetch('/api/viewers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }
}

function syncDocumentViewers() {
  syncDocumentEvents();
  viewerState.path = state.path;
  if (!viewerState.ready && !$('viewerCount').dataset.error) $('viewerCount').textContent = '连接中…';
  void refreshDocumentViewers();
}

async function refreshDocumentViewers() {
  if (viewerState.pending || viewerState.leaving) return;
  viewerState.pending = true;
  const path = state.path;
  try {
    const data = await api('/api/viewers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: viewerSession, path, action: 'heartbeat' }),
      signal: AbortSignal.timeout(10000),
    });
    if (state.path !== path || viewerState.leaving) return;
    const viewers = data.viewers || data.ips.map(ip => ({ ip, documents: path ? [path] : [] }));
    if (!viewerState.ready || JSON.stringify(viewerState.ips) !== JSON.stringify(data.ips) || JSON.stringify(viewerState.viewers) !== JSON.stringify(viewers) || viewerState.self !== data.self || $('viewerCount').dataset.error) {
      viewerState.ips = data.ips;
      viewerState.viewers = viewers;
      viewerState.self = data.self;
      viewerState.ready = true;
      delete $('viewerCount').dataset.error;
      renderDocumentViewers();
    }
  } catch {
    if (state.path === path && !viewerState.leaving) {
      viewerState.ips = [];
      viewerState.viewers = [];
      viewerState.expanded = false;
      renderDocumentViewers();
      $('viewerCount').textContent = '在线状态暂不可用';
      $('viewerCount').dataset.error = 'true';
    }
  } finally {
    viewerState.pending = false;
    if (state.path !== path) syncDocumentViewers();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('toggleViewers').onclick = () => {
    viewerState.expanded = !viewerState.expanded;
    layoutDocumentViewers();
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(layoutDocumentViewers).observe($('documentViewers'));
  window.addEventListener('resize', layoutDocumentViewers);
  document.addEventListener('pointerdown', event => {
    if (viewerState.expanded && !$('documentViewers').contains(event.target)) {
      viewerState.expanded = false;
      layoutDocumentViewers();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && viewerState.expanded) {
      viewerState.expanded = false;
      layoutDocumentViewers();
      $('toggleViewers').focus({ preventScroll: true });
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncDocumentViewers(); });
  window.addEventListener('pagehide', () => { viewerState.leaving = true; leaveDocumentViewers(); });
  window.addEventListener('pageshow', () => { viewerState.leaving = false; syncDocumentViewers(); });
  setInterval(refreshDocumentViewers, 15000);
  syncDocumentViewers();
});
