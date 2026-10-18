// The helpers of the extension, by site: the one table the popup and the content scripts read.
// A helper is on unless the person turned it off in the popup; the choice is kept in
// chrome.storage.sync, so it follows their Chrome profile. A classic script (content scripts
// cannot be modules): it fills globalThis.oikos for the scripts loaded after it.
(() => {
  const oikos = (globalThis.oikos ??= {});

  // `hide` — titles of page blocks that are hidden and never loaded; `open` — titles of blocks
  // that are expanded when they appear. A title is the block's visible heading.
  oikos.SITES = [
    {
      id: 'jira',
      title: 'Jira',
      helpers: [
        {
          id: 'jira.hide-agents',
          title: 'Hide Agents',
          detail: 'The Jira agents block under the description.',
          hide: ['Agents'],
        },
      ],
    },
  ];

  // How a title is compared: without case and extra spaces.
  oikos.norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

  const KEY = 'helpers';

  oikos.loadSettings = async () => (await chrome.storage.sync.get(KEY))[KEY] ?? {};
  oikos.isOn = (settings, id) => settings[id] !== false;
  oikos.setHelper = async (id, on) => {
    const settings = await oikos.loadSettings();
    settings[id] = on;
    await chrome.storage.sync.set({ [KEY]: settings });
  };
  oikos.onSettings = (listener) =>
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes[KEY]) listener(changes[KEY].newValue ?? {});
    });
})();
