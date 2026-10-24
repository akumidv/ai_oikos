#!/usr/bin/env node
// Jira: read tasks, search, sprints and boards; comment and transition under guards.
// Also board and sprint reads, goals, and issue create/edit/link/unlink/move under the same guards.
// Markdown written to Jira links task keys as cards and uploads the images it names (see
// "markdown writes" below); `description` edits one section of a description, or appends to it.
// Read-only by default; every write has --dry-run. `project-init` and `repos add` write only the
// installation's oikos.yaml (task-tracking.jira.projects.<KEY>), under the same guard.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runCli, required, printJson, UsageError } from '../common/cli.mjs';
import { guardOutgoing, outgoingRules, uploadedMarkdown } from '../common/outgoing.mjs';
import { atlassianCreds, credsComplete, atlassianHelp, atlassianClient, missingCreds } from '../common/atlassian.mjs';
import {
  adfToEditableMarkdown, adfToText, appendBlocks, cardKey, imageTargets, markdownToAdf, outline, plainAdf, replaceSection,
  sectionBody, taskKeys,
} from '../common/adf.mjs';
import { adfIdentities, carriedIdentities, lossyNodes, lossyText, missingIdentities } from '../common/adf-loss.mjs';
import { textSize, unifiedDiff } from '../common/diff.mjs';
import { HttpError, ChannelError } from '../common/http.mjs';
import { envValue } from '../common/env.mjs';
import { fileRoots, localFile } from '../common/local-files.mjs';
import { config, configFile } from '../common/config.mjs';
import { INSTALL_FILE } from '../common/paths.mjs';
import {
  ANY, effectiveMode, effectivePolicy, numberPatternProblem, numberPatterns, policyConflict, policyConflicts, policyReason, resolveTransition, statusesText,
  trackerProblems, trackerProject,
} from '../common/transitions.mjs';
import {
  branchesWithoutPullRequest, briefPullRequestLines, codeHosts, collectPullRequests, foundBySearch, mergePullRequests, moveComment, parseBranchUrl,
  parsePullRequestUrl, pullRequestKey, pullRequestLines, searchGaps, searchIncomplete,
} from '../common/pullrequests.mjs';
import { PROJECT_LISTS, PROJECT_MAPS, PROJECT_POLICY, editTrackerProject, poolRepoArgs, trackerProjectText, writeFileAtomic } from '../common/tracking-config.mjs';
import {
  DEFAULT_MONTHS, aliasCandidates, aliasLines, monthsAgo, poolCandidates, poolLines, proseLines, searchOwners,
  policyLines, searchProjectSetup, workflowCoverage, workflowLines,
} from '../common/project-setup.mjs';

const TOOL = 'node oikos/tools/jira/cli.mjs';
const PROJECTS_PATH = 'task-tracking.jira.projects';

// Without a task-tracking.jira part in oikos.yaml (its rules: common/transitions.mjs), the statuses an
// agent may move a task among; from review on only a person moves a task, in either direction. Both
// are the organization's workflow: JIRA_AGENT_STATUSES and JIRA_REVIEW_STATUSES (comma lists in
// oikos.yaml settings), compared case-insensitively.
const statusList = (key, fallback) => (envValue(key) || fallback).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const AGENT_STATUSES = statusList('JIRA_AGENT_STATUSES', 'to do, in progress, blocked');
const REVIEW_ON = new Set(statusList('JIRA_REVIEW_STATUSES', 'review, in review'));
const isAgentStatus = (name) => AGENT_STATUSES.includes(String(name).trim().toLowerCase());

const INFO_FIELDS = 'summary,description,status,assignee,reporter,issuetype,priority,parent,labels,components,issuelinks,attachment,comment,subtasks,duedate';
const LIST_FIELDS = 'summary,status,issuetype,assignee,priority';

/**
 * The credentials and the client for a command that would `what`. Missing credentials are a usage
 * error naming each missing key, raised before any request; only an explicit --dry-run whose
 * preview reads nothing from Jira (`offline`) goes on, with a null client.
 */
function client(what, { offline = false } = {}) {
  const c = atlassianCreds();
  if (credsComplete(c)) return { c, jira: atlassianClient(c, 'jira') };
  if (offline) return { c, jira: null };
  throw missingCreds(c, 'Jira', what);
}

/** The closing note of a dry run made without credentials: the write itself will need them. */
function offlineNote(c) {
  console.log(`\n(no Jira credentials — the write itself needs them)\n${atlassianHelp(c)}`);
}

const name = (o, fallback = '') => (o && (o.displayName || o.name)) || fallback;

function issueLine(issue) {
  const f = issue.fields || {};
  const who = f.assignee ? ` @${name(f.assignee)}` : '';
  return `${issue.key} [${name(f.status)}] ${name(f.issuetype)} · ${f.summary || ''}${who}`;
}

/** Each issue link as the task states it — "<verb> <issue line> [link N]" — the id being what `unlink --id` takes. */
function linksLines(f) {
  return (f.issuelinks || []).map((l) => {
    const other = l.outwardIssue || l.inwardIssue;
    const verb = l.outwardIssue ? l.type?.outward : l.type?.inward;
    return other ? `${verb} ${issueLine(other)}${l.id ? ` [link ${l.id}]` : ''}` : '';
  }).filter(Boolean);
}

/**
 * The lines of `info`: the task's fields, description, attachments and comments, each comment with
 * its id (what `comment --edit` and `--delete` take). `relations: false` leaves out the links and
 * sub-tasks, which `context` prints as sections of their own.
 */
function infoLines(d, { relations = true } = {}) {
  const f = d.fields || {};
  const out = [`Task: ${d.key}`, `Summary: ${f.summary || ''}`];
  out.push(`Type: ${name(f.issuetype)}   Status: ${name(f.status)}   Priority: ${name(f.priority, '-')}   ` +
    `Assignee: ${name(f.assignee, 'unassigned')}   Reporter: ${name(f.reporter, '-')}`);
  if (f.duedate) out.push(`Due: ${f.duedate}`);
  if (f.parent) out.push(`Parent: ${f.parent.key} — ${f.parent.fields?.summary || ''}`);
  if (f.labels?.length) out.push(`Labels: ${f.labels.join(', ')}`);
  if (f.components?.length) out.push(`Components: ${f.components.map((x) => x.name).join(', ')}`);
  const links = relations ? linksLines(f) : [];
  if (links.length) out.push('Links:', ...links.map((l) => `  ${l}`));
  if (relations && f.subtasks?.length) out.push('Sub-tasks:', ...f.subtasks.map((s) => `  ${issueLine(s)}`));
  const body = f.description ? adfToText(f.description).trim() : '';
  out.push('', 'Description:', body || '(empty — the summary above is the whole specification)');
  const atts = f.attachment || [];
  if (atts.length) {
    out.push('', 'Attachments:');
    for (const a of atts) out.push(`  [${a.id}] ${a.filename} (${a.mimeType}, ${a.size} bytes) — NOT READ`);
    out.push(`  Fetch: ${TOOL} attachment --task ${d.key} --id <id> [--dir DIR]`);
  }
  const comments = f.comment?.comments || [];
  if (comments.length) {
    out.push('', `Comments (${comments.length}):`);
    for (const cm of comments) {
      out.push(`  --- ${name(cm.author, '?')}, ${(cm.created || '').slice(0, 10)}${cm.id ? ` [id ${cm.id}]` : ''}`);
      const text = cm.body ? adfToText(cm.body).trim() : '';
      for (const line of (text || '(empty)').split('\n')) if (line.trim()) out.push(`      ${line.trim()}`);
    }
  }
  if (atts.length || /see Attachments|embedded card/.test(body)) {
    out.push('', 'NOTE — part of this task is not text (images, files, cards). Fetch the attachment ' +
      'and read it; if it stays unclear, ask the user. Do not rebuild it from the surrounding text.');
  }
  return out;
}

/**
 * Whether GET /myself rejects the credentials: true on 401/403, false on success, null when it
 * gave no clean answer. Jira answers a rejected credential on an issue with 404 too.
 */
async function credentialsRejected(jira) {
  try {
    await jira.get('/rest/api/3/myself');
    return false;
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return true;
    return null;
  }
}

/** The usage error for a 404 on `key`, after asking /myself whether the credentials are the cause. */
async function issueNotFound(jira, key) {
  const rejected = await credentialsRejected(jira);
  if (rejected === true) {
    return new UsageError(`Jira rejected the credentials for this lookup — JIRA_EMAIL or JIRA_API_TOKEN is wrong or lacks access, not that ${key} is missing.\n` +
      atlassianHelp(atlassianCreds()));
  }
  if (rejected === false) return new UsageError(`${key}: does not exist, or the authenticated account cannot see it.`);
  return new UsageError(`${key}: not found — it does not exist, this account cannot see it, or the credentials are wrong (Jira answers 404 for all three).`);
}

async function fetchIssue(jira, key, fields) {
  try {
    return await jira.get(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw await issueNotFound(jira, key);
    throw e;
  }
}

/**
 * The short reason a read failed on the network or at Jira (`HTTP 500`, the channel message);
 * any other error is a fault of the code and is rethrown.
 */
function networkReason(e) {
  if (!(e instanceof HttpError || e instanceof ChannelError)) throw e;
  return e instanceof HttpError ? `HTTP ${e.status}` : e.message;
}

/** `{ value }` of the read `load`, or `{ error }` with its short reason when it failed on the network. */
async function attempt(load) {
  try {
    return { value: await load() };
  } catch (e) {
    return { error: networkReason(e) };
  }
}

const unavailableLine = (title, reason) => `_${title}: unavailable (${reason})_`;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The warning for an active sprint whose end date has passed — still open, so its tasks look current
 * while the sprint is over — or null. Closing it and the carry-over are a person's decision.
 */
function overdueSprintWarning(sprint, now = Date.now()) {
  const end = Date.parse(sprint?.endDate || '');
  if (sprint?.state !== 'active' || Number.isNaN(end) || end >= now) return null;
  const days = Math.floor((now - end) / DAY_MS);
  const ago = days === 0 ? 'earlier today' : `${days} day${days === 1 ? '' : 's'} ago`;
  return `Warning: the active sprint ended on ${sprint.endDate.slice(0, 10)} (${ago}) and is still open — a person closes it and decides on the carry-over.`;
}

/** GET /search/jql following nextPageToken until `limit` issues are in hand. */
async function jqlSearch(jira, jql, limit, fields = LIST_FIELDS) {
  const issues = [];
  let token;
  let more = false;
  for (;;) {
    let url = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${fields}&maxResults=${Math.min(limit, 100)}`;
    if (token) url += `&nextPageToken=${encodeURIComponent(token)}`;
    const d = await jira.get(url);
    issues.push(...(d.issues || []));
    token = d.nextPageToken;
    if (issues.length >= limit) { more = Boolean(token) || issues.length > limit; break; }
    if (!token || !(d.issues || []).length) break;
  }
  return { issues: issues.slice(0, limit), truncated: more };
}

/**
 * `search --count`: the total of the JQL as POST /search/approximate-count answers it — approximate,
 * and said so; no issue is read. A read, though sent as a POST.
 */
async function printCount(jira, v) {
  const { data } = await jira.post('/rest/api/3/search/approximate-count', { jql: v.jql });
  if (v.json) return printJson(data);
  if (typeof data?.count !== 'number') throw new HttpError(200, '/rest/api/3/search/approximate-count', `no count in the answer: ${JSON.stringify(data)}`);
  console.log(`≈ ${data.count} issue${data.count === 1 ? '' : 's'} (approximate count)`);
  return 0;
}

/** Agile endpoints page with startAt/isLast (boards, sprints) or startAt/total (issues). */
async function agilePaged(jira, path, key, limit) {
  const out = [];
  let startAt = 0;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const d = await jira.get(`${path}${sep}startAt=${startAt}&maxResults=50`);
    const batch = d[key] || [];
    out.push(...batch);
    startAt += batch.length;
    const last = d.isLast ?? (d.total !== undefined ? startAt >= d.total : true);
    if (last || !batch.length || out.length >= limit) break;
  }
  return out.slice(0, limit);
}

async function fieldIdsByName(jira, names) {
  const fields = await jira.get('/rest/api/3/field');
  const out = {};
  for (const f of fields) if (names.includes(f.name) && !out[f.name]) out[f.name] = f.id;
  return out;
}

function readText(values) {
  if (values.file) return readFileSync(values.file, 'utf8');
  return values.text;
}

/** The override flags of the content check (common/outgoing.mjs), on every command that writes text. */
const CHECK_OPTIONS = { 'allow-non-english': { type: 'boolean' }, 'allow-flagged': { type: 'boolean' } };

/** The content check's override flags of `v`, as a command line repeats them. */
const checkFlags = (v) => Object.keys(CHECK_OPTIONS).filter((flag) => v[flag]).map((flag) => `--${flag}`);

// == markdown writes: task keys as cards, image lines as images ==
// markdownToAdf does no I/O, so what it asks about is read first, and only when the markdown has
// something to resolve: the project keys behind its task keys, and the files behind its image lines.
// An image is a local file inside the installation (its .local/ working folders included, not a
// dot-named store there — ADR 0002 D01 — and nothing under a dot-named file or folder elsewhere, such
// as .claude/ or .git/) or the markdown file's folder, or `attachment:<name>` of the issue; a file is
// uploaded unless the issue already holds an attachment of the same name and size.
// `attach` takes files by the same path rule (localFile, tools/common/local-files.mjs), of more types.

const PROJECT_KEYS_PER_CALL = 50;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
const ATTACHMENT_REF = 'attachment:';
// The attachment content endpoint redirects to the media file: /file/<uuid>/binary.
const MEDIA_FILE_ID = /\/file\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/;
const placeholderId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The task keys of the task cards in an ADF node or list of nodes. */
function cardKeysIn(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) cardKeysIn(child, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const key = cardKey(node);
  if (key) out.push(key);
  return cardKeysIn(node.content, out);
}

/** The keys among `projects` the site has: GET /project/search filtered by key, paged. */
async function knownProjects(jira, projects) {
  const query = projects.map((p) => `keys=${encodeURIComponent(p)}`).join('&');
  const found = await agilePaged(jira, `/rest/api/3/project/search?${query}`, 'values', Infinity);
  return new Set(found.map((p) => String(p.key || '').toUpperCase()));
}

/**
 * The site's task links for one command: `forText(md)` and `forDoc(doc)` give the `issueUrl` to
 * convert or judge with — `<site>/browse/KEY` for a key of a project the site has, else null — or
 * undefined when there is no task key to resolve (or no client), without a request. Each project
 * is asked about once; a project list that cannot be read leaves its keys plain text, said on stderr.
 */
function siteLinks(jira, c) {
  const known = new Map();
  const issueUrl = (key) => (known.get(projectOf(key)) ? `${c.baseUrl}/browse/${key}` : null);
  async function learn(keys) {
    const missing = [...new Set(keys.map(projectOf))].filter((p) => !known.has(p));
    for (let i = 0; i < missing.length; i += PROJECT_KEYS_PER_CALL) {
      const chunk = missing.slice(i, i + PROJECT_KEYS_PER_CALL);
      const read = await attempt(() => knownProjects(jira, chunk));
      if (read.error) console.error(`jira: ${chunk.join(', ')} keys stay plain text — the project list could not be read (${read.error}).`);
      for (const p of chunk) known.set(p, Boolean(read.value?.has(p)));
    }
  }
  const resolver = async (keys) => {
    if (!keys.length || !jira) return undefined;
    await learn(keys);
    return issueUrl;
  };
  return { forText: (md) => resolver(taskKeys(md)), forDoc: (doc) => resolver(cardKeysIn(doc?.content)) };
}

const IMAGE_ROOTS = 'the installation and the markdown file\'s folder';

/** Where a relative image path starts and the folders an image may come from (fileRoots). */
const imageRoots = (file) => fileRoots(file, IMAGE_ROOTS);

/** The local image `target` (localFile): an image file, uploaded to the task. */
const localImage = (target, roots) => localFile(target, roots, { what: 'image', types: IMAGE_TYPES, verb: 'uploaded' });

/**
 * The images `md` names (imageTargets) as a plan, judged before anything is read from Jira: an
 * `attachment:<name>` target as { target, name }, a local path as localImage gives it.
 */
function imagePlan(md, file) {
  const targets = imageTargets(md);
  if (!targets.length) return [];
  const roots = imageRoots(file);
  return targets.map((target) => (target.startsWith(ATTACHMENT_REF) ? { target, name: target.slice(ATTACHMENT_REF.length) } : localImage(target, roots)));
}

/** POST the local `file` ({ name, path }) to `key` as one multipart file part of type `mime`; the attachment Jira stored. */
async function uploadFile(jira, key, file, mime) {
  const boundary = `oikos-${randomUUID()}`;
  const filename = file.name.replace(/["\\\r\n]/g, '_');
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head), readFileSync(file.path), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const path = `${issuePath(key)}/attachments`;
  const { status, data } = await jira.raw('POST', path, body, {
    headers: { 'X-Atlassian-Token': 'no-check', 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  });
  const stored = Array.isArray(data) ? data[0] : null;
  if (!stored?.id) throw new HttpError(status, path, `Jira stored no attachment for ${file.name}`);
  return stored;
}

/** The attachments of `key` by file name (the last of a name wins). */
const attachmentsOf = async (jira, key) => new Map(((await fetchIssue(jira, key, 'attachment')).fields?.attachment || []).map((a) => [a.filename, a]));

/** The attachment among `attached` (by name) with the name and size of the local `file`, or undefined. */
function sameAttachment(attached, file) {
  const same = attached?.get(file.name);
  return same && Number(same.size) === file.size ? same : undefined;
}

/**
 * The media file id an ADF media node takes for the attachment `id` — not the attachment id: the
 * content endpoint's redirect, read and not followed, names it. Only the id leaves this function
 * (the redirect URL carries a token).
 */
async function mediaFileId(jira, id) {
  const path = `/rest/api/3/attachment/content/${encodeURIComponent(id)}`;
  const { status, headers } = await jira.raw('GET', path, undefined, { redirect: 'manual', as: 'text' });
  const media = String(headers.get('location') || '').match(MEDIA_FILE_ID)?.[1];
  if (!media) throw new HttpError(status, path, `no media file id in the redirect of attachment ${id}`);
  return media;
}

/**
 * The planned `file` (an image, or a file to attach) as an attachment of `key`: the one it names,
 * one of the same name and size, or a new upload of its type.
 */
async function attachmentFor(jira, key, file, attached) {
  if (!file.path) return attached.get(file.name);
  const same = sameAttachment(attached, file);
  if (same) {
    console.log(`Reusing attachment ${file.name} (${file.size} bytes) of ${key}.`);
    return same;
  }
  const stored = await uploadFile(jira, key, file, file.mime);
  attached.set(file.name, { ...stored, size: stored.size ?? file.size });
  console.log(`Uploaded ${file.name} (${file.size} bytes) to ${key}.`);
  return stored;
}

/** What a dry run says of each planned image, against the attachments `attached` of `key` (null: not read). */
function imageDryLines(plan, key, attached) {
  const lines = plan.map((image) => {
    if (!image.path) return `  ${image.target} — ${attached ? 'already' : 'to be'} on ${key}`;
    const fate = !attached ? 'uploaded, or reused when an attachment of that name and size is there (not read offline)'
      : sameAttachment(attached, image) ? `reused: ${key} has an attachment of that name and size` : `uploaded to ${key}`;
    return `  ${image.target} → ${image.name} (${image.size} bytes) — ${fate}`;
  });
  return ['Images (the media ids in a dry run are placeholders):', ...lines];
}

/**
 * The resolveImage for the planned images of `key` and what a dry run says of them. An
 * `attachment:` target the issue does not have is refused before any upload. A dry run uploads
 * nothing and answers placeholder ids; offline (no client) it reads nothing.
 */
async function imageResolver(jira, key, plan, { dry }) {
  const ids = new Map();
  const resolveImage = (target) => ids.get(target) ?? null;
  if (!plan.length) return { resolveImage, imageLines: [] };
  const attached = jira ? await attachmentsOf(jira, key) : null;
  for (const image of plan) {
    if (!image.path && attached && !attached.has(image.name)) {
      throw new UsageError(`Image '${image.target}': ${key} has no attachment named ${image.name}. Attachments: ${[...attached.keys()].join(', ') || 'none'}`);
    }
  }
  if (dry) {
    plan.forEach((image, n) => ids.set(image.target, placeholderId(n)));
    return { resolveImage, imageLines: imageDryLines(plan, key, attached) };
  }
  for (const image of plan) ids.set(image.target, await mediaFileId(jira, (await attachmentFor(jira, key, image, attached)).id));
  return { resolveImage, imageLines: [] };
}

/**
 * The markdownToAdf options for `md` written to the issue `key`, and what a dry run says of its
 * images: issueUrl when `md` names a task key; resolveImage over its images, uploaded to `key`
 * unless `dry`. resolveImage is always set, so a `media:<id>` line read back stays an image.
 */
async function markdownOptions(jira, links, md, { key, file, dry }) {
  const plan = imagePlan(md, file);
  const issueUrl = await links.forText(md);
  const { resolveImage, imageLines } = await imageResolver(jira, key, plan, { dry });
  return { options: { issueUrl, resolveImage }, imageLines };
}

// == transition: the rules of task-tracking.jira (ADR 0001), or the JIRA_AGENT_STATUSES allowlist ==

const DESCRIPTION_LIMIT = 3000;
const COMMENT_LIMIT = 1500;
const EPICS_LIMIT = 50;
const browse = (c, key) => `${c.baseUrl || '<JIRA_BASE_URL>'}/browse/${key}`;
const issuePath = (key) => `/rest/api/3/issue/${encodeURIComponent(key)}`;
const sameStatus = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const projectOf = (key) => String(key).split('-')[0].toUpperCase();
/** `text` as one shell word: as is when it is plain, else single-quoted. */
const shellWord = (text) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${String(text).replace(/'/g, "'\\''")}'`);

/** `text` cut to `limit` characters, saying how much was left out. */
function truncated(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}\n… (${text.length - limit} more characters)`;
}

/** The http(s) URLs in `text`, in order, without trailing punctuation, each once. */
function urlsIn(text) {
  const found = (String(text).match(/https?:\/\/[^\s<>()[\]"'`]+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, ''));
  return [...new Set(found)];
}

