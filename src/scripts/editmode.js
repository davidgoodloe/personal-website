// In-place copy editor for the mockup (same flow as the site's dev-only EditMode.astro).
// "Edit copy" -> text becomes editable -> edit across the page -> "Save" stashes the edits
// in localStorage 'pendingEdits' (and copies them to the clipboard) -> tell Claude "apply my edits".
// Editable = smallest text units (headings, paragraphs, list items, labels). Bare text next to a
// link is wrapped so it can be edited too. Links, buttons, form fields, the 3D model and the
// map/diagram labels are not editable. Each edit is matched back to source by its original text.
(function () {
  const STORAGE_KEY = 'pendingEdits';
  const css = `
  .ce-bar { position: fixed; right: 16px; bottom: 16px; z-index: 9999; display: flex; align-items: center; gap: 8px; padding: 6px;
    background: #1a1c1f; border: 1px solid #3a3d42; border-radius: 999px; box-shadow: 0 8px 30px rgba(0,0,0,.45); font-family: 'IBM Plex Sans', system-ui, sans-serif; }
  .ce-btn { font: 600 .82rem 'IBM Plex Sans', system-ui, sans-serif; color: #e8e8e8; background: #2c2f34; border: 1px solid #3f434a; border-radius: 999px; padding: 7px 13px; cursor: pointer; }
  .ce-btn:hover { background: #363a40; }
  .ce-primary { background: #e3b34e; color: #1c1608; border-color: #e3b34e; } .ce-primary:hover { background: #eec368; }
  .ce-ghost { background: transparent; color: #b9bcc0; }
  .ce-count { font-size: .78rem; color: #b9bcc0; padding: 0 4px; }
  body.ce-editing [data-ce] { pointer-events: auto; outline: 1px dashed rgba(227,179,78,.55); outline-offset: 3px; border-radius: 2px; cursor: text; }
  body.ce-editing [data-ce]:hover { outline-style: solid; background: rgba(227,179,78,.10); }
  body.ce-editing [data-ce]:focus { outline: 2px solid #e3b34e; background: rgba(227,179,78,.12); }
  body.ce-editing [data-ce-changed] { background: rgba(227,179,78,.16); }
  body.ce-editing main a, body.ce-editing .rail a { cursor: default; }
  @media print { .ce-bar { display: none !important; } }`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  const bar = document.createElement('div');
  bar.className = 'ce-bar'; bar.id = 'ce-bar'; bar.setAttribute('aria-live', 'polite');
  bar.innerHTML = '<button id="ce-toggle" type="button" class="ce-btn ce-primary">&#9998; Edit copy</button>' +
    '<span id="ce-count" class="ce-count" hidden>0 changes</span>' +
    '<button id="ce-save" type="button" class="ce-btn" hidden>Save</button>' +
    '<button id="ce-discard" type="button" class="ce-btn ce-ghost" hidden>Discard</button>';
  document.body.appendChild(bar);
  const toggle = bar.querySelector('#ce-toggle'), saveBtn = bar.querySelector('#ce-save'),
    discardBtn = bar.querySelector('#ce-discard'), countEl = bar.querySelector('#ce-count');
  let editing = false;

  const roots = () => [document.querySelector('main'), document.querySelector('.rail'), document.querySelector('header.top')].filter(Boolean);
  const skip = (el) => el.closest('svg, canvas, button, input, textarea, select, label, #ce-bar, .vh, dialog, .country-map .credit');

  // wrap bare text that shares a parent with elements (e.g. "at " beside a link) so it's editable
  const wrapBareText = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || skip(p) || p.tagName === 'A' || p.tagName === 'SCRIPT' || p.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
        if (p.children.length === 0) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => { const s = document.createElement('span'); s.setAttribute('data-ce-wrap', ''); s.textContent = node.textContent; node.replaceWith(s); });
  };
  const unwrap = () => document.querySelectorAll('[data-ce-wrap]').forEach((s) => s.replaceWith(document.createTextNode(s.textContent || '')));

  const editables = () => {
    const out = [];
    roots().forEach((root) => root.querySelectorAll('*').forEach((el) => {
      if (el.children.length !== 0 || el.tagName === 'A' || skip(el)) return;
      if (!(el.textContent || '').trim()) return;
      out.push(el);
    }));
    return out;
  };

  const nearestContext = (el) => {
    const page = el.closest('[data-camp]');
    const stop = page ? (page.querySelector('.campline')?.textContent || '').trim() : el.closest('.rail') ? 'route list' : 'hero';
    const host = el.closest('h1,h2,h3,h4,p,li,dd,dt,summary,blockquote') || el;
    let n = host.previousElementSibling, head = '';
    while (n) { if (/^H[1-4]$/.test(n.tagName)) { head = n.textContent.trim(); break; } n = n.previousElementSibling; }
    if (!head) { const h = host.closest('.item, .sub, section')?.querySelector('h2,h3'); head = h ? h.textContent.trim() : ''; }
    return [stop, head].filter(Boolean).join(' > ');
  };
  const refreshCount = () => { const n = document.querySelectorAll('[data-ce-changed]').length; countEl.textContent = `${n} change${n === 1 ? '' : 's'}`; countEl.hidden = false; };
  const onInput = (e) => { const el = e.target; const now = (el.innerText || '').trim(); now !== el.dataset.ceOrig ? el.setAttribute('data-ce-changed', '') : el.removeAttribute('data-ce-changed'); refreshCount(); autosave(el); };

  // open every "More" so collapsed copy can be edited too; remember which were closed
  const openDetails = () => document.querySelectorAll('main details:not([open])').forEach((d) => { d.open = true; d.dataset.ceOpened = ''; });
  const closeDetails = () => document.querySelectorAll('details[data-ce-opened]').forEach((d) => { d.open = false; delete d.dataset.ceOpened; });

  const enable = () => {
    editing = true; document.body.classList.add('ce-editing');
    openDetails(); roots().forEach(wrapBareText);
    editables().forEach((el) => { el.setAttribute('data-ce', ''); el.dataset.ceOrig = (el.innerText || '').trim(); el.setAttribute('contenteditable', 'true'); el.addEventListener('input', onInput); });
    toggle.textContent = '✕ Stop editing'; saveBtn.hidden = false; discardBtn.hidden = false; refreshCount();
  };
  const disable = () => {
    editing = false; document.body.classList.remove('ce-editing');
    document.querySelectorAll('[data-ce]').forEach((el) => { el.removeAttribute('contenteditable'); el.removeEventListener('input', onInput); el.removeAttribute('data-ce'); el.removeAttribute('data-ce-changed'); });
    unwrap(); closeDetails();
    toggle.textContent = '✎ Edit copy'; saveBtn.hidden = true; discardBtn.hidden = true;
  };

  toggle.addEventListener('click', () => (editing ? disable() : enable()));
  // Autosave: every keystroke merges the page's current changes into storage, so a reload never loses work.
  const collect = () => [...document.querySelectorAll('[data-ce-changed]')].map((el) => ({
      page: 'journey', context: nearestContext(el), cls: typeof el.className === 'string' ? el.className : '',
      tag: el.tagName.toLowerCase(), original: el.dataset.ceOrig, updated: (el.innerText || '').trim(),
    }));
  const persist = (edits, reverted = []) => {
    let prev = []; try { prev = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (_) {}
    const merged = [...prev.filter((p) => !edits.some((e) => e.original === p.original) && !reverted.includes(p.original)), ...edits];
    try { merged.length ? localStorage.setItem(STORAGE_KEY, JSON.stringify(merged, null, 2)) : localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    window.__edits = merged; return merged;
  };
  let autosaveT = null;
  const autosave = (el) => {
    clearTimeout(autosaveT);
    autosaveT = setTimeout(() => {
      const reverted = el && !el.hasAttribute('data-ce-changed') ? [el.dataset.ceOrig] : [];
      const merged = persist(collect(), reverted);
      countEl.textContent = `${merged.length} saved automatically`;
      countEl.hidden = false;
    }, 400);
  };
  saveBtn.addEventListener('click', async () => {
    const edits = [...document.querySelectorAll('[data-ce-changed]')].map((el) => ({
      page: 'journey', context: nearestContext(el), cls: typeof el.className === 'string' ? el.className : '',
      tag: el.tagName.toLowerCase(), original: el.dataset.ceOrig, updated: (el.innerText || '').trim(),
    }));
    // keep earlier saved-but-unapplied edits, newest wins for the same original
    let prev = []; try { prev = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (_) {}
    const merged = [...prev.filter((p) => !edits.some((e) => e.original === p.original)), ...edits];
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(merged, null, 2)); } catch (_) {}
    window.__edits = merged;
    let copied = false; try { await navigator.clipboard.writeText(JSON.stringify(merged, null, 2)); copied = true; } catch (_) {}
    countEl.textContent = `Saved ${merged.length}${copied ? ' (copied)' : ''} - tell Claude "apply my edits"`;
  });
  discardBtn.addEventListener('click', () => {
    const reverted = [];
    document.querySelectorAll('[data-ce-changed]').forEach((el) => { reverted.push(el.dataset.ceOrig); el.innerText = el.dataset.ceOrig || ''; el.removeAttribute('data-ce-changed'); });
    persist([], reverted); refreshCount();
  });
  // on load, show that saved edits are waiting to be applied
  try { const waiting = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]').length;
    if (waiting) { countEl.textContent = `${waiting} saved edit${waiting === 1 ? '' : 's'} waiting - tell Claude "apply my edits"`; countEl.hidden = false; } } catch (_) {}
  // links and carousels stay put while editing
  document.addEventListener('click', (e) => {
    if (!editing) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && t.closest('main a, .rail a, header.top a, summary')) e.preventDefault();
  }, true);
})();
