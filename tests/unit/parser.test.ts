import { describe, expect, it } from 'vitest'
import {
  parseSevenZipSltListing,
  parseSevenZipTestOutput,
  parseSevenZipExtractOutput,
  parseBsdtarTvf,
  parseProgressLine,
  SevenZipProgressTokenizer
} from '../../src/main/services/engines/output-parser'
import { checkEntryName, validateListing } from '../../src/main/services/fs-safety'

// Captured from the vendored 7zz 23.01 on macOS — updated only with real output.
const SEVENZIP_SLT_SAMPLE = `
7-Zip (z) 23.01 (arm64) : Copyright (c) 1999-2023 Igor Pavlov : 2023-06-20

Listing archive: out/test.zip

--
Path = out/test.zip
Type = zip
Physical Size = 4001030

----------
Path = src
Folder = +
Size = 0
Packed Size = 0
Attributes = D drwxr-xr-x
Encrypted = -

Path = src/a.txt
Folder = -
Size = 12
Packed Size = 12
CRC = B1946AC9
Attributes = A -rw-r--r--
Encrypted = -

Path = src/link
Folder = -
Size = 5
Attributes = l rwxr-xr-x
Symbolic Link = a.txt
`

describe('parseSevenZipSltListing', () => {
  it('parses entries, folders, sizes, CRC and symlinks', () => {
    const { list, archiveType } = parseSevenZipSltListing(SEVENZIP_SLT_SAMPLE)
    expect(archiveType).toBe('zip')
    expect(list.fileCount).toBe(2)
    expect(list.folderCount).toBe(1)
    expect(list.totalUncompressed).toBe(17)
    const link = list.entries.find((e) => e.name === 'src/link')
    expect(link?.isSymlink).toBe(true)
    expect(link?.linkTarget).toBe('a.txt')
    const a = list.entries.find((e) => e.name === 'src/a.txt')
    expect(a?.crc).toBe('B1946AC9')
    expect(a?.size).toBe(12)
  })

  it('flags encrypted entries', () => {
    const { list } = parseSevenZipSltListing(SEVENZIP_SLT_SAMPLE.replace('Encrypted = -\n\nPath = src/a.txt', 'Encrypted = +\n\nPath = src/a.txt'))
    expect(list.encrypted).toBe(true)
  })
})

describe('parseSevenZipTestOutput', () => {
  it('accepts a clean pass', () => {
    const out = 'Testing archive: x\n-\nPath = x\nType = zip\n\nEverything is Ok\n\nFolders: 1\nFiles: 5\nSize: 400\n'
    const r = parseSevenZipTestOutput(out, 0)
    expect(r.ok).toBe(true)
  })
  it('rejects CRC failure with exit 2', () => {
    const out = 'Testing: a.txt\nERROR: CRC Failed in file "a.txt"\n\nArchives with Errors: 1\n'
    const r = parseSevenZipTestOutput(out, 2)
    expect(r.ok).toBe(false)
    expect(r.errorLines.some((l) => /CRC Failed/i.test(l))).toBe(true)
  })
  it('rejects wrong password', () => {
    const out = 'ERROR: Data Error in encrypted file. Wrong password?\n'
    const r = parseSevenZipTestOutput(out, 2)
    expect(r.ok).toBe(false)
  })
})

describe('parseSevenZipExtractOutput', () => {
  it('reads summary counters', () => {
    const out = '\nEverything is Ok\n\nFolders: 2\nFiles: 5\nSize:       4000046\nCompressed: 4001030\n'
    const s = parseSevenZipExtractOutput(out, 0)
    expect(s.files).toBe(5)
    expect(s.folders).toBe(2)
    expect(s.size).toBe(4000046)
    expect(s.hasErrors).toBe(false)
  })
  it('flags CRC failures', () => {
    const s = parseSevenZipExtractOutput('ERROR: CRC Failed in file "x"', 2)
    expect(s.hasErrors).toBe(true)
  })
})

// Captured real bsdtar -tvf output (LC_ALL=C).
const BSDTAR_SAMPLE = `-rw-r--r--  0 shrey staff      12 Nov  9 02:44 a.txt
-rw-r--r--  0 shrey staff  262144 Nov  9 02:44 notes/deep/deeper/deepest/leaf.bin
drwxr-xr-x  0 shrey staff       0 Nov  9 02:44 empty-dir
lrwxr-xr-x  0 shrey staff       5 Nov  9 02:44 link-to-a -> a.txt
-rw-r--r--  0 shrey staff      42 Nov  9 02:44 notes/日本語-ünïcode-ⓤⓝⓘⓒⓞⓓⓔ.txt
`

describe('parseBsdtarTvf', () => {
  it('parses sizes, dirs and symlinks from -tvf output', () => {
    const { list, errorLines } = parseBsdtarTvf(BSDTAR_SAMPLE)
    expect(errorLines).toHaveLength(0)
    expect(list.fileCount).toBe(3)
    expect(list.folderCount).toBe(1)
    expect(list.totalUncompressed).toBe(12 + 262144 + 42)
    const link = list.entries.find((e) => e.name === 'link-to-a')
    expect(link?.isSymlink).toBe(true)
    expect(link?.linkTarget).toBe('a.txt')
    const uni = list.entries.find((e) => e.name?.includes('日本語'))
    expect(uni?.size).toBe(42)
  })
  it('captures error lines', () => {
    const { list, errorLines } = parseBsdtarTvf('bsdtar: Error opening archive: Unrecognized archive format\n')
    expect(errorLines.length).toBe(1)
    expect(list.fileCount).toBe(0)
  })
})

describe('progress tokens', () => {
  it('parses 7zz -bsp1 percent + file markers', () => {
    expect(parseProgressLine(' 45% L2 12 + src/big.bin')).toMatchObject({ percent: 45, filesDone: 12, currentFile: 'src/big.bin' })
    expect(parseProgressLine(' 45% L2 13 - src/big.bin')).toMatchObject({ percent: 45, filesDone: 13, fileDone: 'src/big.bin' })
    expect(parseProgressLine('  7% L1 0')).toMatchObject({ percent: 7, filesDone: 0 })
  })
  it('tokenizer splits backspace-separated updates', () => {
    const tok = new SevenZipProgressTokenizer()
    const tokens = tok.feed(' 10% L1 0 \b\b\b 20% L1 0 \b\b\b 30% L1 1 - a.bin\n')
    expect(tokens.length).toBe(3)
    expect(tokens[2]?.percent).toBe(30)
    expect(tokens[2]?.fileDone).toBe('a.bin')
  })
})

describe('checkEntryName (ZIP-slip boundary)', () => {
  const cases: Array<[string, string | null]> = [
    ['normal/file.txt', 'normal/file.txt'],
    ['./current/file', 'current/file'],
    ['a//b.txt', 'a/b.txt'],
    ['.', ''],
    ['./', ''],
    ['../evil.txt', null],
    ['a/../../evil', null],
    ['..', null],
    ['/absolute/path', null],
    ['C:\\Users\\evil', null],
    ['\\\\server\\share', null],
    ['bad\u0000name', null],
    ['ctrl\u0007char', null]
  ]
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected ?? 'rejected'}`, () => {
      const r = checkEntryName(input)
      if (expected === null) expect(r.violation).toBeDefined()
      else expect(r.safePath).toBe(expected)
    })
  }

  it('validateListing returns all violations', () => {
    const v = validateListing(['ok.txt', '../a', '/etc/passwd', 'fine.bin'])
    expect(v).toHaveLength(2)
  })
})