/**
 * When the task last entered `status`, from its changelog histories ({ created, items[] }), or null
 * when no history moves it there (it was created in it).
 */
function lastEntry(histories, status) {
  let last = null;
  for (const h of histories) {
    const into = (h.items || []).some((i) => (i.fieldId || i.field) === 'status' && sameStatus(i.toString ?? '', status));
    if (into && (last === null || Date.parse(h.created) > Date.parse(last))) last = h.created;
  }
  return last;
}

/**
 * The Jira transition to `to` open from the current status, or a usage error naming the reachable
 * ones `shown` keeps — and what `paths` (given the open transitions) adds, when it finds a way round.
 */
async function jiraTransition(jira, key, to, current, shown, { paths } = {}) {
  const { transitions = [] } = await jira.get(`${issuePath(key)}/transitions`);
  const match = transitions.find((t) => sameStatus(name(t.to), to));
  if (match) return match;
  const reachable = transitions.map((t) => name(t.to)).filter(shown);
  const around = paths ? await paths(transitions) : [];
  throw new UsageError([`no transition to '${to}' from ${current}. Reachable: ${reachable.join(', ') || 'none'}`, ...around].join('\n'));
}

const PATH_CANDIDATES = 10;
/** `text` as a JQL string literal. */
const jqlString = (text) => `"${String(text).replace(/["\\]/g, '\\$&')}"`;

/**
 * The two-step paths to `to` when no transition reaches it directly, as lines for the error: through
 * a status S an open transition reaches, when the rules allow both current → S and S → `to` (mode
 * other than person) and this project's history shows a move S → `to` (one search of one result per
 * S, for at most PATH_CANDIDATES of them). A search that fails counts as no history. `history` holds
 * the searches of this run by their JQL — one Map per single move or batch, so the tasks of a batch
 * in the same status ask each once.
 */
async function twoStepPaths(jira, { part, project, key, current, to, history }, transitions) {
  const mode = (from, status) => effectiveMode(part, project, from, status);
  const statuses = new Map(transitions.map((t) => [name(t.to).trim().toLowerCase(), name(t.to)]));
  const candidates = [...statuses.values()].filter((s) => !sameStatus(s, current) && mode(current, s) !== 'person').slice(0, PATH_CANDIDATES);
  const out = [];
  for (const via of candidates) {
    const modes = [mode(current, via), mode(via, to)];
    if (modes[1] === 'person') continue;
    const jql = `project = ${jqlString(project)} AND status CHANGED FROM ${jqlString(via)} TO ${jqlString(to)}`;
    if (!history.has(jql)) history.set(jql, attempt(() => jqlSearch(jira, jql, 1, 'status')));
    const seen = await history.get(jql);
    if (!seen.value?.issues.length) continue;
    const step = (status) => `  ${TOOL} transition --task ${shellWord(key)} --to ${shellWord(status)} --dry-run`;
    out.push(`A path the rules allow: ${current} → ${via} → ${to} (modes: ${modes.join(', ')}; the second step is seen in this project's history). ` +
      'Each step is its own move with its own dry run:', step(via), step(to));
  }
  return out;
}

function commentLines(text) {
  return text ? ['Comment posted after the move:', '-'.repeat(40), text, '-'.repeat(40)] : [];
}

/** The transition `match` of `key`, posted. */
async function transitionOnly(jira, key, current, match) {
  await jira.post(`${issuePath(key)}/transitions`, { transition: { id: match.id } });
  console.log(`${key}: ${current} → ${name(match.to)}`);
}

/** The comment of a move (markdown, as `comment` posts it), posted to `key`. */
async function moveCommentPost(jira, c, key, text) {
  const r = await jira.post(`${issuePath(key)}/comment`, { body: markdownToAdf(text, { issueUrl: await siteLinks(jira, c).forText(text) }) });
  console.log(`Posted comment to ${key} (HTTP ${r.status}): ${browse(c, key)}`);
}

/**
 * The comment `text` of a move of `key` to `to` that went through and whose post failed with
 * `error`: its full text (markdown, with its pull request lines) between the fences of commentLines,
 * under a header naming the command to post it with — the task is in `to` now, so a dry run of the
 * move answers "no transition" and no longer shows it.
 */
function unpostedCommentLines(text, key, to, error) {
  const reason = String(error?.message ?? error).split('\n')[0];
  return [`${key}: moved to ${to}; the comment was not posted (${reason}). Its text, to post with ` +
    `${TOOL} comment --task ${shellWord(key)} --file <this text saved> --dry-run first:`, '-'.repeat(40), text, '-'.repeat(40)];
}

/** The comment of a move of `key` to `to`, posted; when the post fails, its text is printed and the error goes on. */
async function postMoveComment(jira, c, key, to, text) {
  try {
    await moveCommentPost(jira, c, key, text);
  } catch (e) {
    console.log(unpostedCommentLines(text, key, to, e).join('\n'));
    throw e;
  }
}

/** The move itself, then the comment (markdown, as `comment` posts it) when one was given. */
async function move(jira, c, v, current, match) {
  await transitionOnly(jira, v.task, current, match);
  if (v.comment) await postMoveComment(jira, c, v.task, name(match.to), v.comment);
  return 0;
}

/** No task-tracking.jira part: an agent moves a task only among JIRA_AGENT_STATUSES, as before the rules. */
async function allowlistTransition(v, dry) {
  const c = atlassianCreds();
  const refuse = () => {
    console.error(`refused: an agent moves a task only among ${AGENT_STATUSES.join(', ')} — move ${v.task} to '${v.to}' yourself: ${browse(c, v.task)}`);
    return 3;
  };
  if (!isAgentStatus(v.to)) return refuse();
  // Even the dry run reads the current status and the transitions open from it.
  const { jira } = client(`move ${v.task}`);
  const d = await fetchIssue(jira, v.task, 'status');
  const current = name(d.fields.status);
  if (!isAgentStatus(current)) return refuse();
  const match = await jiraTransition(jira, v.task, v.to, current, isAgentStatus);
  if (dry) {
    console.log(`DRY RUN — would move ${v.task}: ${current} → ${name(match.to)} (transition ${match.id})`);
    if (v.comment) console.log(commentLines(v.comment).join('\n'));
    return 0;
  }
  return move(jira, c, v, current, match);
}

/**
 * The move of the task `key` to `to` by the rules of `part`: { d, project, current, resolved, origin,
 * match }, or { refusal } naming the rule when it is a person's move. No transition to `to` is a usage
 * error with the reachable statuses and the two-step paths the rules allow; `history` is the run's
 * cache of their history searches (`twoStepPaths`), a new one when not given.
 */
async function moveOf(jira, c, part, key, to, { history = new Map() } = {}) {
  const project = projectOf(key);
  const d = await fetchIssue(jira, key, 'summary,status,assignee,description,attachment,parent,issuetype');
  const current = name(d.fields.status);
  const resolved = resolveTransition(part, project, current, to);
  const origin = `task-tracking.jira.${resolved.origin}`;
  if (resolved.mode === 'person') {
    const why = resolved.rule ? `by ${origin}` : `by ${origin} (${part.defaults?.default ? 'person' : 'unset, so person'}) — no rule covers it`;
    return { refusal: `${current} → ${to} in ${project} is a person's move ${why} — move ${key} to '${to}' yourself: ${browse(c, key)}` };
  }
  // The stricter of rule and policy wins (ADR 0004 D03): `policy:` sets it apart from a rule's own refusal.
  const conflict = policyConflict(part, project, current, to, resolved);
  if (conflict) {
    return { refusal: `policy: ${current} → ${to} in ${project} is a person's move — ${policyReason(conflict, 'task-tracking.jira')}; `
      + `it falls under ${origin} (${resolved.mode}), which the policy overrides — move ${key} to '${to}' yourself: ${browse(c, key)}` };
  }
  const open = (status) => effectiveMode(part, project, current, status) !== 'person';
  const paths = (transitions) => twoStepPaths(jira, { part, project, key, current, to, history }, transitions);
  const match = await jiraTransition(jira, key, to, current, open, { paths });
  return { d, project, current, resolved, origin, match };
}

/** A task-tracking.jira part: the rule the move falls under decides (agent, confirm, person). */
async function ruleTransition(v, part, dry) {
  const { c, jira } = client(`move ${v.task}`);
  const planned = await moveOf(jira, c, part, v.task, v.to);
  if (planned.refusal) {
    console.error(`refused: ${planned.refusal}`);
    return 3;
  }
  const { d, project, current, resolved, origin, match } = planned;
  if (!dry && resolved.mode === 'confirm') {
    // The comment of a confirm move also lists the pull requests found in the pool (D05) — and in the
    // extended set under --extended (D08) — as its dry run showed.
    const { pullRequests, skip } = await taskPullRequests(jira, d, v.task, resolved.project, {}, { extended: Boolean(v.extended), skip: v['skip-pr'], part });
    skipNotes(v.task, skip);
    const code = await move(jira, c, { ...v, comment: moveComment(v.comment, pullRequests.pullRequests) }, current, match);
    // Only a move and comment that went through list "what was found"; a failure has thrown by now.
    incompleteNote(v.task, pullRequests);
    return code;
  }
  if (!dry) return move(jira, c, v, current, match);
  if (resolved.mode === 'agent' && v['skip-pr']?.length) {
    throw new UsageError(`--skip-pr: ${current} → ${v.to} is an agent move, which looks for no pull request and posts none — leave the flag out.`);
  }
  if (resolved.mode === 'agent') {
    console.log(`DRY RUN — would move ${v.task}: ${current} → ${name(match.to)} (transition ${match.id}; mode agent by ${origin})`);
    if (v.comment) console.log(commentLines(v.comment).join('\n'));
    return 0;
  }
  const lines = await confirmEvidence(jira, c, { v, d, project, current, match, resolved, origin, part });
  console.log(lines.join('\n'));
  return 0;
}

/** Every comment of `key`, oldest first. */
const allComments = (jira, key) => agilePaged(jira, `${issuePath(key)}/comment?orderBy=created`, 'comments', 5000);

/** The comments among `comments` made at or after `since` (all when null). */
function commentsSince(comments, since) {
  const from = since ? Date.parse(since) : -Infinity;
  return comments.filter((cm) => Date.parse(cm.created) >= from);
}

const commentText = (cm) => (cm.body ? adfToText(cm.body).trim() : '');

/** The task's remote links as { title, url }, or the reason they could not be read. */
async function remoteLinks(jira, key) {
  try {
    const links = await jira.get(`${issuePath(key)}/remotelink`);
    return { links: (Array.isArray(links) ? links : []).map((l) => ({ title: l.object?.title || '(untitled)', url: l.object?.url || '' })), error: null };
  } catch (e) {
    if (e instanceof HttpError) return { links: [], error: `HTTP ${e.status}` };
    throw e;
  }
}

const DEV_STATES = { OPEN: 'open', DRAFT: 'draft', MERGED: 'merged', DECLINED: 'closed', CLOSED: 'closed' };

/** A pull request as dev-status reports it, as a pull request record (common/pullrequests.mjs). */
function devPullRequest(pr) {
  const parsed = parsePullRequestUrl(pr.url || '');
  return {
    url: parsed?.url || pr.url, repo: parsed ? `${parsed.host}:${parsed.path}` : null, number: parsed?.number ?? null,
    title: pr.name || null, branch: pr.source?.branch || null, state: DEV_STATES[String(pr.status).toUpperCase()] || 'unknown',
  };
}

/**
 * What the Jira development integrations report for the issue `issueId` — best effort (D05). The
 * summary counts pull requests and branches per integration app; the detail is read once per app the
 * summary names, by its own applicationType (never a fixed one: a third-party git app reports
 * under its own type). Returns pull request records, branches, the commit count the summary names,
 * `about` — the summary's count and apps, for the full dry run — and `notes`, each a part not read;
 * `error` is the reason when the summary itself could not be read.
 */
async function devStatus(jira, issueId) {
  const out = { known: [], branches: [], commits: 0, about: null, notes: [], error: null };
  const unavailable = networkReason;
  if (!issueId) return { ...out, error: 'the issue id was not read', notes: ['dev-status unavailable: the issue id was not read'] };
  let summary;
  try {
    summary = (await jira.get(`/rest/dev-status/latest/issue/summary?issueId=${encodeURIComponent(issueId)}`)).summary || {};
  } catch (e) {
    const reason = unavailable(e);
    return { ...out, error: reason, notes: [`dev-status unavailable (${reason})`] };
  }
  out.commits = summary.repository?.overall?.count ?? 0;
  const apps = new Map();
  for (const part of [summary.pullrequest, summary.branch]) {
    for (const [type, app] of Object.entries(part?.byInstanceType || {})) apps.set(type, app?.name || type);
  }
  const counted = summary.pullrequest?.overall?.count ?? 0;
  out.about = `dev-status: ${counted} pull request(s) via ${apps.size ? [...apps.values()].join(', ') : 'no integration app'}`;
  for (const [type, appName] of apps) {
    try {
      const q = new URLSearchParams({ issueId, applicationType: type, dataType: 'pullrequest' });
      const { detail = [] } = await jira.get(`/rest/dev-status/latest/issue/detail?${q}`);
      for (const d of detail) {
        out.known.push(...(d.pullRequests || []).filter((pr) => pr.url).map(devPullRequest));
        out.branches.push(...(d.branches || []).map((b) => parseBranchUrl(b.url || '')).filter(Boolean));
      }
    } catch (e) {
      out.notes.push(`dev-status detail of ${appName} unavailable (${unavailable(e)})`);
    }
  }
  return out;
}

/**
 * The pull requests of the task `d` (D05): the PR URLs in its description, every comment and its
 * remote links, what dev-status reports, then the project's pool, and its extended set when
 * `extended` (D08). `sources` are what the caller has read already ({ description, comments,
 * remote }); what is missing is read here. The pull requests `skip` names (--skip-pr, D12) are
 * taken out into `skipped` before the commit search is decided on; `skip` says which of its URLs
 * named an attached one or none at all. `incomplete` holds the notes of what was not read: all the
 * notes but dev-status's own count.
 */
async function taskPullRequests(jira, d, key, project, sources = {}, { extended = false, skip = [], part, hosts = codeHosts('jira') } = {}) {
  const description = sources.description ?? (d.fields.description ? adfToText(d.fields.description).trim() : '');
  const comments = sources.comments ?? await allComments(jira, key);
  const remote = sources.remote ?? await remoteLinks(jira, key);
  const dev = await devStatus(jira, d.id);
  const urls = [...urlsIn([description, ...comments.map(commentText)].join('\n')), ...remote.links.map((l) => l.url)];
  // In the project's number_repos a bare number written as a pattern counts too; nothing found → commits (D11).
  const found = await collectPullRequests(key, {
    urls, known: dev.known, knownBranches: dev.branches,
    aliases: project?.key_aliases || [], repos: project?.repos || [],
    extended: extended ? project?.extended_repos || [] : [],
    numberRepos: project?.number_repos || [], patterns: numberPatterns(part, project), commits: true, skip, hosts,
  });
  const incomplete = [...dev.notes, ...found.notes];
  return {
    pullRequests: { ...found, notes: [...(dev.about ? [dev.about] : []), ...incomplete], incomplete },
    skip: found.skip, repos: project?.repos || [], extended: project?.extended_repos || [],
  };
}

/** The usage error of --skip-pr URLs that name an attached pull request, or none found by search (D12). */
function skipError({ attached, unmatched }, found) {
  const out = [];
  if (attached.length) out.push(`--skip-pr ${attached.join(', ')}: attached to the task — an attached pull request is not posted with the move, so there is nothing to skip.`);
  if (unmatched.length) {
    const searched = found ? ` — found: ${foundBySearch(found).map((pr) => pr.url).join(', ') || 'none'}` : '';
    out.push(`--skip-pr ${unmatched.join(', ')}: no pull request found by search has this URL${found ? '' : ' in any task'}${searched}.`);
  }
  return out.length ? new UsageError(out.join('\n')) : null;
}

/** The --skip-pr URLs of the real move that no longer name a pull request found by search: a note on stderr each. */
function skipNotes(key, { attached, unmatched }) {
  for (const url of [...attached, ...unmatched]) console.error(`${key}: note — --skip-pr ${url} names no pull request found by search now; nothing to leave out.`);
}

/**
 * The note of a real move whose pull request search, collected again, was incomplete (D13): on
 * stderr, with its first gap, once the move and its comment went through; the exit code stays.
 */
function incompleteNote(key, found) {
  const [gap] = searchGaps(found);
  if (gap) console.error(`${key}: note — the pull request search was incomplete now (${gap}); the comment lists only what was found`);
}

/** The options of `pullRequestLines` for the task's project: its pool, its extended set, whether that was searched. */
function pullRequestOptions(projectKey, { repos, extended }, searchedExtended, extendedCommand) {
  return { projectKey, repos, extended, searchedExtended, extendedCommand, configPath: PROJECTS_PATH, tool: TOOL };
}

/** The transition dry run `v` again, with --extended: what the hint of an unsearched extended set prints. */
function extendedTransitionCommand(v) {
  return [TOOL, 'transition', '--task', shellWord(v.task), '--to', shellWord(v.to),
    ...(v.comment ? ['--comment', shellWord(v.comment)] : []), ...checkFlags(v),
    ...(v['skip-pr'] || []).flatMap((url) => ['--skip-pr', shellWord(url)]),
    '--dry-run', ...(v.brief ? ['--brief'] : []), '--extended'].join(' ');
}

/** A reader of projects (GET /project/{key}) that reads each one once per run, failures included. */
function projectReader(jira) {
  const read = new Map();
  return (key) => {
    if (!read.has(key)) read.set(key, jira.get(`/rest/api/3/project/${encodeURIComponent(key)}`));
    return read.get(key);
  };
}

const openEpicsJql = (project) => `project = "${project}" AND issuetype = Epic AND statusCategory != Done ORDER BY key`;

/**
 * The role epics of a project (D09), each read by its key: { role, key, summary, status, flags } —
 * `flags` name an epic that is closed (status category done), missing, or not an epic.
 */
async function roleEpics(jira, roles) {
  const out = [];
  for (const [role, given] of Object.entries(roles || {})) {
    const key = String(given).trim().toUpperCase();
    try {
      const e = await jira.get(`${issuePath(key)}?fields=summary,status,issuetype`);
      const f = e.fields || {};
      const flags = [];
      if (name(f.issuetype).toLowerCase() !== 'epic') flags.push(`not an epic: ${name(f.issuetype, 'no type')}`);
      if (f.status?.statusCategory?.key === 'done') flags.push('closed');
      out.push({ role, key: e.key || key, summary: f.summary || '', status: name(f.status, '?'), flags });
    } catch (e) {
      const flag = e instanceof HttpError && e.status === 404 ? 'missing: no such issue, or not visible' : `not read: ${networkReason(e)}`;
      out.push({ role, key, summary: '', status: null, flags: [flag] });
    }
  }
  return out;
}

/**
 * Whether an epic of `other` can be the parent of a task of `own` (D10): `parent`, or `link only` when
 * either project is team-managed; `not known` when a project could not be read. With its reason.
 */
async function parentMark(projects, own, other) {
  try {
    for (const key of [own, other]) if (teamManaged(await projects(key))) return { mark: 'link only', why: `${key} is team-managed, so a parent must be in ${own}` };
    return { mark: 'parent', why: 'both projects are company-managed' };
  } catch (e) {
    return { mark: 'not known', why: `a project could not be read (${networkReason(e)})` };
  }
}

/** The open epics of each `epic_projects` project (D10), marked parent or link only for a task of `own`. */
async function subjectEpics(jira, config, own, projects) {
  const out = [];
  for (const given of config?.epic_projects || []) {
    const project = String(given).trim().toUpperCase();
    const read = await attempt(() => jqlSearch(jira, openEpicsJql(project), EPICS_LIMIT, 'summary,description'));
    if (read.error) out.push({ project, epics: [], more: false, error: read.error });
    else out.push({ project, epics: read.value.issues, more: read.value.truncated, error: null, ...(await parentMark(projects, own, project)) });
  }
  return out;
}

/**
 * The epic of the task `d`: { self } when it is one, { current } (its epic parent), or — missing — its
 * non-epic `parent` and the candidates: the role epics of `config` (D09), the other open epics of
 * `project` (`more` when there were more), and the open epics of its `epic_projects` (D10), each
 * project read once through `projects`.
 */
async function taskEpic(jira, d, project, { config, projects }) {
  const f = d.fields;
  if (name(f.issuetype).toLowerCase() === 'epic') return { self: true, missing: false };
  if (f.parent && name(f.parent.fields?.issuetype).toLowerCase() === 'epic') return { current: f.parent, missing: false };
  const roles = await roleEpics(jira, config?.epic_roles);
  const roleKeys = new Set(roles.map((r) => r.key));
  const { issues, truncated: more } = await jqlSearch(jira, openEpicsJql(project), EPICS_LIMIT, 'summary,description');
  const subjects = await subjectEpics(jira, config, project, projects);
  return { parent: f.parent || null, roles, epics: issues.filter((e) => !roleKeys.has(String(e.key).toUpperCase())), more, subjects, missing: true };
}

/** One candidate epic of the full dry run: its key and summary, its description cut on the next line, and `mark`. */
function epicCandidateLine(e, mark = '') {
  const about = e.fields?.description ? adfToText(e.fields.description).replace(/\s+/g, ' ').trim() : '';
  return `    ${e.key} — ${e.fields?.summary || ''}${mark}${about ? `\n        ${truncated(about, 160).replace(/\n/g, ' ')}` : ''}`;
}

