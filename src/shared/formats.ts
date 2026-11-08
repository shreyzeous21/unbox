/**
 * Format registry — the single source of truth for what Unbox supports and,
 * critically, what integrity each format can actually provide. The UI reads
 * capabilities from here so it can never overclaim.
 */

export type FormatId =
  | 'zip'
  | '7z'
  | 'rar'
  | 'tar'
  | 'tar-gz'
  | 'tar-bz2'
  | 'tar-xz'
  | 'tar-zst'
  | 'gz'
  | 'bz2'
  | 'xz'
  | 'zst'
  | 'lzma'
  | 'z'
  | 'iso'
  | 'cab'
  | 'wim'
  | 'arj'
  | 'lzh'
  | 'cpio'
  | 'xar'
  | 'msi'
  | 'rpm'
  | 'deb'
  | 'dmg'

export type EngineId = 'sevenzip' | 'libarchive' | 'zstd'

/** What kind of integrity verification a format genuinely allows. */
export type IntegrityLevel =
  | 'entry-crc' // per-entry CRC/hash checked during extraction
  | 'codec' // only the compression codec's stream integrity (gzip/xz/zstd checksums)
  | 'header' // tar-style weak per-block header checksums only
  | 'none' // no integrity information at all

export interface FormatCapability {
  id: FormatId
  label: string
  extensions: string[]
  /** Engines in priority order. */
  engines: EngineId[]
  canList: 'cheap' | 'stream' | 'no' // cheap = index/header only; stream = full decode pass
  canPreTest: boolean
  integrity: IntegrityLevel
  password: boolean
  multiVolume: boolean
  /** True when the uncompressed total size is unknown before extraction. */
  sizeUnknownUpfront: boolean
  notes?: string
}

