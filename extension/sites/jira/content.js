// Jira helpers (common/helpers.js names them and their titles): blocks to hide are hidden before
// they load, blocks to open are expanded as soon as an issue shows. Runs at document_start and follows the page with one MutationObserver;
// the work happens in its callback, before the browser paints what was added.
(() => {
  const { SITES, loadSettings, isOn, onSettings, norm, sections } = globalThis.oikos;
  const { HIDDEN } = sections;
  const site = SITES.find((s) => s.id === 'jira');

  // Sections and fields of the issue view. They are never hidden; they bound the hidden blocks,
  // so an app panel next to them never takes them along.
  const LANDMARKS = [
    'Description', 'Activity', 'Details', 'More fields', 'Automation', 'Development', 'Releases',
    'Child work items', 'Child issues', 'Subtasks', 'Linked work items', 'Linked issues',
    'Attachments', 'Web links', 'Confluence content', 'Comments', 'History', 'Work log',
    'Pinned fields', 'Assignee', 'Reporter', 'Labels', 'Priority', 'Sprint', 'Parent',
  ].map(norm);
  // The issue view: the full page of /browse/KEY, or the panel and dialog opened over a board.
  const ISSUE_VIEW = '[data-testid^="issue.views"], [data-testid^="issue-view"]';
  // Where a title is someone's own text, a menu or the navigation, not a block of the issue view.
  const SKIP = '.ak-renderer-document, .ProseMirror, [contenteditable="true"], nav, [role="navigation"], [role="menu"], [role="listbox"], [role="tooltip"]';

  const hideTitles = new Map(); // title → helper id
  const openTitles = new Map();
  for (const h of site.helpers) {
    for (const t of h.hide ?? []) hideTitles.set(norm(t), h.id);
    for (const t of h.open ?? []) openTitles.set(norm(t), h.id);
  }
  const titles = [...new Set([...hideTitles.keys(), ...openTitles.keys(), ...LANDMARKS])];

  let settings = {}; // every helper on until the stored choice is read
  let last = { hidden: [], opened: [], labels: [] };
  const opened = new Set(); // issue|title pairs opened in this tab: a block the person closed stays closed

  const inIssueView = (el) => !!el.closest(ISSUE_VIEW) || location.pathname.startsWith('/browse/');

  function issueKey() {
    const m = location.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/) ?? location.search.match(/[?&]selectedIssue=([A-Z][A-Z0-9_]*-\d+)/);
    return m ? m[1] : null;
  }

  function apply() {
    if (!document.body) return;
    const labels = sections.findLabels(document.body, titles).filter(({ el }) => inIssueView(el) && !el.closest(SKIP));
    const hideBy = new Map([...hideTitles].filter(([, id]) => isOn(settings, id)));
    last = { hidden: sections.reconcile(labels, hideBy), opened: openBlocks(labels), labels };
  }

  function openBlocks(labels) {
    const report = [];
    for (const { title, el } of labels) {
      const id = openTitles.get(title);
      if (!id || !isOn(settings, id) || sections.isHidden(el)) continue;
      const key = `${issueKey() ?? location.pathname + location.search}|${title}`;
      const toggle = el.closest('[aria-expanded]') ?? el.closest('button, [role="button"]') ?? sections.blockOf(el, labels.map((l) => l.el))?.querySelector('[aria-expanded]');
      let state;
      if (!toggle) state = 'no-toggle';
      else if (toggle.getAttribute('aria-expanded') === 'true') state = 'open';
      else if (opened.has(key)) state = 'closed-by-you';
      else {
        state = 'opened';
        // After the current commit of the page's framework, not in the middle of it.
        setTimeout(() => toggle.click(), 0);
      }
      opened.add(key);
      report.push({ id, title, state });
    }
    return report;
  }

  const observer = new MutationObserver((records) => {
    let changed = false;
    for (const r of records) {
      if (r.type === 'attributes') {
        // The page pointed a frame of a hidden block somewhere: hold it again.
        if (r.target.tagName === 'IFRAME' && sections.isHidden(r.target)) sections.hold(r.target);
        continue;
      }
      if (r.type === 'characterData') {
        changed ||= sections.hasTitle(r.target, titles);
        continue;
      }
      for (const node of r.addedNodes) {
        changed ||= sections.hasTitle(node, titles);
        if (node.nodeType === Node.ELEMENT_NODE) {
          for (const frame of sections.framesIn(node)) if (sections.isHidden(frame)) sections.hold(frame);
        }
      }
    }
    if (changed) apply();
  });
  observer.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src'],
  });

  loadSettings().then((s) => { settings = s; apply(); });
  onSettings((s) => { settings = s; apply(); });
  document.addEventListener('DOMContentLoaded', apply, { once: true });

  // The popup asks what the helpers did on this page.
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type !== 'oikos.status') return;
    apply();
    reply({
      site: site.id,
      issue: issueKey(),
      issueView: !!document.querySelector(ISSUE_VIEW),
      hidden: last.hidden,
      opened: last.opened,
      blocks: document.querySelectorAll(`[${HIDDEN}]`).length,
      diagnostics: last.labels
        .filter(({ title }) => hideTitles.has(title) || openTitles.has(title))
        .map(({ title, el }) => ({ title, path: sections.describe(el) })),
    });
  });
})();
