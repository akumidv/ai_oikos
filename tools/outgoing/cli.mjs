#!/usr/bin/env node
// The content check of text going to the organization on a route no oikos tool writes — the
// messenger, a mail draft, a form in the shared browser, a vault note to be shared (ADR 0003 D05):
// `check --text | --file` reports what the write tools would flag, by the same rules
// (common/outgoing.mjs). Read-only: it sends nothing, so it has no --dry-run.
import { readFileSync } from 'node:fs';
import { runCli, printJson, UsageError } from '../common/cli.mjs';
import { checkLines, checkOutgoing, maskSecret, outgoingRules } from '../common/outgoing.mjs';

const commands = {
  check: {
    help: 'check a draft for what must not reach the organization — non-English text, the assistant, a local path, a secret, the installation\'s own terms (--text TEXT | --file PATH; the rules of .local/outgoing.yaml apply); exit 3 with `flagged: content check:` when something is found, 0 when clean',
    options: { text: { type: 'string' }, file: { type: 'string' } },
    run(v) {
      if (Boolean(v.text) === Boolean(v.file)) throw new UsageError('one of --text or --file is required');
      const text = v.file ? readFileSync(v.file, 'utf8') : v.text;
      const check = checkOutgoing([{ label: v.file ? 'file' : 'text', text }], outgoingRules());
      if (v.json) {
        printJson({
          findings: check.findings.map(({ finding: f }) => ({
            line: f.line, category: f.category, match: f.category === 'secret' ? maskSecret(f.match) : f.match,
          })),
          allowed: check.allowed,
        });
      } else {
        const lines = checkLines(check);
        console.log(check.findings.length ? `CHECK outgoing text: ${check.findings.length} finding(s)` : 'CHECK outgoing text: clean');
        if (lines.length) console.log(lines.join('\n'));
      }
      if (!check.findings.length) return 0;
      const categories = [...new Set(check.findings.map(({ finding }) => finding.category))].join(', ');
      console.error(`flagged: content check: ${categories} — fix the draft before it goes out.`);
      return 3;
    },
  },
};

runCli('outgoing', commands);