/** The `## Epic` lines of the full confirm dry run. */
function epicLines(epic, project) {
  if (epic.self) return ['  The task is itself an epic.'];
  if (epic.current) return [`  ${epic.current.key} — ${epic.current.fields?.summary || ''}`];
  const lines = [epic.parent ? `  None: the parent ${epic.parent.key} is a ${name(epic.parent.fields?.issuetype, 'non-epic issue')}, not an epic.` : '  None: the task has no epic.'];
  if (epic.roles.length) {
    lines.push(`  Role epics of ${project} (${PROJECTS_PATH}.${project}.epic_roles):`);
    for (const r of epic.roles) {
      const about = r.status ? `${r.key} — ${r.summary} [${r.status}]` : r.key;
      lines.push(`    ${r.role}: ${about}${r.flags.length ? ` — ${r.flags.join('; ')}` : ''}`);
    }
  }
  const count = `${epic.epics.length}${epic.more ? `, first ${EPICS_LIMIT}` : ''}`;
  lines.push(epic.roles.length ? `  Other open epics of ${project} (${count}):` : `  Open epics of ${project} (${count}) — the candidates:`);
  lines.push(...epic.epics.map((e) => epicCandidateLine(e)));
  if (!epic.epics.length) lines.push('    (none)');
  for (const s of epic.subjects) {
    if (s.error) {
      lines.push(`  Open epics of ${s.project} (epic_projects): not read (${s.error})`);
      continue;
    }
    lines.push(`  Open epics of ${s.project} (epic_projects; ${s.epics.length}${s.more ? `, first ${EPICS_LIMIT}` : ''}) — ${s.mark}: ${s.why}:`);
    lines.push(...s.epics.map((e) => epicCandidateLine(e, `  [${s.mark}]`)));
    if (!s.epics.length) lines.push('    (none)');
  }
  return lines;
}

/** The `## What to do` lines about picking an epic, for a task without one. */
function epicAdvice(epic, key, project) {
  const lines = ['- The task has no epic. If Requires asks for one, propose the best-fitting open epic above with a one-line',
    `  reason and the runner-up; on the user's answer set it first: ${TOOL} edit --task ${key} --parent <EPIC> --dry-run, then this move.`];
  if (epic.roles.length || epic.subjects.length) {
    lines.push('- Rank as the project\'s epics rule says: a subject epic that fits the task\'s topic first (those of the other projects',
      '  included), a role epic only when no subject epic fits.');
  }
  if (epic.subjects.some((s) => s.mark !== 'parent' && !s.error)) {
    lines.push(`- A link-only pick takes two writes, both dry runs shown before one question: a parent of ${project} (a role epic by`,
      `  the rule, else its best-fitting open epic) and a Relates link to the subject epic:`,
      `  ${TOOL} edit --task ${key} --parent <EPIC of ${project}> --dry-run`,
      `  ${TOOL} link --from ${key} --type Relates --to <subject EPIC> --dry-run`,
      `  With no open epic of ${project}, offer the link alone and say the task stays without a parent.`);
  }
  return lines;
}

/**
 * What a `confirm` dry run shows, read once for both renderings: the comments since the task last
 * entered `current`, its description, epic, remote links and URLs, its pull requests, and the comment
 * the move would post.
 */
async function confirmFacts(jira, { v, d, project, current, resolved, part, projects, hosts }) {
  const f = d.fields;
  const histories = await agilePaged(jira, `${issuePath(v.task)}/changelog`, 'values', 5000);
  const since = lastEntry(histories, current);
  const comments = await allComments(jira, v.task);
  const recent = commentsSince(comments, since);
  const description = f.description ? adfToText(f.description).trim() : '';
  const commentTexts = recent.map(commentText);
  const epic = await taskEpic(jira, d, project, { config: resolved.project, projects: projects || projectReader(jira) });
  const remote = await remoteLinks(jira, v.task);
  const urls = urlsIn([description, ...commentTexts].join('\n'));
  const searchedExtended = Boolean(v.extended);
  const prs = await taskPullRequests(jira, d, v.task, resolved.project, { description, comments, remote }, { extended: searchedExtended, skip: v['skip-pr'], part, hosts });
  const posted = moveComment(v.comment, prs.pullRequests.pullRequests);
  return { since, comments, recent, commentTexts, description, epic, remote, urls, searchedExtended, prs, posted };
}

/** The dry run of a `confirm` move: what the task records, for the agent to judge against the rule (D02, D04, D06); --brief prints it short. */
async function confirmEvidence(jira, c, move) {
  const facts = await confirmFacts(jira, move);
  const refused = skipError(facts.prs.skip, facts.prs.pullRequests.pullRequests);
  if (refused) throw refused;
  return move.v.brief ? briefEvidenceLines(move, facts) : evidenceLines(c, move, facts);
}

/** The full confirm dry run, from what confirmFacts read. */
function evidenceLines(c, { v, d, project, current, match, resolved, origin }, facts) {
  const f = d.fields;
  const { rule } = resolved;
  const { since, comments, recent, commentTexts, description, epic, remote, urls, searchedExtended, prs, posted } = facts;
  const out = ['--- DRY RUN (requested --dry-run) ---',
    `Would move ${v.task}: ${current} → ${name(match.to)} (transition ${match.id})`,
    rule ? `Rule: ${origin} — ${statusesText(rule.from)} → ${statusesText(rule.to)}, mode confirm` : `Rule: none covers the move; ${origin} is confirm`,
    'Requires:', ...(rule?.requires ? rule.requires.trim().split('\n').map((l) => `  ${l}`) : ['  (no requirement stated — judge by the project\'s results)'])];
  const hint = (key, what) => (resolved.project?.[key]
    ? [`${what} (task-tracking.jira.projects.${project}.${key}):`, ...String(resolved.project[key]).trim().split('\n').map((l) => `  ${l}`)]
    : [`${what}: (task-tracking.jira.projects.${project}.${key} is not set)`]);
  out.push(...hint('results', 'Where results of this project are'), ...hint('epics', 'How this project splits its epics'));

  out.push('', '## Task', `${v.task} · ${f.summary || ''}`);
  out.push(f.assignee
    ? `Assignee: ${name(f.assignee)} (account id ${f.assignee.accountId}) — mention as [~accountid:${f.assignee.accountId}]`
    : 'Assignee: unassigned');
  out.push('', '## Description', description ? truncated(description, DESCRIPTION_LIMIT) : '(empty)');
  const atts = f.attachment || [];
  out.push('', `## Attachments (${atts.length})`, ...(atts.length ? atts.map((a) => `  ${a.filename}`) : ['  (none)']));
  const entered = since ? `entered ${current} on ${since}` : `was created in ${current} (no move into it in the changelog)`;
  out.push('', `## Comments since the task ${entered} (${recent.length} of ${comments.length})`);
  if (!recent.length) out.push('  (none)');
  recent.forEach((cm, i) => {
    out.push(`  --- ${name(cm.author, '?')}, ${cm.created || '?'}`);
    for (const line of truncated(commentTexts[i] || '(empty)', COMMENT_LIMIT).split('\n')) if (line.trim()) out.push(`      ${line.trim()}`);
  });
  const remoteShown = remote.error ? [`  (remote links not readable: ${remote.error})`] : remote.links.map((l) => `  ${l.title} — ${l.url || '?'}`);
  out.push('', '## Links', 'Remote links:', ...(remoteShown.length ? remoteShown : ['  (none)']),
    'URLs in the description and these comments:', ...(urls.length ? urls.map((u) => `  ${u}`) : ['  (none)']));
  out.push('', ...pullRequestLines(prs.pullRequests, pullRequestOptions(project, prs, searchedExtended, extendedTransitionCommand(v))));
  out.push('', '## Epic', ...epicLines(epic, project));
  out.push('', '## Comment posted with the move', ...(posted ? ['-'.repeat(40), posted, '-'.repeat(40)] : ['  (none — pass --comment "…" to post one after the move)']));
  const mention = f.assignee ? `[~accountid:${f.assignee.accountId}]` : 'the reporter';
  out.push('', '## What to do',
    '- Judge the evidence above against Requires and the project\'s results: where is the result of this task —',
    '  a pull request, a document, a link, an attachment, the result written out — or a comment saying there is none and why?',
    '- Ask the user in this chat (not through a question tool: its answer is not a prompt), stating where the result is.',
    '- Pull requests: merged ones show the result is in; an open, draft or closed one, or a state not read, is for the user to weigh.',
    `  Those found only in the pool${searchedExtended ? ' or the extended set' : ''} are written into the task by the comment posted with the move;`,
    '  one that is not this task\'s (its title or branch says otherwise) is left out with --skip-pr <url>, on the dry run and the move.');
  if (epic.missing) out.push(...epicAdvice(epic, v.task, project));
  out.push(`- If the result is not clear, do not move the task: prepare a comment that mentions ${mention} and asks where`,
    `  the results are — ${TOOL} comment --task ${v.task} --text "…" --dry-run.`,
    `- The move itself is this command without --dry-run, after the user's answer.`,
    '', browse(c, v.task), 'DRY RUN — nothing written to Jira.');
  return out;
}

const BRIEF_EPICS_LIMIT = 300;
const BRIEF_ITEMS = 5;
const BRIEF_URL = 100;

/** The first BRIEF_ITEMS of `items` joined by `separator`, then how many more; `none` when empty. */
function briefList(items, separator) {
  if (!items.length) return 'none';
  const more = items.length > BRIEF_ITEMS ? ` (+${items.length - BRIEF_ITEMS} more)` : '';
  return `${items.slice(0, BRIEF_ITEMS).join(separator)}${more}`;
}

/** `text` on one line, cut to `limit` characters with an ellipsis. */
function oneLine(text, limit) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

const BRIEF_GROUP_LIMIT = 160;
const epicNames = (epics) => epics.map((e) => `${e.key} ${e.fields?.summary || ''}`.trimEnd()).join('; ');

/**
 * The Epic line of the brief dry run: the task's epic, or its candidates — the role epics (role, key,
 * summary, a flag), the other open epics of `project`, and each `epic_projects` project's open epics
 * with its parent / link only mark — each group cut on its own, with its count.
 */
function briefEpicLine(epic, project) {
  if (epic.self) return 'Epic: the task is itself an epic';
  if (epic.current) return `Epic: ${epic.current.key} ${epic.current.fields?.summary || ''}`.trimEnd();
  const none = epic.parent ? `none (the parent ${epic.parent.key} is not an epic)` : 'none';
  const groups = [];
  if (epic.roles.length) {
    const roles = epic.roles.map((r) => `${r.role} ${r.key}${r.summary ? ` ${r.summary}` : ''}${r.flags.length ? ` [${r.flags.join('; ')}]` : ''}`);
    groups.push(`roles: ${oneLine(roles.join('; '), BRIEF_GROUP_LIMIT)}`);
  }
  const own = epic.epics.length ? `open epics (${epic.epics.length}${epic.more ? '+' : ''}): ${oneLine(epicNames(epic.epics), BRIEF_EPICS_LIMIT)}` : null;
  if (!epic.roles.length && !epic.subjects.length) return `Epic: ${none} — ${own || `${project} has no open epic`}`;
  groups.push(own || `no other open epic of ${project}`);
  for (const s of epic.subjects) {
    if (s.error) groups.push(`${s.project}: not read (${s.error})`);
    else groups.push(`${s.project} [${s.mark}] (${s.epics.length}${s.more ? '+' : ''}): ${s.epics.length ? oneLine(epicNames(s.epics), BRIEF_GROUP_LIMIT) : 'none'}`);
  }
  return `Epic: ${none} — ${groups.join(' | ')}`;
}

/** The Flags of the brief dry run: what the full one shows missing, a few words each. */
function briefFlags({ resolved }, { urls, remote, epic, prs }) {
  const flags = [];
  if (!prs.pullRequests.pullRequests.length) flags.push('no pull request');
  // A search that did not run or stopped part way, or commits whose pull requests were not read,
  // leave the evidence incomplete: the full dry run is read first (D13).
  // Only a first page read or dev-status unavailable stays a note.
  if (searchIncomplete(prs.pullRequests)) flags.push('pull request search incomplete');
  if (!urls.length && !remote.links.length) flags.push('no link in the description, the comments or the remote links');
  if (epic.missing && /\bepic/i.test(resolved.rule?.requires || '')) flags.push('no epic, and Requires names one');
  if (!prs.repos.length) flags.push('the repository pool is empty, only the pull requests the task carries were looked for');
  return flags;
}

/** The brief confirm dry run (--brief): one short block for the task, built from what confirmFacts read. */
function briefEvidenceLines(move, facts, { batch } = {}) {
  const { v, d, project, current, match, resolved, origin } = move;
  const { searchedExtended, prs, posted, epic, urls, recent } = facts;
  // A result need not be code (D02, D04): the other links, the attachments and the comments count too.
  const links = urls.filter((u) => !parsePullRequestUrl(u)).map((u) => oneLine(u, BRIEF_URL));
  const attachments = (d.fields.attachment || []).map((a) => a.filename);
  const requires = resolved.rule?.requires;
  const results = resolved.project?.results;
  const searched = foundBySearch(prs.pullRequests.pullRequests).length;
  const more = searched ? ` (+${searched} PR line${searched === 1 ? '' : 's'})` : '';
  const comment = v.comment ? `${firstLine(v.comment)}${more}` : posted ? `the pull requests found by search${more}` : 'none';
  const flags = briefFlags(move, facts);
  // In a batch the project's results are printed once above the blocks, and the full evidence is the task's own dry run.
  const full = batch ? `Full evidence: ${singleDryRun(batch, v.task, prs.pullRequests.skipped)}` : 'Full evidence: same command without --brief.';
  return [
    `${v.task} · ${oneLine(d.fields.summary, 80)} · ${current} → ${name(match.to)} (mode confirm, rule ${origin})`,
    `Requires: ${requires ? oneLine(requires, 200) : '(none stated — judge by the project\'s results)'}`,
    ...(batch ? [] : [`Results: ${resultsText(results, project)}`]),
    ...briefPullRequestLines(prs.pullRequests, pullRequestOptions(project, prs, searchedExtended, extendedTransitionCommand(batch || v))),
    `Links: ${briefList(links, '; ')}`,
    `Attachments: ${briefList(attachments, ', ')}`,
    `Comments since entry: ${recent.length}`,
    briefEpicLine(epic, project),
    `Comment: ${comment}`,
    `Flags: ${flags.length ? flags.join('; ') : 'none'}`,
    full,
  ];
}

/** The project's results on one line, or that they are not set. */
const resultsText = (results, project) => (results ? oneLine(results, 160) : `(${PROJECTS_PATH}.${project}.results is not set)`);

/** The single full dry run of the task `key` of the batch `v`: its flags, and the --skip-pr URLs that matched it. */
function singleDryRun(v, key, skipped = []) {
  const urls = (v['skip-pr'] || []).filter((url) => skipped.some((pr) => pullRequestKey(pr.url) === pullRequestKey(url)));
  return [TOOL, 'transition', '--task', shellWord(key), '--to', shellWord(v.to),
    ...(v.comment ? ['--comment', shellWord(v.comment)] : []), ...checkFlags(v),
    ...urls.flatMap((url) => ['--skip-pr', shellWord(url)]), ...(v.extended ? ['--extended'] : []), '--dry-run'].join(' ');
}

// == many tasks in one move (D13) ==

const BATCH_LIMIT = 50;
const TASK_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** The keys of `--task A,B,…`: each a task key, each once (case-insensitively), at most BATCH_LIMIT. */
function batchKeys(text) {
  const keys = [];
  for (const given of splitList(text)) {
    if (!TASK_KEY.test(given)) throw new UsageError(`--task: '${given}' is not a task key like PROJ-123`);
    if (!keys.some((k) => k.toUpperCase() === given.toUpperCase())) keys.push(given);
  }
  if (!keys.length) throw new UsageError('--task: no task key given');
  if (keys.length > BATCH_LIMIT) throw new UsageError(`--task names ${keys.length} tasks; a move takes at most ${BATCH_LIMIT} — split the list`);
  return keys;
}

/** Whether `e` is an error a batch reports for its task and goes past. */
const taskFailure = (e) => e instanceof UsageError || e instanceof HttpError || e instanceof ChannelError;

/**
 * Each task of a batch resolved on its own: { key, move } for one that moves, { key, reason } for one
 * that will not; the history searches of the path hints are shared by the batch.
 */
async function batchPlans(jira, c, part, keys, to) {
  const plans = [];
  const history = new Map();
  for (const key of keys) {
    try {
      const planned = await moveOf(jira, c, part, key, to, { history });
      plans.push(planned.refusal ? { key, reason: planned.refusal } : { key, move: { ...planned, part } });
    } catch (e) {
      if (!taskFailure(e)) throw e;
      plans.push({ key, reason: e.message.replace(/\n/g, '\n    ') });
    }
  }
  return plans;
}

/** The --skip-pr URLs that no task of the batch found by search (D13): attached somewhere, or nowhere. */
function batchSkipMisses(v, skips) {
  const urls = v['skip-pr'] || [];
  const found = (url) => skips.some((s) => !s.attached.includes(url) && !s.unmatched.includes(url));
  const missed = urls.filter((url) => !found(url));
  return { attached: missed.filter((url) => skips.some((s) => s.attached.includes(url))), unmatched: missed.filter((url) => !skips.some((s) => s.attached.includes(url))) };
}

/** The batch dry run: always brief, one block per task, the results once per project, then the tasks that will not move. */
async function batchDryRun(jira, c, v, part, plans) {
  const projects = projectReader(jira);
  const hosts = codeHosts('jira');
  const blocks = [];
  const skips = [];
  const unread = new Map();
  const results = new Map();
  for (const { key, move: planned } of plans.filter((p) => p.move)) {
    const { d, current, match, resolved, origin, project } = planned;
    if (resolved.mode === 'agent') {
      blocks.push([`${key} · ${oneLine(d.fields.summary, 80)} · ${current} → ${name(match.to)} (mode agent, rule ${origin})`,
        ...(v.comment ? [`Comment: ${firstLine(v.comment)}`] : [])]);
      continue;
    }
    let facts;
    try {
      facts = await confirmFacts(jira, { ...planned, v: { ...v, task: key }, projects, hosts });
    } catch (e) {
      // One task's evidence that cannot be read keeps that task back, not the batch (D13).
      if (!taskFailure(e)) throw e;
      unread.set(key, { key, reason: `its evidence was not read — ${String(e.message).split('\n')[0]}` });
      continue;
    }
    skips.push(facts.prs.skip);
    if (!results.has(project)) results.set(project, resultsText(resolved.project?.results, project));
    blocks.push(briefEvidenceLines({ ...planned, v: { ...v, task: key } }, facts, { batch: v }));
  }
  const misses = batchSkipMisses(v, skips);
  if (unread.size) {
    // A task whose evidence was not read may have found the URL: a note, not a usage error (D13).
    const notRead = [...unread.keys()].join(', ');
    for (const url of [...misses.attached, ...misses.unmatched]) console.error(`note — --skip-pr ${url} left out no PR found by search among the tasks read; not read: ${notRead}`);
  } else {
    const refused = skipError(misses);
    if (refused) throw refused;
  }
  const movable = plans.filter((p) => p.move).length - unread.size;
  const out = ['--- DRY RUN (requested --dry-run) ---', `Would move ${movable} of ${plans.length} tasks to ${v.to}, each by its own rule:`];
  for (const [project, text] of results) out.push(`Results of ${project}: ${text}`);
  for (const block of blocks) out.push('', ...block);
  const stay = plans.map((p) => (p.reason ? p : unread.get(p.key))).filter(Boolean);
  out.push('', stay.length ? `Will not move (${stay.length}):` : 'Will not move: none', ...stay.map((p) => `  ${p.key}: ${p.reason}`));
  out.push('', '## What to do',
    '- Judge each confirm task as for a single move; a task whose block shows no PR and no link, or flags the pull request',
    '  search incomplete, is judged from its full dry run (its Full evidence line) before the question.',
    '- Take out of --task every task that will not or should not move, and dry-run the shorter command: the move is the dry-run',
    '  command without --dry-run, so the confirmed list holds only movable tasks.',
    '- Ask one question in this chat that names every task, its result and its epic; the move runs on the user\'s answer.',
    `- --comment is posted to every task; a task-specific comment is a single move.`,
    '', 'DRY RUN — nothing written to Jira.');
  console.log(out.join('\n'));
  return movable ? 0 : 3;
}

/**
 * The real batch move: per task, the evidence collected again, the move, and a report; a task moved
 * whose comment failed counts as moved and is reported apart. Exit 2 if any move or comment failed.
 */
async function batchMove(jira, c, v, part, keys) {
  const hosts = codeHosts('jira');
  const history = new Map();
  const skips = [];
  let moved = 0;
  let uncommented = 0;
  for (const key of keys) {
    try {
      const planned = await moveOf(jira, c, part, key, v.to, { history });
      if (planned.refusal) throw new UsageError(planned.refusal);
      const { d, current, match, resolved } = planned;
      let comment = v.comment;
      let found = null;
      if (resolved.mode === 'confirm') {
        const { pullRequests, skip } = await taskPullRequests(jira, d, key, resolved.project, {}, { extended: Boolean(v.extended), skip: v['skip-pr'], part, hosts });
        skips.push(skip);
        found = pullRequests;
        comment = moveComment(v.comment, pullRequests.pullRequests);
      }
      await transitionOnly(jira, key, current, match);
      moved += 1;
      console.log(`moved ${key}`);
      if (comment) {
        try {
          await postMoveComment(jira, c, key, name(match.to), comment);
        } catch (e) {
          if (!taskFailure(e)) throw e;
          uncommented += 1;
          console.error(`${key}: moved, but the comment was not posted — ${String(e.message).split('\n')[0]}`);
          continue;
        }
      }
      // Only a move and comment that went through list "what was found".
      if (found) incompleteNote(key, found);
    } catch (e) {
      if (!taskFailure(e)) throw e;
      console.error(`${key}: ${String(e.message).split('\n')[0]}`);
    }
  }
  const misses = batchSkipMisses(v, skips);
  for (const url of [...misses.attached, ...misses.unmatched]) console.error(`note — --skip-pr ${url} names no pull request any task found by search now; nothing to leave out.`);
  console.log(`${moved}/${keys.length} moved${uncommented ? `, ${uncommented} without its comment` : ''}`);
  return moved === keys.length && !uncommented ? 0 : 2;
}

