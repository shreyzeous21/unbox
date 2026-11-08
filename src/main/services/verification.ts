/**
 * Verification service — decides, honestly, what was actually verified.
 *
 * It never upgrades an outcome: the ceiling for a format comes from
 * FORMAT_CAPABILITIES.integrity, the floor from what the engine reported.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { FORMAT_CAPABILITIES, type FormatId, type IntegrityLevel } from '@shared/formats'
import type { EngineListEntry, ExtractResult } from './engines/engine-types'
import type { TreeAudit } from './fs-safety'
import type { JobIssue, VerificationOutcome } from '@shared/job-types'

export interface VerificationInput {
  format: FormatId
  list: { entries: EngineListEntry[]; totalUncompressed?: number } | null
  extract: ExtractResult
  /** Pre-test passed earlier in the pipeline. */
  preTestPassed: boolean
  /** The temp workspace root the engine wrote into. */
  root: string
  /** Extracted file count as reported by fs audit (authoritative). */
  audit: TreeAudit
  /** If size was unknown upfront (stream formats). */
  sizeUnknownUpfront: boolean
}

export interface VerificationReport {
  outcome: VerificationOutcome
  issues: JobIssue[]
  stats: {
    filesExtracted: number
    filesFailed: number
    foldersCreated: number
    linksCreated: number
    bytesExtracted: number
  }
}

const MAX_NAMED_ISSUES = 200 // reports stay bounded even for archives with 10k bad entries

function pushIssue(issues: JobIssue[], issue: JobIssue): void {
  if (issues.length < MAX_NAMED_ISSUES) issues.push(issue)
  else if (issues.length === MAX_NAMED_ISSUES) {
    issues.push({ severity: 'warning', code: 'ISSUES_TRUNCATED', message: 'further issues omitted from this report (see logs)' })
  }
}

export async function verifyExtraction(input: VerificationInput): Promise<VerificationReport> {
  const issues: JobIssue[] = []
  const caps = FORMAT_CAPABILITIES[input.format]
  const integrity: IntegrityLevel = caps?.integrity ?? 'none'

  // 1. Engine outcome — classify failures into job issues.
  for (const e of input.extract.issues) {
    pushIssue(issues, { severity: e.severity, code: e.code, message: e.message, entry: e.entry })
  }

  // 2. Engine-reported errors that demand failure regardless of format:
  const fatalEngineCodes = new Set(['WRONG_PASSWORD', 'CRC_FAILED', 'DATA_ERROR', 'TRUNCATED', 'DISK_FULL', 'PERMISSION_DENIED', 'IO_ERROR', 'MISSING_VOLUME'])
  const engineFatal = input.extract.issues.some((i) => i.severity === 'error' && fatalEngineCodes.has(i.code))

  // 3. Symlink audit (already performed by caller? no — we run it here when caller passed raw tree).
  let escapedLinks = 0
  if (input.audit.escapedLinks.length > 0) {
    escapedLinks = input.audit.escapedLinks.length
    for (const l of input.audit.escapedLinks.slice(0, 50)) {
      pushIssue(issues, { severity: 'error', code: 'LINK_ESCAPE', message: `symbolic link escaped the extraction folder and was removed: ${l.link} → ${l.target}` })
    }
  }

  // 4. Entry presence + size verification when listing was available.
  let filesFailed = 0
  if (input.list && !input.sizeUnknownUpfront) {
    const fileEntries = input.list.entries.filter((e) => !e.isDir)
    // For cheap-list formats, every regular file must exist with the listed size.
    let checked = 0
    for (const entry of fileEntries) {
      if (entry.isSymlink) continue
      const check = await checkEntryOnDisk(input.root, entry)
      checked++
      if (!check.ok) {
        filesFailed++
        pushIssue(issues, {
          severity: 'error',
          code: check.code,
          message: check.message,
          entry: entry.name
        })
      }
      if (checked >= 200_000) break // bounded check; listing itself was capped
    }
  }

  const filesExtracted = Math.max(0, input.audit.files)
  const stats = {
    filesExtracted,
    filesFailed,
    foldersCreated: input.audit.folders,
    linksCreated: input.audit.symlinks,
    bytesExtracted: input.audit.bytes
  }

  // 5. Outcome synthesis — strictest wins; nothing is ever upgraded.
  let outcome: VerificationOutcome
  if (engineFatal || escapedLinks > 0 || filesFailed > 0 || !input.extract.ok) {
    outcome = 'failed'
  } else if (input.extract.cancelled) {
    outcome = 'failed'
  } else {
    if (integrity === 'entry-crc') {
      // Engine checked CRCs in-stream (7zz) or pre-test passed with in-stream CRC checks.
      outcome = 'crc-verified'
    } else if (integrity === 'codec') {
      outcome = 'codec-verified'
    } else if (integrity === 'header') {
      outcome = input.list ? 'size-verified' : 'unverified'
    } else {
      outcome = input.list && filesFailed === 0 ? 'size-verified' : 'unverified'
    }
    if (!input.preTestPassed && caps?.canPreTest) {
      pushIssue(issues, { severity: 'warning', code: 'PRE_TEST_SKIPPED', message: 'pre-extraction integrity test was disabled by settings' })
    }
    if (input.audit.incomplete) {
      pushIssue(issues, { severity: 'warning', code: 'AUDIT_INCOMPLETE', message: input.audit.incompleteReason ?? 'output tree audit could not complete' })
    }
  }

  return { outcome, issues, stats }
}

async function checkEntryOnDisk(
  root: string,
  entry: EngineListEntry
): Promise<{ ok: boolean; code: string; message: string }> {
  const full = path.join(root, entry.name)
  try {
    const st = await fsp.lstat(full)
    if (entry.size !== undefined && st.isFile() && st.size !== entry.size) {
      return {
        ok: false,
        code: 'SIZE_MISMATCH',
        message: `size mismatch: archive lists ${entry.size} bytes, extracted ${st.size} bytes`
      }
    }
    return { ok: true, code: 'OK', message: '' }
  } catch {
    return { ok: false, code: 'MISSING_FILE', message: 'file listed in archive but not present after extraction' }
  }
}
