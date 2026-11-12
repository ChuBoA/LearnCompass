// 筆記：資料格式、HTML 淨化（只保留允許的格式）與所見即所得編輯器。
import { newId } from './csv.js';

const ALLOWED = new Set(['P', 'BR', 'H2', 'H3', 'STRONG', 'EM', 'U', 'S', 'MARK', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A', 'HR', 'CODE', 'PRE', 'DIV']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'TITLE', 'HEAD', 'SVG', 'IMG', 'PICTURE',
  'VIDEO', 'AUDIO', 'CANVAS', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'TEMPLATE', 'NOSCRIPT', 'MATH']);
const RENAME = { H1: 'H2', H4: 'H3', H5: 'H3', H6: 'H3', B: 'STRONG', I: 'EM', STRIKE: 'S', DEL: 'S', INS: 'U' };
const BLOCKISH = new Set(['SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'TABLE', 'TBODY', 'THEAD', 'TR', 'DL', 'DT', 'DD', 'ADDRESS']);
const BLOCKS = new Set(['P', 'DIV', 'H2', 'H3', 'LI', 'BLOCKQUOTE', 'PRE', 'HR', 'UL', 'OL']);

function copyChildren(src, dest) {
  for (const node of src.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) { dest.append(node.textContent); continue; }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    let tag = node.tagName.toUpperCase();
    if (DROP.has(tag)) continue;

    // 從 Google 文件、網頁貼上時，格式常寫在 span 的 style 裡
    if (tag === 'SPAN' || tag === 'FONT') {
      const style = node.style || {};
      let target = dest;
      const wrap = name => { const el = document.createElement(name); target.append(el); target = el; };
      const bg = style.backgroundColor || '';
      if (bg && !/transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|initial|inherit|white|rgb\(255,\s*255,\s*255\)/.test(bg)) wrap('MARK');
      if (/bold|[6-9]00/.test(style.fontWeight || '')) wrap('STRONG');
      if (style.fontStyle === 'italic') wrap('EM');
      if (/underline/.test(style.textDecoration || style.textDecorationLine || '')) wrap('U');
      if (/line-through/.test(style.textDecoration || style.textDecorationLine || '')) wrap('S');
      copyChildren(node, target);
      continue;
    }

    tag = RENAME[tag] || (BLOCKISH.has(tag) ? 'DIV' : tag);
    if (tag === 'TD' || tag === 'TH') { copyChildren(node, dest); dest.append(' '); continue; }
    if (!ALLOWED.has(tag)) { copyChildren(node, dest); continue; }
    // 標題或段落裡若包著清單等區塊（瀏覽器編輯時偶爾會產生），只保留內容
    if (['H2', 'H3', 'P'].includes(tag) && node.querySelector('ul, ol, p, div, blockquote, h2, h3, pre')) {
      copyChildren(node, dest);
      continue;
    }

    const el = document.createElement(tag);
    if (tag === 'A') {
      const href = (node.getAttribute('href') || '').trim();
      if (!/^(https?:|mailto:)/i.test(href)) { copyChildren(node, dest); continue; }
      el.setAttribute('href', href);
    }
    if (tag === 'UL' && node.hasAttribute('data-checklist')) el.setAttribute('data-checklist', '');
    if (tag === 'LI' && node.getAttribute('data-checked') === 'true') el.setAttribute('data-checked', 'true');
    copyChildren(node, el);
    dest.append(el);
  }
}

export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const out = document.createElement('div');
  copyChildren(doc.body, out);
  return out.innerHTML;
}

