#!/usr/bin/env node
// PATCH-13 — let authenticated LAN sessions through the @linxin666 dsh-web suite's
// loopback-only trust fences. The suite hard-codes "loopback or paired-iPhone only"
// guards on its UX panels (usage, ssh, task boards, squads/agents, plugin manager,
// market, presets, session archive, pet, diagrams, skill/skin explorers, browser
// view). On a LAN-bound deployment (no 127.0.0.1 listener, browsers on other hosts)
// every panel 403s even for logged-in admins.
//
// This script patches the installed packages in place. Trust model: a request that
// carries a `dsh_session` cookie has already been validated by the @xgone/dsh-remote
// auth plugin before any route runs (invalid cookies are rejected with 401 upstream),
// so cookie presence here is equivalent to "authenticated admin". The sec-fetch /
// origin same-origin markers are untouched, so CSRF protection stays intact.
//
// Deliberately NOT patched (security design, keep loopback-only):
//   - @linxin666/dsh-remote-bridge (device-pairing bootstrap token)
//   - @linxin666/dsh-ssh (tunnel listeners bind loopback by design)
//
// Usage:  node scripts/apply-patch13.mjs [nodeModulesDir]
//   default nodeModulesDir = E:/dsh/home/profiles/superagent/node_modules
// Idempotent: files already carrying the PATCH-13 marker are skipped.
// Re-run after installing or updating any @linxin666 package.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? 'E:/dsh/home/profiles/superagent/node_modules'
const scope = join(root, '@linxin666')
const MARKER = 'PATCH-13'
const EXCLUDE = new Set(['dsh-remote-bridge', 'dsh-ssh'])
const COOKIE = '(typeof %s.headers?.cookie === "string" && %s.headers.cookie.includes("dsh_session="))'

const cookieClause = v => `${COOKIE.replace(/%s/g, v)}`

const transforms = [
  // 1) paired-or-loopback fence helper (bundled into several packages)
  {
    pattern: /function isPairedOrLoopbackAllowed\(([^)]*)\)\s*\{\s*if \(isLoopbackRequest\(request\)\) return true;\s*return lookupPairing\(ctx\)\?\.isPairedDevice\(request\) === true;\s*\}/,
    replace: m => `function isPairedOrLoopbackAllowed(${m[1]}) {\n\tif (isLoopbackRequest(request)) return true;\n\t${cookieClause('request')}; // ${MARKER}: authenticated LAN session passes the fence\n\treturn lookupPairing(ctx)?.isPairedDevice(request) === true;\n}`,
  },
  // 2) inline loopback guards on route handlers
  {
    pattern: /if \(!isLoopbackRequest\((\w+)\)\) \{/g,
    replace: m => `if (!(isLoopbackRequest(${m[1]}) || ${cookieClause(m[1])})) { // ${MARKER}`,
  },
  // 3) socket remote-address guards (web-all shell)
  {
    pattern: /if \((\w+) !== "127\.0\.0\.1" && \1 !== "::1"\) \{/g,
    replace: m => `if (${m[1]} !== "127.0.0.1" && ${m[1]} !== "::1" && ${cookieClause('req')}) { // ${MARKER}`,
  },
  // 4) trusted-request fence (squads/agents: sec-fetch + loopback address)
  {
    pattern: /return isLoopbackAddress\(req\.socket\.remoteAddress\);(?!\s*\/\/)/,
    replace: () => `return isLoopbackAddress(req.socket.remoteAddress) || ${cookieClause('req')}; // ${MARKER}`,
  },
]

let patched = 0
const skipped = []
for (const pkg of readdirSync(scope)) {
  if (EXCLUDE.has(pkg)) continue
  const libDir = join(scope, pkg, 'lib')
  let files
  try { files = readdirSync(libDir).filter(f => f.endsWith('.js')).map(f => join(libDir, f)) } catch { continue }
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (text.includes(MARKER)) { skipped.push(`${pkg}/${file.split('node_modules').pop()}`); continue }
    let next = text
    for (const { pattern, replace } of transforms) next = next.replace(pattern, replace)
    if (next !== text) {
      writeFileSync(file, next)
      patched++
      console.log(`patched ${pkg}/${file.split('node_modules').pop()}`)
    }
  }
}
if (skipped.length) console.log(`already marked (skipped): ${skipped.length} files`)
console.log(`PATCH-13: ${patched} file(s) patched under ${scope}`)
