/**
 * Redaction for session transcripts.
 *
 * This is the load-bearing part of moving a session between machines. A Claude
 * Code transcript contains every file the agent read, every command it ran and
 * every command's output — so `.env` files, private keys and tokens end up in
 * there as a matter of routine. A scan of 574 real transcripts on one developer's
 * machine found AWS-shaped keys in 4 files, private-key headers in 2, and 85,794
 * absolute home paths.
 *
 * The default is to **scan, not redact**. Moving your own session to your own
 * machine over an encrypted one-shot channel does not increase exposure — the
 * secret is already on both ends — whereas redacting is destructive and
 * unrecoverable: the placeholder is all the bundle carries, so the resumed
 * conversation reads mangled text forever.
 *
 * So you are always told what is in there, and `--redact` is there for the case
 * that actually warrants it: a bundle written to a file, which can travel
 * anywhere, or a session going to someone who is not you.
 *
 * Reports count findings and mask values. Printing the secret to prove it was
 * found would defeat the point.
 */

/**
 * Ordered most-specific first, because the first match wins and a generic rule
 * would otherwise swallow a precise one.
 */
export const RULES = [
  { id: 'anthropic-key', label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', label: 'OpenAI-style key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g },
  { id: 'github-token', label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { id: 'gitlab-token', label: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { id: 'slack-token', label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'aws-key-id', label: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'google-key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe-key', label: 'Stripe key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { id: 'private-key', label: 'Private key block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { id: 'jwt', label: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'bearer', label: 'Bearer token', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { id: 'url-credentials', label: 'Credentials in a URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi },
  {
    id: 'assigned-secret',
    label: 'Assigned secret',
    // No leading `\b`: it cannot match after an underscore, so `DB_PASSWORD=…`
    // and `MY_API_KEY=…` were slipping through entirely.
    re: /(?<=(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
    // A key name is not enough. `password: string` in an interface and
    // `token=token` in a function signature both match the name; only the value
    // can tell them apart. See `looksLikeCredential`.
    guard: (value) => looksLikeCredential(value),
  },
];

/**
 * Identifiers a programmer writes after `password:` or `token=`, which a
 * person would never choose as a credential. Long camelCase names land here
 * too — `accessTokenValue` is a variable, not a secret.
 */
const CODE_WORDS = [
  // Type names and keywords.
  /^(?:string|number|boolean|object|any|unknown|never|void|bytes|str|int|bool|float|char|text|uuid|nullable|optional|required|readonly)$/i,
  // camelCase: accessToken, clientSecret, apiKey.
  /^[a-z]+[A-Z][A-Za-z0-9]*$/,
  // snake_case and SCREAMING_SNAKE: access_token, DB_PASSWORD.
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/,
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/,
];

// Deliberately *not* a suffix rule. `hunter2secret` ends in "secret" and is a
// password; `accessToken` ends in "token" and is a variable. Shape tells them
// apart, the ending does not. The cost is that a camelCase password like
// `myDogRex2024` is missed — noted in the README rather than papered over.
const looksLikeCode = (value) => CODE_WORDS.some((re) => re.test(value));

/** Bits of information per character — real keys are high, English words are not. */
export function entropy(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Does this value look like a credential, rather than code that happens to sit
 * after the word `password`?
 *
 * Getting this wrong in the permissive direction is not a near-miss: the
 * original text is replaced by a placeholder and is unrecoverable from the
 * bundle, so the resumed conversation reads mangled source. The earlier rule
 * shredded `password: string`, `token=token` and `secret: config.clientSecret`.
 */
export function looksLikeCredential(value) {
  if (typeof value !== 'string' || value.length < 8) return false;

  // `config.clientSecret`, `response.data.accessToken`
  if (/^[\w$]+(?:\.[\w$]+)+$/.test(value)) return false;

  // Identifier-shaped values are the hard case: `string` and `token` are code,
  // but so is `hunter2secret` by shape. Length and vocabulary separate them —
  // nobody declares a variable called `hunter2secret`, and nobody uses `string`
  // as a password.
  if (/^[A-Za-z_$][\w$]*$/.test(value)) {
    if (value.length < 12) return false;
    // A random key can happen to look like camelCase (`aB3xK9zQ1mP7`), so shape
    // alone is not enough at this length — genuinely random strings carry more
    // information per character than anything a person names a variable.
    if (looksLikeCode(value) && entropy(value) < 3.4) return false;
  }
  // `os.getenv(`, `process.env[`, template literals — this is code.
  if (/[()[\]{}<>]/.test(value)) return false;
  if (/^(?:true|false|null|undefined|none|nil|self|this)$/i.test(value)) return false;
  // `$MY_KEY`, `${SECRET}` — a reference to a secret, not the secret.
  if (/^[$%]/.test(value)) return false;

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  if (classes < 2) return false;

  return entropy(value) >= 2.8;
}

/**
 * Placeholder-looking values are documentation, not credentials.
 *
 * Note `test` is deliberately absent: `password: testpassword123` is a real
 * password on somebody's staging box, and whitelisting it shipped it in clear.
 */
const LOOKS_FAKE = /^(?:x{4,}|y{4,}|\.{3,}|<.*>|\$\{.*\}|(?:your|my|the)[_-]|example|placeholder|redacted|changeme|dummy|fake|sample|todo|null|none|undefined)/i;
const FAKE_ANYWHERE = /EXAMPLE|PLACEHOLDER|REDACTED|YOUR_|_HERE\b/i;

const isProbablyFake = (value) => LOOKS_FAKE.test(value) || FAKE_ANYWHERE.test(value);

/** Stable per-value so the same secret reads as the same token throughout. */
function placeholderFor(rule, value, seen) {
  if (!seen.has(value)) seen.set(value, seen.size + 1);
  return `‹${rule.id}:${seen.get(value)}›`;
}

/**
 * Replace every home directory with a portable marker.
 *
 * Not a secret, but it leaks the username, and 85,794 stale absolute paths make
 * an imported transcript wrong on the receiving machine anyway. The importer
 * substitutes its own home back in.
 */
export function portablePaths(text, home) {
  if (!home) return { text, count: 0 };
  let count = 0;

  // Two spellings, because this runs over both raw file contents and
  // JSON-serialised records. On Windows a home of `C:\Users\me` appears in JSON
  // as `C:\\Users\\me`, so matching only the raw form meant Windows exports
  // rewrote nothing and shipped the username in every path.
  const forms = [...new Set([home, JSON.stringify(home).slice(1, -1)])];

  let out = text;
  for (const form of forms) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Only at a path boundary: a home of `/Users/me` was turning `/Users/menu/x`
    // into `‹home›nu/x`, which imports as a directory nobody has.
    out = out.replace(new RegExp(`${escaped}(?=[/"'\\\\ ,;:)\\]]|$)`, 'g'), () => { count++; return '‹home›'; });
  }
  return { text: out, count };
}

/**
 * Redact secrets from a string.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string[]} [opts.allow]  rule ids to skip
 * @param {Map}      [opts.seen]   share across calls so numbering stays stable
 * @returns {{text:string, findings:Array<{id,label,fake:boolean}>}}
 */
export function redactText(text, { allow = [], seen = new Map(), context = false, scanOnly = false } = {}) {
  if (typeof text !== 'string' || !text) return { text: text ?? '', findings: [] };
  const findings = [];
  let out = text;

  for (const rule of RULES) {
    if (allow.includes(rule.id)) continue;
    out = out.replace(rule.re, (match, ...rest) => {
      // A rule may look past the match itself before deciding.
      if (rule.guard && !rule.guard(match)) return match;

      if (isProbablyFake(match)) {
        findings.push({ id: rule.id, label: rule.label, fake: true });
        return match; // documentation examples stay readable
      }

      const finding = { id: rule.id, label: rule.label, fake: false };
      if (context) {
        // Enough surrounding text to judge a hit, with the value masked so a
        // preview never becomes a way to print secrets. The window around it is
        // masked too: the same secret frequently appears twice on a line, and a
        // "context" containing it would defeat the entire point of the preview.
        const mask = `⟪${match.length} chars⟫`;
        const at = typeof rest.at(-2) === 'number' ? rest.at(-2) : text.indexOf(match);
        const scrub = (s) => s.split(match).join(mask).replace(/\s+/g, ' ');
        const before = scrub(text.slice(Math.max(0, at - 32), at));
        const after = scrub(text.slice(at + match.length, at + match.length + 24));
        finding.context = `${before}${mask}${after}`;
      }
      findings.push(finding);
      // Scanning tells you what is in the bundle without changing a byte of it.
      // Replacing is destructive and unrecoverable, so it is never the default.
      return scanOnly ? match : placeholderFor(rule, match, seen);
    });
  }
  return { text: out, findings };
}

/** Walk any JSON value, redacting every string inside it. */
export function redactValue(value, ctx) {
  if (typeof value === 'string') {
    const { text, findings } = redactText(value, ctx);
    ctx.findings.push(...findings);
    return text;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, ctx);
    return out;
  }
  return value;
}

/**
 * Redact a whole transcript.
 * @param {object[]} records  parsed .jsonl records
 */
export function redactTranscript(records, { home, allow = [], seen = new Map(), scanOnly = false, context = false } = {}) {
  // `seen` is threaded in so the transcript and the sidecars share one numbering.
  // With separate maps, two *different* secrets both render as `‹key:1›`, which
  // breaks the stability contract and misleads whoever reads the result.
  const ctx = { allow, seen, scanOnly, context, findings: [] };
  let pathCount = 0;

  const redacted = records.map((record) => {
    const clean = redactValue(record, ctx);
    if (home) {
      const asText = JSON.stringify(clean);
      const { text, count } = portablePaths(asText, home);
      pathCount += count;
      return count ? JSON.parse(text) : clean;
    }
    return clean;
  });

  // The findings themselves come back too, not just the tally. --preview needs
  // the individual hits and their surrounding text, and a summary cannot be
  // un-summarised.
  return { records: redacted, report: summarise(ctx.findings, pathCount), findings: ctx.findings };
}

/** Counts only — a report that printed the secret would defeat its own purpose. */
export function summarise(findings, pathCount = 0) {
  const byRule = new Map();
  for (const f of findings) {
    const row = byRule.get(f.id) ?? { id: f.id, label: f.label, redacted: 0, examples: 0 };
    if (f.fake) row.examples++; else row.redacted++;
    byRule.set(f.id, row);
  }
  const rows = [...byRule.values()].sort((a, b) => b.redacted - a.redacted);
  return {
    rows,
    redacted: rows.reduce((n, r) => n + r.redacted, 0),
    examplesLeft: rows.reduce((n, r) => n + r.examples, 0),
    pathsRewritten: pathCount,
    clean: rows.every((r) => r.redacted === 0),
  };
}

/** Human-readable report, safe to print anywhere. */
export function formatReport(report) {
  const lines = [];
  if (report.clean) lines.push('  no credentials found');
  for (const r of report.rows) {
    if (!r.redacted) continue;
    lines.push(`  ${String(r.redacted).padStart(4)}  ${r.label}`);
  }
  if (report.examplesLeft) {
    lines.push(`  ${String(report.examplesLeft).padStart(4)}  left as-is (look like documentation examples)`);
  }
  if (report.pathsRewritten) {
    lines.push(`  ${String(report.pathsRewritten).padStart(4)}  home paths made portable`);
  }
  return lines.join('\n');
}
