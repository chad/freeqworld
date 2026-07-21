#!/usr/bin/env node
// Regenerate the avatar conformance fixtures (spec §31).
// Any FreeqWorld-compatible implementation must reproduce these exactly:
//   canonical_seed = HKDF-SHA256(ikm=UTF8(did), salt="freeq-world-avatar", info="avatar-v1")
//   traits         = avatar-v1 trait tables selected by sfc32 seeded from the first 16 bytes
//   sprite_hash    = SHA-256 over the four facing sprites' palette-indexed pixels + palette
// Run: npx vite-node scripts/gen-fixtures.mjs

import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveAvatar, spriteHash } from '../shared/src/avatar.ts'
import { deriveLeitmotif } from '../shared/src/leitmotif.ts'

const DIDS = [
  'did:plc:ewvi7nmzuoqusbcablsm7c4h', // bsky.app's own did — a stable public constant
  'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', // ed25519 test vector key
  'did:plc:z72i7hdynmk6r22z27h6tvur',
  'did:key:z6Mkfriq1MqLBoPWecGoDLjguo1sB9brj6wT3qZ5BxkKpuP6',
  'did:example:freeqworld-conformance-0001',
]

const fixtures = []
for (const did of DIDS) {
  const avatar = await deriveAvatar(did)
  const motif = await deriveLeitmotif(did)
  fixtures.push({
    did,
    avatar_version: avatar.base_generator,
    canonical_seed: avatar.canonical_seed_hex,
    expected_traits: avatar.traits,
    sprite_hash: await spriteHash(avatar),
    leitmotif: { notes: motif.notes, rhythmic_cell: motif.rhythmic_cell, instrument: motif.instrument },
  })
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'avatar-conformance.json')
writeFileSync(out, JSON.stringify(fixtures, null, 2) + '\n')
console.log(`wrote ${fixtures.length} fixtures to ${out}`)
