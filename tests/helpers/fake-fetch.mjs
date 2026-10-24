// A preload (`node --import`) that answers fetch from canned routes, for connector tests without a
// network. OIKOS_FAKE_FETCH names a JSON file `{ "routes": [ … ] }`; each route has
//   method   default GET (POST for a `graphql` route)
//   url      the exact URL, or
//   match    a regular expression source tested against the URL
//   graphql  a substring of the GraphQL query (e.g. the operation name): matches a POST to a URL
//            ending in /graphql whose JSON `query` contains it
//   variables optional with `graphql`: an object whose every entry the call's variables equal
//   status, headers, body   the answer (body: JSON or a string)
//   times    optional: the route answers this many calls, then no longer matches
// The first matching route wins. Every call is appended to OIKOS_FAKE_FETCH_LOG as one JSON line
// { method, url, body } — never a header, so no credential. An unmatched call is reported as
// `NETWORK ATTEMPT <method> <url>` on stderr and refused, as the no-fetch preload does.
import { appendFileSync, readFileSync } from 'node:fs';

const routes = process.env.OIKOS_FAKE_FETCH ? JSON.parse(readFileSync(process.env.OIKOS_FAKE_FETCH, 'utf8')).routes : [];
const answered = routes.map(() => 0);

const parsed = (body) => {
  if (body === undefined || body === null) return null;
  try { return JSON.parse(String(body)); } catch { return String(body); }
};

function matches(route, method, url, body) {
  if (route.graphql !== undefined) {
    if (method !== (route.method || 'POST').toUpperCase() || !/\/graphql$/.test(url)) return false;
    if (route.url !== undefined && route.url !== url) return false;
    if (route.variables && !Object.entries(route.variables).every(([k, v]) => body?.variables?.[k] === v)) return false;
    return typeof body?.query === 'string' && body.query.includes(route.graphql);
  }
  if (method !== (route.method || 'GET').toUpperCase()) return false;
  if (route.url !== undefined) return route.url === url;
  if (route.match !== undefined) return new RegExp(route.match).test(url);
  return false;
}

function answer(route) {
  const status = route.status ?? 200;
  const empty = route.body === undefined || status === 204 || status === 304;
  const text = empty ? null : typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
  const type = typeof route.body === 'string' ? 'text/plain' : 'application/json';
  return new Response(text, { status, headers: { 'content-type': type, ...route.headers } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input);
  const method = (init.method || 'GET').toUpperCase();
  const body = parsed(init.body);
  if (process.env.OIKOS_FAKE_FETCH_LOG) appendFileSync(process.env.OIKOS_FAKE_FETCH_LOG, `${JSON.stringify({ method, url, body })}\n`);
  const i = routes.findIndex((r, n) => (r.times === undefined || answered[n] < r.times) && matches(r, method, url, body));
  if (i < 0) {
    process.stderr.write(`NETWORK ATTEMPT ${method} ${url}\n`);
    throw new Error('the network is off in tests');
  }
  answered[i] += 1;
  return answer(routes[i]);
};
