#!/usr/bin/env node
/**
 * fetch-engines.mjs — vendors the native extraction engines into resources/bin.
 *
 * 1. 7-Zip CLI (`7zz` 23.01, universal arm64+x64)
 *    Downloaded from 7-zip.org, SHA-256 pinned. License: LGPL-2.1 + unRAR
 *    restriction; the license text is fetched and stored alongside the binary.
 *
 * 2. Zstandard CLI (`zstd` 1.5.7, universal arm64+x64)
 *    Built from the pinned upstream source tarball using Apple clang
 *    (requires Xcode Command Line Tools). License: BSD-3 + GPL-2 dual;
 *    license files are copied from the source tree.
 *
 * Idempotent: already-vendored, verified binaries are left untouched
 * (pass --force to rebuild). `--if-missing` skips everything that exists.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN_DIR = path.join(ROOT, 'resources', 'bin')
const TMP_DIR = path.join(ROOT, 'resources', 'tmp')
const LICENSE_DIR = path.join(ROOT, 'resources', 'licenses')

const SEVENZIP_URL = 'https://www.7-zip.org/a/7z2301-mac.tar.xz'
const SEVENZIP_SHA256 = '343eae9ccbbd8f68320adaaa3c87e0244cf39fad0fbec6b9d2cd3e5b0f8a5fbf'
const SEVENZIP_LICENSE_URL = 'https://www.7-zip.org/license.txt'

const ZSTD_VERSION = '1.5.7'
const ZSTD_URL = `https://github.com/facebook/zstd/releases/download/v${ZSTD_VERSION}/zstd-${ZSTD_VERSION}.tar.gz`
const ZSTD_SHA256 = 'eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3'

const args = new Set(process.argv.slice(2))
const FORCE = args.has('--force')
const IF_MISSING = args.has('--if-missing')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

async function downloadTo(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  if (!res.body) throw new Error(`empty response body for ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

/** Runs a command, inheriting stdio; throws with captured stderr on failure. */
function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', ...opts.spawn })
  if (res.error) throw res.error
  if (res.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (${res.status}): ${res.stderr ?? res.stdout ?? ''}`.slice(0, 2000))
  }
  return res
}

function haveBinary(file, versionArg, expectSubstring) {
  if (!existsSync(file)) return false
  const res = spawnSync(file, versionArg, { encoding: 'utf8' })
  if (res.status !== 0) return false
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  return out.includes(expectSubstring)
}

async function fetchSevenZip() {
  const bin = path.join(BIN_DIR, '7zz')
  if (!FORCE && haveBinary(bin, [], '7-Zip')) {
    console.log('[engines] 7zz present, skipping')
    return
  }

  console.log(`[engines] downloading 7-Zip (${SEVENZIP_URL})`)
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })
  const archive = path.join(TMP_DIR, '7zz.tar.xz')
  await downloadTo(SEVENZIP_URL, archive)
  const got = sha256(archive)
  if (got !== SEVENZIP_SHA256) {
    throw new Error(`7zz checksum mismatch:\n  expected ${SEVENZIP_SHA256}\n  got      ${got}`)
  }
  run('/usr/bin/tar', ['-xf', archive, '-C', TMP_DIR])
  mkdirSync(BIN_DIR, { recursive: true })
  rmSync(bin, { force: true })
  // Fresh empty dir, then move the verified binary in.
  const extracted = path.join(TMP_DIR, '7zz')
  if (!existsSync(extracted)) throw new Error('7zz not found inside archive')
  run('/bin/mv', [extracted, bin])
  run('/bin/chmod', ['755', bin])
  try {
    await downloadTo(SEVENZIP_LICENSE_URL, path.join(LICENSE_DIR, '7-ZIP-license.txt'))
  } catch (e) {
    console.warn(`[engines] warning: could not fetch 7-Zip license text: ${e.message}`)
  }
  console.log('[engines] 7zz vendored and verified')
}

async function fetchZstd() {
  const bin = path.join(BIN_DIR, 'zstd')
  if (!FORCE && haveBinary(bin, ['--version'], 'Zstandard')) {
    console.log('[engines] zstd present, skipping')
    return
  }

  console.log(`[engines] building zstd ${ZSTD_VERSION} from pinned source (universal arm64+x64)`)
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })
  const archive = path.join(TMP_DIR, 'zstd.tar.gz')
  await downloadTo(ZSTD_URL, archive)
  const got = sha256(archive)
  if (got !== ZSTD_SHA256) {
    throw new Error(`zstd checksum mismatch:\n  expected ${ZSTD_SHA256}\n  got      ${got}`)
  }
  run('/usr/bin/tar', ['-xzf', archive, '-C', TMP_DIR])
  const srcDir = path.join(TMP_DIR, `zstd-${ZSTD_VERSION}`)
  if (!existsSync(srcDir)) throw new Error('zstd source not found after extraction')
  const archFlags = '-O2 -arch arm64 -arch x86_64'
  const jobs = Math.max(2, os.cpus().length)
  run('make', ['-C', path.join(srcDir, 'lib'), 'libzstd', `-j${jobs}`, `CFLAGS=${archFlags}`])
  run('make', ['-C', path.join(srcDir, 'programs'), 'zstd', `-j${jobs}`, `CFLAGS=${archFlags}`, `LDFLAGS=-arch arm64 -arch x86_64`])
  mkdirSync(BIN_DIR, { recursive: true })
  rmSync(bin, { force: true })
  run('/bin/mv', [path.join(srcDir, 'programs', 'zstd'), bin])
  run('/bin/chmod', ['755', bin])
  for (const f of ['LICENSE', 'COPYING']) {
    if (existsSync(path.join(srcDir, f))) run('/bin/cp', [path.join(srcDir, f), path.join(LICENSE_DIR, `zstd-${f}`)])
  }
  console.log('[engines] zstd built and vendored')
}

async function verifyAll() {
  for (const [bin, vArg, needle] of [
    [path.join(BIN_DIR, '7zz'), [], '7-Zip'],
    [path.join(BIN_DIR, 'zstd'), ['--version'], 'v1.5']
  ]) {
    const res = spawnSync(bin, vArg, { encoding: 'utf8' })
    const ok = res.status === 0 && `${res.stdout ?? ''}${res.stderr ?? ''}`.includes(needle)
    console.log(`[engines] ${path.basename(bin)}: ${ok ? 'OK' : 'FAILED'} ${ok ? `${res.stdout ?? res.stderr}`.trim().split('\n')[0] : ''}`)
    if (!ok) throw new Error(`vendored engine failed verification: ${bin}`)
  }
}

async function main() {
  mkdirSync(LICENSE_DIR, { recursive: true })
  await fetchSevenZip()
  await fetchZstd()
  await verifyAll()
  rmSync(TMP_DIR, { recursive: true, force: true })
  console.log('[engines] all engines ready')
}

main().catch((err) => {
  console.error(`[engines] FAILED: ${err.message}`)
  console.error('[engines] Note: zstd build requires Xcode Command Line Tools (xcode-select --install).')
  process.exit(1)
})
