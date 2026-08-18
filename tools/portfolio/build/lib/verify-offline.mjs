/**
 * Static "no external references" verification for the two self-contained
 * targets.
 *
 * The runtime acceptance check (headless browser, zero recorded requests) is
 * the real proof; this is the cheap gate that runs on every build so a
 * regression is caught at build time rather than at test time. It reads the
 * emitted bytes — not the sources — because the emitted bytes are what ships.
 */

/** Anything that can pull a byte off the network, or reach a module loader. */
const RUNTIME_PATTERNS = [
  [/\bfetch\s*\(/, 'fetch() call'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bimportScripts\s*\(/, 'importScripts()'],
  [/\bsendBeacon\s*\(/, 'navigator.sendBeacon()'],
  [/\bnew\s+Worker\s*\(/, 'new Worker()'],
  [/\bnew\s+SharedWorker\s*\(/, 'new SharedWorker()'],
  [/\bnavigator\s*\.\s*serviceWorker\b/, 'serviceWorker registration'],
  [/\bimport\s*\(/, 'dynamic import()'],
  [/\brequire\s*\(/, 'require()'],
  [/\bprocess\s*\.\s*(env|cwd|argv)\b/, 'Node process API'],
];

/** Scheme-bearing or protocol-relative references anywhere in the bytes. */
const URL_PATTERNS = [
  [/https?:\/\//i, 'absolute http(s) URL'],
  [/\bsrc\s*=\s*["']\/\//i, 'protocol-relative src'],
  [/\bhref\s*=\s*["']\/\//i, 'protocol-relative href'],
  [/@import\b/i, 'CSS @import'],
  [/url\s*\(\s*(?!["']?data:)/i, 'CSS url() to a non-data target'],
];

/**
 * Every attribute that can make the browser fetch something. `data:` URIs and
 * pure fragments are self-contained and therefore allowed.
 */
const FETCHING_ATTRS =
  /\b(src|srcset|href|poster|action|formaction|data|manifest|ping|background)\s*=\s*["']([^"']*)["']/gi;

const ALLOWED_VALUE = /^(data:|#|$)/i;

/**
 * @param {string} label human-readable target name, used in messages
 * @param {string} text  the emitted file contents
 * @param {{ html?: boolean }} [opts]
 * @returns {string[]} one message per violation; empty means clean
 */
export function findExternalReferences(label, text, opts = {}) {
  const bad = [];
  const at = (i) => `line ${text.slice(0, i).split('\n').length}`;

  for (const [re, what] of [...RUNTIME_PATTERNS, ...URL_PATTERNS]) {
    const m = re.exec(text);
    if (m) bad.push(`${label}: ${what} at ${at(m.index)} — ${JSON.stringify(m[0].slice(0, 60))}`);
  }

  if (opts.html) {
    for (const m of text.matchAll(FETCHING_ATTRS)) {
      if (!ALLOWED_VALUE.test(m[2].trim())) {
        bad.push(`${label}: fetching attribute ${m[1]}="${m[2].slice(0, 60)}" at ${at(m.index)}`);
      }
    }
    if (/<link[^>]+rel\s*=\s*["']?stylesheet/i.test(text)) {
      bad.push(`${label}: external stylesheet <link>`);
    }
    if (/<(iframe|embed|object|audio|video|img|source|track)\b/i.test(text)) {
      bad.push(`${label}: embedded media element that could reference a remote asset`);
    }
  } else {
    // Artifact payload: must be one blob with no module graph left in it.
    for (const [re, what] of [
      [/^\s*import\s+[^(]/m, 'top-level import statement'],
      [/^\s*export\s+/m, 'top-level export statement'],
      [/\bfrom\s+["'][^."'/][^"']*["']/, 'bare module specifier'],
      [/\bmodule\s*\.\s*exports\b/, 'CommonJS module.exports'],
    ]) {
      const m = re.exec(text);
      if (m) bad.push(`${label}: ${what} at ${at(m.index)} — ${JSON.stringify(m[0].slice(0, 60))}`);
    }
  }

  return bad;
}
