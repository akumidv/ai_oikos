// Blocks of a web application's page, found by their visible titles, and hidden so they cost
// nothing: a hidden block is display:none (no layout, no paint), and every frame inside it is held
// at about:blank, so the app embedded there does not load at all. Nodes are never removed — the
// page's framework (React in Jira) owns them and breaks on a node that went missing.
//
// Where a block ends is not read from the page's markup (class names and test ids change with
// every release) but from the other titles around it: a block is the largest ancestor of its
// title that holds no other known title. So the list of titles includes the page's own sections
// (landmarks), which are never hidden but keep a hidden neighbour from swallowing them.
(() => {
  const oikos = (globalThis.oikos ??= {});

  const HIDDEN = 'data-oikos-hidden';
  const HELD = 'data-oikos-src';
  // A block this long, or one holding the page's frame, is a sign the titles around it are not
  // rendered yet: it is left alone rather than hidden with half the page in it.
  const MAX_TEXT = 4000;
  const PAGE_FRAME = 'main, [role="main"], nav, [role="navigation"], header[role="banner"]';

  const { norm } = oikos;

  // A text node can be a whole title or the first words of one split across elements
  // ("Issue activity by <b>Some app</b>").
  const startsTitle = (text, title) => text === title || (text.length >= 3 && title.startsWith(`${text} `));

  /** Does this added or changed node carry text of one of `titles` (normalised)? */
  function hasTitle(node, titles) {
    if (node.nodeType === Node.TEXT_NODE) return textMatches(node, titles);
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) if (textMatches(t, titles)) return true;
    return false;
  }

  function textMatches(textNode, titles) {
    const text = norm(textNode.data);
    if (!text) return false;
    for (const title of titles) if (startsTitle(text, title)) return true;
    return false;
  }

  /** The elements under `root` whose whole text is one of `titles` (normalised): [{ title, el }]. */
  function findLabels(root, titles) {
    const found = [];
    const seen = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const text = norm(t.data);
      if (!text) continue;
      for (const title of titles) {
        if (!startsTitle(text, title)) continue;
        const el = labelElement(t, title);
        if (el && !seen.has(el)) {
          seen.add(el);
          found.push({ title, el });
        }
      }
    }
    return found;
  }

  function labelElement(textNode, title) {
    let el = textNode.parentElement;
    for (let i = 0; el && i < 4; i++, el = el.parentElement) {
      if (el.closest('script, style')) return null;
      const text = norm(el.textContent);
      if (text === title) return el;
      if (text.length > title.length) return null;
    }
    return null;
  }

  /** The block a label heads: its largest ancestor holding no other label; null when that is too big. */
  function blockOf(el, labelEls) {
    let node = el;
    for (;;) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      if (labelEls.some((other) => other !== el && parent.contains(other))) break;
      node = parent;
    }
    if (node.textContent.length > MAX_TEXT || node.matches(PAGE_FRAME) || node.querySelector(PAGE_FRAME)) return null;
    return node;
  }

  /** Hold a frame at about:blank, keeping its address to give back. */
  function hold(frame) {
    const src = frame.getAttribute('src');
    if (!src || src === 'about:blank') return;
    frame.setAttribute(HELD, src);
    frame.setAttribute('src', 'about:blank');
  }

  function release(frame) {
    if (!frame.hasAttribute(HELD)) return;
    frame.setAttribute('src', frame.getAttribute(HELD));
    frame.removeAttribute(HELD);
  }

  const framesIn = (el) => (el.tagName === 'IFRAME' ? [el] : [...el.querySelectorAll('iframe')]);
  const isHidden = (el) => !!el.closest(`[${HIDDEN}]`);

  function hide(node, id) {
    node.setAttribute(HIDDEN, id);
    for (const frame of framesIn(node)) hold(frame);
  }

  function show(node) {
    node.removeAttribute(HIDDEN);
    for (const frame of framesIn(node)) if (!isHidden(frame)) release(frame);
  }

  /**
   * Make the page match the wanted state: the block of every label whose title is in `hideBy`
   * (title → helper id) hidden, every other block this script hid shown again.
   * Returns [{ id, title, state: 'hidden' | 'too-big' }].
   */
  function reconcile(labels, hideBy) {
    const labelEls = labels.map((l) => l.el);
    const wanted = new Map();
    const report = [];
    for (const { title, el } of labels) {
      const id = hideBy.get(title);
      if (!id) continue;
      const node = blockOf(el, labelEls);
      report.push({ id, title, state: node ? 'hidden' : 'too-big' });
      if (node) wanted.set(node, id);
    }
    // Hide first, then show: a stale outer block shown after its inner one is hidden again does
    // not let the frames between them start loading.
    for (const [node, id] of wanted) hide(node, id);
    for (const node of document.querySelectorAll(`[${HIDDEN}]`)) if (!wanted.has(node)) show(node);
    return report;
  }

  /** A compact path from a label up to the body — what a person sends when a block is missed. */
  function describe(el) {
    const path = [];
    for (let node = el; node && node !== document.body && path.length < 16; node = node.parentElement) {
      let step = node.tagName.toLowerCase();
      for (const attr of ['data-testid', 'role', 'aria-expanded', HIDDEN]) {
        if (node.hasAttribute(attr)) step += `[${attr}=${node.getAttribute(attr)}]`;
      }
      path.push(`${step} (${node.textContent.length})`);
    }
    return path;
  }

  oikos.sections = { HIDDEN, hasTitle, findLabels, blockOf, reconcile, hold, framesIn, isHidden, describe };
})();
