// ==UserScript==
// @name         DMY Better
// @namespace    local.copy-md
// @version      0.8.1
// @description  代码源（newoj 和旧 OJ）：解除复制限制、复制题面为 Markdown、保存题目（PDF + 附件）、保存整个比赛
// @author       koma404
// @homepageURL  https://github.com/koma404/DMY-Better
// @supportURL   https://greasyfork.org/zh-CN/scripts/600021-dmy-better
// @match        https://newoj.daimayuan.top/p/*
// @match        https://newoj.daimayuan.top/contest/*
// @match        http://oj.daimayuan.top/problem/*
// @match        http://oj.daimayuan.top/contest/*
// @match        https://oj.daimayuan.top/problem/*
// @match        https://oj.daimayuan.top/contest/*
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @grant        unsafeWindow
// @connect      *
// @noframes
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /* ================= 配置（页面结构不同时改这里） ================= */
  // 题面容器：按顺序尝试，不对就用 F12 找到题面外层元素，把选择器放到第一项
  const ROOTS = [
    '.uoj-article', // 旧 OJ（oj.daimayuan.top，UOJ 系统）
    '.problem-content', '.problem-content-container',
    '.section__body.typo', '.typo', 'article', 'main',
  ];
  // 标题：都没匹配到就从 document.title 里截取
  const TITLE_SELECTORS = ['.problem-title', '.section__header h1', 'h1', '.section__title'];
  // 附件链接：优先用这些选择器；全都没匹配到时，才按文件后缀/路径猜
  const ATTACH_SELECTORS = [
    'a[href*="type=additional_file"]',
    'a[href*="download.php"]', // 旧 OJ 的「附加文件」
    '.problem-attachments a', '.attachments a', '.attachment a', 'a[download]',
  ];
  const FILE_RE = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|pdf|docx?|xlsx?|pptx?|txt|in|out|ans|cpp|c|h|py|java|mp3|mp4)$/i;
  const PATH_RE = /\/(files?|attachments?|downloads?)\//i;
  // 代码源旧 OJ（UOJ 系统）：题目页 /problem/3259 或 /contest/431/problem/3259
  const OLD_OJ = location.hostname === 'oj.daimayuan.top';
  const OLD_OJ_SUFFIX = /\s*-\s*Daimayuan Online Judge\s*$/i;
  // PDF：渲染宽度(CSS px)与清晰度。宽度越小字越大；清晰度越高文件越大
  const PDF_WIDTH = 720;
  const PDF_SCALE = 2;
  // 保存整个比赛时，iframe 加载题面后额外等待的毫秒数（等公式等渲染完）
  const PAGE_SETTLE_MS = 1500;

  /* ================= 1. 解除复制限制 ================= */
  const style = document.createElement('style');
  style.textContent = '*{user-select:text!important;-webkit-user-select:text!important}';
  document.documentElement.appendChild(style);

  let pending = null; // 脚本自己要写入剪贴板的文本

  ['cut', 'contextmenu', 'selectstart', 'dragstart'].forEach(ev =>
    window.addEventListener(ev, e => e.stopImmediatePropagation(), true)
  );

  // copy：脚本主动复制时放入 Markdown，其余情况只屏蔽网站自己的拦截
  window.addEventListener('copy', e => {
    if (pending !== null) {
      e.clipboardData.setData('text/plain', pending);
      e.preventDefault();
    }
    e.stopImmediatePropagation();
  }, true);

  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'a'].includes(e.key.toLowerCase()))
      e.stopImmediatePropagation();
  }, true);

  /* ================= 2. 通用工具 ================= */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const safe = s => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ').replace(/[. ]+$/, '').slice(0, 80) || 'problem';

  const findRoot = (doc = document) => ROOTS.map(s => doc.querySelector(s)).find(Boolean);

  // 等页面字体加载完：主动把 KaTeX 的所有字体都加载一遍，最多等 15 秒。
  // html2canvas 画字前要测量字体基线，而它是在【运行脚本的页面】（全局 document）里测量的，不是题面所在的 iframe。
  // 保存整个比赛时这个页面是比赛页：它声明了 KaTeX 字体但页面上没有公式，字体还没加载，
  // 测出来的是替代字体的基线，公式就会下沉、错位。测量本身会触发加载，所以只有第一题出问题。
  // 把题面 iframe 里声明的 @font-face 复制到当前页面。旧 OJ 的比赛页没有公式，也就没声明 MathJax 字体，
  // html2canvas 在当前页面测量基线时会找不到这些字体，每道题的公式都会错位。
  // 读不到内容的跨域样式表（比如 CDN 上的 KaTeX / MathJax 样式）就直接在当前页面引入同一个样式表。
  async function mirrorFontFaces(doc) {
    if (doc === document) return;
    const css = [];
    const links = [];
    const collect = (sheet) => {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { if (sheet.href) links.push(sheet.href); return; }
      const base = sheet.href || doc.baseURI;
      for (const r of rules) {
        if (r.type === 3 && r.styleSheet) collect(r.styleSheet); // @import
        else if (r.type === 4 && r.cssRules) collect({ cssRules: r.cssRules, href: sheet.href }); // @media
        else if (r.type === 5) { // @font-face
          css.push(r.cssText.replace(/url\((['"]?)(?!data:)([^'")]+)\1\)/g,
            (m, q, u) => { try { return `url("${new URL(u, base).href}")`; } catch (e) { return m; } }));
        }
      }
    };
    for (const sheet of doc.styleSheets) collect(sheet);

    if (css.length) {
      let st = document.getElementById('__dmy_fonts');
      if (!st) {
        st = document.createElement('style');
        st.id = '__dmy_fonts';
        (document.head || document.documentElement).appendChild(st);
      }
      const have = new Set(st.textContent.split('\n'));
      const add = css.filter(c => !have.has(c));
      if (add.length) st.textContent += add.join('\n') + '\n';
    }

    const have = new Set([...document.querySelectorAll('link[rel~="stylesheet"]')].map(l => l.href));
    await Promise.all(links.filter(h => /katex|mathjax|font/i.test(h) && !have.has(h)).map(href =>
      new Promise(resolve => {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = href;
        l.onload = l.onerror = resolve;
        (document.head || document.documentElement).appendChild(l);
        setTimeout(resolve, 10000);
      })));
  }

  // 调试：列出当前页面（和题面 iframe）的字体与样式表情况，复制到剪贴板
  function fontReport(doc, label) {
    const out = [`== ${label}：${doc.location && doc.location.href}`];
    try {
      out.push(`MathJax：${(() => { try { const M = unsafeWindow.MathJax; return M ? (M.version || 'yes') : '无'; } catch (e) { return '?'; } })()}，KaTeX 元素：${doc.querySelectorAll('.katex').length}，MathJax 元素：${doc.querySelectorAll('.MathJax, .MathJax_CHTML, mjx-container, .mjx-chtml').length}`);
    } catch (e) {}
    out.push('字体（family / status）：');
    try { [...doc.fonts].forEach(f => out.push(`  ${f.family} ${f.style} ${f.weight} → ${f.status}`)); } catch (e) { out.push('  读取出错 ' + e.message); }
    out.push('样式表：');
    for (const sh of doc.styleSheets) {
      let n = '?';
      try { n = sh.cssRules.length; } catch (e) { n = '跨域，读不到'; }
      out.push(`  ${sh.href || '(内联)'} 规则数：${n}`);
    }
    const sample = doc.querySelector('.katex, .MathJax, .MathJax_CHTML, mjx-container, .mjx-chtml');
    if (sample) {
      const inner = sample.querySelector('*') || sample;
      out.push(`公式元素示例 font-family：${doc.defaultView.getComputedStyle(inner).fontFamily}`);
      out.push(`公式元素 HTML（截断）：${sample.outerHTML.slice(0, 600)}`);
    }
    return out.join('\n');
  }

  async function debugFonts() {
    const parts = [fontReport(document, '当前页面')];
    if (isContestPage()) {
      const list = parseProblemLinks(document);
      if (list[0]) {
        try {
          const { frame, doc } = await loadProblemDoc(list[0].url);
          parts.push(fontReport(doc, '第一题 iframe（已执行字体复制与等待）'));
          parts.push(fontReport(document, '复制字体后的当前页面'));
          frame.remove();
        } catch (e) { parts.push('加载第一题失败：' + e.message); }
      }
    }
    const text = parts.join('\n\n');
    console.log('[DMY Better] 字体调试信息\n' + text);
    toast(writeClipboard(text) ? '已复制字体调试信息' : '复制失败，请在控制台查看', 4000);
  }

  async function waitFonts(doc) {
    const fonts = doc.fonts;
    if (!fonts) return;
    await Promise.race([
      (async () => {
        await fonts.ready;
        await Promise.all([...fonts]
          .filter(f => /katex|mathjax|mjx/i.test(f.family) && f.status !== 'loaded')
          .map(f => f.load().catch(() => {})));
        await fonts.ready;
      })(),
      sleep(15000),
    ]);
  }

  function toast(msg, ms = 2200) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText =
      'position:fixed;left:16px;bottom:64px;z-index:99999;padding:8px 14px;max-width:80vw;' +
      'background:#333;color:#fff;border-radius:6px;font:14px sans-serif';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
    return t;
  }

  // 新 OJ：/p/xxx；旧 OJ：/problem/123、/contest/12/problem/123
  const PROBLEM_PATH = /\/(p\/[^/]+|(contest\/\d+\/)?problem\/\d+)\/?$/;
  const isProblemPage = () => PROBLEM_PATH.test(location.pathname);
  const isContestPage = () => /^\/contest\//.test(location.pathname) && !isProblemPage();

  /* ================= 3. DOM -> Markdown ================= */
  const texOf = el => {
    const a = el.querySelector('annotation[encoding="application/x-tex"]');
    return a ? a.textContent.trim() : el.textContent.trim();
  };

  function kids(node) {
    return [...node.childNodes].map(md).join('');
  }

  function md(node) {
    if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();

    // 公式
    if (node.matches('.katex-display'))
      return `\n\n$$\n${texOf(node)}\n$$\n\n`;
    if (node.matches('.katex'))
      return `$${texOf(node)}$`;
    if (tag === 'script' && /^math\/tex/.test(node.type))
      return /mode=display/.test(node.type)
        ? `\n\n$$\n${node.textContent.trim()}\n$$\n\n`
        : `$${node.textContent.trim()}$`;
    if (node.matches('.MathJax_CHTML, .mjx-chtml, .MathJax_SVG, .MathJax_Display, .MJX_Assistive_MathML'))
      return ''; // 旧 OJ 的 MathJax 2 渲染结果，公式源码在旁边的 <script type="math/tex"> 里
    if (node.matches('.MathJax, .MathJax_Preview, mjx-container, style, button, svg'))
      return tag === 'mjx-container' ? `$${node.textContent.trim()}$` : '';

    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return `\n\n${'#'.repeat(+tag[1])} ${kids(node).trim()}\n\n`;
      case 'p':
        return `\n\n${kids(node).trim()}\n\n`;
      case 'br':
        return '  \n';
      case 'strong': case 'b':
        return `**${kids(node).trim()}**`;
      case 'em': case 'i':
        return `*${kids(node).trim()}*`;
      case 'code':
        return node.parentElement.tagName === 'PRE'
          ? node.textContent
          : `\`${node.textContent}\``;
      case 'pre':
        return `\n\n\`\`\`\n${node.textContent.replace(/\n+$/, '')}\n\`\`\`\n\n`;
      case 'a':
        return `[${kids(node).trim()}](${node.href})`;
      case 'img':
        return `![${node.alt || ''}](${node.src})`;
      case 'blockquote':
        return '\n\n' + kids(node).trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
      case 'ul': case 'ol': {
        let i = 0;
        const items = [...node.children]
          .filter(c => c.tagName === 'LI')
          .map(li => {
            const body = kids(li).trim().replace(/\n/g, '\n  ');
            return (tag === 'ol' ? `${++i}. ` : '- ') + body;
          });
        return '\n\n' + items.join('\n') + '\n\n';
      }
      case 'table': {
        const rows = [...node.querySelectorAll('tr')].map(tr =>
          [...tr.children].map(c => kids(c).trim().replace(/\n+/g, ' '))
        );
        if (!rows.length) return '';
        const sep = rows[0].map(() => '---');
        return '\n\n' + [rows[0], sep, ...rows.slice(1)]
          .map(r => '| ' + r.join(' | ') + ' |').join('\n') + '\n\n';
      }
      case 'div': case 'section':
        return `\n${kids(node)}\n`;
      default:
        return kids(node);
    }
  }

  function writeClipboard(text) {
    pending = text;
    let ok = false;
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch (e) {}
    pending = null;
    if (!ok) {
      try { GM_setClipboard(text); ok = true; } catch (e) {}
    }
    return ok;
  }

  function copyMarkdown() {
    if (!isProblemPage()) return toast('请在题目页使用');
    const root = findRoot();
    if (!root) return toast('没找到题面容器，请修改 ROOTS');
    const text = md(root)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n';
    toast(writeClipboard(text) ? `已复制 ${text.length} 字符` : '复制失败');
  }

  /* ================= 4. 生成 PDF ================= */
  const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,pre,tr,img,blockquote,.katex-display';

  // 从沙箱 window / 页面 window / 裸全局变量里找库
  function getLibs() {
    const wins = [window];
    try { if (typeof unsafeWindow !== 'undefined') wins.push(unsafeWindow); } catch (e) {}
    let h2c, JsPDF;
    for (const w of wins) {
      try {
        h2c = h2c || w.html2canvas;
        JsPDF = JsPDF || (w.jspdf && w.jspdf.jsPDF) || w.jsPDF;
      } catch (e) {}
    }
    try { if (!h2c && typeof html2canvas !== 'undefined') h2c = html2canvas; } catch (e) {}
    try { if (!JsPDF && typeof jspdf !== 'undefined') JsPDF = jspdf.jsPDF; } catch (e) {}
    return { h2c, JsPDF };
  }

  async function makePdf(root, title) {
    const { h2c, JsPDF } = getLibs();
    if (!h2c || !JsPDF) {
      const miss = [!h2c && 'html2canvas', !JsPDF && 'jsPDF'].filter(Boolean).join('、');
      throw new Error(`${miss} 未加载（@require 下载失败或被拦截，见控制台）`);
    }

    let cuts = []; // 可分页的位置（CSS px，相对题面顶部）
    root.setAttribute('data-md-root', '1');
    let canvas;
    try {
      canvas = await h2c(root, {
        scale: PDF_SCALE,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
        onclone: doc => {
          const el = doc.querySelector('[data-md-root]');
          if (!el) return;

          // 副本里的动画会从头播放，截图时处于半透明阶段：关掉动画，并把透明度拉满
          const st = doc.createElement('style');
          st.textContent =
            '*,*::before,*::after{animation:none!important;transition:none!important}';
          (doc.head || doc.documentElement).appendChild(st);

          el.style.cssText +=
            `;width:${PDF_WIDTH}px!important;max-width:none!important;margin:0!important;` +
            'padding:8px 12px!important;box-sizing:border-box!important;' +
            'overflow:visible!important;height:auto!important;max-height:none!important;' +
            'border:0!important;box-shadow:none!important;background:#fff!important';

          const win = doc.defaultView;
          const opaque = n => {
            if (parseFloat(win.getComputedStyle(n).opacity) < 1)
              n.style.setProperty('opacity', '1', 'important');
          };
          [el, ...el.querySelectorAll('*')].forEach(opaque);
          for (let p = el.parentElement; p; p = p.parentElement)
            p.style.setProperty('opacity', '1', 'important');

          if (!el.querySelector('h1')) {
            const h = doc.createElement('h1');
            h.textContent = title;
            h.style.cssText = 'font-size:22px;margin:0 0 14px;';
            el.insertBefore(h, el.firstChild);
          }
          const top = el.getBoundingClientRect().top;
          cuts = [...el.querySelectorAll(BLOCKS)]
            .map(b => b.getBoundingClientRect().bottom - top)
            .filter(v => v > 0)
            .sort((a, b) => a - b);
        },
      });
    } finally {
      root.removeAttribute('data-md-root');
    }

    // 按块边界分页，避免把一行字切成两半
    const s = canvas.width / PDF_WIDTH;
    const pageH = Math.floor(canvas.width * 277 / 190); // A4 减去 10mm 页边距
    const pages = [];
    let y = 0;
    while (y < canvas.height - 2) {
      let end = Math.min(y + pageH, canvas.height);
      if (end < canvas.height) {
        const cand = cuts.map(v => Math.round(v * s))
          .filter(v => v > y + pageH * 0.5 && v <= end);
        if (cand.length) end = cand[cand.length - 1];
      }
      pages.push([y, end]);
      y = end;
    }

    const pdf = new JsPDF({ unit: 'mm', format: 'a4', compress: true });
    pages.forEach(([a, b], i) => {
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = b - a;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(canvas, 0, a, canvas.width, b - a, 0, 0, canvas.width, b - a);
      if (i) pdf.addPage();
      pdf.addImage(c.toDataURL('image/jpeg', 0.95), 'JPEG', 10, 10,
        190, (b - a) * 190 / canvas.width, undefined, 'FAST');
    });
    return pdf.output('blob');
  }

  /* ================= 5. 附件 ================= */
  function nameOf(a, u) {
    let n = a.getAttribute('download') || '';
    if (!n) {
      try { n = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || ''); }
      catch (e) { n = u.pathname.split('/').filter(Boolean).pop() || ''; }
    }
    // 旧 OJ（UOJ）的「附加文件」是 download.php?type=problem&id=…，下载的是附件压缩包
    if (/\.php$/i.test(n)) n = `${a.textContent.trim() || 'attachment'}.zip`;
    if (!/\.[A-Za-z0-9]{1,6}$/.test(n)) n = a.textContent.trim() || n || 'file';
    return n.replace(/[\\/:*?"<>|]/g, '_');
  }

  function collectAttachments(doc = document) {
    const here = ((doc.location && doc.location.href) || location.href).split('#')[0];
    const seen = new Map();
    const add = a => {
      let u;
      try { u = new URL(a.href, here); } catch (e) { return; }
      if (!/^https?:$/.test(u.protocol)) return;
      if (u.href.split('#')[0] === here) return;
      if (!seen.has(u.href)) seen.set(u.href, { url: u.href, name: nameOf(a, u) });
    };
    ATTACH_SELECTORS.forEach(s => doc.querySelectorAll(s).forEach(a => a.href && add(a)));
    if (!seen.size) { // 没匹配到就按后缀/路径猜
      doc.querySelectorAll('a[href]').forEach(a => {
        let u;
        try { u = new URL(a.href, here); } catch (e) { return; }
        if (FILE_RE.test(u.pathname) || PATH_RE.test(u.pathname)) add(a);
      });
    }
    return [...seen.values()];
  }

  /* ================= 6. 题号 / 标题 / 比赛题目列表 ================= */
  const idxLetter = i => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

  function titleFromDocTitle() {
    // 形如「题目详情 - RGB - 代码源 OJ」，去掉首尾的固定部分
    const full = document.title.replace(/\s+/g, ' ').trim();
    const parts = full.split(' - ').map(x => x.trim()).filter(Boolean);
    return parts.length > 2 ? parts.slice(1, -1).join(' - ') : (full || 'problem');
  }

  function getTitle() {
    if (OLD_OJ) return document.title.replace(OLD_OJ_SUFFIX, '').trim() || 'problem';
    for (const s of TITLE_SELECTORS) {
      const t = document.querySelector(s);
      const txt = t && t.textContent.replace(/\s+/g, ' ').trim();
      if (txt) return txt;
    }
    return titleFromDocTitle();
  }

  // 第一层：页面标题里的「…… #A. RGB」
  function headingInfo() {
    const els = document.querySelectorAll('h1,h2,h3,h4,h5,[class*="title"]');
    for (const el of els) {
      const t = el.textContent.replace(/\s+/g, ' ').trim();
      if (!t || t.length > 150) continue;
      const m = t.match(/#\s*([A-Za-z0-9]{1,3})\s*[.．]\s*(.+?)\s*$/);
      if (m) return { letter: m[1].toUpperCase(), name: m[2] };
    }
    if (OLD_OJ) { // 旧 OJ：比赛题目页「A. 逆序对」，普通题目页「#3259. 逆序对」
      for (const el of document.querySelectorAll('h1,h2')) {
        const t = el.textContent.replace(/\s+/g, ' ').trim();
        const m = t.length <= 150 && t.match(/^(#\d+|[A-Za-z]\d?)\s*[.．]\s*(.+?)$/);
        if (m) return { letter: m[1].replace('#', '').toUpperCase(), name: m[2] };
      }
    }
    return null;
  }

  // 解析一个文档里的比赛题目列表：[{url, letter, name}]
  function parseProblemLinks(doc) {
    const tables = [...doc.querySelectorAll('table')]
      .filter(t => [...t.querySelectorAll('a[href]')].some(a => { try { return PROBLEM_PATH.test(new URL(a.getAttribute('href'), location.href).pathname); } catch (e) { return false; } }));
    const scope = tables[0] || doc;
    const seen = new Set();
    const out = [];
    scope.querySelectorAll('a[href]').forEach(a => {
      let u;
      try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { return; }
      if (u.origin !== location.origin || !PROBLEM_PATH.test(u.pathname)) return;
      const key = u.pathname + u.search;
      if (seen.has(key)) return;
      seen.add(key);
      const i = out.length;
      const full = a.textContent.replace(/\s+/g, ' ').trim();
      const f = a.firstElementChild ? a.firstElementChild.textContent.trim() : '';
      let letter, name;
      if (/^[A-Za-z0-9]{1,3}$/.test(f) && full.length > f.length && full.startsWith(f)) {
        letter = f.toUpperCase(); // 链接里「题号」「题名」是分开的两个元素
        name = full.slice(f.length).replace(/^[\s.．、:：-]+/, '').trim();
      } else {
        letter = idxLetter(i);    // 否则按顺序编号
        name = full.replace(new RegExp('^' + letter + '[\\s.．、:：]+'), '').trim() || full;
      }
      out.push({ url: u.href, letter, name: name || full || `题目${i + 1}` });
    });
    return out;
  }

  async function fetchContestProblems(tid) {
    for (const path of [`/contest/${tid}/problems`, `/contest/${tid}`]) {
      try {
        const r = await fetch(path, { credentials: 'include' });
        if (!r.ok) continue;
        const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
        const list = parseProblemLinks(doc);
        if (list.length) return list;
      } catch (e) {}
    }
    return [];
  }

  // 第二层：用 URL 里的 tid 去读比赛题目列表，按题目 id 对应
  async function infoFromContest() {
    const tid = new URL(location.href).searchParams.get('tid');
    if (!tid) return null;
    const list = await fetchContestProblems(tid);
    const pid = location.pathname.split('/').filter(Boolean).pop();
    const hit = list.find(p => new URL(p.url).pathname.split('/').filter(Boolean).pop() === pid);
    return hit ? { letter: hit.letter, name: hit.name } : null;
  }

  function getContestTitle(tid) {
    if (OLD_OJ) {
      // 旧 OJ：导航里的 /contest/<id> 链接文字是「比赛主页」，顶部还有站名和「Home」，都不能用。
      // 依次取：居中的大标题 → 网页标题去掉站名 → 最长的标题文字
      const bad = t => !t || /Online Judge/i.test(t) || /^(home|首页|比赛主页)$/i.test(t);
      const text = e => e.textContent.replace(/\s+/g, ' ').trim();
      const center = [...document.querySelectorAll('h1.text-center, h2.text-center, .page-header h1')]
        .map(text).find(t => !bad(t));
      if (center) return center;
      const fromTitle = document.title.replace(OLD_OJ_SUFFIX, '').trim();
      if (!bad(fromTitle)) return fromTitle;
      const longest = [...document.querySelectorAll('h1, h2')].map(text).filter(t => !bad(t))
        .sort((a, b) => b.length - a.length)[0];
      return longest || 'contest';
    }
    if (tid) { // 导航栏里指向 /contest/<tid> 的链接，文字就是比赛名
      for (const a of document.querySelectorAll('a[href]')) {
        let u;
        try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { continue; }
        if (u.origin === location.origin && u.pathname.replace(/\/$/, '') === `/contest/${tid}`) {
          const t = a.textContent.replace(/\s+/g, ' ').trim();
          if (t) return t;
        }
      }
    }
    for (const s of TITLE_SELECTORS) {
      const t = document.querySelector(s);
      const txt = t && t.textContent.replace(/\s+/g, ' ').trim();
      if (txt) return txt;
    }
    return titleFromDocTitle();
  }

  /* ================= 7. 下载 ================= */
  let lastDlErr = '';

  // 返回 true 表示已按「文件夹/文件名」交给 GM_download；false 表示退回了普通下载（不带文件夹）
  function dl(url, path, flatName) {
    return new Promise(resolve => {
      const fallback = err => {
        if (err) {
          lastDlErr = `${err.error || ''} ${err.details || ''}`.trim();
          console.warn('[DMY Better] GM_download 失败，改用普通下载：', path, err);
        }
        const a = document.createElement('a');
        a.href = url;
        a.download = flatName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        resolve(false);
      };
      if (typeof GM_download !== 'function') return fallback();
      try {
        GM_download({
          url, name: path, saveAs: false,
          onload: () => resolve(true),
          onerror: fallback,
          ontimeout: () => fallback({ error: 'timeout' }),
        });
      } catch (e) { fallback({ error: 'exception', details: String(e) }); }
    });
  }

  const newStat = () => ({ pdf: 0, files: 0, outside: 0, errs: [] });

  // 把一道题的 PDF 和附件存进 dir 目录
  async function saveProblem(doc, root, title, dir, fileBase, stat) {
    const flat = dir.replace(/\//g, ' - '); // 退回普通下载时的文件名前缀
    try {
      const blob = await makePdf(root, title);
      const u = URL.createObjectURL(blob);
      const r = await dl(u, `${dir}/${fileBase}.pdf`, `${flat}.pdf`);
      setTimeout(() => URL.revokeObjectURL(u), 60000);
      stat.pdf++;
      if (!r) stat.outside++;
    } catch (e) {
      console.error('[DMY Better] PDF 失败', e);
      stat.errs.push(`${fileBase} 的 PDF：${e.message}`);
    }
    const files = collectAttachments(doc);
    for (const f of files) {
      await sleep(300);
      const r = await dl(f.url, `${dir}/${f.name}`, `${flat} - ${f.name}`);
      stat.files++;
      if (!r) stat.outside++;
    }
  }

  const tailOf = stat =>
    (stat.outside ? `；${stat.outside} 个未进入文件夹` : '') +
    (lastDlErr ? `；下载报错：${lastDlErr}` : '') +
    (stat.errs.length ? `；失败：${stat.errs.join('；')}` : '');

  let busy = false;

  /* ================= 8. 保存当前题目 ================= */
  async function savePackage() {
    if (!isProblemPage()) return toast('请在题目页使用');
    if (busy) return toast('正在处理，请稍等');
    const root = findRoot();
    if (!root) return toast('没找到题面容器，请修改 ROOTS');
    busy = true;
    lastDlErr = '';
    const prog = toast('正在读取题目信息…', 1e9);
    try {
      let info = headingInfo();
      if (!info) info = await infoFromContest().catch(() => null);
      const title = info ? `${info.letter}. ${info.name}` : getTitle();
      const folder = safe(title);

      await waitFonts(document);
      prog.textContent = `正在生成 PDF：${folder}`;
      const stat = newStat();
      await saveProblem(document, root, title, folder, folder, stat);

      prog.remove();
      toast(`「${folder}」PDF ${stat.pdf ? '已保存' : '未生成'}，附件 ${stat.files} 个${tailOf(stat)}`, 8000);
    } finally {
      busy = false;
    }
  }

  /* ================= 9. 保存整个比赛 ================= */
  async function loadProblemDoc(url) {
    const f = document.createElement('iframe');
    f.style.cssText =
      'position:fixed;left:-99999px;top:0;width:1280px;height:900px;border:0;' +
      'opacity:0;pointer-events:none';
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('页面加载超时')), 30000);
        f.onload = () => { clearTimeout(timer); resolve(); };
        f.onerror = () => { clearTimeout(timer); reject(new Error('页面加载失败')); };
        f.src = url;
        document.body.appendChild(f);
      });
      let doc = null;
      try { doc = f.contentDocument; } catch (e) {}
      if (!doc || !doc.body) throw new Error('页面无法嵌入 iframe（站点可能禁止嵌入）');

      const t0 = Date.now();
      while (!(doc.readyState === 'complete' && findRoot(doc))) {
        if (Date.now() - t0 > 20000) throw new Error('等待题面超时，检查 ROOTS');
        await sleep(300);
      }
      await waitFonts(doc);
      await mirrorFontFaces(doc);
      await waitFonts(document); // html2canvas 在比赛页里测量字体基线，见 waitFonts 的说明
      await sleep(PAGE_SETTLE_MS);
      const root = findRoot(doc);
      await Promise.race([
        Promise.all([...root.querySelectorAll('img')].map(im =>
          im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; }))),
        sleep(5000),
      ]);
      return { frame: f, doc, root };
    } catch (e) {
      f.remove();
      throw e;
    }
  }

  async function saveContest() {
    if (!isContestPage()) return toast('请在比赛页（/contest/…）使用');
    if (busy) return toast('正在处理，请稍等');
    busy = true;
    lastDlErr = '';
    const prog = toast('正在读取题目列表…', 1e9);
    try {
      const m = location.pathname.match(/^\/contest\/([^/]+)/);
      const tid = m && m[1];
      let list = parseProblemLinks(document);
      if (!list.length && tid) list = await fetchContestProblems(tid);
      if (!list.length) {
        prog.remove();
        return toast('没找到题目链接', 4000);
      }

      const contest = safe(getContestTitle(tid));
      const stat = newStat();
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const title = `${p.letter}. ${p.name}`;
        const folder = safe(title);
        const tag = `[${i + 1}/${list.length}] ${folder}`;
        prog.textContent = `${tag}：加载题面…`;
        try {
          const { frame, doc, root } = await loadProblemDoc(p.url);
          try {
            prog.textContent = `${tag}：生成 PDF 并下载…`;
            await saveProblem(doc, root, title, `${contest}/${folder}`, folder, stat);
          } finally {
            frame.remove();
          }
        } catch (e) {
          console.error('[DMY Better]', folder, e);
          stat.errs.push(`${folder}：${e.message}`);
        }
        await sleep(500);
      }

      prog.remove();
      toast(`「${contest}」完成：PDF ${stat.pdf}/${list.length}，附件 ${stat.files} 个${tailOf(stat)}`, 12000);
    } finally {
      busy = false;
    }
  }

  /* ================= 10. 按钮 ================= */
  function tick() {
    if (!document.body) return;
    const key = (isProblemPage() ? 'p' : '') + (isContestPage() ? 'c' : '');
    const bar = document.getElementById('__dmy_bar');
    if (bar && bar.dataset.key === key) return;
    if (bar) bar.remove();
    if (!key) return;

    const items = [];
    if (isProblemPage()) items.push(['复制 MD', copyMarkdown], ['保存题目', savePackage]);
    if (isContestPage()) items.push(['保存整个比赛', saveContest]);

    const el = document.createElement('div');
    el.id = '__dmy_bar';
    el.dataset.key = key;
    el.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:99999;display:flex;gap:8px';
    items.forEach(([text, fn]) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText =
        'padding:8px 14px;border:0;border-radius:6px;background:#ff8c1a;color:#fff;' +
        'font:14px sans-serif;cursor:pointer';
      b.onclick = fn;
      el.appendChild(b);
    });
    document.body.appendChild(el);
  }

  // 站内跳转不一定整页刷新，定时检查路径，按钮随页面类型切换
  window.addEventListener('DOMContentLoaded', () => {
    tick();
    setInterval(tick, 600);
  });

  GM_registerMenuCommand('复制题面为 Markdown', copyMarkdown);
  GM_registerMenuCommand('保存题目（PDF + 附件）', savePackage);
  GM_registerMenuCommand('保存整个比赛', saveContest);
  GM_registerMenuCommand('调试：字体信息', debugFonts);
})();