export const FORMAT_CAPABILITIES: Record<FormatId, FormatCapability> = {
  zip: {
    id: 'zip', label: 'ZIP', extensions: ['.zip', '.z01', '.zip.001'],
    engines: ['sevenzip'], canList: 'cheap', canPreTest: true, integrity: 'entry-crc',
    password: true, multiVolume: true, sizeUnknownUpfront: false,
    notes: 'CRC32 verified per entry during extraction. Supports ZipCrypto and AES.'
  },
  '7z': {
    id: '7z', label: '7-Zip', extensions: ['.7z', '.7z.001'],
    engines: ['sevenzip'], canList: 'cheap', canPreTest: true, integrity: 'entry-crc',
    password: true, multiVolume: true, sizeUnknownUpfront: false,
    notes: 'Header-compressed/archives without size table report indeterminate progress.'
  },
  rar: {
    id: 'rar', label: 'RAR / RAR5', extensions: ['.rar', '.part1.rar', '.r00'],
    engines: ['sevenzip'], canList: 'cheap', canPreTest: true, integrity: 'entry-crc',
    password: true, multiVolume: true, sizeUnknownUpfront: false,
    notes: 'Extraction only (unRAR license). RAR5 BLAKE2 hashes verified when present.'
  },
  tar: {
    id: 'tar', label: 'TAR', extensions: ['.tar'],
    engines: ['libarchive'], canList: 'cheap', canPreTest: false,
    integrity: 'header', password: false, multiVolume: false, sizeUnknownUpfront: false,
    notes: 'tar header checksums are weak; treated as best-effort integrity.'
  },
  'tar-gz': {
    id: 'tar-gz', label: 'TAR.GZ / TGZ', extensions: ['.tar.gz', '.tgz'],
    engines: ['libarchive'], canList: 'stream', canPreTest: false,
    integrity: 'codec', password: false, multiVolume: false, sizeUnknownUpfront: true,
    notes: 'gzip CRC32 covers the stream; per-file sizes known only as tar headers stream by.'
  },
  'tar-bz2': {
    id: 'tar-bz2', label: 'TAR.BZ2', extensions: ['.tar.bz2', '.tbz2'],
    engines: ['libarchive'], canList: 'stream', canPreTest: false,
    integrity: 'codec', password: false, multiVolume: false, sizeUnknownUpfront: true,
    notes: 'bzip2 CRC32 is per-block; archive cannot be indexed without a full decode.'
  },
  'tar-xz': {
    id: 'tar-xz', label: 'TAR.XZ', extensions: ['.tar.xz', '.txz'],
    engines: ['libarchive'], canList: 'stream', canPreTest: false,
    integrity: 'codec', password: false, multiVolume: false, sizeUnknownUpfront: true,
    notes: 'xz SHA-256 verified when the archive carries an index.'
  },
  'tar-zst': {
    id: 'tar-zst', label: 'TAR.ZST', extensions: ['.tar.zst', '.tzst'],
    engines: ['zstd'], canList: 'stream', canPreTest: false,
    integrity: 'codec', password: false, multiVolume: false, sizeUnknownUpfront: true,
    notes: 'Requires the vendored zstd engine. Frame checksum verified when present.'
  },
  gz: {
    id: 'gz', label: 'GZIP', extensions: ['.gz'],
    engines: ['libarchive', 'sevenzip'], canList: 'no', canPreTest: false,
    integrity: 'codec', password: false, multiVolume: false, sizeUnknownUpfront: true,
    notes: 'Single-file stream; inner content auto-detected after decode.'
  },
  bz2: {
    id: 'bz2', label: 'BZIP2', extensions: ['.bz2'],
    engines: ['libarchive', 'sevenzip'], canList: 'no', canPreTest: false,
    integrity: 'codec', password: false, multiVolume: false, sizeUnknownUpfront: true
  },
  xz: {
    id: 'xz', label: 'XZ', extensions: ['.xz'],
    engines: ['libarchive', 'sevenzip'], canList: 'no', canPreTest: false,
    integrity: 'codec', password: false, multiVolume: false, sizeUnknownUpfront: true
  },
  zst: {
    id: 'zst', label: 'ZSTD', extensions: ['.zst'],
    engines: ['zstd'], canList: 'no', canPreTest: false,
    integrity: 'codec', password: false, multiVolume: false, sizeUnknownUpfront: true,
    notes: 'Requires the vendored zstd engine.'
  },
  lzma: {
    id: 'lzma', label: 'LZMA', extensions: ['.lzma'],
    engines: ['sevenzip', 'libarchive'], canList: 'no', canPreTest: false,
    integrity: 'none', password: false, multiVolume: false, sizeUnknownUpfront: true,
    notes: 'Raw LZMA streams carry no checksum; only size verification applies.'
  },
  z: {
    id: 'z', label: 'Unix compress (Z)', extensions: ['.z', '.Z'],
    engines: ['sevenzip', 'libarchive'], canList: 'no', canPreTest: false,
    integrity: 'none', password: false, multiVolume: false, sizeUnknownUpfront: true
  },
  iso: {
    id: 'iso', label: 'ISO disc image', extensions: ['.iso'],
    engines: ['sevenzip'], canList: 'cheap', canPreTest: true, integrity: 'none',
    password: false, multiVolume: false, sizeUnknownUpfront: false,
    notes: 'ISO9660 provides no per-file CRCs; files are size-verified only.'
  },
  cab: {
    id: 'cab', label: 'CAB', extensions: ['.cab'],
    engines: ['sevenzip'], canList: 'cheap', canPreTest: true, integrity: 'entry-crc',
    password: false, multiVolume: true, sizeUnknownUpfront: false
  },
  wim: {
    id: 'wim', label: 'WIM', extensions: ['.wim', '.swm'],
    engines: ['sevenzip'], canList: 'cheap', canPreTest: true, integrity: 'entry-crc',
    password: false, multiVolume: true, sizeUnknownUpfront: false,
    notes: 'WIM stores SHA-1 per resource; 7-Zip validates on read.'
  },
  arj: {
    id: 'arj', label: 'ARJ', extensions: ['.arj'],
    engines: ['sevenzip'], canList: 'cheap', canPreTest: true, integrity: 'entry-crc',
    password: true, multiVolume: true, sizeUnknownUpfront: false,
    notes: 'Legacy format; encrypted ARJ is best-effort.'
  },
  lzh: {
    id: 'lzh', label: 'LZH', extensions: ['.lzh', '.lha'],
    engines: ['sevenzip'], canList: 'cheap', canPreTest: true, integrity: 'entry-crc',
    password: false, multiVolume: false, sizeUnknownUpfront: false,
    notes: 'Integrity depends on the LZH method used per entry.'
  },
  cpio: {
    id: 'cpio', label: 'CPIO', extensions: ['.cpio'],
    engines: ['libarchive', 'sevenzip'], canList: 'cheap', canPreTest: false,
    integrity: 'header', password: false, multiVolume: false, sizeUnknownUpfront: false
  },
  xar: {
    id: 'xar', label: 'XAR', extensions: ['.xar', '.pkg'],
    engines: ['sevenzip', 'libarchive'], canList: 'cheap', canPreTest: true,
    integrity: 'entry-crc', password: false, multiVolume: false, sizeUnknownUpfront: false,
    notes: 'XAR stores per-file checksums (sha1/sha256) in its TOC.'
  },
  msi: {
    id: 'msi', label: 'MSI package', extensions: ['.msi'],
    engines: ['sevenzip'], canList: 'cheap', canPreTest: true, integrity: 'none',
    password: false, multiVolume: false, sizeUnknownUpfront: false,
    notes: 'Container-level read; MSI tables are not interpreted.'
  },
  rpm: {
    id: 'rpm', label: 'RPM package', extensions: ['.rpm'],
    engines: ['sevenzip', 'libarchive'], canList: 'cheap', canPreTest: false,
    integrity: 'header', password: false, multiVolume: false, sizeUnknownUpfront: false
  },
  deb: {
    id: 'deb', label: 'DEB package', extensions: ['.deb'],
    engines: ['sevenzip', 'libarchive'], canList: 'cheap', canPreTest: false,
    integrity: 'header', password: false, multiVolume: false, sizeUnknownUpfront: false
  },
  dmg: {
    id: 'dmg', label: 'DMG disc image', extensions: ['.dmg'],
    engines: ['sevenzip'], canList: 'cheap', canPreTest: false, integrity: 'none',
    password: false, multiVolume: false, sizeUnknownUpfront: false,
    notes: 'Plain (unencrypted, uncompressed or ADC/LZMA) DMG images only. APFS-encrypted or EULA DMGs are rejected with a clear error.'
  }
}

export const EXTENSION_TO_FORMAT: ReadonlyMap<string, FormatId> = buildExtensionMap()

function buildExtensionMap(): Map<string, FormatId> {
  const map = new Map<string, FormatId>()
  for (const cap of Object.values(FORMAT_CAPABILITIES)) {
    for (const ext of cap.extensions) {
      // Longest extension wins so `.tar.gz` beats `.gz`.
      if (!map.has(ext) || ext.length > (EXT_LEN(map.get(ext)) ?? 0)) map.set(ext, cap.id)
    }
  }
  function EXT_LEN(id: FormatId | undefined): number {
    if (!id) return 0
    const cur = [...map.entries()].find(([, v]) => v === id)?.[0]
    return cur ? cur.length : 0
  }
  return map
}

export function formatLabel(id: FormatId): string {
  return FORMAT_CAPABILITIES[id]?.label ?? id
}