/** `transition --task A,B,…` (D13): each task resolved on its own, one brief dry run, one confirmation. */
async function batchTransition(v, part, keys, dry) {
  const { c, jira } = client(`move ${keys.join(', ')}`);
  if (!dry) return batchMove(jira, c, v, part, keys);
  return batchDryRun(jira, c, v, part, await batchPlans(jira, c, part, keys, v.to));
}

// == comment: post, edit or delete one's own ==

const commentPath = (key, id) => `${issuePath(key)}/comment/${encodeURIComponent(id)}`;
const firstLine = (text) => (String(text).split('\n').find((l) => l.trim()) || '(empty)').trim();

/** --edit / --delete as a comment id: digits only, and not both. */
function commentId(v) {
  if (v.edit !== undefined && v.delete !== undefined) throw new UsageError('pass --edit or --delete, not both');
  const id = v.edit ?? v.delete;
  if (id !== undefined && !/^\d+$/.test(id)) throw new UsageError(`a comment id is digits only, got '${id}' — the [id N] of a comment in \`info\``);
  return id;
}

/**
 * The comment `id` of `key`, refused unless the account of these credentials wrote it — an agent
 * edits and deletes its own words; `others` overrides.
 */
async function ownComment(jira, key, id, { others = false } = {}) {
  let comment;
  try {
    comment = await jira.get(commentPath(key, id));
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new UsageError(`${key} has no comment ${id} visible to this account.`);
    throw e;
  }
  const me = (await jira.get('/rest/api/3/myself')).accountId;
  if (!others && (!me || comment.author?.accountId !== me)) {
    throw new UsageError(`Refusing: comment ${id} on ${key} was written by ${name(comment.author, 'someone else')}, not by this account. ` +
      'Edit or delete only your own comments; --others overrides.');
  }
  return comment;
}

/** Refuse a markdown overwrite of `comment` when it holds what markdown cannot carry (--force overrides); `links` judges its cards. */
async function guardCommentLossless(comment, key, id, links) {
  const lost = lossyText(lossyNodes(comment.body, { issueUrl: await links.forDoc(comment.body) }));
  if (lost) {
    throw new UsageError(`Refusing to replace comment ${id} on ${key} from markdown — it holds what markdown cannot carry and would be lost: ${lost}. ` +
      'Pass --force to overwrite anyway.');
  }
}

/** `comment --delete ID`: read the comment, then delete it; an offline dry run names only the id. */
async function deleteComment(v, id) {
  const dry = Boolean(v['dry-run']);
  const { c, jira } = client(`delete comment ${id} of ${v.task}`, { offline: dry });
  const comment = jira ? await ownComment(jira, v.task, id, v) : null;
  const what = `comment ${id} of ${v.task}${comment ? ` by ${name(comment.author, '?')}` : ''}`;
  const shown = comment ? `${what}: ${firstLine(commentText(comment))}` : what;
  if (dry) {
    dryHeader();
    console.log(`Comment that WOULD be deleted: ${shown}\nDRY RUN — nothing written to Jira.`);
    if (!jira) offlineNote(c);
    return 0;
  }
  const { status } = await jira.raw('DELETE', commentPath(v.task, id));
  if (status !== 204) {
    console.error(`Jira answered HTTP ${status} to the delete, not 204; check ${what} in Jira: ${browse(c, v.task)}`);
    return 2;
  }
  console.log(`Deleted ${what} (HTTP ${status}).`);
  return 0;
}

// == context: the sections after the task, each degrading to one unavailable line ==

const OPEN_STATES = new Set(['open', 'draft']);

/** `{ value }` of a section's read, or `{ error }` when it failed on the network or Jira refused it. */
async function attemptSection(load) {
  try {
    return { value: await load() };
  } catch (e) {
    if (e instanceof UsageError) return { error: firstLine(e.message) };
    return { error: networkReason(e) };
  }
}

/** A context section: its heading and lines, or one unavailable line when its read failed. */
const sectionLines = (title, read) => (read.error ? ['', unavailableLine(title, read.error)] : ['', `## ${title}`, ...read.value]);

/** The first `limit` of `lines`, then how many were left out. */
const capped = (lines, limit) => (lines.length > limit ? [...lines.slice(0, limit), `  … ${lines.length - limit} more`] : lines);

function subtaskLines(f, limit) {
  const lines = capped((f.subtasks || []).map((s) => `  ${issueLine(s)}`), limit);
  return lines.length ? lines : ['  (none)'];
}

function linkSectionLines(f, limit) {
  const lines = capped(linksLines(f).map((l) => `  ${l}`), limit);
  return lines.length ? [...lines, `  Remove one: ${TOOL} unlink --id <N> --dry-run`] : ['  (none)'];
}

/** The Code section: what Jira's development panel reports — pull requests (open first), branches without one, commits. */
function codeLines(dev, key, limit) {
  const pullRequests = mergePullRequests(dev.known).sort((a, b) => Number(!OPEN_STATES.has(a.state)) - Number(!OPEN_STATES.has(b.state)));
  const out = capped(pullRequests.map((pr) => `  [${pr.state}] ${pr.title || '(title not read)'} — ${pr.url}${pr.branch ? ` (branch ${pr.branch})` : ''}`), limit);
  out.push(...capped(branchesWithoutPullRequest(dev.branches, pullRequests).map((b) => `  branch ${b.branch} — ${b.repo}`), limit));
  if (dev.commits) out.push(`  ${dev.commits} commit(s)`);
  if (!out.length) out.push(`  (no pull request, branch or commit carrying ${key} in Jira's development panel)`);
  out.push(...dev.notes.filter((n) => /unavailable/.test(n)).map((n) => `  ${n}`),
    `  The panel shows only code hosts connected to Jira; \`${TOOL} info --task ${key} --extended\` also searches the project's repositories.`);
  return out;
}

/** The Goals section: the goals of the task, then those of its epic (`epicKey`, when it has one). */
async function goalsSection(jira, { d, fieldIds, goalsId, epicKey }) {
  if (fieldIds.error) return { error: fieldIds.error };
  if (!goalsId) return { value: ['  (this Jira site has no Goals field)'] };
  return attemptSection(async () => {
    const fromEpic = epicKey ? goalAris(await fetchIssue(jira, epicKey, goalsId), goalsId) : [];
    const lines = await goalLinesOf(jira, goalAris(d, goalsId), fromEpic, 'on epic');
    return lines.length ? lines.map((l) => `  ${l}`) : [`  (none on the task${epicKey ? ' or its epic' : ''})`];
  });
}

/**
 * The warnings of `context` for the task `d`: what is out of step and who puts it right. Open pull
 * requests count as work going on; they and branches count as code existing. `pullRequests` and
 * `branches` are what the development panel reports (empty when it could not be read).
 */
function contextWarnings(d, { inActive, isEpic, pullRequests, branches }) {
  const f = d.fields || {};
  const status = name(f.status).toLowerCase();
  const category = f.status?.statusCategory?.key;
  const open = pullRequests.filter((pr) => OPEN_STATES.has(pr.state));
  // Work is going on when the status is in Jira's "In Progress" category (key `indeterminate`), or a pull request is open.
  const inWork = category === 'indeterminate' || open.length > 0;
  const warnings = [];
  if (isEpic) warnings.push('this is an epic — work goes into a task created under it.');
  if (inWork && !isEpic && !inActive && category !== 'done') warnings.push('work is going on but the task is not in an active sprint — a person adds it to the active sprint.');
  if (config()['task-tracking']?.jira) {
    if (REVIEW_ON.has(status)) warnings.push(`status is ${name(f.status)} — a move from here follows task-tracking.jira; transition --dry-run shows its rule.`);
  } else if (REVIEW_ON.has(status)) warnings.push(`status is ${name(f.status)} — from review on only a person moves the task.`);
  if (category === 'done') warnings.push('the task is closed — closed tasks are not worked on.');
  if (category === 'new' && (open.length || branches.length)) {
    warnings.push(`code exists but the status is ${name(f.status)} — move it to the status work is in: ${TOOL} transition --task ${d.key} --to <status> --dry-run`);
  }
  const comments = lower((f.comment?.comments || []).map(commentText).join('\n'));
  for (const pr of open) {
    if (!comments.includes(lower(pr.url))) warnings.push(`pull request ${pr.url} is open but no comment names it — post one: ${TOOL} comment --task ${d.key} --text "…" --dry-run`);
  }
  return warnings;
}

// == attach: local files uploaded to a task ==
// The path rule is the image lines' (localFile): inside the installation, a working folder of
// .local/ included, never a dot-named store there nor a dot-named file or folder elsewhere (.claude/,
// .mcp.json, .git/); the types are an allowlist — no archive, which could carry a closed store —, the
// size is capped.

const ATTACH_LIMIT = 10 * 1024 * 1024;
const ATTACH_TYPES = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.yaml': 'application/yaml', '.yml': 'application/yaml', '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

/** The files `given` (--file) names, each judged by localFile before any request, each once by its real path. */
function attachPlan(given) {
  const roots = fileRoots(null, 'the installation');
  const files = [];
  for (const target of given) {
    const file = localFile(target, roots, { what: 'file', types: ATTACH_TYPES, verb: 'attached', maxBytes: ATTACH_LIMIT });
    if (!files.some((f) => f.path === file.path)) files.push(file);
  }
  return files;
}

/** The attach types read as text by the content check; any other is checked by its name only. */
const ATTACH_TEXT_TYPES = new Set(['.md', '.txt', '.log', '.csv', '.json', '.yaml', '.yml', '.svg']);

/** What `attach` sends, for the content check: each file's name, and the content of a text type. */
function attachTexts(files) {
  return files.flatMap((f) => (ATTACH_TEXT_TYPES.has((f.name.match(/\.[^.]+$/)?.[0] || '').toLowerCase())
    ? [{ label: `${f.name} (name)`, text: f.name }, { label: f.name, text: readFileSync(f.path, 'utf8') }]
    : [{ label: f.name, text: f.name, unread: true }]));
}

/** What the dry run of `attach` says of each planned file, against the attachments `attached` of `key` (null: not read offline). */
function attachDryLines(files, key, attached) {
  return files.map((f) => {
    const same = sameAttachment(attached, f);
    const fate = !attached ? 'uploaded, or skipped when the task has an attachment of that name and size (not read offline)'
      : same ? `skipped: ${key} has an attachment of that name and size (id ${same.id})` : `uploaded to ${key}`;
    return `  ${f.target} → ${f.name} (${f.size} bytes, ${f.mime}) — ${fate}`;
  });
}

/**
 * `attach --task KEY --file PATH…`: the dry run (offline without credentials), or each file uploaded
 * (one of the same name and size already there is not uploaded again), then the task's attachments
 * read back. Exit 2 when an upload failed or a file is not among them.
 */
async function attachFiles(v, positionals = []) {
  required(v, 'task');
  if (positionals.length) throw new UsageError(`each file takes its own --file: --file ${positionals[0]}`);
  if (!v.file?.length) throw new UsageError('--file PATH is required (repeat it for several files)');
  const files = attachPlan(v.file);
  checkContent(v, attachTexts(files));
  const dry = Boolean(v['dry-run']);
  const { c, jira } = client(`attach files to ${v.task}`, { offline: dry });
  const attached = jira ? await attachmentsOf(jira, v.task) : null;
  if (dry) {
    dryHeader();
    console.log([`Task:   ${v.task}`, `Target: ${browse(c, v.task)}`, 'Files that WOULD be attached:', ...attachDryLines(files, v.task, attached),
      'DRY RUN — nothing written to Jira.'].join('\n'));
    if (!jira) offlineNote(c);
    return 0;
  }
  const stored = [];
  let failed = 0;
  for (const file of files) {
    try {
      stored.push({ file, id: String((await attachmentFor(jira, v.task, file, attached)).id) });
    } catch (e) {
      if (!taskFailure(e)) throw e;
      failed += 1;
      console.error(`${file.name}: not attached — ${firstLine(e.message)}`);
    }
  }
  const now = new Map(((await fetchIssue(jira, v.task, 'attachment')).fields?.attachment || []).map((a) => [String(a.id), a]));
  const missing = stored.filter((s) => !now.has(s.id));
  console.log(`Attachments of ${v.task}, read back:`);
  for (const { file, id } of stored) {
    const a = now.get(id);
    console.log(a ? `  [${a.id}] ${a.filename} (${a.size} bytes)` : `  ${file.name}: attachment ${id} is NOT on ${v.task}`);
  }
  if (missing.length) console.error(`NOT CONFIRMED: ${missing.map((s) => s.file.name).join(', ')} not among the attachments of ${v.task}; check it in Jira: ${browse(c, v.task)}`);
  return failed || missing.length ? 2 : 0;
}

/** PUT the body `doc` over comment `id` of `key`; anything but 200 exits 2. */
async function replaceComment(jira, c, key, id, doc) {
  const { status } = await jira.raw('PUT', commentPath(key, id), { body: doc });
  if (status !== 200) {
    console.error(`Jira answered HTTP ${status} to the edit, not 200; check comment ${id} in Jira: ${browse(c, key)}`);
    return 2;
  }
  console.log(`Edited comment ${id} of ${key} (HTTP ${status}): ${browse(c, key)}`);
  return 0;
}