export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  let text = '';
  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { text += child.textContent; continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toUpperCase();
      if (tag === 'BR') { text += '\n'; continue; }
      if (tag === 'LI') {
        const parent = child.parentElement;
        if (parent?.hasAttribute('data-checklist')) text += child.getAttribute('data-checked') === 'true' ? '☑ ' : '☐ ';
        else if (parent?.tagName === 'OL') text += `${[...parent.children].indexOf(child) + 1}. `;
        else text += '• ';
      }
      walk(child);
      if (BLOCKS.has(tag)) text += '\n';
    }
  };
  walk(doc.body);
  return text.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function countTodos(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const items = doc.querySelectorAll('ul[data-checklist] > li');
  return { total: items.length, done: [...items].filter(li => li.getAttribute('data-checked') === 'true').length };
}

export function parseTags(value) {
  return [...new Set(String(value || '').split(/[,，、#\s]+/).map(t => t.trim()).filter(Boolean))].slice(0, 20);
}

export function normalizeNote(n) {
  const now = new Date().toISOString();
  const html = sanitizeHtml(n.html || '');
  return {
    id: n.id || newId(),
    courseId: n.courseId || '',
    title: String(n.title || '').trim().slice(0, 200),
    html,
    text: htmlToText(html),
    tags: Array.isArray(n.tags) ? parseTags(n.tags.join(',')) : parseTags(n.tags),
    pinned: !!n.pinned,
    todo: countTodos(html),
    attachments: Array.isArray(n.attachments) ? n.attachments : [],
    createdAt: n.createdAt || now,
    updatedAt: n.updatedAt || now
  };
}

export const isNoteEmpty = n => !n.title && !n.text && !n.attachments.length;

// ---------- 所見即所得編輯器 ----------
const escHtml = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function setupRichEditor({ body, toolbar, linkPop, onChange, onNotice }) {
  const selection = () => getSelection();
  const inBody = node => node && body.contains(node);

  function closest(selector) {
    const sel = selection();
    if (!sel.rangeCount) return null;
    let node = sel.anchorNode;
    if (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
    const found = node?.closest(selector);
    return inBody(found) && found !== body ? found : null;
  }

  function changed() {
    convertHighlightSpans();
    updatePlaceholder();
    updateToolbar();
    onChange();
  }

  // 把游標放在元素最後一個文字的後面（放在元素邊界時，Chrome 的清單指令會產生奇怪的巢狀結構）
  function caretToEnd(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = null;
    while (walker.nextNode()) last = walker.currentNode;
    const range = document.createRange();
    if (last) range.setStart(last, last.length);
    else range.setStart(el, el.childNodes.length);
    range.collapse(true);
    selection().removeAllRanges();
    selection().addRange(range);
  }

  // 游標不在編輯區時（例如還沒點進內文就按工具列），把游標放到內文最後面
  function ensureCaret() {
    if (inBody(selection().anchorNode)) return;
    body.focus();
    caretToEnd(body);
  }

  function exec(cmd, value = null) {
    ensureCaret();
    document.execCommand(cmd, false, value);
    changed();
  }

  // execCommand 的螢光筆會產生 <span style="background-color">，統一換成 <mark>，深色模式才看得清楚
  function convertHighlightSpans() {
    body.querySelectorAll('span[style*="background"]').forEach(span => {
      const mark = document.createElement('mark');
      mark.append(...span.childNodes);
      span.replaceWith(mark);
    });
  }

  function updatePlaceholder() {
    body.classList.toggle('is-empty', !body.textContent.trim() && !body.querySelector('li, hr'));
  }

  const STATE_CMDS = ['bold', 'italic', 'underline', 'strikeThrough'];
  function updateToolbar() {
    if (!inBody(selection().anchorNode)) return;
    for (const btn of toolbar.querySelectorAll('[data-cmd]')) {
      const cmd = btn.dataset.cmd;
      let on = false;
      if (STATE_CMDS.includes(cmd)) { try { on = document.queryCommandState(cmd); } catch { on = false; } }
      else if (cmd === 'insertUnorderedList') on = !!closest('ul:not([data-checklist])');
      else if (cmd === 'insertOrderedList') on = !!closest('ol');
      else if (cmd === 'checklist') on = !!closest('ul[data-checklist]');
      else if (cmd === 'heading') on = !!closest('h2, h3');
      else if (cmd === 'quote') on = !!closest('blockquote');
      else if (cmd === 'highlight') on = !!closest('mark');
      else continue;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  // ---- 清單：瀏覽器內建的清單指令會把清單塞進段落裡（<p><ul>），所以自己處理 ----
  const listKind = list => (list.tagName === 'OL' ? 'ol' : list.hasAttribute('data-checklist') ? 'check' : 'ul');

  function blockOf(node) {
    let el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (el && el !== body && !/^(P|DIV|H2|H3|BLOCKQUOTE|PRE)$/.test(el.tagName)) el = el.parentElement;
    return el && el !== body ? el : null;
  }

  // 把一個清單項目變回段落；它後面的項目另外組成一個清單
  function liToParagraph(li) {
    const list = li.parentElement;
    const items = [...list.children];
    const after = items.slice(items.indexOf(li) + 1);
    const p = document.createElement('p');
    p.append(...li.childNodes);
    if (!p.textContent && !p.querySelector('br')) p.append(document.createElement('br'));
    list.after(p);
    if (after.length) {
      const rest = list.cloneNode(false);
      rest.append(...after);
      p.after(rest);
    }
    li.remove();
    if (!list.children.length) list.remove();
    caretToEnd(p);
  }

  function setList(kind) {
    const li = closest('li');
    if (li) {
      const list = li.parentElement;
      if (listKind(list) === kind) { liToParagraph(li); changed(); return; }
      let target = list;
      const tag = kind === 'ol' ? 'OL' : 'UL';
      if (list.tagName !== tag) {
        target = document.createElement(tag);
        target.append(...list.childNodes);
        list.replaceWith(target);
      }
      if (kind === 'check') target.setAttribute('data-checklist', '');
      else {
        target.removeAttribute('data-checklist');
        target.querySelectorAll('li[data-checked]').forEach(x => x.removeAttribute('data-checked'));
      }
      caretToEnd(li);
      changed();
      return;
    }

    const list = document.createElement(kind === 'ol' ? 'ol' : 'ul');
    if (kind === 'check') list.setAttribute('data-checklist', '');
    const item = document.createElement('li');
    list.append(item);
    const node = selection().anchorNode;
    const block = blockOf(node);
    if (block) {
      item.append(...block.childNodes);
      block.replaceWith(list);
    } else if (node && node !== body && node.parentNode === body) {
      body.insertBefore(list, node);
      item.append(node);
    } else {
      if (body.childNodes.length === 1 && body.firstChild.nodeName === 'BR') body.firstChild.remove();
      body.append(list);
    }
    if (!item.textContent && !item.querySelector('br')) item.append(document.createElement('br'));
    caretToEnd(item);
    changed();
  }

  function toggleHighlight() {
    const mark = closest('mark');
    if (mark) { mark.replaceWith(...mark.childNodes); changed(); return; }
    if (selection().isCollapsed) { onNotice('請先選取要標記的文字'); return; }
    exec('hiliteColor', '#ffe39a');
  }

  function addLink() {
    const sel = selection();
    const range = sel.rangeCount && inBody(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    let url = prompt('輸入連結網址', 'https://');
    if (!url || !url.trim() || url.trim() === 'https://') return;
    url = url.trim();
    if (!/^(https?:|mailto:)/i.test(url)) url = 'https://' + url;
    body.focus();
    if (range) { sel.removeAllRanges(); sel.addRange(range); }
    if (sel.isCollapsed) exec('insertHTML', `<a href="${escHtml(url)}">${escHtml(url)}</a>&nbsp;`);
    else exec('createLink', url);
  }

  function run(cmd) {
    if (cmd !== 'link') ensureCaret();
    switch (cmd) {
      case 'heading':
        if (closest('li')) { onNotice('清單裡不能設定標題'); break; }
        exec('formatBlock', closest('h2, h3') ? '<p>' : '<h2>');
        break;
      case 'quote':
        if (closest('li')) { onNotice('清單裡不能設定引用'); break; }
        exec('formatBlock', closest('blockquote') ? '<p>' : '<blockquote>');
        break;
      case 'checklist': setList('check'); break;
      case 'insertUnorderedList': setList('ul'); break;
      case 'insertOrderedList': setList('ol'); break;
      case 'highlight': toggleHighlight(); break;
      case 'link': addLink(); break;
      case 'clear':
        exec('removeFormat');
        closest('mark')?.replaceWith(...closest('mark').childNodes);
        exec('formatBlock', '<p>');
        break;
      default: exec(cmd);
    }
  }

  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* 舊瀏覽器 */ }

  // 按工具列時不要讓編輯區失去選取範圍
  toolbar.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  toolbar.addEventListener('click', e => {
    const btn = e.target.closest('[data-cmd]');
    if (btn) run(btn.dataset.cmd);
  });

  // 在空白的清單項目按 Enter：離開清單
  body.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const li = closest('li');
    if (li && !li.textContent.trim()) {
      e.preventDefault();
      liToParagraph(li);
      changed();
    }
  });

  body.addEventListener('input', e => {
    // 在待辦清單按 Enter 產生的新項目不要沿用上一項的勾選狀態
    if (e.inputType === 'insertParagraph') {
      const li = closest('li');
      if (li?.parentElement?.hasAttribute('data-checklist')) li.removeAttribute('data-checked');
    }
    hideLinkPop();
    changed();
  });

  body.addEventListener('paste', e => {
    const data = e.clipboardData;
    if (!data) return;
    const html = data.getData('text/html');
    const text = data.getData('text/plain');
    if (!html && !text) {
      if (data.files?.length) { e.preventDefault(); onNotice('圖片與檔案功能將在下一階段加入'); }
      return;
    }
    e.preventDefault();
    if (html) exec('insertHTML', sanitizeHtml(html));
    else exec('insertText', text);
  });

  // 點待辦項目左邊的方框切換完成；點連結顯示「開啟連結」
  body.addEventListener('click', e => {
    const li = e.target.closest('li');
    if (li && e.target === li && li.parentElement?.hasAttribute('data-checklist')
        && e.clientX - li.getBoundingClientRect().left < 30) {
      e.preventDefault();
      if (li.getAttribute('data-checked') === 'true') li.removeAttribute('data-checked');
      else li.setAttribute('data-checked', 'true');
      changed();
      return;
    }
    const a = e.target.closest('a');
    if (a && inBody(a)) showLinkPop(a); else hideLinkPop();
  });

  function showLinkPop(a) {
    const href = a.getAttribute('href') || '';
    if (!/^(https?:|mailto:)/i.test(href)) return;
    const rect = a.getBoundingClientRect();
    linkPop.href = href;
    linkPop.hidden = false;
    linkPop.style.left = Math.max(8, Math.min(rect.left, innerWidth - linkPop.offsetWidth - 8)) + 'px';
    linkPop.style.top = (rect.bottom + 6) + 'px';
  }
  function hideLinkPop() { linkPop.hidden = true; }
  linkPop.addEventListener('click', hideLinkPop);
  body.closest('dialog')?.addEventListener('scroll', hideLinkPop, true);

  document.addEventListener('selectionchange', () => { if (inBody(selection().anchorNode)) updateToolbar(); });

  return {
    focusEnd: ensureCaret,
    setHtml(html) {
      body.innerHTML = sanitizeHtml(html);
      hideLinkPop();
      updatePlaceholder();
      toolbar.querySelectorAll('[aria-pressed]').forEach(b => b.setAttribute('aria-pressed', 'false'));
    },
    getHtml() {
      convertHighlightSpans();
      return sanitizeHtml(body.innerHTML);
    }
  };
}
