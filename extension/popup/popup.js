// The popup: what oikos is, the helpers with a switch each, and what they did on the open tab
// (asked from the tab's content script; a tab without one has no helpers).
(async () => {
  const { SITES, loadSettings, isOn, setHelper, norm } = globalThis.oikos;

  document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;

  const status = await pageStatus();
  const settings = await loadSettings();

  if (status) {
    const site = SITES.find((s) => s.id === status.site);
    const page = document.getElementById('page');
    page.hidden = false;
    page.textContent = !status.issueView
      ? `${site.title}: no issue view on this page`
      : `${site.title} · ${status.issue ?? 'issue'} · ${status.blocks} block(s) hidden`;
    const copy = document.getElementById('copy');
    copy.hidden = false;
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(JSON.stringify(status, null, 2));
      copy.textContent = 'Copied';
    });
  }

  const main = document.getElementById('sites');
  for (const site of SITES) {
    const section = el('section', 'site');
    section.append(el('h2', '', site.title));
    for (const helper of site.helpers) section.append(helperRow(helper, status?.site === site.id ? status : null));
    main.append(section);
  }

  function helperRow(helper, status) {
    const row = el('div', 'helper');
    const label = el('label', 'switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = isOn(settings, helper.id);
    input.setAttribute('aria-label', helper.title);
    input.addEventListener('change', () => setHelper(helper.id, input.checked));
    label.append(input, el('span'));
    const titles = [...(helper.hide ?? []), ...(helper.open ?? [])];
    row.append(el('div', 'title', helper.title), label, el('div', 'detail', `${titles.join(', ')}. ${helper.detail}`));
    if (status && input.checked) row.append(el('div', 'state', stateOf(helper, titles, status)));
    return row;
  }

  // One line: what the helper found and did on the page, and which of its titles are not there.
  function stateOf(helper, titles, status) {
    const words = {
      hidden: 'hidden', 'too-big': 'left visible (its end is unclear)',
      opened: 'opened', open: 'already open', 'closed-by-you': 'left as you set it', 'no-toggle': 'found, nothing to click',
    };
    const done = [...status.hidden, ...status.opened].filter((r) => r.id === helper.id);
    const parts = done.map((r) => `${original(titles, r.title)}: ${words[r.state] ?? r.state}`);
    const missing = titles.filter((t) => !done.some((r) => r.title === norm(t)));
    if (missing.length) parts.push(`not on this page: ${missing.join(', ')}`);
    return parts.join(' · ');
  }

  const original = (titles, title) => titles.find((t) => norm(t) === title) ?? title;

  async function pageStatus() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, { type: 'oikos.status' });
    } catch {
      return null; // no content script in this tab: not a site with helpers
    }
  }

  function el(tag, cls = '', text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
})();