const commands = {
  whoami: {
    help: 'check the credentials: which Atlassian account the tool acts as',
    options: {},
    async run(v) {
      const { c, jira } = client('check the account');
      const me = await jira.get('/rest/api/3/myself');
      if (v.json) return printJson(me);
      console.log(`${me.displayName} <${me.emailAddress || c.email}> on ${c.baseUrl}`);
      console.log(atlassianHelp(c));
    },
  },

  info: {
    help: `a task: summary, status, description, links, attachments, comments; --extended adds its pull requests — attached, from the project's pool and from its extended set (${PROJECTS_PATH}.<KEY>.extended_repos); --description [--adf] [--out FILE] prints only the description as editable markdown (an image as ![alt](media:…), a task card as its key) or raw ADF, what \`description\` and \`edit --description\` take back`,
    options: { task: { type: 'string' }, extended: { type: 'boolean' }, description: { type: 'boolean' }, adf: { type: 'boolean' }, out: { type: 'string' } },
    async run(v) {
      required(v, 'task');
      if (v.description) {
        if (v.extended || v.json) throw new UsageError('--description prints only the description: not with --extended or --json (--adf prints its raw ADF)');
        return printDescription(v);
      }
      if (v.adf || v.out !== undefined) throw new UsageError('--adf and --out belong to --description');
      const part = v.extended ? config()['task-tracking']?.jira : undefined;
      const problems = trackerProblems(part, 'task-tracking.jira');
      if (problems.length) throw new UsageError(`${INSTALL_FILE} has problems in task-tracking.jira — fix them first: ${problems.join('; ')}`);
      const { c, jira } = client(`read ${v.task}`);
      const d = await fetchIssue(jira, v.task, INFO_FIELDS);
      // Without --extended no code host is read: the pull requests are the dry run's of a confirm move (D05).
      const prs = v.extended ? await taskPullRequests(jira, d, d.key, trackerProject(part, projectOf(d.key))?.config, {}, { extended: true, part }) : null;
      if (v.json) return printJson(prs ? { issue: d, pullRequests: prs.pullRequests } : d);
      console.log(infoLines(d).join('\n'));
      if (prs) console.log(['', ...pullRequestLines(prs.pullRequests, pullRequestOptions(projectOf(d.key), prs, true))].join('\n'));
      console.log(`\n${c.baseUrl}/browse/${d.key}`);
    },
  },

  context: {
    help: 'info plus sprint, epic and its other children, sub-tasks, links (with their ids), code (Jira\'s development panel: pull requests, branches, commits), goals of the task and its epic, and warnings — read before working on a task',
    options: { task: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      required(v, 'task');
      const limit = Number(v.limit || 20);
      const { c, jira } = client(`read ${v.task}`);
      // Only the task itself is fatal; every later section that fails prints one unavailable line.
      const fieldIds = await attempt(() => fieldIdsByName(jira, ['Sprint', 'Goals']));
      const { Sprint: sprintId, Goals: goalsId } = fieldIds.value || {};
      const fields = [INFO_FIELDS, sprintId, goalsId].filter(Boolean).join(',');
      const d = await fetchIssue(jira, v.task, fields);
      const f = d.fields || {};
      const out = ['## Task', ...infoLines(d, { relations: false })];

      const sprints = (sprintId && f[sprintId]) || [];
      out.push('');
      if (fieldIds.error) out.push(unavailableLine('Sprint', fieldIds.error));
      else {
        out.push('## Sprint');
        for (const s of sprints) {
          const overdue = overdueSprintWarning(s);
          out.push(`  ${s.name} [${s.state}] (id ${s.id}${s.endDate ? `, ends ${s.endDate.slice(0, 10)}` : ''})`, ...(overdue ? [`    ${overdue}`] : []));
        }
        if (!sprints.length) out.push('  (none)');
      }

      const isEpic = name(f.issuetype).toLowerCase() === 'epic';
      const epicKey = isEpic ? d.key : (f.parent && name(f.parent.fields?.issuetype).toLowerCase() === 'epic' ? f.parent.key : null);
      if (epicKey) {
        const title = `Epic ${epicKey} — children`;
        const children = await attempt(() => jqlSearch(jira, `parent = ${epicKey} ORDER BY status, key`, limit));
        if (children.error) out.push('', unavailableLine(title, children.error));
        else {
          out.push('', `## ${title}${children.value.truncated ? ` (first ${limit})` : ''}`);
          for (const i of children.value.issues) if (i.key !== d.key) out.push(`  ${issueLine(i)}`);
        }
      }
      out.push(...sectionLines('Sub-tasks', { value: subtaskLines(f, limit) }), ...sectionLines('Links', { value: linkSectionLines(f, limit) }));

      const dev = await devStatus(jira, d.id);
      out.push(...sectionLines('Code', dev.error ? { error: dev.error } : { value: codeLines(dev, d.key, limit) }));
      out.push(...sectionLines('Goals', await goalsSection(jira, { d, fieldIds, goalsId, epicKey: epicKey === d.key ? null : epicKey })));

      // A Sprint field that could not be read counts as no active sprint: a task in work must be in one.
      const inActive = sprints.some((s) => s.state === 'active');
      const warnings = contextWarnings(d, { inActive, isEpic, pullRequests: mergePullRequests(dev.known), branches: dev.branches });
      out.push('', '## Warnings', ...(warnings.length ? warnings.map((w) => `  - ${w}`) : ['  (none)']));
      if (v.json) return printJson(d);
      console.log(out.join('\n'));
      console.log(`\n${c.baseUrl}/browse/${d.key}`);
    },
  },

  search: {
    help: 'read-only JQL search (--jql, --limit default 50); --count prints only the total, Jira\'s approximate count, and reads no rows',
    options: { jql: { type: 'string' }, limit: { type: 'string' }, fields: { type: 'string' }, count: { type: 'boolean' } },
    async run(v) {
      required(v, 'jql');
      if (v.count && (v.limit !== undefined || v.fields !== undefined)) throw new UsageError('--count prints only the total: not with --limit or --fields');
      const { jira } = client('search');
      if (v.count) return printCount(jira, v);
      const { issues, truncated } = await jqlSearch(jira, v.jql, Number(v.limit || 50), v.fields || LIST_FIELDS);
      if (v.json) return printJson(issues);
      for (const i of issues) console.log(issueLine(i));
      console.log(`${issues.length} issue(s)${truncated ? ' … more (raise --limit)' : ''}`);
    },
  },

  boards: {
    help: 'agile boards (--project KEY, --name substring)',
    options: { project: { type: 'string' }, name: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      const { jira } = client('list boards');
      const q = new URLSearchParams();
      if (v.project) q.set('projectKeyOrId', v.project);
      if (v.name) q.set('name', v.name);
      const boards = await agilePaged(jira, `/rest/agile/1.0/board?${q}`, 'values', Number(v.limit || 100));
      if (v.json) return printJson(boards);
      for (const b of boards) console.log(`${String(b.id).padStart(5)}  ${b.type.padEnd(6)} ${b.name}${b.location?.projectKey ? `  (${b.location.projectKey})` : ''}`);
      console.log(`${boards.length} board(s)`);
    },
  },

  sprints: {
    help: 'sprints of a board (--board ID, --state active,future,closed; default active,future)',
    options: { board: { type: 'string' }, state: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      required(v, 'board');
      const { jira } = client('list sprints');
      const state = v.state || 'active,future';
      const sprints = await agilePaged(jira, `/rest/agile/1.0/board/${v.board}/sprint?state=${state}`, 'values', Number(v.limit || 50));
      if (v.json) return printJson(sprints);
      for (const s of sprints) {
        const dates = [s.startDate, s.endDate].map((x) => (x ? x.slice(0, 10) : '?')).join(' → ');
        const overdue = overdueSprintWarning(s);
        console.log(`${String(s.id).padStart(6)}  [${s.state}] ${s.name}  ${dates}${s.goal ? `\n        goal: ${s.goal}` : ''}${overdue ? `\n        ${overdue}` : ''}`);
      }
      console.log(`${sprints.length} sprint(s)`);
    },
  },

  sprint: {
    help: 'one sprint: goal, dates, issues grouped by status, load per assignee (--id, or --board for its active sprint)',
    options: { id: { type: 'string' }, board: { type: 'string' }, limit: { type: 'string' } },
    async run(v) {
      if (!v.id && !v.board) throw new UsageError('--id or --board is required');
      const { jira } = client('read the sprint');
      let sprint;
      if (v.id) sprint = await jira.get(`/rest/agile/1.0/sprint/${v.id}`);
      else {
        const active = await agilePaged(jira, `/rest/agile/1.0/board/${v.board}/sprint?state=active`, 'values', 10);
        if (!active.length) throw new UsageError(`board ${v.board} has no active sprint`);
        if (active.length > 1) console.log(`# board ${v.board} has ${active.length} active sprints; showing the first. Use --id for another.`);
        sprint = active[0];
      }
      const issues = await agilePaged(jira, `/rest/agile/1.0/sprint/${sprint.id}/issue?fields=${LIST_FIELDS}`, 'issues', Number(v.limit || 500));
      if (v.json) return printJson({ sprint, issues });
      const dates = [sprint.startDate, sprint.endDate].map((x) => (x ? x.slice(0, 10) : '?')).join(' → ');
      console.log(`Sprint ${sprint.id}: ${sprint.name} [${sprint.state}] ${dates}`);
      const overdue = overdueSprintWarning(sprint);
      if (overdue) console.log(overdue);
      if (sprint.goal) console.log(`Goal: ${sprint.goal}`);
      const byStatus = new Map();
      const byAssignee = new Map();
      for (const i of issues) {
        const st = name(i.fields.status);
        if (!byStatus.has(st)) byStatus.set(st, []);
        byStatus.get(st).push(i);
        const who = name(i.fields.assignee, 'unassigned');
        const row = byAssignee.get(who) || { total: 0, done: 0 };
        row.total += 1;
        if (i.fields.status?.statusCategory?.key === 'done') row.done += 1;
        byAssignee.set(who, row);
      }
      for (const [st, list] of byStatus) {
        console.log(`\n## ${st} (${list.length})`);
        for (const i of list) console.log(`  ${issueLine(i)}`);
      }
      console.log('\n## Load');
      for (const [who, r] of [...byAssignee].sort((a, b) => b[1].total - a[1].total)) console.log(`  ${who.padEnd(28)} ${r.done}/${r.total} done`);
      const done = issues.filter((i) => i.fields.status?.statusCategory?.key === 'done').length;
      console.log(`\n${issues.length} issue(s), ${done} done`);
    },
  },

  comment: {
    help: 'post a markdown comment (--task, --text or --file; [~accountid:ID] mentions a person; a task key becomes a card; an image line ![alt](path.png) or ![alt](attachment:name) becomes an image, a file uploaded to the task; --dry-run, --plain, --show-adf); --edit ID replaces, --delete ID deletes a comment of this account (the [id N] in info; --others for someone else\'s; --edit is refused over content markdown cannot carry, unless --force); the dry run of a text over 2000 characters prints its size, outline and first lines, --full the whole text (ignored by the post itself)',
    options: {
      task: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' },
      edit: { type: 'string' }, delete: { type: 'string' }, others: { type: 'boolean' }, force: { type: 'boolean' },
      'dry-run': { type: 'boolean' }, plain: { type: 'boolean' }, 'show-adf': { type: 'boolean' }, full: { type: 'boolean' },
      ...CHECK_OPTIONS,
    },
    async run(v) {
      required(v, 'task');
      const id = commentId(v);
      if (v.delete !== undefined) return deleteComment(v, id);
      const text = readText(v);
      if (!text) throw new UsageError('--text or --file is required');
      // An image line's local path is replaced by the uploaded file: only its name reaches Jira.
      checkContent(v, v.plain ? [{ label: 'comment', text }] : uploadedMarkdown('comment', text));
      const dry = Boolean(v['dry-run']);
      // The preview of a comment reads nothing from Jira, so an explicit --dry-run works without credentials.
      const { c, jira } = client(`comment on ${v.task}`, { offline: dry });
      const links = siteLinks(jira, c);
      // An edit reads the comment first, even in a dry run with credentials: whose it is, and what it holds.
      const old = id && jira ? await ownComment(jira, v.task, id, v) : null;
      if (old && !v.force) await guardCommentLossless(old, v.task, id, links);
      // Images are uploaded to the task only after the guards, and only for a real write.
      const { options, imageLines } = v.plain ? { options: null, imageLines: [] } : await markdownOptions(jira, links, text, { key: v.task, file: v.file, dry });
      const doc = v.plain ? plainAdf(text) : markdownToAdf(text, options);
      if (dry) {
        console.log('--- DRY RUN (requested --dry-run) ---');
        console.log(`Task:   ${v.task}\nTarget: ${c.baseUrl || '<JIRA_BASE_URL>'}/browse/${v.task}`);
        if (id) console.log(`Comment ${id} that WOULD be replaced${old ? ` (by ${name(old.author, '?')}): ${firstLine(commentText(old))}` : ''}\nNew text:`);
        else console.log('Comment that WOULD be posted:');
        console.log((compactText(v, text) ? compactNewLines(text, doc) : ['-'.repeat(40), text, '-'.repeat(40)]).join('\n'));
        if (imageLines.length) console.log(imageLines.join('\n'));
        if (v['show-adf']) console.log(JSON.stringify(doc, null, 2));
        console.log('DRY RUN — nothing written to Jira.');
        if (!jira) offlineNote(c);
        return 0;
      }
      if (id) return replaceComment(jira, c, v.task, id, doc);
      const r = await jira.post(`/rest/api/3/issue/${encodeURIComponent(v.task)}/comment`, { body: doc });
      console.log(`Posted comment to ${v.task} (HTTP ${r.status}): ${c.baseUrl}/browse/${v.task}`);
    },
  },

  transition: {
    help: 'move a task (--task, --to, --comment TEXT posted after the move, --dry-run, --extended, --brief, --skip-pr URL); by the rules of task-tracking.jira in oikos.yaml (agent, confirm — the dry run prints the evidence and the pull requests, and pool-only ones join the comment —, person), else only among JIRA_AGENT_STATUSES; --extended also searches the project\'s extended_repos, on the user\'s request; --brief prints a confirm dry run as one short block (ignored by the move itself, so the move is the dry run without --dry-run); --skip-pr (repeatable) leaves a PR found by search out of the comment; --task A,B,… (at most 50 keys, rules only) moves each by its own rule, its dry run always brief; no direct transition prints a two-step path the rules allow and the project\'s history shows',
    options: {
      task: { type: 'string' }, to: { type: 'string' }, comment: { type: 'string' }, extended: { type: 'boolean' }, brief: { type: 'boolean' },
      'skip-pr': { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' }, ...CHECK_OPTIONS,
    },
    async run(v) {
      required(v, 'task', 'to');
      const dry = Boolean(v['dry-run']);
      checkContent(v, [{ label: 'comment', text: v.comment }]);
      const keys = v.task.includes(',') ? batchKeys(v.task) : [v.task];
      const part = config()['task-tracking']?.jira;
      if ((part === undefined || part === null) && keys.length > 1) {
        throw new UsageError(`--task A,B,…: moving many tasks at once follows the rules of task-tracking.jira in ${INSTALL_FILE}, and there are none — move one task at a time.`);
      }
      if ((part === undefined || part === null) && v['skip-pr']?.length) {
        throw new UsageError(`--skip-pr: without task-tracking.jira in ${INSTALL_FILE} a move looks for no pull request and posts none — leave the flag out.`);
      }
      if (part === undefined || part === null) return allowlistTransition({ ...v, task: keys[0] }, dry);
      const problems = trackerProblems(part, 'task-tracking.jira');
      if (problems.length) throw new UsageError(`${INSTALL_FILE} has problems in task-tracking.jira — fix them first: ${problems.join('; ')}`);
      // One task is the single move, full or --brief; more are a batch, always brief (D13).
      if (keys.length > 1) return batchTransition(v, part, keys, dry);
      return ruleTransition({ ...v, task: keys[0] }, part, dry);
    },
  },

  attachment: {
    help: 'download one attachment (--task, --id from the Attachments list, --dir default .); `attach` uploads files',
    options: { task: { type: 'string' }, id: { type: 'string' }, dir: { type: 'string' } },
    async run(v) {
      required(v, 'task', 'id');
      const { jira } = client('download');
      const d = await fetchIssue(jira, v.task, 'attachment');
      const att = (d.fields.attachment || []).find((a) => String(a.id) === String(v.id));
      if (!att) throw new UsageError(`${v.task} has no attachment ${v.id}. Ids: ${(d.fields.attachment || []).map((a) => a.id).join(', ') || 'none'}`);
      const r = await jira.raw('GET', att.content, undefined, { as: 'buffer' });
      const dir = v.dir || '.';
      mkdirSync(dir, { recursive: true });
      const path = join(dir, att.filename);
      writeFileSync(path, r.data);
      console.log(`Saved ${att.filename} (${att.mimeType}, ${r.data.length} bytes) → ${path}`);
    },
  },

  attach: {
    help: `attach local files to a task (--task KEY --file PATH, repeat --file for several; ${Object.keys(ATTACH_TYPES).join(', ')}; at most ${ATTACH_LIMIT / 1024 / 1024} MB each; a file inside the installation, a working folder of .local/ included, never a dot-named store there nor under a dot-named file or folder elsewhere (.claude/, .mcp.json, .git/); --dry-run lists name, size and type, and whether the task already has an attachment of that name and size, which is not uploaded again — offline too); the write reads the task's attachments back and prints each file's id; the content check reads a text type (${[...ATTACH_TEXT_TYPES].join(', ')}) and the name of every file, never an image's or an office file's content`,
    options: { task: { type: 'string' }, file: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' }, ...CHECK_OPTIONS },
    run: attachFiles,
  },
};

// Goals (Atlassian Home / Townsquare) live behind the GraphQL gateway. `goals_search` ignores its
// search string in practice, so the list is paged in full and filtered here.
// Goals are planned per quarter; the quarter is a tag on the goal: `q3-26` = Q3 2026.
const GOAL_FIELDS = 'id key name url isArchived state{label value} owner{ accountId name } targetDate{ dateRange{ end } } parentGoal{ key name } tags{ edges{ node{ name } } }';
const goalTags = (g) => (g.tags?.edges || []).map((e) => e.node.name);

/** `current` / `next` / `previous` → the quarter tag (q3-26); anything else passes as is. */
function quarterTag(value, now = new Date()) {
  const shift = { current: 0, next: 1, previous: -1, prev: -1 }[value];
  if (shift === undefined) return value;
  const q = Math.floor(now.getMonth() / 3) + shift;
  const year = now.getFullYear() + Math.floor(q / 4);
  return `q${((q % 4) + 4) % 4 + 1}-${String(year).slice(-2)}`;
}
let cloudIdCache;

async function graphql(jira, query, variables) {
  const { data } = await jira.post('/gateway/api/graphql', { query, variables });
  if (!data?.data && data?.errors) throw new UsageError(`goals API: ${data.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
  return data?.data;
}

async function goalsContainer(jira) {
  cloudIdCache ??= (await jira.get('/_edge/tenant_info')).cloudId;
  return `ari:cloud:townsquare::site/${cloudIdCache}`;
}

async function allGoals(jira) {
  const container = await goalsContainer(jira);
  const out = [];
  let after = null;
  for (let page = 0; page < 50; page++) {
    const d = await graphql(jira, `query OikosGoalList($c:ID!,$after:String){ goals_search(containerId:$c, searchString:"", first:100, after:$after){ pageInfo{ hasNextPage endCursor } edges{ node{ ${GOAL_FIELDS} } } } }`, { c: container, after });
    const conn = d.goals_search;
    out.push(...conn.edges.map((e) => e.node));
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

async function goalByKey(jira, key, extra = '') {
  const d = await graphql(jira, `query OikosGoalByKey($c:ID!,$k:String!){ goals_byKey(containerId:$c, goalKey:$k){ ${GOAL_FIELDS} ${extra} } }`, { c: await goalsContainer(jira), k: key });
  if (!d?.goals_byKey) throw new UsageError(`goal ${key}: not found, or not visible to this account`);
  return d.goals_byKey;
}

/** The goal ARIs the Goals field `fieldId` of the issue `d` names. */
const goalAris = (d, fieldId) => (d.fields?.[fieldId] || []).map((g) => g.id).filter(Boolean);

/**
 * One line per goal: those of `own`, then those of `inherited` not among them, marked `(<mark>)`;
 * a goal these credentials cannot read is named by its ARI.
 */
async function goalLinesOf(jira, own, inherited, mark) {
  const lines = [];
  for (const [ari, onParent] of [...own.map((a) => [a, false]), ...inherited.filter((a) => !own.includes(a)).map((a) => [a, true])]) {
    const goal = (await graphql(jira, `query OikosGoalById($a:ID!){ goals_byId(goalId:$a){ ${GOAL_FIELDS} } }`, { a: ari }))?.goals_byId;
    lines.push(`${goal ? goalLine(goal) : `${ari} (goal not readable with these credentials)`}${onParent ? `  (${mark})` : ''}`);
  }
  return lines;
}

function goalLine(g) {
  const due = g.targetDate?.dateRange?.end ? ` · due ${g.targetDate.dateRange.end.slice(0, 10)}` : '';
  const parent = g.parentGoal ? ` · under ${g.parentGoal.key}` : '';
  const tags = goalTags(g).length ? ` · #${goalTags(g).join(' #')}` : '';
  return `${g.key} ${g.name.trim()} — ${g.state?.label || '?'} · ${g.owner?.name || 'no owner'}${due}${parent}${tags}${g.isArchived ? ' [archived]' : ''}`;
}

// == writes beyond comment/transition: create, edit (one or bulk), sprint moves, links ==
// Every one prints what it would do under --dry-run, and needs credentials even then: the
// preview resolves users, goals, sprints and JQL on the site (only `link` and `unlink` preview
// offline; `unlink` then names only the id, as it cannot read the link).
// Bulk selection by JQL is capped (--max, default 50) so a wide query never edits more than
// the user saw.

const DEFAULT_MAX = 50;

async function accountId(jira, who) {
  if (!who || who === 'none') return null;
  if (who === 'me') return (await jira.get('/rest/api/3/myself')).accountId;
  if (/^[0-9a-f:-]{20,}$/i.test(who)) return who;
  const users = await jira.get(`/rest/api/3/user/search?query=${encodeURIComponent(who)}`);
  const active = users.filter((u) => u.active !== false && u.accountType === 'atlassian');
  if (active.length !== 1) {
    throw new UsageError(`'${who}' matches ${active.length} users${active.length ? `: ${active.map((u) => u.displayName).join(', ')}` : ''} — use the email`);
  }
  return active[0].accountId;
}

const splitList = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

/**
 * The content check (common/outgoing.mjs) of a write's texts, in its dry run and its real run, before
 * any upload or request that writes.
 */
function checkContent(v, texts) {
  guardOutgoing(texts, v, outgoingRules());
}

/** Keys from --task A,B or --jql (capped by --max). */
async function selectKeys(jira, v) {
  if (v.task) return splitList(v.task);
  if (!v.jql) throw new UsageError('--task KEY[,KEY…] or --jql is required');
  const max = Number(v.max || DEFAULT_MAX);
  const { issues, truncated } = await jqlSearch(jira, v.jql, max + 1);
  if (issues.length > max || truncated) throw new UsageError(`the JQL selects more than --max ${max} issues; narrow it or raise --max`);
  return issues.map((i) => i.key);
}

/** The markdown description of create/edit: --file, else --description. */
const descriptionText = (v) => (v.file ? readFileSync(v.file, 'utf8') : v.description);

/** The `fields` object for create/edit from the common options; `adf` are the markdownToAdf options of the description. */
async function fieldsFrom(jira, v, adf = {}) {
  const f = {};
  const description = descriptionText(v);
  if (v.summary) f.summary = v.summary;
  if (description) f.description = markdownToAdf(description, adf);
  if (v.priority) f.priority = { name: v.priority };
  if (v.parent) f.parent = { key: v.parent };
  if (v.due) f.duedate = v.due === 'none' ? null : v.due;
  if (v.labels !== undefined) f.labels = splitList(v.labels);
  if (v.assignee) f.assignee = { accountId: await accountId(jira, v.assignee) };
  if (v.assignee === 'none') f.assignee = null;
  return f;
}

const GOAL_LINK_MUTATION = 'mutation OikosGoalLink($input:TownsquareGoalsLinkWorkItemInput!){ goals_linkWorkItem(input:$input){ success errors{ message } } }';

/** The Goals field id and the goals `keys` name, resolved once for `create --goals` and `edit --add-goals`. */
async function goalsToAdd(jira, keys) {
  const ids = await fieldIdsByName(jira, ['Goals']);
  if (!ids.Goals) throw new UsageError('this Jira site has no Goals field');
  const keyOf = new Map();
  for (const k of new Set(keys)) {
    let goal;
    try {
      goal = await goalByKey(jira, k);
    } catch (e) {
      if (e instanceof UsageError) throw new UsageError(`${e.message} — find its key with \`${TOOL} goals --search <text>\``);
      throw e;
    }
    keyOf.set(goal.id, k);
  }
  return { fieldId: ids.Goals, keyOf };
}

/** The goal ARIs the Goals field of `key` names, and the issue's id. */
async function issueGoals(jira, key, fieldId) {
  const d = await fetchIssue(jira, key, fieldId);
  return { id: String(d.id ?? ''), goals: (d.fields?.[fieldId] || []).map((g) => g.id).filter(Boolean) };
}

/** One planned link: the `goals_linkWorkItem` variables for goal `goalId` and the issue whose id is `issueId`. */
function goalLink(goalId, goalKey, issueId) {
  return { goalKey, variables: { goalId, workItemId: `ari:cloud:jira:${cloudIdCache}:issue/${issueId}` } };
}

/**
 * The `goals_linkWorkItem` variables for each goal `key` lacks: [{ goalKey, variables }]. A goal
 * already on the task is named and skipped. Jira answers 204 to a PUT of the Goals field and drops
 * the value; only the goals service links one.
 */
async function goalLinksFor(jira, key, { fieldId, keyOf }) {
  const { id, goals } = await issueGoals(jira, key, fieldId);
  await goalsContainer(jira);
  const links = [];
  for (const [goalId, goalKey] of keyOf) {
    if (goals.includes(goalId)) console.log(`Goal ${goalKey} is already set on ${key}.`);
    else links.push(goalLink(goalId, goalKey, id));
  }
  return links;
}

/** Send `goals_linkWorkItem`, then confirm by reading the task's Goals field back; false on failure. */
async function linkGoal(jira, key, fieldId, { goalKey, variables }) {
  const d = await graphql(jira, GOAL_LINK_MUTATION, { input: variables });
  const result = d?.goals_linkWorkItem;
  if (!result?.success) {
    const why = (result?.errors || []).map((e) => e.message).join('; ') || 'no reason given';
    console.error(`Jira did not link goal ${goalKey} to ${key}: ${why}.`);
    return false;
  }
  if (!(await issueGoals(jira, key, fieldId)).goals.includes(variables.goalId)) {
    console.error(`GOAL NOT CONFIRMED: the goals service accepted ${goalKey}, but ${key} does not show it; check it in Jira.`);
    return false;
  }
  console.log(`Goal ${goalKey} set on ${key} (confirmed by reading ${key} back).`);
  return true;
}

const lower = (text) => String(text || '').trim().toLowerCase();

/**
 * The link type `wanted` names — by its name or its outward verb ("A <verb> B"), or by its inward
 * verb, which swaps the ends: { typeName, verb, outward }. Ambiguous or unknown is refused, naming
 * the matches or every valid type with its verbs.
 */
function linkKind(types, wanted) {
  const want = lower(wanted);
  const hits = [];
  for (const t of types) {
    if (want === lower(t.name) || want === lower(t.outward)) hits.push({ typeName: t.name, verb: t.outward || t.name, outward: true });
    else if (want === lower(t.inward)) hits.push({ typeName: t.name, verb: t.inward, outward: false });
  }
  if (hits.length === 1) return hits[0];
  if (hits.length) throw new UsageError(`--type '${wanted}' matches several link types: ${hits.map((h) => h.typeName).join(', ')}.`);
  const valid = types.map((t) => `${t.name} (${t.outward} / ${t.inward})`).join('; ');
  throw new UsageError(`No link type '${wanted}'. Valid: ${valid}.`);
}

/**
 * How `from` states its link of `typeName` to `to`: { verb, id }, or null. A link stated with
 * `verb` wins over one stated the other way; the POST returns no id, so this read is also where
 * the id comes from.
 */
async function linkReadBack(jira, from, to, typeName, verb) {
  const d = await fetchIssue(jira, from, 'issuelinks');
  const found = (d.fields?.issuelinks || [])
    .filter((l) => lower(l.type?.name) === lower(typeName) && (l.outwardIssue || l.inwardIssue)?.key === to)
    .map((l) => ({ verb: l.outwardIssue ? l.type?.outward : l.type?.inward, id: String(l.id ?? '?') }));
  return found.find((l) => lower(l.verb) === lower(verb)) || found[0] || null;
}

/** "<inward key> <outward verb> <outward key> (link id N)", as GET /issueLink names the ends. */
async function linkSentence(jira, id) {
  let d;
  try {
    d = await jira.get(`/rest/api/3/issueLink/${id}`);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new UsageError(`No link with id ${id}.`);
    throw e;
  }
  return `${d.inwardIssue?.key || '?'} ${d.type?.outward || 'relates to'} ${d.outwardIssue?.key || '?'} (link id ${id})`;
}

/**
 * The ADF `md` becomes, judged before any upload: task keys linked as the write links them, and
 * only `media:<id>` and URL image lines as images (a local or `attachment:` image is new to the
 * description, so it keeps no old identity). What the identity guards compare against.
 */
async function judgedMarkdown(links, md) {
  return markdownToAdf(md, { issueUrl: await links.forText(md), resolveImage: () => null });
}

/** What of `before` (an ADF document or node list) the markdown result `after` leaves out: its images by media id, its task cards by URL. */
const droppedCarried = (before, after) => missingIdentities(carriedIdentities(before), carriedIdentities(after));

const KEEP_HINT = 'Keep each image as its `![alt](media:<id>)` line (as `info --description` prints it) and each task card as its key';

/**
 * What replacing `key`'s description with the markdown result `next` would lose: { lost, dropped }
 * — the nodes markdown cannot carry (lossyText) and the carried images and cards `next` leaves out.
 */
async function descriptionLoss(jira, key, links, next) {
  const d = await fetchIssue(jira, key, 'description');
  const current = d.fields?.description;
  const lost = lossyText(lossyNodes(current, { issueUrl: await links.forDoc(current) }));
  return { lost: lost ? `${key}: ${lost}` : '', dropped: droppedCarried(current, next).map((id) => `${key}: ${id}`) };
}

/**
 * Refuse a markdown overwrite of the description of any of `keys` that holds nodes markdown cannot
 * carry (images and files, cards, macros, mentions, …), or whose images and cards the new text
 * `md` leaves out, naming each issue and what it would lose.
 */
async function guardLossless(jira, keys, links, md) {
  const next = await judgedMarkdown(links, md);
  const losses = [];
  const dropped = [];
  for (const key of keys) {
    const loss = await descriptionLoss(jira, key, links, next);
    if (loss.lost) losses.push(loss.lost);
    dropped.push(...loss.dropped);
  }
  const rest = `To change one part and keep the rest, use \`${TOOL} description --task KEY --section "Heading"\` or \`--append\`; pass --force to overwrite anyway.`;
  if (losses.length) {
    throw new UsageError(`Refusing to replace the description from markdown — it holds what markdown cannot carry and would be lost: ${losses.join('; ')}. ` +
      `An embedded image is also deleted from Attachments once the description no longer references it. ${rest}`);
  }
  if (dropped.length) {
    throw new UsageError(`Refusing to replace the description from markdown — the new text leaves out what the old one carries: ${dropped.join('; ')}. ` +
      `An embedded image is also deleted from Attachments once the description no longer references it. ${KEEP_HINT}. ${rest}`);
  }
}

const GOALS_FIELD_REFUSED = '--goals cannot set the Goals field (Jira drops the value): add a goal with --add-goals; removing one is done in Atlassian Home';

const COMMON_FIELDS = {
  summary: { type: 'string' }, description: { type: 'string' }, file: { type: 'string' },
  priority: { type: 'string' }, parent: { type: 'string' }, due: { type: 'string' },
  labels: { type: 'string' }, assignee: { type: 'string' }, goals: { type: 'string' },
  'dry-run': { type: 'boolean' }, ...CHECK_OPTIONS, full: { type: 'boolean' },
};

function dryHeader() {
  console.log('--- DRY RUN (requested --dry-run) ---');
}

/**
 * The fields a dry run would write; `parent` is the checked parent's line (checkedParent), when there
 * is one; `compact`, when given, the lines that stand for a long description (compact dry runs).
 */
function showFields(fields, parent, compact) {
  for (const [k, val] of Object.entries(fields)) {
    const description = compact ? `(compact)\n${compact.join('\n')}` : `\n${adfToText(val).trim()}`;
    const shown = k === 'description' ? description : k === 'parent' && parent ? parent.shown : JSON.stringify(val);
    console.log(`  ${k}: ${shown}`);
  }
  if (parent?.note) console.log(`  note: ${parent.note}`);
}

// A team-managed project takes only a parent of its own project: Jira refuses any other with HTTP 400
// ("must be created in the same project as the parent"). The parent is therefore read, and the
// projects on both sides when they differ, before the dry run and before the write.

const PARENT_FIELDS = 'project,issuetype,status,summary';
/** A project as GET /project/{key} answers it: team-managed (next-gen) or company-managed. */
const teamManaged = (p) => p?.simplified === true || p?.style === 'next-gen';

/**
 * The parent `parentKey` for the issues `targets` ([{ task, project, from }]: what a message names,
 * the issue's project, the key a link would start from): { shown, note } for the dry run. A missing
 * parent, or one in another project where either side is team-managed, is refused for the whole
 * command, naming every offending issue, and the issues that can take it with the `edit` that sets
 * it on them alone; each project is read once.
 */
async function checkedParent(jira, parentKey, targets) {
  let parent;
  try {
    parent = await fetchIssue(jira, parentKey, PARENT_FIELDS);
  } catch (e) {
    if (e instanceof UsageError) throw new UsageError(`--parent ${parentKey}: ${e.message}`);
    throw e;
  }
  const f = parent.fields || {};
  const own = String(f.project?.key || projectOf(parent.key || parentKey)).toUpperCase();
  const project = projectReader(jira);
  const refused = [];
  const crossing = [];
  const taking = [];
  for (const { task, project: target, from } of targets) {
    if (target === own) {
      taking.push(from);
      continue;
    }
    const team = teamManaged(await project(target)) ? target : teamManaged(await project(own)) ? own : null;
    if (!team) {
      crossing.push(task);
      taking.push(from);
      continue;
    }
    refused.push(`${task}: parent ${parentKey} is in project ${own}; ${team} is team-managed, so a parent must be in ${target}.`,
      `  Set an epic of ${target} as the parent and link the other one: ${TOOL} link --from ${from} --type Relates --to ${parentKey} --dry-run`);
  }
  // Only `edit` passes several issues, so the ones that can take the parent are named with an `edit` of their own.
  if (refused.length && taking.length) {
    refused.push(`${taking.join(', ')} can take ${parentKey}: run ${TOOL} edit --task ${taking.join(',')} --parent ${parentKey} --dry-run`);
  }
  if (refused.length) throw new UsageError(`refusing --parent ${parentKey}, nothing written:\n${refused.join('\n')}`);
  const note = crossing.length
    ? `the parent ${parentKey} is in project ${own}, not that of ${crossing.join(', ')}; company-managed projects allow a parent in another project.`
    : null;
  return { shown: `${parent.key || parentKey} — ${f.summary || ''} [${name(f.status, '?')}]`, note };
}

Object.assign(commands, {
  create: {
    help: 'create an issue (--project, --type, --summary, --description|--file (markdown; task keys become cards; image lines are refused — add them after with `description`), --parent, --assignee me|email, --labels, --priority, --due, --goals GOAL-1,… (linked through the goals service after the create), --sprint ID, --dry-run); the dry run of a description over 2000 characters prints its size, outline and first lines, --full the whole text (ignored by the create itself)',
    options: { project: { type: 'string' }, type: { type: 'string' }, sprint: { type: 'string' }, ...COMMON_FIELDS },
    async run(v) {
      required(v, 'project', 'summary');
      const { c, jira } = client(`create an issue in ${v.project}`);
      const description = descriptionText(v);
      if (description && imageTargets(description).length) {
        throw new UsageError(`create does not upload images — the issue does not exist yet: ${imageTargets(description).join(', ')}. ` +
          `Create it without those image lines, then add them with \`${TOOL} description --task <KEY> --append --file …\` (or --section).`);
      }
      checkContent(v, [{ label: 'summary', text: v.summary }, { label: 'description', text: description }]);
      const issueUrl = description ? await siteLinks(jira, c).forText(description) : undefined;
      const fields = { project: { key: v.project }, issuetype: { name: v.type || 'Task' }, ...(await fieldsFrom(jira, v, { issueUrl })) };
      const target = String(v.project).toUpperCase();
      const parent = v.parent ? await checkedParent(jira, v.parent, [{ task: `the new issue in ${target}`, project: target, from: '<KEY of the new issue>' }]) : null;
      // Goals are resolved before the create, so an unknown goal is refused before anything is written.
      const goalKeys = splitList(v.goals);
      const goals = goalKeys.length ? await goalsToAdd(jira, goalKeys) : null;
      const linksFor = (issueId) => (goals ? [...goals.keyOf].map(([goalId, goalKey]) => goalLink(goalId, goalKey, issueId)) : []);
      if (v['dry-run']) {
        dryHeader();
        console.log(`Would create in ${v.project}:`);
        showFields(fields, parent, compactText(v, description) ? compactNewLines(description, fields.description) : null);
        if (v.sprint) console.log(`  then add to sprint ${v.sprint}`);
        for (const l of linksFor('<id of the new issue>')) {
          console.log(`Goal link that WOULD be sent (goals_linkWorkItem) for the new issue (${l.goalKey}): ${JSON.stringify(l.variables)}`);
        }
        console.log('DRY RUN — nothing written to Jira.');
        return 0;
      }
      const { data } = await jira.post('/rest/api/3/issue', { fields });
      if (v.sprint) await jira.post(`/rest/agile/1.0/sprint/${v.sprint}/issue`, { issues: [data.key] });
      console.log(`Created ${data.key}${v.sprint ? ` in sprint ${v.sprint}` : ''}: ${c.baseUrl}/browse/${data.key}`);
      let linked = true;
      for (const l of linksFor(data.id)) linked = (await linkGoal(jira, data.key, goals.fieldId, l)) && linked;
      if (!linked) {
        console.error(`${data.key} was created, but a goal was not linked (above); add it with \`${TOOL} edit --task ${data.key} --add-goals …\`.`);
        return 2;
      }
    },
  },

  edit: {
    help: 'edit fields of one issue or many (--task A,B | --jql … --max N; --summary, --description|--file (markdown, as comment writes it, images on one issue only; refused over mentions, odd cards and images and other content markdown cannot carry, unless --force — description --section edits one part), --assignee, --labels (set), --add-labels, --remove-labels, --priority, --parent, --due, --add-goals GOAL-1,… (links through the goals service; removing a goal is done in Atlassian Home), --dry-run); the dry run of a description over 2000 characters prints its size, outline and a diff from each current description, --full the whole text (ignored by the edit itself)',
    options: { task: { type: 'string' }, jql: { type: 'string' }, max: { type: 'string' }, 'add-labels': { type: 'string' }, 'remove-labels': { type: 'string' }, 'add-goals': { type: 'string' }, force: { type: 'boolean' }, ...COMMON_FIELDS },
    async run(v) {
      if (v.goals !== undefined) throw new UsageError(GOALS_FIELD_REFUSED);
      const addGoals = splitList(v['add-goals']);
      const { c, jira } = client('edit issues');
      const keys = await selectKeys(jira, v);
      const links = siteLinks(jira, c);
      const description = descriptionText(v);
      checkContent(v, [{ label: 'summary', text: v.summary }, ...uploadedMarkdown('description', description)]);
      if (description && !v.force) await guardLossless(jira, keys, links, description);
      if (description && imagePlan(description, v.file).length && keys.length !== 1) {
        throw new UsageError(`the description has image lines, and an image is uploaded to one issue: edit one --task at a time (selected: ${keys.join(', ')})`);
      }
      const parent = v.parent ? await checkedParent(jira, v.parent, keys.map((key) => ({ task: key, project: projectOf(key), from: key }))) : null;
      // Images are uploaded only after the guards, and only for a real write.
      const adf = description ? await markdownOptions(jira, links, description, { key: keys[0], file: v.file, dry: Boolean(v['dry-run']) }) : { options: {}, imageLines: [] };
      const fields = await fieldsFrom(jira, v, adf.options);
      const update = {};
      const labelOps = [...splitList(v['add-labels']).map((l) => ({ add: l })), ...splitList(v['remove-labels']).map((l) => ({ remove: l }))];
      if (labelOps.length) update.labels = labelOps;
      if (!Object.keys(fields).length && !labelOps.length && !addGoals.length) throw new UsageError('nothing to change: pass at least one field option');
      const goals = addGoals.length ? await goalsToAdd(jira, addGoals) : null;
      const plans = [];
      const changesFields = Object.keys(fields).length > 0 || labelOps.length > 0;
      for (const key of keys) {
        const goalLinks = goals ? await goalLinksFor(jira, key, goals) : [];
        if (changesFields || goalLinks.length) plans.push({ key, goalLinks });
      }
      if (!plans.length) {
        console.log('Nothing to change.');
        return 0;
      }
      if (v['dry-run']) {
        dryHeader();
        console.log(`Would edit ${plans.length} issue(s): ${plans.map((p) => p.key).join(', ')}`);
        const long = compactText(v, description) ? await compactReplaceLines(jira, plans.map((p) => p.key), description, fields.description) : null;
        showFields(fields, parent, long);
        if (adf.imageLines.length) console.log(adf.imageLines.join('\n'));
        if (labelOps.length) console.log(`  labels: ${labelOps.map((o) => (o.add ? `+${o.add}` : `-${o.remove}`)).join(' ')}`);
        for (const { key, goalLinks } of plans) {
          for (const l of goalLinks) console.log(`Goal link that WOULD be sent (goals_linkWorkItem) for ${key} (${l.goalKey}): ${JSON.stringify(l.variables)}`);
        }
        console.log('DRY RUN — nothing written to Jira.');
        return 0;
      }
      let failed = 0;
      for (const { key, goalLinks } of plans) {
        try {
          if (changesFields) await jira.raw('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields, update });
          let linked = true;
          for (const l of goalLinks) linked = (await linkGoal(jira, key, goals.fieldId, l)) && linked;
          if (!linked) throw new Error('a goal was not linked (above)');
          console.log(`edited ${key}`);
        } catch (e) {
          failed += 1;
          console.error(`${key}: ${e.message}`);
        }
      }
      console.log(`${plans.length - failed}/${plans.length} edited`);
      return failed ? 2 : 0;
    },
  },

  'move-to-sprint': {
    help: 'move issues into a sprint, or back to the backlog (--sprint ID | --backlog; --task A,B | --jql … --max N; --dry-run)',
    options: { sprint: { type: 'string' }, backlog: { type: 'boolean' }, task: { type: 'string' }, jql: { type: 'string' }, max: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    async run(v) {
      if (!v.sprint && !v.backlog) throw new UsageError('--sprint ID or --backlog is required');
      const { jira } = client('move issues');
      const keys = await selectKeys(jira, v);
      let target = v.backlog ? 'the backlog' : `sprint ${v.sprint}`;
      if (v.sprint) {
        const s = await jira.get(`/rest/agile/1.0/sprint/${v.sprint}`);
        if (s.state === 'closed') throw new UsageError(`sprint ${s.name} is closed; issues cannot be moved into it`);
        target = `sprint ${s.id} "${s.name}" [${s.state}]`;
      }
      if (v['dry-run']) {
        dryHeader();
        console.log(`Would move ${keys.length} issue(s) to ${target}: ${keys.join(', ')}`);
        console.log('DRY RUN — nothing written to Jira.');
        return 0;
      }
      for (let i = 0; i < keys.length; i += 50) {
        const issues = keys.slice(i, i + 50);
        const path = v.backlog ? '/rest/agile/1.0/backlog/issue' : `/rest/agile/1.0/sprint/${v.sprint}/issue`;
        await jira.post(path, { issues });
      }
      console.log(`Moved ${keys.length} issue(s) to ${target}`);
    },
  },

  link: {
    help: 'link two issues: --from A --type Blocks --to B means "A blocks B" (--type takes a type name or either verb; an inward verb such as "is blocked by" swaps the ends); an existing same link is reported, a reversed one refused; confirmed by reading A back (--dry-run); --types lists link types',
    options: { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string' }, types: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    async run(v) {
      if (v.types) {
        const { jira } = client('list link types');
        const { issueLinkTypes = [] } = await jira.get('/rest/api/3/issueLinkType');
        for (const t of issueLinkTypes) console.log(`${t.name.padEnd(16)} A ${t.outward} B  /  B ${t.inward} A`);
        return 0;
      }
      required(v, 'from', 'to', 'type');
      // Without credentials an explicit --dry-run can only echo the request; with them it resolves
      // the type and checks the links the from-issue already has.
      const { c, jira } = client(`link ${v.from} to ${v.to}`, { offline: v['dry-run'] });
      if (!jira) {
        dryHeader();
        console.log(`Would link: ${v.from} —${v.type}→ ${v.to}\nDRY RUN — nothing written to Jira.`);
        offlineNote(c);
        return 0;
      }
      const { issueLinkTypes = [] } = await jira.get('/rest/api/3/issueLinkType');
      const kind = linkKind(issueLinkTypes, v.type);
      const sentence = `${v.from} ${kind.verb} ${v.to}`;
      // An existing link of this type is settled first, so the read-back after the POST is unambiguous.
      const existing = await linkReadBack(jira, v.from, v.to, kind.typeName, kind.verb);
      if (existing && lower(existing.verb) === lower(kind.verb)) {
        console.log(`Already linked: ${sentence} (link id ${existing.id}).`);
        return 0;
      }
      if (existing) {
        throw new UsageError(`Refusing: ${v.from} already ${existing.verb} ${v.to} (link id ${existing.id}), the opposite of "${sentence}". ` +
          `Remove it first: \`${TOOL} unlink --id ${existing.id}\`.`);
      }
      if (v['dry-run']) {
        dryHeader();
        console.log(`Would link: ${sentence} (type ${kind.typeName})\nDRY RUN — nothing written to Jira.`);
        return 0;
      }
      // POST /issueLink names the ends mirrored to how GET issuelinks shows them: the issue that
      // carries the outward verb ("A blocks B") goes in inwardIssue; an inward verb swaps the ends.
      const [carrier, other] = kind.outward ? [v.from, v.to] : [v.to, v.from];
      await jira.post('/rest/api/3/issueLink', { type: { name: kind.typeName }, inwardIssue: { key: carrier }, outwardIssue: { key: other } });
      const stated = await linkReadBack(jira, v.from, v.to, kind.typeName, kind.verb);
      if (!stated) {
        console.error(`LINK NOT CONFIRMED: Jira accepted the link, but ${v.from} shows no ${kind.typeName} link to ${v.to}; check it in Jira.`);
        return 2;
      }
      const found = `${v.from} ${stated.verb} ${v.to} (link id ${stated.id})`;
      if (lower(stated.verb) !== lower(kind.verb)) {
        console.error(`LINK DIRECTION NOT CONFIRMED: asked "${sentence}", but Jira states ${found}; ` +
          `remove it with \`${TOOL} unlink --id ${stated.id}\` and check the link type's wording with \`${TOOL} link --types\`.`);
        return 2;
      }
      console.log(`Linked: ${found}, confirmed by reading ${v.from} back.`);
      return 0;
    },
  },

  unlink: {
    help: 'remove a link by its id, the one `link` reports (--id N, --dry-run)',
    options: { id: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    async run(v) {
      required(v, 'id');
      if (!/^\d+$/.test(v.id)) throw new UsageError(`--id is a link id, digits only, got '${v.id}'`);
      // Without credentials an explicit --dry-run can only name the id; with them it reads the link.
      const { c, jira } = client(`remove link ${v.id}`, { offline: v['dry-run'] });
      if (!jira) {
        dryHeader();
        console.log(`Link that WOULD be removed: link id ${v.id}\nDRY RUN — nothing written to Jira.`);
        offlineNote(c);
        return 0;
      }
      const sentence = await linkSentence(jira, v.id);
      if (v['dry-run']) {
        dryHeader();
        console.log(`Link that WOULD be removed: ${sentence}\nDRY RUN — nothing written to Jira.`);
        return 0;
      }
      const { status } = await jira.raw('DELETE', `/rest/api/3/issueLink/${v.id}`);
      if (status !== 204) {
        console.error(`Jira answered HTTP ${status} to the unlink, not 204; check ${sentence} in Jira.`);
        return 2;
      }
      console.log(`Unlinked: ${sentence}`);
      return 0;
    },
  },

  goals: {
    help: 'goals (OKRs): of a task (--task), or the list (--tag q3-26|current|next|previous, --owner me|email, --search text, --state on_track|at_risk|off_track|pending|done|…, --archived, --limit); --tags lists the tags',
    options: { task: { type: 'string' }, owner: { type: 'string' }, tag: { type: 'string' }, tags: { type: 'boolean' }, search: { type: 'string' }, state: { type: 'string' }, archived: { type: 'boolean' }, limit: { type: 'string' } },
    async run(v) {
      const { jira } = client('read goals');
      if (v.tags) {
        const counts = new Map();
        for (const g of await allGoals(jira)) for (const t of goalTags(g)) counts.set(t, (counts.get(t) || 0) + 1);
        if (v.json) return printJson(Object.fromEntries(counts));
        for (const [t, n] of [...counts].sort()) console.log(`${t.padEnd(16)} ${n} goal(s)`);
        console.log(`current quarter: ${quarterTag('current')}`);
        return 0;
      }
      if (!v.task) {
        let goals = await allGoals(jira);
        if (!v.archived) goals = goals.filter((g) => !g.isArchived);
        if (v.tag) {
          const want = splitList(v.tag).map((t) => quarterTag(t).toLowerCase());
          goals = goals.filter((g) => goalTags(g).some((t) => want.includes(t.toLowerCase())));
        }
        if (v.state) goals = goals.filter((g) => g.state?.value === v.state);
        if (v.owner) {
          const id = await accountId(jira, v.owner);
          goals = goals.filter((g) => g.owner?.accountId === id);
        }
        if (v.search) {
          const needle = v.search.toLowerCase();
          goals = goals.filter((g) => `${g.key} ${g.name} ${g.owner?.name || ''}`.toLowerCase().includes(needle));
        }
        goals = goals.slice(0, Number(v.limit || 200));
        if (v.json) return printJson(goals);
        for (const g of goals) console.log(goalLine(g));
        console.log(`${goals.length} goal(s)${v.tag ? ` tagged ${splitList(v.tag).map((t) => quarterTag(t)).join(', ')}` : ''}${v.archived ? '' : ' (archived hidden; --archived to include)'}`);
        return 0;
      }
      const ids = await fieldIdsByName(jira, ['Goals']);
      if (!ids.Goals) { console.log('this Jira site has no Goals field'); return 0; }
      const d = await fetchIssue(jira, v.task, `parent,${ids.Goals}`);
      const fromParent = d.fields.parent ? goalAris(await fetchIssue(jira, d.fields.parent.key, ids.Goals), ids.Goals) : [];
      const lines = await goalLinesOf(jira, goalAris(d, ids.Goals), fromParent, 'on parent');
      if (!lines.length) { console.log(`${v.task}: no goals on the task or its parent`); return 0; }
      for (const line of lines) console.log(line);
    },
  },

  goal: {
    help: 'one goal: state, owner, due, tags, parent, sub-goals, comments, and the Jira issues attached to it (--key GOAL-42, --limit, --comments N)',
    options: { key: { type: 'string' }, limit: { type: 'string' }, comments: { type: 'string' } },
    async run(v) {
      required(v, 'key');
      const { jira } = client('read goals');
      const goal = await goalByKey(jira, v.key, `subGoals{ edges{ node{ key name isArchived state{label value} } } } comments(first:${Number(v.comments || 10)}){ edges{ node{ commentText creationDate creator{ name } } } }`);
      const { issues, truncated } = await jqlSearch(jira, `Goals = ${goal.key} ORDER BY status, key`, Number(v.limit || 100));
      if (v.json) return printJson({ goal, issues });
      console.log(goalLine(goal));
      console.log(`  ${goal.url}`);
      const subs = (goal.subGoals?.edges || []).map((e) => e.node).filter((g) => !g.isArchived);
      if (subs.length) console.log('\nSub-goals:', ...subs.map((g) => `\n  ${g.key} ${g.name.trim()} — ${g.state?.label || '?'}`));
      const comments = (goal.comments?.edges || []).map((e) => e.node);
      if (comments.length) {
        console.log(`\nComments (${comments.length}):`);
        for (const cm of comments) {
          let text = cm.commentText || '';
          try { text = adfToText(JSON.parse(text)); } catch { /* plain text */ }
          console.log(`  --- ${cm.creator?.name || '?'}, ${(cm.creationDate || '').slice(0, 10)}`);
          for (const line of text.trim().split('\n')) if (line.trim()) console.log(`      ${line.trim()}`);
        }
      }
      console.log(`\nJira issues attached (${issues.length}${truncated ? '+' : ''}):`);
      for (const i of issues) console.log(`  ${issueLine(i)}`);
      if (!issues.length) console.log('  (none — tasks may reach it through their epic: check the epics above)');
    },
  },

  mine: {
    help: "what is assigned to a person — open issues and this quarter's goals they own (--user me|email, default me; --tag current|q3-26; --all to include done issues)",
    options: { user: { type: 'string' }, tag: { type: 'string' }, all: { type: 'boolean' }, limit: { type: 'string' } },
    async run(v) {
      const { jira } = client('read assignments');
      // "me" is the account of the API token — the person in JIRA_EMAIL.
      const who = v.user || 'me';
      const id = await accountId(jira, who);
      const user = await jira.get(`/rest/api/3/user?accountId=${id}`);
      const done = v.all ? '' : ' AND statusCategory != Done';
      const { issues, truncated } = await jqlSearch(jira, `assignee = "${id}"${done} ORDER BY status, priority DESC, updated DESC`, Number(v.limit || 100));
      const inSprint = new Set((await jqlSearch(jira, `assignee = "${id}"${done} AND sprint in openSprints()`, 500, 'summary')).issues.map((i) => i.key));
      const tag = quarterTag(v.tag || 'current');
      const goals = (await allGoals(jira)).filter((g) => !g.isArchived && g.owner?.accountId === id && goalTags(g).some((t) => t.toLowerCase() === tag.toLowerCase()));
      if (v.json) return printJson({ user, issues, goals });
      console.log(`${user.displayName}${user.emailAddress ? ` <${user.emailAddress}>` : ''}${who === 'me' ? ' (the account of JIRA_EMAIL)' : ''}`);
      console.log(`\n## Issues assigned${v.all ? '' : ', open'} (${issues.length}${truncated ? '+' : ''}; ${inSprint.size} in an active sprint)`);
      const byStatus = new Map();
      for (const i of issues) {
        const st = name(i.fields.status);
        if (!byStatus.has(st)) byStatus.set(st, []);
        byStatus.get(st).push(i);
      }
      for (const [st, list] of byStatus) {
        console.log(`\n### ${st} (${list.length})`);
        for (const i of list) console.log(`  ${inSprint.has(i.key) ? '*' : ' '} ${issueLine(i)}`);
      }
      if (inSprint.size) console.log('\n  * = in an active sprint');
      console.log(`\n## Goals owned, ${tag} (${goals.length})`);
      for (const g of goals) console.log(`  ${goalLine(g)}`);
      if (!goals.length) console.log('  (none)');
    },
  },

  'goal-comment': {
    help: 'add a markdown comment to a goal (--key GOAL-42, --text|--file; task keys become cards, image lines stay text; --dry-run)',
    options: { key: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' }, 'dry-run': { type: 'boolean' }, ...CHECK_OPTIONS },
    async run(v) {
      required(v, 'key');
      const text = readText(v);
      if (!text) throw new UsageError('--text or --file is required');
      checkContent(v, [{ label: 'comment', text }]);
      const { c, jira } = client(`comment on goal ${v.key}`);
      const goal = await goalByKey(jira, v.key);
      const issueUrl = await siteLinks(jira, c).forText(text);
      if (v['dry-run']) {
        dryHeader();
        console.log(`Goal: ${goalLine(goal)}\nComment that WOULD be added:\n${'-'.repeat(40)}\n${text}\n${'-'.repeat(40)}`);
        console.log('DRY RUN — nothing written to Atlassian Home.');
        return 0;
      }
      const d = await graphql(jira, 'mutation OikosGoalComment($i:TownsquareGoalsCreateCommentInput!){ goals_createComment(input:$i){ success errors{ message } comment{ url } } }', {
        i: { entityId: goal.id, commentText: JSON.stringify(markdownToAdf(text, { issueUrl })) },
      });
      const r = d?.goals_createComment;
      if (!r?.success) throw new UsageError(`comment not added: ${(r?.errors || []).map((e) => e.message).join('; ') || 'unknown error'}`);
      console.log(`Commented on ${goal.key}: ${r.comment?.url || goal.url}`);
    },
  },
});

// == description: append to it, replace one section, or replace it from raw ADF ==
// (`info --description` reads it: a write command has no read mode, so the write guard needs no
// exemption.) Append and section touch only the part they edit, so the rest of the description
// needs no lossless guard: its nodes are kept as they are. A section's old body is guarded (it is
// replaced), and so is a whole replace from raw ADF, by what it drops (identities, adfIdentities).

const emptyDoc = () => ({ type: 'doc', version: 1, content: [] });

/** `append`, `section` or `replace` (raw ADF); flags that do not go together are a usage error. */
function descriptionMode(v) {
  if (v.append && v.section !== undefined) throw new UsageError('pass --append or --section, not both');
  if (v.adf && (v.append || v.section !== undefined)) throw new UsageError('--adf replaces the whole description from a JSON document; --append and --section take markdown');
  if (v.section !== undefined && !v.section.trim()) throw new UsageError('--section needs a heading, e.g. --section "Acceptance criteria" (leading #s fix its level)');
  if (v.append) return 'append';
  if (v.section !== undefined) return 'section';
  if (v.adf) return 'replace';
  throw new UsageError(`pass --append, --section "Heading", or --adf --file doc.json (a whole replace from markdown is \`${TOOL} edit --task KEY --file …\`; \`${TOOL} info --task KEY --description\` reads it)`);
}

/** The current description of `key` (null when empty). */
const currentDescription = async (jira, key) => (await fetchIssue(jira, key, 'description')).fields?.description || null;

/** `info --description`: the editable markdown (or with --adf the raw ADF), to stdout or --out. */
async function printDescription(v) {
  const { c, jira } = client(`read the description of ${v.task}`);
  const current = await currentDescription(jira, v.task);
  let out;
  if (v.adf) out = JSON.stringify(current || emptyDoc(), null, 2);
  else {
    out = adfToEditableMarkdown(current).trim();
    const lost = lossyText(lossyNodes(current, { issueUrl: await siteLinks(jira, c).forDoc(current) }));
    if (lost) console.error(`NOTE: the description holds what markdown cannot carry: ${lost}. Edit it with \`${TOOL} description --append\` or \`--section\`, or read it with --adf.`);
  }
  if (!v.out) {
    console.log(out);
    return 0;
  }
  writeFileSync(v.out, `${out}\n`);
  console.log(`${v.task} description (${v.adf ? 'ADF' : 'markdown'}, ${out.length} characters) → ${v.out}`);
  return 0;
}

/** The raw ADF document of `text`, or a usage error saying what it is not. */
function rawDocument(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`--adf takes an ADF JSON document: ${e.message}`);
  }
  if (doc?.type !== 'doc' || !Array.isArray(doc.content)) throw new UsageError('--adf takes an ADF document: { "type": "doc", "version": 1, "content": [ … ] }');
  return doc;
}

/** What of `current` a whole replace by `next` drops: each identity (adfIdentities) `next` does not hold. */
const droppedIdentities = (current, next) => missingIdentities(adfIdentities(current), adfIdentities(next));

/**
 * The body under `heading` in `current`, or null when no heading matches; several matches are a
 * usage error naming them (replaceSection is the one that tells ambiguous from missing).
 */
function sectionOf(current, heading) {
  try {
    replaceSection(current, heading, []);
  } catch (e) {
    throw new UsageError(`${e.message} — name the level too, e.g. --section "## ${heading.replace(/^#+\s*/, '')}"`);
  }
  // Not ambiguous, so sectionBody throws only for a missing heading.
  try {
    return sectionBody(current, heading);
  } catch {
    return null;
  }
}

/** The outline of `doc`, marking the heading `edited` (its text, any case) when given. */
function outlineLines(doc, edited) {
  const title = edited?.replace(/^#+\s*/, '').trim().toLowerCase();
  const lines = outline(doc).map((h) => `  ${'#'.repeat(h.level)} ${h.text}${title && h.text.toLowerCase() === title ? '  <- replaced' : ''}`);
  return ['Resulting outline:', ...(lines.length ? lines : ['  (no headings)'])];
}

// == compact dry runs: a long text by its size, outline and diff ==
// A dry run of a text longer than COMPACT_OVER characters (edit and create descriptions, description,
// comment) prints its size, its outline and a diff against the current text — or, with nothing to
// compare against, its first lines — unless --full. --full only changes what a dry run prints: the
// write guard takes the real run to be the dry run's command without --dry-run, so the real run
// accepts --full and ignores it.

const COMPACT_OVER = 2000;
const COMPACT_HEAD = 15;
const COMPACT_DIFF = { context: 3, maxHunks: 8, maxLines: 120 };

/** Whether the dry run of `v` shows `text` compact: longer than COMPACT_OVER, and no --full. */
const compactText = (v, text) => !v.full && String(text || '').length > COMPACT_OVER;

/** The size of `text` and how to see it whole, the first line of a compact dry run. */
function sizeLine(text) {
  const { chars, lines } = textSize(text);
  return `Size: ${chars} characters, ${lines} lines — shown compact (over ${COMPACT_OVER} characters); --full prints the whole text`;
}

/** The first COMPACT_HEAD lines of `text`, then how many were left out. */
function headLines(text) {
  const lines = String(text).split('\n');
  const more = lines.length > COMPACT_HEAD ? [`  … ${lines.length - COMPACT_HEAD} more lines`] : [];
  return [`First lines:`, ...lines.slice(0, COMPACT_HEAD).map((l) => `  ${l}`), ...more];
}

/** The diff of the description of `key` from `before` to `after` (both editable markdown), or that nothing changes. */
function descriptionDiff(key, before, after) {
  const diff = unifiedDiff(before, after, { ...COMPACT_DIFF, labels: [`${key} description (current)`, `${key} description (new)`] });
  return diff.length ? diff : [`${key}: the description does not change`];
}

/** A long new text with nothing to compare against (create, comment): its size, the outline of `doc`, its first lines. */
const compactNewLines = (text, doc) => [sizeLine(text), ...outlineLines(doc), ...headLines(text)];

/**
 * A long description replacing that of each of `keys` (edit): its size and outline, then per issue
 * the diff from the current description, both sides as editable markdown.
 */
async function compactReplaceLines(jira, keys, text, doc) {
  const out = [sizeLine(text), ...outlineLines(doc)];
  const after = adfToEditableMarkdown(doc).trim();
  for (const key of keys) out.push(...descriptionDiff(key, adfToEditableMarkdown(await currentDescription(jira, key)).trim(), after));
  return out;
}

/**
 * Refuse replacing the section body `body` with the markdown `md` when the body holds what markdown
 * cannot carry, or images and cards `md` leaves out (--force overrides).
 */
async function guardSection(body, md, { heading, key, links }) {
  const part = { type: 'doc', version: 1, content: body };
  const lost = lossyText(lossyNodes(part, { issueUrl: await links.forDoc(part) }));
  if (lost) {
    throw new UsageError(`Refusing to replace section "${heading}" of ${key} from markdown — it holds what markdown cannot carry and would be lost: ${lost}. ` +
      'Pass --force to replace it anyway.');
  }
  const dropped = droppedCarried(part, await judgedMarkdown(links, md));
  if (dropped.length) {
    throw new UsageError(`Refusing to replace section "${heading}" of ${key} from markdown — the new body leaves out what the old one carries: ${dropped.join(', ')}. ` +
      `${KEEP_HINT}, or pass --force to replace it anyway.`);
  }
}

/**
 * The description `mode` makes of `current` from `text`: { doc, lines } — the document to PUT and
 * what the dry run and the write say of it. Guards and image uploads (unless `dry`) happen here.
 */
async function editedDescription(jira, links, v, { mode, text, current, dry }) {
  if (mode === 'replace') {
    const doc = rawDocument(text);
    // As markdown, so a link's target is checked too.
    checkContent(v, [{ label: 'description', text: adfToEditableMarkdown(doc) }]);
    const dropped = v.force ? [] : droppedIdentities(current, doc);
    if (dropped.length) {
      throw new UsageError(`Refusing to replace the description of ${v.task}: the new document drops what the old one holds: ${dropped.join(', ')}. ` +
        `Read the current one with \`${TOOL} info --task ${v.task} --description --adf\`, or pass --force to replace it anyway.`);
    }
    const was = adfToText(current || emptyDoc()).trim();
    return { doc, lines: [`Replacing the whole description of ${v.task} (was ${was.length} characters: ${firstLine(was)})`] };
  }
  checkContent(v, [{ label: 'section', text: v.section }, ...uploadedMarkdown('description', text)]);
  const body = mode === 'section' ? sectionOf(current, v.section) : null;
  if (body && !v.force) await guardSection(body, text, { heading: v.section, key: v.task, links });
  const { options, imageLines } = await markdownOptions(jira, links, text, { key: v.task, file: v.file, dry });
  const blocks = markdownToAdf(text, options).content;
  if (mode === 'append') {
    const title = `Appending to the description of ${v.task}:`;
    return { doc: appendBlocks(current, blocks), lines: [title], title, imageLines };
  }
  const old = body ? adfToEditableMarkdown({ type: 'doc', version: 1, content: body }).trim() : '';
  const title = body === null ? `No section "${v.section}" in the description of ${v.task} — it is appended as a new one.` : `Replacing section "${v.section}" of ${v.task}.`;
  const lines = body === null ? [title] : [`${title} Its body now:`, '-'.repeat(40), old || '(empty)', '-'.repeat(40), 'New body:'];
  return { doc: replaceSection(current, v.section, blocks), lines, title, imageLines, edited: v.section };
}

/** `description --append | --section | --adf`: read the description, edit it, PUT it back (expects 204). */
async function writeDescription(v, mode) {
  const text = readText(v);
  if (!text) throw new UsageError('--text or --file is required');
  const dry = Boolean(v['dry-run']);
  const { c, jira } = client(`change the description of ${v.task}`);
  const links = siteLinks(jira, c);
  const current = await currentDescription(jira, v.task);
  const edit = await editedDescription(jira, links, v, { mode, text, current, dry });
  if (dry) {
    dryHeader();
    console.log(`Task:   ${v.task}\nTarget: ${browse(c, v.task)}`);
    // A long text is shown by its size and the diff of the whole description; the outline follows below.
    if (mode !== 'replace' && compactText(v, text)) {
      const before = adfToEditableMarkdown(current).trim();
      console.log([edit.title, sizeLine(text), ...descriptionDiff(v.task, before, adfToEditableMarkdown(edit.doc).trim())].join('\n'));
    } else {
      console.log(edit.lines.join('\n'));
      if (mode !== 'replace') console.log(`${'-'.repeat(40)}\n${text}\n${'-'.repeat(40)}`);
    }
    if (edit.imageLines?.length) console.log(edit.imageLines.join('\n'));
    console.log(outlineLines(edit.doc, edit.edited).join('\n'));
    if (v['show-adf']) console.log(JSON.stringify(edit.doc, null, 2));
    console.log('DRY RUN — nothing written to Jira.');
    return 0;
  }
  const { status } = await jira.raw('PUT', issuePath(v.task), { fields: { description: edit.doc } });
  if (status !== 204) {
    console.error(`Jira answered HTTP ${status} to the description, not 204; check ${v.task} in Jira: ${browse(c, v.task)}`);
    return 2;
  }
  if (mode === 'section' && edit.lines[0].startsWith('No section')) console.log(edit.lines[0]);
  console.log(`Wrote the description of ${v.task} (${mode === 'section' ? `section "${v.section}"` : mode === 'append' ? 'appended' : 'replaced from ADF'}; HTTP ${status}): ${browse(c, v.task)}`);
  return 0;
}

Object.assign(commands, {
  description: {
    help: 'edit a task\'s description (read it with info --description): --append or --section "Heading" (a missing heading is appended; leading #s fix its level) with --text|--file adds or replaces only that part, markdown as comment writes it (cards, images uploaded to the task; a replaced section is refused over what markdown cannot carry, or when the new body leaves out an image or task card the old one had, unless --force); --adf --file doc.json replaces it whole, refused when the new document lacks a media id, mention account id, card URL, macro (extension type and key), status text or emoji short name the old one had anywhere in it, unless --force; --dry-run prints the resulting outline, and for a --text|--file over 2000 characters its size and the diff of the whole description instead of the text, --full the whole text (ignored by the write itself)',
    options: {
      task: { type: 'string' }, adf: { type: 'boolean' },
      append: { type: 'boolean' }, section: { type: 'string' }, text: { type: 'string' }, file: { type: 'string' },
      force: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'show-adf': { type: 'boolean' }, ...CHECK_OPTIONS,
      full: { type: 'boolean' },
    },
    async run(v) {
      required(v, 'task');
      return writeDescription(v, descriptionMode(v));
    },
  },
});

// == history: the status moves of tasks, from their changelog ==
// A read: who moved a task between which statuses and when, how long it stayed in each status, how
// often review sent it back, and how the moves split between this token's account, other people and
// apps (automation). Over a JQL selection the same, added up across the issues.

const HISTORY_FIELDS = 'summary,status,created';
const HISTORY_MAX = 50;
// The changelog entries read per issue; one more is asked for, so a longer changelog is known to be truncated.
const CHANGELOG_LIMIT = 5000;
// The return rule (returnsOf): a return from review is a move whose `from` matches REVIEW_STATUS and
// whose `to` does not and is a status the issue was in before that move, its initial status (the
// first move's `from`) included — the work went back to where it had been. `In Review → QA` (QA not
// visited before), `In Review → Approved` and `Ready for Review → In Review` are not returns.
const REVIEW_STATUS = /review/i;
const RETURN_RULE = `a move out of a status matching ${REVIEW_STATUS} to one not matching it that the issue was in before (its initial status included)`;
const ROLES = ['me', 'person', 'app'];

/** The role of a change's author: `me` (the account `me`), `app` (an app, or no author: automation), else `person`. */
function actorRole(author, me) {
  if (!author || author.accountType === 'app') return 'app';
  return me && author.accountId === me ? 'me' : 'person';
}

/** A changelog item's text value (`fromString`, `toString`), '' when it has none. */
const itemText = (item, key) => (Object.hasOwn(item, key) && typeof item[key] === 'string' ? item[key] : '');

/** The status moves in `histories` (changelog entries), oldest first: { at, from, to, actor, role }. */
function statusMoves(histories, me) {
  const moves = [];
  for (const h of histories) {
    for (const item of h.items || []) {
      if ((item.fieldId || item.field) !== 'status') continue;
      moves.push({ at: h.created, from: itemText(item, 'fromString'), to: itemText(item, 'toString'), actor: name(h.author, 'automation'), role: actorRole(h.author, me) });
    }
  }
  return moves.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * The number of returns from review among `moves` (oldest first), by the return rule: a move whose
 * `from` matches REVIEW_STATUS and whose `to` does not and is a status the issue was in before that
 * move — every earlier `from` and `to`, so its initial status too.
 */
function returnsOf(moves) {
  const visited = new Set();
  let returns = 0;
  for (const move of moves) {
    visited.add(move.from);
    if (move.to && REVIEW_STATUS.test(move.from) && !REVIEW_STATUS.test(move.to) && visited.has(move.to)) returns += 1;
    visited.add(move.to);
  }
  return returns;
}

/**
 * What the `moves` of an issue created at `created` and now in `status` add up to: `time` — ms per
 * status, from the creation to the first move, between moves, and in the current status (`open`) up
 * to `now` —, the `returns` from review (returnsOf), and the moves `byRole`. From a `truncated`
 * changelog the time is partial: the moves after the last one read are missing, so the interval
 * after it is credited to no status and `open` is null.
 */
function historyTotals(moves, { created, status, truncated = false, now = Date.now() }) {
  const time = {};
  const add = (state, ms) => { if (state && Number.isFinite(ms)) time[state] = (time[state] || 0) + Math.max(0, ms); };
  let open = moves.length ? moves[0].from : status;
  let since = Date.parse(created);
  for (const move of moves) {
    add(open, Date.parse(move.at) - since);
    open = move.to;
    since = Date.parse(move.at);
  }
  if (!truncated) add(open, now - since);
  const byRole = Object.fromEntries(ROLES.map((role) => [role, moves.filter((m) => m.role === role).length]));
  return { time, open: truncated ? null : open, returns: returnsOf(moves), byRole };
}

/** `ms` as a short duration: 3d 4h, 5h 20m, 12m. */
function duration(ms) {
  const minutes = Math.round(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

const roleText = (byRole) => ROLES.map((role) => `${role} ${byRole[role]}`).join(', ');
const timeText = ({ time, open }) => Object.entries(time).map(([state, ms]) => `${state} ${duration(ms)}${state === open ? ' (now)' : ''}`).join(' · ') || '(none)';
const moveTime = (at) => String(at || '?').slice(0, 16).replace('T', ' ');

/** What a history read from a truncated changelog lacks, said once per issue. */
const TRUNCATED_NOTE = `the changelog has more than ${CHANGELOG_LIMIT} entries and only the first ${CHANGELOG_LIMIT} were read: later moves are missing, the time in status is partial (the interval after the last move read is credited to no status) and the returns may be undercounted`;

/** The lines of one issue's history: every move, then its time in status, returns and moves by role. */
function historyLines(h) {
  const moves = h.moves.map((m) => `  ${moveTime(m.at)}  ${m.from || '?'} → ${m.to || '?'}  ${m.actor} (${m.role})`);
  const none = h.truncated ? '  (no status change in the changelog entries read)' : `  (no status change in the changelog — in ${h.status} since it was created)`;
  return [`${h.key} · ${h.summary} [${h.status}]`,
    ...(moves.length ? ['Transitions:', ...moves] : [none]),
    ...(h.truncated ? [`TRUNCATED: ${TRUNCATED_NOTE}.`] : []),
    `Time in status${h.truncated ? ' (partial)' : ''}: ${timeText(h.totals)}`,
    `Returns from review: ${h.totals.returns}`,
    `Moves by role: ${roleText(h.totals.byRole)}`];
}

const median = (sorted) => (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);

/** The totals across `histories`: per status the issues that were in it and the median and mean time, the returns, the moves by role. */
function historyAggregate(histories) {
  const spans = new Map();
  for (const h of histories) for (const [state, ms] of Object.entries(h.totals.time)) spans.set(state, [...(spans.get(state) || []), ms]);
  const statuses = {};
  for (const [state, list] of spans) {
    const sorted = [...list].sort((a, b) => a - b);
    statuses[state] = { issues: sorted.length, median: median(sorted), mean: sorted.reduce((a, b) => a + b, 0) / sorted.length };
  }
  const byRole = Object.fromEntries(ROLES.map((role) => [role, histories.reduce((n, h) => n + h.totals.byRole[role], 0)]));
  return { issues: histories.length, statuses, returns: histories.reduce((n, h) => n + h.totals.returns, 0), returned: histories.filter((h) => h.totals.returns).length, byRole,
    truncated: histories.filter((h) => h.truncated).length };
}

/** The lines of a selection: the block across the issues, then one line per issue. */
function bulkHistoryLines(histories, aggregate, more) {
  const width = Math.max(0, ...Object.keys(aggregate.statuses).map((s) => s.length));
  const out = [`## ${histories.length} issue${histories.length === 1 ? '' : 's'}${more ? ` (the first ${histories.length}; more match — raise --max)` : ''}`,
    'Time in status, median / mean over the issues that were in it (the current status counted up to now):',
    ...Object.entries(aggregate.statuses).map(([state, s]) => `  ${state.padEnd(width)}  ${duration(s.median)} / ${duration(s.mean)}  (${s.issues} issue${s.issues === 1 ? '' : 's'})`),
    `Returns from review: ${aggregate.returns}${aggregate.returns ? ` (in ${aggregate.returned} issue${aggregate.returned === 1 ? '' : 's'})` : ''}`,
    `Moves by role: ${roleText(aggregate.byRole)}`,
    ...(aggregate.truncated ? [`TRUNCATED in ${aggregate.truncated} issue${aggregate.truncated === 1 ? '' : 's'} (marked below): ${TRUNCATED_NOTE}.`] : []),
    '', '## Per issue'];
  for (const h of histories) {
    out.push(`  ${h.key} [${h.status}] · ${h.moves.length} move${h.moves.length === 1 ? '' : 's'} (${roleText(h.totals.byRole)}) · returns ${h.totals.returns} · ${timeText(h.totals)}${h.truncated ? ' · TRUNCATED, time partial' : ''}`);
  }
  return out;
}

/** The issues `history` reads: --task KEY[,KEY…] each by its key, or the first --max of --jql; `more` when the JQL selects more. */
async function historyIssues(jira, v) {
  if (Boolean(v.task) === Boolean(v.jql)) throw new UsageError('pass --task KEY or --jql "…", one of them');
  if (v.max !== undefined && !v.jql) throw new UsageError('--max caps a --jql selection');
  if (v.raw && !v.json) throw new UsageError('--raw adds the raw changelog to --json: pass both');
  if (v.task) return { issues: await Promise.all(splitList(v.task).map((key) => fetchIssue(jira, key, HISTORY_FIELDS))), more: false };
  const max = Number(v.max ?? HISTORY_MAX);
  if (!Number.isInteger(max) || max < 1) throw new UsageError(`--max must be a whole number of issues, got '${v.max}'`);
  const { issues, truncated } = await jqlSearch(jira, v.jql, max, HISTORY_FIELDS);
  return { issues, more: truncated };
}

/**
 * `history`: each issue's changelog read (at most CHANGELOG_LIMIT entries; one more read says it is
 * `truncated`), its moves and totals printed — one issue in full, a selection as one block and a
 * line each. --json prints { issues: [{ key, summary, status, created, truncated, moves, totals }],
 * aggregate }; --raw adds each issue's raw `changelog`.
 */
async function printHistory(v) {
  const { jira } = client('read the history');
  const { issues, more } = await historyIssues(jira, v);
  const me = (await jira.get('/rest/api/3/myself')).accountId;
  const histories = [];
  for (const issue of issues) {
    const f = issue.fields || {};
    const read = await agilePaged(jira, `${issuePath(issue.key)}/changelog`, 'values', CHANGELOG_LIMIT + 1);
    const truncated = read.length > CHANGELOG_LIMIT;
    const changelog = read.slice(0, CHANGELOG_LIMIT);
    const moves = statusMoves(changelog, me);
    histories.push({ key: issue.key, summary: f.summary || '', status: name(f.status, '?'), created: f.created || null, truncated, moves,
      totals: historyTotals(moves, { created: f.created, status: name(f.status), truncated }), ...(v.raw ? { changelog } : {}) });
  }
  const aggregate = historyAggregate(histories);
  if (v.json) return printJson({ issues: histories, aggregate });
  const bulk = Boolean(v.jql) || histories.length > 1;
  console.log((bulk ? bulkHistoryLines(histories, aggregate, more) : historyLines(histories[0])).join('\n'));
  return 0;
}

Object.assign(commands, {
  history: {
    help: `status history (--task KEY, or --jql "…" with --max N default ${HISTORY_MAX}): each move with when, from → to, who and their role (me: this token's account; app: an app or automation; person), time in each status (the current one up to now), returns from review (the return rule: ${RETURN_RULE}), moves by role; a --jql selection prints one block across its issues (median / mean time per status, returns, moves by role) and one line per issue; a changelog over ${CHANGELOG_LIMIT} entries is read up to that and said TRUNCATED, its time in status partial (the interval after the last move read credited to no status); --json prints the moves, totals and aggregate, --raw adds each raw changelog`,
    options: { task: { type: 'string' }, jql: { type: 'string' }, max: { type: 'string' }, raw: { type: 'boolean' } },
    run: printHistory,
  },
});

// == project setup: task-tracking.jira.projects.<KEY> in oikos.yaml (ADR 0001 D05, D07) ==
// Both commands write only the installation's oikos.yaml, through the write guard like any write.

const TASK_NUMBERS_LIMIT = 500;

/** A project key as given (`proj`) upper-cased, or a usage error. */
function projectKeyArg(key, usage) {
  if (!key || !/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new UsageError(`a project key like PROJ is required: ${usage}`);
  return key.toUpperCase();
}

/** The --number-pattern values (D11), each a literal template with `{n}` once beside other text. */
function numberPatternArgs(given = []) {
  return given.map((pattern) => {
    const problem = numberPatternProblem(pattern);
    if (problem) throw new UsageError(`--number-pattern '${pattern}' ${problem} (e.g. 'FIX[{n}]')`);
    return pattern.trim();
  });
}

/** The --epic-role values (D09) as { role: KEY }: `role=KEY-n`, the role in lower case, each role once. */
function epicRoleArgs(given = []) {
  const roles = {};
  for (const pair of given) {
    const m = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*([A-Za-z][A-Za-z0-9_]*-\d+)\s*$/.exec(pair);
    if (!m) throw new UsageError(`--epic-role '${pair}' is not <role>=<KEY-n> (e.g. fixes=PROJ-10)`);
    const role = m[1].toLowerCase();
    if (roles[role] && roles[role] !== m[2].toUpperCase()) throw new UsageError(`--epic-role ${role} is given twice, for ${roles[role]} and ${m[2].toUpperCase()}`);
    roles[role] = m[2].toUpperCase();
  }
  return roles;
}

/** The --person-only and --policy-source values (ADR 0004 D01) as a policy change, or undefined when neither is given. */
function policyArgs(statuses = [], source = undefined) {
  if (!statuses.length && source === undefined) return undefined;
  const personOnly = statuses.map((status) => {
    const text = String(status).trim();
    if (!text || text === ANY) throw new UsageError(`--person-only '${status}' is not a status name (e.g. Review); name each person-only status`);
    return text;
  });
  if (source !== undefined && !String(source).trim()) throw new UsageError('--policy-source is empty: give the knowledge-base page the policy comes from');
  return { person_only: personOnly, ...(source !== undefined ? { source: String(source).trim() } : {}) };
}

/** The installation's oikos.yaml: its path and text ('' when it does not exist yet). */
function installationConfig() {
  const file = configFile();
  return { file, text: existsSync(file) ? readFileSync(file, 'utf8') : '' };
}

/** The lines that say what an edit adds, keeps and replaces. */
function editLines(edit) {
  const out = [];
  for (const list of [...PROJECT_LISTS, ...PROJECT_MAPS]) {
    if (edit.added[list].length) out.push(`  ${list} + ${edit.added[list].join(', ')}`);
    if (edit.present[list].length) out.push(`  ${list}: already there — ${edit.present[list].join(', ')}`);
  }
  if (edit.added[PROJECT_POLICY]?.length) out.push(`  ${PROJECT_POLICY}.person_only + ${edit.added[PROJECT_POLICY].join(', ')}`);
  if (edit.present[PROJECT_POLICY]?.length) out.push(`  ${PROJECT_POLICY}.person_only: already there — ${edit.present[PROJECT_POLICY].join(', ')}`);
  for (const field of edit.replaced) out.push(`  ${field}: ${field.split('.').reduce((at, k) => at?.[k], edit.before) ? 'replaced' : 'set'}`);
  return out;
}

/** Write an edit to `file`, or show it under --dry-run. */
function writeEdit(edit, file, dry) {
  const at = `${PROJECTS_PATH}.${edit.key}`;
  if (dry) {
    console.log([`Would change ${at} in ${INSTALL_FILE}:`, ...editLines(edit), 'The block after the change:',
      trackerProjectText(edit.text, 'jira', edit.key), `DRY RUN — nothing written to ${INSTALL_FILE}.`].join('\n'));
    return 0;
  }
  writeFileAtomic(edit.text, file);
  console.log([`Wrote ${at} in ${INSTALL_FILE}:`, ...editLines(edit)].join('\n'));
  return 0;
}

/** The project's workflow statuses, each once, in the order Jira lists them per issue type. */
async function workflowStatuses(jira, key) {
  const types = await jira.get(`/rest/api/3/project/${encodeURIComponent(key)}/statuses`);
  const seen = new Map();
  for (const type of Array.isArray(types) ? types : []) {
    for (const status of type.statuses || []) if (status.name && !seen.has(status.name.toLowerCase())) seen.set(status.name.toLowerCase(), status.name);
  }
  return [...seen.values()];
}

/** The numbers of the project's most recent tasks. */
async function taskNumbers(jira, key) {
  const { issues } = await jqlSearch(jira, `project = "${key}" ORDER BY created DESC`, TASK_NUMBERS_LIMIT, 'summary');
  return issues.map((i) => Number(String(i.key).split('-').pop())).filter(Number.isInteger);
}

const failure = (e) => {
  if (!(e instanceof HttpError || e instanceof ChannelError || e instanceof UsageError)) throw e;
  return String(e.message).split('\n')[0];
};

/**
 * The line saying that the project's first own `number_patterns` replace `defaults.number_patterns`
 * (D11: a project's list replaces the defaults, it does not add to them); none when the defaults have
 * no pattern or the project had its own list already.
 */
function replacedDefaults(edit, part, key) {
  const defaults = numberPatterns(part, null);
  if (!edit.added.number_patterns?.length || Array.isArray(edit.before?.number_patterns) || !defaults.length) return [];
  return [`  number_patterns for ${key} replace defaults.number_patterns (${defaults.join(', ')})`];
}

/** The dry run of project-init: the report of steps 1–4 and the block step 5 would write. */
async function projectInitReport(key, v, edit, part) {
  const project = edit.before;
  const pool = project?.repos || [];
  const extended = project?.extended_repos || [];
  const configured = project?.key_aliases || [];
  let jira = null;
  let jiraError = null;
  try {
    ({ jira } = client(`read the workflow and tasks of ${key}`));
  } catch (e) {
    jiraError = failure(e);
  }
  let statuses = [];
  let workflowError = jiraError;
  if (jira) {
    try { statuses = await workflowStatuses(jira, key); } catch (e) { workflowError = failure(e); }
  }
  let numbers = [];
  let numbersError = jiraError;
  if (jira) {
    try { numbers = await taskNumbers(jira, key); } catch (e) { numbersError = failure(e); }
  }

  const months = Number(v.months ?? DEFAULT_MONTHS);
  const since = monthsAgo(months);
  const patterns = v.pattern || [];
  const known = edit.after.repos || [];
  // Default owners come from both lists (D08); the alias scan reads the pool's repositories only.
  const owners = searchOwners(v.owner || [], [...known, ...(edit.after.extended_repos || [])]);
  const prefixes = [key, ...new Set([...configured, ...(v.alias || [])].map((a) => String(a).toUpperCase()))];
  const found = owners.length || known.length
    ? await searchProjectSetup({ owners, prefixes, patterns, pool: known, since, hosts: codeHosts('jira') })
    : { hits: [], matched: [], names: [], notes: { pool: [], aliases: [] } };

  const out = ['--- DRY RUN (requested --dry-run) ---', `Setup of ${key}: ${PROJECTS_PATH}.${key} in ${INSTALL_FILE}`, ''];
  out.push(...workflowLines(statuses, workflowCoverage(statuses, part, key), { configPath: 'task-tracking.jira', projectKey: key, error: workflowError }), '');
  // The policy as it would hold with the proposed block (ADR 0004 D02): a new person-only status shows its conflicts now.
  const proposed = edit.changed && Boolean(edit.added[PROJECT_POLICY]?.length || edit.replaced.includes(`${PROJECT_POLICY}.source`));
  const planned = edit.changed ? { ...(part || {}), projects: { ...(part?.projects || {}), [key]: edit.after } } : part;
  const workflow = !workflowError && statuses.length > 0;
  out.push(...policyLines(policyConflicts(planned, key, workflow ? statuses : null), effectivePolicy(planned, key), {
    configPath: 'task-tracking.jira', projectKey: key, workflow, proposed,
  }), '');
  const aliasError = numbersError ? `the task numbers of ${key} were not read: ${numbersError}` : null;
  out.push(...aliasLines(aliasCandidates(found.names, key, numbers), { configured, error: aliasError, notes: found.notes.aliases }), '');
  const skipped = owners.length ? null : `No owner to search: pass --owner github:<owner> (the pool and the extended set of ${key} are empty). Candidates by activity and pattern were not searched.`;
  out.push(...poolLines(poolCandidates(found.hits, found.matched, pool, extended), {
    pool, extended, owners, since, patterns, notes: found.notes.pool, skipped, tool: TOOL, projectKey: key,
  }), '');
  out.push(...proseLines(project), '');
  out.push('## Proposed block');
  if (edit.changed) out.push(...editLines(edit), ...replacedDefaults(edit, part, key), trackerProjectText(edit.text, 'jira', key));
  else out.push(`  nothing to write — ${project ? `the flags change nothing in ${PROJECTS_PATH}.${key}` : 'no --alias, --repo, --extended-repo, --results, --epics, --number-pattern, --epic-role, --epic-project, --person-only or --policy-source given'}`);
  out.push('', '## What to do',
    '- Ask the user in this chat which aliases and repositories to keep, and where the results of this project\'s tasks are.',
    '  A repository where the project\'s pull requests are possible but rare goes into the extended set (--extended-repo),',
    '  searched only when the user asks; the pool (--repo) is searched on every confirm move.',
    '- Optional: how a bare task number is written (--number-pattern \'FIX[{n}]\'; the repositories it holds for: repos add --numbers),',
    '  the general epics by role (--epic-role fixes=KEY-n) and the projects whose open epics are candidates too (--epic-project KEY).',
    '- Run this command again with the chosen --alias, --repo, --extended-repo, --results, --epics, --number-pattern, --epic-role,',
    '  --epic-project and --dry-run (and repos add --numbers for the number repositories); show its proposed block;',
    '  on the user\'s yes run that command unchanged without --dry-run (a standalone command: no ;, && or | around it).',
    `- Patterns (--pattern) only help this search: the pool keeps the names the user picks.`,
    '- A conflict under ## Policy is fixed in the rules (by hand, as the fix says); a person-only status the organization\'s page names',
    '  is recorded with --person-only STATUS and --policy-source URL (scenarios/policy-check.md).',
    `DRY RUN — nothing written to ${INSTALL_FILE}.`);
  return out;
}

Object.assign(commands, {
  repos: {
    help: `add repositories to a project's pool: repos add <KEY> <host:owner/name>... (--dry-run); with --extended to its extended set, searched only on request; with --numbers to its number_repos, where a bare task number written as one of its number_patterns is the project's (the repository already in the pool or the extended set, its numbers no other project's); writes only ${PROJECTS_PATH}.<KEY>.repos (or .extended_repos, .number_repos) in oikos.yaml`,
    options: { 'dry-run': { type: 'boolean' }, extended: { type: 'boolean' }, numbers: { type: 'boolean' } },
    async run(v, positionals) {
      const usage = `${TOOL} repos add [--extended] <KEY> <host:owner/name>... [--dry-run], or repos add --numbers <KEY> <host:owner/name>... [--dry-run]`;
      if (v.extended && v.numbers) throw new UsageError(`--extended and --numbers are two lists: add the repository to the extended set first, then to number_repos — ${usage}`);
      const list = v.numbers ? 'number_repos' : v.extended ? 'extended_repos' : 'repos';
      const [verb, keyArg, ...given] = positionals;
      if (verb !== 'add') throw new UsageError(`usage: ${usage}`);
      const key = projectKeyArg(keyArg, usage);
      if (!given.length) throw new UsageError(`at least one repository is required: ${usage}`);
      const repos = poolRepoArgs(given, TOOL);
      const { file, text } = installationConfig();
      const edit = editTrackerProject(text, 'jira', key, { [list]: repos });
      if (!edit.changed) {
        console.log(`Nothing to add: ${edit.present[list].join(', ')} already in ${PROJECTS_PATH}.${edit.key}.${list}`);
        return 0;
      }
      if (v['dry-run']) console.log('--- DRY RUN (requested --dry-run) ---');
      return writeEdit(edit, file, Boolean(v['dry-run']));
    },
  },

  'project-init': {
    help: `set a project up in ${PROJECTS_PATH}.<KEY> of oikos.yaml: project-init <KEY> (--alias X, --repo host:owner/name, --extended-repo host:owner/name, --results, --epics, --number-pattern 'FIX[{n}]', --epic-role role=KEY-n, --epic-project KEY, --person-only STATUS, --policy-source URL, --pattern GLOB, --owner host:owner, --months N default ${DEFAULT_MONTHS}, --dry-run); the dry run reports the workflow against the rules, the policy's conflicts with them, alias and pool candidates, and the block it would write`,
    options: {
      alias: { type: 'string', multiple: true }, repo: { type: 'string', multiple: true }, 'extended-repo': { type: 'string', multiple: true },
      results: { type: 'string' }, epics: { type: 'string' },
      'number-pattern': { type: 'string', multiple: true }, 'epic-role': { type: 'string', multiple: true }, 'epic-project': { type: 'string', multiple: true },
      pattern: { type: 'string', multiple: true }, owner: { type: 'string', multiple: true }, months: { type: 'string' },
      'person-only': { type: 'string', multiple: true }, 'policy-source': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    async run(v, positionals) {
      const usage = `${TOOL} project-init <KEY> [--alias X]... [--repo host:owner/name]... [--extended-repo host:owner/name]... [--results "…"] [--epics "…"] `
        + '[--number-pattern \'FIX[{n}]\']... [--epic-role role=KEY-n]... [--epic-project KEY]... [--person-only STATUS]... [--policy-source URL] '
        + '[--pattern GLOB]... [--owner host:owner]... [--months N] [--dry-run]';
      if (positionals.length !== 1) throw new UsageError(`usage: ${usage}`);
      const key = projectKeyArg(positionals[0], usage);
      if (v.months !== undefined && !(Number.isInteger(Number(v.months)) && Number(v.months) > 0)) throw new UsageError(`--months must be a whole number of months, got '${v.months}'`);
      const aliases = (v.alias || []).map((a) => {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(a)) throw new UsageError(`--alias '${a}' is not a key prefix like PJ`);
        return a.toUpperCase();
      });
      const repos = poolRepoArgs(v.repo || [], TOOL);
      const extendedRepos = poolRepoArgs(v['extended-repo'] || [], TOOL);
      const change = {
        key_aliases: aliases, repos, extended_repos: extendedRepos, results: v.results, epics: v.epics,
        number_patterns: numberPatternArgs(v['number-pattern']), epic_roles: epicRoleArgs(v['epic-role']),
        epic_projects: (v['epic-project'] || []).map((p) => projectKeyArg(p, '--epic-project KEY')),
        policy: policyArgs(v['person-only'], v['policy-source']),
      };
      const part = config()['task-tracking']?.jira;
      const { file, text } = installationConfig();
      const edit = editTrackerProject(text, 'jira', key, change);
      if (v['dry-run']) {
        console.log((await projectInitReport(edit.key, v, edit, part)).join('\n'));
        return 0;
      }
      if (!edit.changed) {
        console.log(`Nothing to write: ${PROJECTS_PATH}.${edit.key} already has what the flags give.`);
        return 0;
      }
      return writeEdit(edit, file, false);
    },
  },
});

runCli('jira', commands, { connector: 'jira' });
