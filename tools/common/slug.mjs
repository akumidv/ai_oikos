// The one spelling of a plain lowercase name — a catalog id, a handoff slug, a mount's skill prefix:
// latin letters, digits and `-`, starting with a letter or digit.

/** A plain lowercase name. */
export const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * `text` as a name that matches SLUG: lowercased, every run of other characters one `-`, none at
 * either end. '' when nothing of it is a letter or a digit, so the caller says so.
 * @param {string} text
 * @returns {string}
 */
export const slugify = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
