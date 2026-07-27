#!/usr/bin/env node
// Ship the ID app. Builds BOTH targets, then rsyncs — in one command, because
// the sequence is the whole problem.
//
// Written after shipping a stale bundle: the deploy was
//   git commit && git push && miren deploy && rsync pfp/dist-root/
// with no build in it, so nginx served a bundle from 34 minutes earlier while
// the container (which runs TypeScript at runtime) had the fix. That split is
// nasty precisely because the server route LOOKED correct when tested, and the
// in-browser download — the thing a person actually clicks — did not.
//
//   node scripts/deploy-pfp.mjs            # build both targets and deploy
//   node scripts/deploy-pfp.mjs --dry-run  # build and verify, ship nothing

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = process.env.PFP_HOST ?? 'root@87.99.152.98'
const REMOTE = process.env.PFP_REMOTE ?? '/var/www/pfp/'
const dry = process.argv.includes('--dry-run')

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts })

// 1. typecheck, because a broken bundle deploys just as happily as a good one
console.log('→ typecheck')
run('npx', ['tsc', '--noEmit'])

// 2. both targets. /id/ on world.freeq.at and / on pfp.freeq.at produce
//    different asset hashes; shipping one and not the other points a browser at
//    a bundle that isn't there.
for (const args of [['vite', 'build', 'pfp'], ['vite', 'build', 'pfp', '--base=/', '--outDir=dist-root']]) {
  console.log(`→ npx ${args.join(' ')}`)
  run('npx', args)
}

// 3. the bundle must be newer than every source file it is built from, or we are
//    about to ship something stale again
const newest = (dir, skip = /node_modules|dist/) => {
  let latest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.test(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) latest = Math.max(latest, newest(full, skip))
    else if (/\.(ts|html|css)$/.test(entry.name)) latest = Math.max(latest, statSync(full).mtimeMs)
  }
  return latest
}
const srcTime = Math.max(newest(join(ROOT, 'pfp')), newest(join(ROOT, 'music', 'src')), newest(join(ROOT, 'shared', 'src')))
const distDir = join(ROOT, 'pfp', 'dist-root', 'assets')
const bundles = readdirSync(distDir).filter((f) => f.endsWith('.js'))
const bundleTime = Math.max(...bundles.map((f) => statSync(join(distDir, f)).mtimeMs))
if (bundleTime < srcTime) {
  console.error(`✗ bundle is older than its sources (${new Date(bundleTime).toISOString()} < ${new Date(srcTime).toISOString()})`)
  process.exit(1)
}
console.log(`✓ bundle ${bundles.join(', ')} is current`)

if (dry) {
  console.log('dry run: not shipping')
  process.exit(0)
}

// 4. ship
console.log(`→ rsync → ${HOST}:${REMOTE}`)
run('rsync', ['-az', '--delete', join(ROOT, 'pfp', 'dist-root') + '/', `${HOST}:${REMOTE}`])

// 5. and confirm the hash the world serves is the hash we just built
const localIndex = readFileSync(join(ROOT, 'pfp', 'dist-root', 'index.html'), 'utf8')
const want = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(localIndex)?.[1]
const live = execFileSync('curl', ['-s', 'https://pfp.freeq.at/'], { encoding: 'utf8' })
const got = /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(live)?.[1]
if (want && got && want !== got) {
  console.error(`✗ pfp.freeq.at serves ${got}, expected ${want}`)
  process.exit(1)
}
console.log(`✓ pfp.freeq.at serves ${got}`)
console.log('\nNote: world.freeq.at/id/ is served by the CONTAINER — run `miren deploy -C freeq` too.')
