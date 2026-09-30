// ==UserScript==
// @name         复旦 eLearning 文档弹窗预览
// @namespace    https://elearning.fudan.edu.cn/
// @version      1.1.4
// @description  在 eLearning 页面中预览 PDF、Word(docx) 与 PowerPoint(pptx)，无需自动保存文件
// @license      MIT
// @homepageURL  https://github.com/Shauzn-527/fudan-elearning-pdf-preview
// @supportURL   https://github.com/Shauzn-527/fudan-elearning-pdf-preview/issues
// @updateURL    https://raw.githubusercontent.com/Shauzn-527/fudan-elearning-pdf-preview/main/elearning-pdf-preview.user.js
// @downloadURL  https://raw.githubusercontent.com/Shauzn-527/fudan-elearning-pdf-preview/main/elearning-pdf-preview.user.js
// @match        https://elearning.fudan.edu.cn/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const EXTENSIONS = {
    pdf: { label: 'PDF', mime: 'application/pdf' },
    docx: {
      label: 'Word 文档',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    pptx: {
      label: 'PowerPoint 演示文稿',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    },
  };

  function extensionOf(text) {
    if (!text) return null;
    const match = text.match(/\.(pdf|docx|pptx)(?:[?#]|$)/i);
    return match ? match[1].toLowerCase() : null;
  }

  // Office 解析库按需加载：仅在打开 docx/pptx 时才拉取，PDF 预览不依赖任何第三方库。
  const LIBRARY_SOURCES = {
    mammoth: {
      url: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
      global: 'mammoth',
      requires: [],
    },
    jszip: {
      url: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
      global: 'JSZip',
      requires: [],
    },
    chartjs: {
      url: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js',
      global: 'Chart',
      requires: [],
    },
    pptxviewjs: {
      url: 'https://cdn.jsdelivr.net/npm/pptxviewjs@1.1.9/dist/PptxViewJS.min.js',
      global: 'PptxViewJS',
      requires: ['chartjs', 'jszip'],
      // pptxviewjs 的 UMD 走 CommonJS 分支时会 require 这两个外部依赖。
      requireMap: { 'chart.js/auto': 'chartjs', jszip: 'jszip' },
    },
  };
  const libraryPromises = {};

  function fetchText(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('浏览器扩展未提供脚本加载功能。'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 60000,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`依赖加载失败（HTTP ${response.status}）。`));
          } else if (!response.responseText) {
            reject(new Error('依赖文件为空。'));
          } else {
            resolve(response.responseText);
          }
        },
        onerror: () => reject(new Error('依赖加载失败。')),
        ontimeout: () => reject(new Error('依赖加载超时。')),
      });
    });
  }

  // 以受控的 CommonJS 方式执行第三方 UMD 库，直接拿到 module.exports，
  // 不依赖 Tampermonkey 沙箱里 window / self / globalThis 是否为同一对象，
  // 也避免库把结果写到 window 而脚本去 globalThis 上找不到。
  function evaluateModule(source, resolveRequire) {
    const module = { exports: {} };
    const require = (id) => {
      const resolved = resolveRequire ? resolveRequire(id) : undefined;
      if (resolved == null) throw new Error(`预览组件依赖 ${id} 未加载。`);
      return resolved;
    };
    const factory = new Function('module', 'exports', 'require', source);
    factory(module, module.exports, require);
    return module.exports;
  }

  function loadLibrary(name) {
    if (libraryPromises[name]) return libraryPromises[name];
    const lib = LIBRARY_SOURCES[name];
    libraryPromises[name] = (async () => {
      const dependencies = {};
      for (const dep of lib.requires) dependencies[dep] = await loadLibrary(dep);
      const source = await fetchText(lib.url);
      const value = evaluateModule(source, (id) => {
        const depName = lib.requireMap && lib.requireMap[id];
        return depName ? dependencies[depName] : undefined;
      });
      if (!value) throw new Error(`预览组件 ${name} 加载后未就绪。`);
      return value;
    })();
    return libraryPromises[name];
  }

  function fileLinkFromClick(event) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return null;
    }

    const link = event.target?.nodeType === 1 ? event.target.closest('a[href]') : null;
    if (!link || link.hasAttribute('download')) return null;
    if (link.matches('.download, .download_link, [aria-label*="Download"], [aria-label*="下载"]')) {
      return null;
    }

    let url;
    try {
      url = new URL(link.href, location.href);
    } catch {
      return null;
    }
    if (url.origin !== location.origin) return null;

    const fileMatch = url.pathname.match(/^(\/(?:courses\/\d+\/)?files\/\d+)(?:\/.*)?$/);
    const label = [link.textContent, link.title, link.dataset.filename]
      .filter(Boolean)
      .join(' ');
    const ext = extensionOf(label) || (!fileMatch && extensionOf(url.pathname));
    if (!ext || !EXTENSIONS[ext]) return null;

    const name = (link.dataset.filename || link.textContent || link.title || '').trim() || ext;
    const downloadUrl = fileMatch
      ? new URL(`${fileMatch[1]}/download?download_frd=1`, location.origin)
      : url;
    return { link, url, name, ext, downloadUrl };
  }

  const state = {
    root: null,
    title: null,
    status: null,
    viewer: null,
    canvasHost: null,
    canvas: null,
    prevButton: null,
    nextButton: null,
    slideIndicator: null,
    originalLink: null,
    downloadLink: null,
    closeButton: null,
    trigger: null,
    controller: null,
    pptxViewer: null,
    objectUrls: [],
    requestId: 0,
    oldOverflow: '',
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function ensureDialog() {
    if (state.root) return;

    const style = element('style');
    style.textContent = `
      .fdfile-overlay[hidden], .fdfile-overlay [hidden] { display: none !important; }
      .fdfile-overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex;
        align-items: center; justify-content: center; padding: 16px; box-sizing: border-box;
        background: rgba(15, 23, 42, .68); font: 14px/1.5 system-ui, sans-serif; }
      .fdfile-dialog { display: flex; flex-direction: column; width: min(1200px, 100%);
        height: min(900px, 100%); min-height: 280px; overflow: hidden; border-radius: 12px;
        background: #fff; box-shadow: 0 20px 70px rgba(0, 0, 0, .35); color: #1f2937; }
      .fdfile-header { display: flex; align-items: center; gap: 12px; min-height: 54px;
        box-sizing: border-box; padding: 10px 16px; border-bottom: 1px solid #e5e7eb; }
      .fdfile-title { flex: 1; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; font-size: 16px; font-weight: 600; }
      .fdfile-action { flex: none; border: 1px solid #cbd5e1; border-radius: 6px;
        padding: 6px 10px; background: #fff; color: #1d4ed8; text-decoration: none;
        font: inherit; cursor: pointer; }
      .fdfile-action:hover, .fdfile-action:focus-visible { background: #eff6ff; }
      .fdfile-close { color: #334155; }
      .fdfile-body { position: relative; flex: 1; min-height: 0; display: flex;
        align-items: center; justify-content: center; background: #e5e7eb; }
      .fdfile-status { position: absolute; z-index: 1; max-width: 420px; margin: 16px;
        padding: 18px 22px; border-radius: 8px; background: #fff; text-align: center;
        color: #334155; white-space: pre-line; box-shadow: 0 4px 18px #64748b44; }
      .fdfile-viewer { display: block; width: 100%; height: 100%; border: 0; background: #e5e7eb; }
      .fdfile-canvas-host { display: flex; flex-direction: column; align-items: center;
        justify-content: center; width: 100%; height: 100%; gap: 8px; }
      .fdfile-canvas { max-width: 100%; max-height: calc(100% - 52px); background: #fff; }
      .fdfile-slide-nav { display: flex; align-items: center; gap: 8px; }
      .fdfile-slide-indicator { min-width: 48px; text-align: center; color: #334155; }
      @media (max-width: 600px) {
        .fdfile-overlay { padding: 0; }
        .fdfile-dialog { height: 100%; min-height: 0; border-radius: 0; }
        .fdfile-header { flex-wrap: wrap; }
        .fdfile-title { flex-basis: 100%; }
      }
    `;

    const root = element('div', 'fdfile-overlay');
    root.hidden = true;
    const dialog = element('section', 'fdfile-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'fdfile-title');

    const header = element('header', 'fdfile-header');
    const title = element('h2', 'fdfile-title');
    title.id = 'fdfile-title';
    const originalLink = element('a', 'fdfile-action', '打开原文件');
    originalLink.hidden = true;
    originalLink.target = '_blank';
    originalLink.rel = 'noopener noreferrer';
    const downloadLink = element('a', 'fdfile-action', '下载');
    downloadLink.target = '_blank';
    downloadLink.rel = 'noopener noreferrer';
    const closeButton = element('button', 'fdfile-action fdfile-close', '关闭');
    closeButton.type = 'button';
    header.append(title, originalLink, downloadLink, closeButton);

    const body = element('div', 'fdfile-body');
    const status = element('div', 'fdfile-status', '正在读取文件…');
    status.setAttribute('role', 'status');

    const viewer = element('iframe', 'fdfile-viewer');
    viewer.title = '文档预览';
    viewer.hidden = true;

    const canvasHost = element('div', 'fdfile-canvas-host');
    canvasHost.hidden = true;
    const canvas = element('canvas', 'fdfile-canvas');
    const slideNav = element('div', 'fdfile-slide-nav');
    const prevButton = element('button', 'fdfile-action', '上一页');
    prevButton.type = 'button';
    const slideIndicator = element('span', 'fdfile-slide-indicator', '1 / 1');
    const nextButton = element('button', 'fdfile-action', '下一页');
    nextButton.type = 'button';
    slideNav.append(prevButton, slideIndicator, nextButton);
    canvasHost.append(canvas, slideNav);

    body.append(status, viewer, canvasHost);
    dialog.append(header, body);
    root.append(dialog);
    document.head.append(style);
    document.body.append(root);

    root.addEventListener('click', (event) => {
      if (event.target === root) closeDialog();
    });
    closeButton.addEventListener('click', closeDialog);
    prevButton.addEventListener('click', () => stepSlide(-1));
    nextButton.addEventListener('click', () => stepSlide(1));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !root.hidden) closeDialog();
    });

    Object.assign(state, {
      root, title, status, viewer, canvasHost, canvas,
      prevButton, nextButton, slideIndicator,
      originalLink, downloadLink, closeButton,
    });
  }

  function makeObjectUrl(blob) {
    const url = URL.createObjectURL(blob);
    state.objectUrls.push(url);
    return url;
  }

  function clearPending() {
    state.requestId += 1;
    state.controller?.abort();
    state.controller = null;
    state.pptxViewer = null;
    if (state.viewer) {
      state.viewer.onload = null;
      state.viewer.onerror = null;
      state.viewer.removeAttribute('src');
      state.viewer.hidden = true;
    }
    if (state.canvasHost) state.canvasHost.hidden = true;
    if (state.canvas) {
      state.canvas.width = 0;
      state.canvas.height = 0;
    }
    for (const url of state.objectUrls) URL.revokeObjectURL(url);
    state.objectUrls = [];
  }

  function closeDialog() {
    if (!state.root || state.root.hidden) return;
    clearPending();
    state.root.hidden = true;
    document.body.style.overflow = state.oldOverflow;
    state.trigger?.focus();
    state.trigger = null;
  }

  function showError(message) {
    state.viewer.hidden = true;
    if (state.canvasHost) state.canvasHost.hidden = true;
    state.status.hidden = false;
    state.status.textContent = `${message}\n可以打开原文件，或使用右上角的下载按钮。`;
    state.originalLink.hidden = false;
  }

  function requestThroughTampermonkey(url, signal) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('浏览器扩展未提供跨站文件读取功能。'));
        return;
      }
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      let request;
      let finished = false;
      const done = (callback) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => {
        request?.abort();
        done(() => reject(new DOMException('Aborted', 'AbortError')));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      try {
        request = GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'blob',
          timeout: 60000,
          headers: { Accept: '*/*' },
          onload: (response) => done(() => {
            if (response.status < 200 || response.status >= 300) {
              reject(new Error(response.status === 401 || response.status === 403
                ? '登录状态或文件权限已失效。'
                : `文件请求失败（HTTP ${response.status}）。`));
              return;
            }
            const data = response.response;
            if (data == null) {
              reject(new Error('文件服务返回了空内容。'));
              return;
            }
            resolve(data instanceof Blob ? data : new Blob([data]));
          }),
          onerror: () => done(() => reject(new Error('文件服务拒绝了预览请求。'))),
          ontimeout: () => done(() => reject(new Error('文件读取超时。'))),
          onabort: () => done(() => reject(new DOMException('Aborted', 'AbortError'))),
        });
      } catch (error) {
        done(() => reject(error));
      }
      if (signal.aborted) onAbort();
    });
  }

  async function retrieveFile(file, signal) {
    try {
      const response = await fetch(file.downloadUrl.href, {
        credentials: 'same-origin',
        redirect: 'follow',
        signal,
        headers: { Accept: '*/*' },
      });
      if (!response.ok) {
        throw new Error(response.status === 401 || response.status === 403
          ? '登录状态或文件权限已失效。'
          : `文件请求失败（HTTP ${response.status}）。`);
      }
      return await response.blob();
    } catch (error) {
      if (signal.aborted || error?.name !== 'TypeError') throw error;
      // Canvas may redirect a file to another host that cannot be read by page fetch.
      return await requestThroughTampermonkey(file.downloadUrl.href, signal);
    }
  }

  async function renderPdf(file, blob, requestId) {
    const pdfBlob = blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
    const url = makeObjectUrl(pdfBlob);
    state.status.textContent = '正在打开预览…';
    state.viewer.onload = () => {
      if (requestId === state.requestId) state.status.hidden = true;
    };
    state.viewer.onerror = () => {
      if (requestId === state.requestId) showError('浏览器未能嵌入 PDF 预览。');
    };
    state.viewer.hidden = false;
    state.viewer.src = url;
  }

  async function renderDocx(file, blob, requestId) {
    state.status.textContent = '正在加载 Word 预览组件…';
    const mammoth = await loadLibrary('mammoth');
    if (requestId !== state.requestId || state.root.hidden) return;
    state.status.textContent = '正在解析 Word 文档…';
    const arrayBuffer = await blob.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer });
    if (requestId !== state.requestId || state.root.hidden) return;

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font: 15px/1.6 system-ui, "Microsoft YaHei", sans-serif; color: #1f2937;
    max-width: 820px; margin: 32px auto; padding: 0 24px; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  table, th, td { border: 1px solid #cbd5e1; }
  th, td { padding: 6px 10px; }
</style></head><body>${result.value}</body></html>`;
    const url = makeObjectUrl(new Blob([html], { type: 'text/html' }));
    state.viewer.onload = () => {
      if (requestId === state.requestId) state.status.hidden = true;
    };
    state.viewer.onerror = () => {
      if (requestId === state.requestId) showError('浏览器未能显示 Word 预览。');
    };
    state.viewer.hidden = false;
    state.viewer.src = url;
  }

  function fileLike(blob, name, type) {
    if (typeof File === 'function') return new File([blob], name, { type });
    return new Blob([blob], { type });
  }

  function updateSlideIndicator(viewer) {
    if (!state.slideIndicator || !viewer) return;
    const getCurrent = viewer.getCurrentSlideIndex || viewer.getCurrentSlide;
    const getTotal = viewer.getSlideCount;
    const current = typeof getCurrent === 'function' ? getCurrent.call(viewer) : null;
    const total = typeof getTotal === 'function' ? getTotal.call(viewer) : null;
    if (current == null || total == null) return;
    state.slideIndicator.textContent = `${current + 1} / ${total}`;
  }

  function stepSlide(direction) {
    const viewer = state.pptxViewer;
    if (!viewer || state.root.hidden) return;
    const method = direction > 0
      ? (viewer.nextSlide || viewer.next)
      : (viewer.previousSlide || viewer.previous || viewer.prev);
    if (typeof method !== 'function') return;
    Promise.resolve(method.call(viewer))
      .then(() => updateSlideIndicator(viewer))
      .catch(() => {});
  }

  function sizeCanvasForSlide(canvas) {
    // pptxviewjs 会在渲染时自行设置画布尺寸（含 devicePixelRatio 与 style），
    // 这里只需给一个正的非零默认尺寸，以通过它的入参校验。
    canvas.width = 960;
    canvas.height = 540;
  }

  async function renderPptx(file, blob, requestId) {
    state.status.textContent = '正在加载 PPT 预览组件…';
    const PptxViewJS = await loadLibrary('pptxviewjs');
    if (requestId !== state.requestId || state.root.hidden) return;
    state.status.textContent = '正在解析演示文稿…';
    const name = /\.pptx$/i.test(file.name) ? file.name : `${file.name || 'presentation'}.pptx`;
    sizeCanvasForSlide(state.canvas);
    const viewer = new PptxViewJS.PPTXViewer({ canvas: state.canvas });
    state.pptxViewer = viewer;
    await viewer.loadFile(fileLike(blob, name, EXTENSIONS.pptx.mime));
    if (requestId !== state.requestId || state.root.hidden) return;
    // pptxviewjs 默认 dpi=96 但 pixelRatio=devicePixelRatio，高分屏下两者不一致，
    // 会让文本与图形的坐标缩放错位；固定为 1× 渲染（dpi=96/pixelRatio=1）以对齐。
    try {
      const renderer = viewer.processor && viewer.processor.processor;
      if (renderer && typeof renderer.setPixelRatio === 'function') {
        renderer.setPixelRatio(1);
      }
    } catch {}
    await viewer.render();
    if (requestId !== state.requestId || state.root.hidden) return;
    updateSlideIndicator(viewer);
    state.status.hidden = true;
    state.canvasHost.hidden = false;
  }

  async function loadFile(file) {
    const requestId = state.requestId;
    const controller = new AbortController();
    state.controller = controller;
    const timeoutId = setTimeout(() => {
      if (requestId === state.requestId && !state.root.hidden) {
        controller.abort();
        showError('文件读取超时。');
      }
    }, 60000);

    try {
      const blob = await retrieveFile(file, controller.signal);
      if (requestId !== state.requestId || state.root.hidden) return;

      const downloadUrl = makeObjectUrl(blob);
      state.downloadLink.href = downloadUrl;
      state.downloadLink.download = /\.(pdf|docx|pptx)$/i.test(file.name)
        ? file.name
        : `document.${file.ext}`;

      if (file.ext === 'pdf') await renderPdf(file, blob, requestId);
      else if (file.ext === 'docx') await renderDocx(file, blob, requestId);
      else if (file.ext === 'pptx') await renderPptx(file, blob, requestId);
    } catch (error) {
      if (controller.signal.aborted || requestId !== state.requestId) return;
      showError(error instanceof Error ? error.message : '无法读取文件。');
    } finally {
      clearTimeout(timeoutId);
      if (state.controller === controller) state.controller = null;
    }
  }

  function openDialog(file) {
    ensureDialog();
    if (state.root.hidden) state.oldOverflow = document.body.style.overflow;
    clearPending();
    state.trigger = file.link;
    state.title.textContent = file.name;
    state.originalLink.href = file.url.href;
    state.originalLink.hidden = true;
    state.downloadLink.href = file.downloadUrl.href;
    state.downloadLink.removeAttribute('download');
    state.downloadLink.textContent = `下载 ${EXTENSIONS[file.ext].label}`;
    state.status.textContent = '正在读取文件…';
    state.status.hidden = false;
    state.root.hidden = false;
    document.body.style.overflow = 'hidden';
    state.closeButton.focus();
    void loadFile(file);
  }

  window.addEventListener('click', (event) => {
    const file = fileLinkFromClick(event);
    if (!file) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openDialog(file);
  }, true);
})();
