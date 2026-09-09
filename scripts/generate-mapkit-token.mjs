#!/usr/bin/env node
/**
 * Sign a MapKit JS JWT (ES256) from a downloaded .p8 key.
 *
 * NEVER place .p8 keys in this repo. Pass an absolute path outside the tree.
 *
 * Apple Developer portal:
 *   1. Identifiers → Maps IDs → register a Maps ID
 *   2. Keys → + → enable MapKit JS → download the .p8 (shown once)
 *   3. Note the Key ID (kid) and your Team ID (iss)
 *
 * Usage:
 *   MAPKIT_KEY_FILE=/abs/path/AuthKey_XXXX.p8 \
 *   MAPKIT_KEY_ID=XXXXXXXXXX \
 *   MAPKIT_TEAM_ID=XXXXXXXXXX \
 *   node scripts/generate-mapkit-token.mjs
 *
 * Or flags:
 *   node scripts/generate-mapkit-token.mjs \
 *     --key-file /abs/path/AuthKey_XXXX.p8 \
 *     --key-id XXXXXXXXXX \
 *     --team-id XXXXXXXXXX \
 *     --expiry-days 180 \
 *     --origin https://tauri.localhost
 *
 * `--origin` / MAPKIT_ORIGIN is optional. When set, Apple rejects the
 * JWT from any other page origin (stolen-token blast radius). Omit it
 * for a token that works in both `pnpm tauri dev` (http://localhost:5173)
 * and the bundled app (https://tauri.localhost). Prefer a short-lived
 * token plus origin once you ship a single production origin.
 *
 * Then put the printed token in `.env` as MEMLORE_MAPKIT_TOKEN=...
 * (`src-tauri/build.rs` forwards it to option_env! at compile time).
 */

import { createPrivateKey, createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function arg(flag, envName) {
  const idx = process.argv.indexOf(flag)
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]
  return process.env[envName] ?? ''
}

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

const keyFile = arg('--key-file', 'MAPKIT_KEY_FILE')
const keyId = arg('--key-id', 'MAPKIT_KEY_ID')
const teamId = arg('--team-id', 'MAPKIT_TEAM_ID')
const origin = arg('--origin', 'MAPKIT_ORIGIN')
const expiryDaysRaw = arg('--expiry-days', 'MAPKIT_EXPIRY_DAYS') || '180'
const expiryDays = Number(expiryDaysRaw)

if (!keyFile || !keyId || !teamId) {
  console.error(
    'Missing MAPKIT_KEY_FILE / MAPKIT_KEY_ID / MAPKIT_TEAM_ID (or --key-file / --key-id / --team-id).',
  )
  process.exit(1)
}

if (!Number.isFinite(expiryDays) || expiryDays <= 0) {
  console.error('expiry days must be a positive number (default 180).')
  process.exit(1)
}

const pem = readFileSync(resolve(keyFile), 'utf8')
const now = Math.floor(Date.now() / 1000)
const exp = now + Math.round(expiryDays * 86400)
const header = { alg: 'ES256', kid: keyId, typ: 'JWT' }
const payload = origin ? { iss: teamId, iat: now, exp, origin } : { iss: teamId, iat: now, exp }
const unsigned = `${b64urlJson(header)}.${b64urlJson(payload)}`

const signer = createSign('SHA256')
signer.update(unsigned)
signer.end()
const sig = signer.sign({
  key: createPrivateKey(pem),
  dsaEncoding: 'ieee-p1363',
})
const token = `${unsigned}.${Buffer.from(sig).toString('base64url')}`
const expiryIso = new Date(exp * 1000).toISOString()

console.log(token)
console.error(`expires: ${expiryIso} (${expiryDays} day(s))`)
