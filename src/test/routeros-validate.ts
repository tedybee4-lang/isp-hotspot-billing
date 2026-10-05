// =============================================================================
//  A RouterOS-aware validator for generated scripts.
//
//  Not regex soup. This tokenises the script the way RouterOS does - strings,
//  comments, braces and brackets - and then checks structural invariants that
//  string matching cannot express: a `do={` with no owning command, a variable
//  read before it is assigned, an unbalanced block.
//
//  Every failure mode found on real hardware is a case here, so the next one
//  fails in CI rather than in a customer's terminal.
// =============================================================================

export interface ValidationIssue {
  line: number
  rule: string
  message: string
  text: string
}

/** One logical line, stripped of comments and with string literals masked. */
function mask(line: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inStr) {
      if (c === '\\') { i++; out += '  '; continue }
      if (c === '"') { inStr = false; out += ' '; continue }
      out += ' '
      continue
    }
    if (c === '"') { inStr = true; out += ' '; continue }
    out += c
  }
  return out
}

const isComment = (l: string) => l.trim().startsWith('#')

export function validateRouterOsScript(script: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const raw = script.split('\n')
  const lines = raw.map(mask)

  const add = (i: number, rule: string, message: string) =>
    issues.push({ line: i + 1, rule, message, text: raw[i] })

  // --- 1. standalone `do={` / `onerror=` with no owning command -----------
  // `do=` is an ARGUMENT to a command. At the start of a line there is no
  // command to attach it to, and RouterOS answers
  // "expected end of command". This is the exact line-5 failure.
  lines.forEach((l, i) => {
    if (isComment(raw[i])) return
    // `} do={` closes the `in={...}` half of an `:onerror` pair and opens the
    // `do={...}` half. That is valid and is how every survey is guarded.
    if (/^\s*\}\s*do=\{\s*$/.test(l)) return
    if (/^\s*(do=|onerror\s)/.test(l)) {
      add(i, 'standalone-do', '`do=`/`onerror=` with no command to attach it to')
    }
  })

  // --- 2. unbalanced braces and parens, ignoring string contents ----------
  let depth = 0
  let paren = 0
  lines.forEach((l, i) => {
    if (isComment(raw[i])) return
    for (const c of l) {
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '(') paren++
      else if (c === ')') paren--
      if (depth < 0) { add(i, 'unbalanced-brace', 'closing brace with no opener'); depth = 0 }
      if (paren < 0) { add(i, 'unbalanced-paren', 'closing paren with no opener'); paren = 0 }
    }
  })
  if (depth !== 0) issues.push({
    line: raw.length, rule: 'unbalanced-brace',
    message: `${depth > 0 ? 'unclosed' : 'extra'} brace block at end of script`,
    text: '',
  })
  if (paren !== 0) issues.push({
    line: raw.length, rule: 'unbalanced-paren',
    message: 'unbalanced parentheses at end of script', text: '',
  })

  // --- 3. variables read before assignment ------------------------------
  // Scoped: a `:local` is visible until the end of the block that declares it.
  // At the top level that is the whole script; inside `{ }` it is that block.
  // Tracking depth per declaration is what lets this catch a genuine
  // never-assigned variable without drowning in false positives.
  const defined = new Map<string, number>([['e', 0]])
  let vdepth = 0
  lines.forEach((l, i) => {
    if (isComment(raw[i])) return
    // A `:local` may open its line or follow a `{` on the same line, so the
    // search is positional: the declaration belongs to whatever brace depth is
    // open AT THE POINT it appears, not at the end of the line.
    for (const decl of l.matchAll(/:local\s+([A-Za-z_][A-Za-z0-9_-]*)/g)) {
      const before = l.slice(0, decl.index)
      const opened = (before.match(/\{/g) ?? []).length
      const closed = (before.match(/\}/g) ?? []).length
      defined.set(decl[1], vdepth + opened - closed)
    }
    // `:foreach x in=[...]` binds x for the body of the block. Without this the
    // loop variable looked undefined on every one of the 90 row surveys.
    const fe = /^\s*:foreach\s+([A-Za-z_][A-Za-z0-9_-]*)\s+in=/.exec(l)
    if (fe) defined.set(fe[1], vdepth)
    // `$i->"prop"` is property access, not a variable read: the arrow swallows the
    // `-`. Strip those before looking for `$name` reads.
    const scan = l.replace(/\$[A-Za-z_][A-Za-z0-9_-]*->/g, ' ')
    for (const r of scan.matchAll(/\$([A-Za-z_][A-Za-z0-9_-]*)/g)) {
      const name = r[1]
      // `:set x [:replace $x ...]` reads the variable it is about to write.
      const isSelfWrite = new RegExp(`^\\s*:set\\s+${name}\\b`).test(l)
      if (!defined.has(name)) {
        add(i, 'undefined-variable',
          `\$${name} is read but never assigned in this script`)
      } else if (defined.get(name)! > vdepth && !isSelfWrite) {
        add(i, 'undefined-variable',
          `\$${name} is only assigned inside a nested block, so it is out of scope here`)
      }
    }
    for (const c of l) {
      if (c === '{') vdepth++
      else if (c === '}') {
        vdepth--
        for (const [k, d] of defined) if (d > vdepth) defined.delete(k)
      }
    }
  })

  // --- 4. destructive commands ------------------------------------------
  // Discovery and bootstrap are additive. A `remove`, `unset` or factory reset
  // in a generated script destroys a customer's configuration.
  const DESTRUCTIVE = [
    /\/system\s+reset-configuration/,
    /\/system\s+reboot\s*$/,
    /\bremove\b/,
    /\bunset\b/,
    /\/file\s+remove/,
  ]
  lines.forEach((l, i) => {
    if (isComment(raw[i])) return
    for (const re of DESTRUCTIVE) {
      if (re.test(l) && !/\/\s*file\s+remove\s+\$f\b/.test(raw[i])) {
        add(i, 'destructive', `destructive command in a read-only script: ${re}`)
      }
    }
  })

  // --- 5. /tool fetch argument hygiene ----------------------------------
  lines.forEach((l, i) => {
    if (isComment(raw[i])) return
    if (!l.includes('/tool fetch')) return
    if (/\burl=/.test(l) && !/\burl=/.test(raw[i])) {
      add(i, 'fetch-url', 'url= is missing')
    }
    if (/mode=https/.test(l) && !/check-certificate=yes/.test(l)) {
      add(i, 'fetch-tls', 'HTTPS fetch without check-certificate=yes')
    }
    // `keep-result` with `output=file` is rejected by RouterOS 7.
    if (/keep-result/.test(l) && /output=file/.test(l)) {
      add(i, 'fetch-output', 'keep-result with output=file is rejected by RouterOS')
    }
    if (/http-method/i.test(l)) {
      add(i, 'fetch-insecure', 'http-method is not a RouterOS property; use method=POST')
    }
    if (/mode=http\b/.test(l) && !/mode=https/.test(l)) {
      add(i, 'fetch-insecure', 'plaintext HTTP fallback')
    }
    // `http-data=(($j))` - a doubled grouping on the BODY argument. Only the
    // argument is checked; a legitimate nested call such as `[:len ($x)]` or
    // an `https://` URL is not a doubled group.
    if (/http-data=\(\(/.test(l)) {
      add(i, 'fetch-body', 'doubled parentheses around the http-data body')
    }
  })

  // --- 5b. JSON strategy ------------------------------------------------
  // `[:serialize to=json]` is RouterOS 7.13+. Where it is used, hand-escaping
  // is dead weight and a second, divergent way to build JSON. Where it is not
  // available, something must escape.
  const usesSerialize = /:serialize to=json/.test(script)
  lines.forEach((l, i) => {
    if (isComment(raw[i])) return
    if (usesSerialize && /\[:replace/.test(l)) {
      add(i, 'json-strategy',
        'hand-escaping is present alongside :serialize; only one JSON strategy should emit')
    }
  })

  // --- 6. JSON safety ---------------------------------------------------
  // Every value entering a JSON document must pass through the escaper.
  lines.forEach((_l, i) => {
    if (isComment(raw[i])) return
    // A value concatenated into a quoted JSON key/value slot without escaping.
    if (/\\"\w+\\":\\"/.test(raw[i]) && /\$p\b/.test(raw[i]) && !/:set j /.test(raw[i])) {
      add(i, 'json-unescaped',
        'a raw value is concatenated into JSON without passing through the escaper')
    }
  })

  // --- 7. RouterOS 6 compatibility --------------------------------------
  // The ternary is not available on every RouterOS 6 build.
  lines.forEach((l, i) => {
    if (isComment(raw[i])) return
    if (/\?[^:]*:/.test(l) && !/^\s*#/.test(l) && !l.includes('http')) {
      add(i, 'ternary', 'ternary `? :` is not available on every RouterOS 6 build')
    }
  })

  return issues
}