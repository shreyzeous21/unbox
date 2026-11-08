# Unbox — Universal Archive Extractor for macOS

Design document. Everything here is implementation-driven: every claim is enforced by code
and tests, and every engine limitation is stated explicitly.

---

## A. System Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Renderer (React 19 + Zustand + Tailwind v4 + shadcn/ui)                 │
│  sandbox: ON · nodeIntegration: OFF · contextIsolation: ON               │
│  Sees only the typed window.unbox API (contextBridge). No fs, no paths   │
│  it didn't get from main. Zustand store fed by throttled IPC events.     │
└───────────────▲──────────────────────────────────────────┬───────────────┘
                │ ipcRenderer.invoke / events              │
┌───────────────┴──────────────────────────────────────────▼───────────────┐
│  Preload (contextBridge) — validates + forwards, zero node APIs exposed  │
└───────────────▲──────────────────────────────────────────┬───────────────┘
                │                                          │
┌───────────────┴──────────────────────────────────────────▼───────────────┐
│  Main process                                                            │
│  ┌─────────────┐ ┌──────────────────┐ ┌──────────────────────────────┐   │
│  │ IPC layer   │ │ Extraction       │ │ Support services             │   │
│  │ (typed      │ │ Orchestrator     │ │ · archive-detect (magic+ext) │   │
│  │  channels,  │ │ · job manager    │ │ · fs-safety (paths, links)   │   │
│  │  input      │ │ · worker host    │ │ · disk-space preflight       │   │
│  │  validation)│ │ · job persistence│ │ · verification service       │   │
│  └─────────────┘ │ · recovery mgr   │ │ · structured logging         │   │
│                  └───────┬──────────┘ └──────────────────────────────┘   │
│                          │ MessagePort (throttled 100ms batches)        │
│  ┌───────────────────────▼────────────────────────────────────────────┐  │
│  │ utilityProcess worker (extraction-worker.ts)                       │  │
│  │ Owns engine processes: 7zz · bsdtar (system libarchive) · zstd     │  │
│  │ Streaming extraction only. Bounded concurrency (1 archive at a     │  │
│  │ time by default). Aggregates engine output → progress.             │  │
│  │ Passwords reach engines via stdin prompt, never argv, never logs.  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

Key decisions:

- **Extraction runs in an Electron `utilityProcess`**, not in main: a misbehaving or
  OOM-hitting worker can be killed and recovered without taking down the window or the
  job manager. The renderer never talks to the worker directly.
- **Workers spawn engine binaries** (`7zz`, `/usr/bin/bsdtar`, vendored `zstd`) as child
  processes with piped stdio. Engines do the compression math; we never reimplement
  algorithms. Memory ceiling is bounded by stream buffering of the engines, not Node heaps.
- **Progress contract**: worker → main via `MessagePort`, throttled to ≥100 ms batches;
  main → renderer via a single `job:event` channel. No per-chunk IPC.
- **Atomic finalization**: extraction always targets `<dest>/<ArchiveName>.unbox-partial-<id>`
  (or a hidden temp sibling); only after verification passes is it `rename(2)`d to the
  final name — atomic on APFS. "Completed" is only ever announced after the rename.
- **Jobs are persisted** (`jobs/<id>.json`, atomic write + fsync) through every state
  transition so a crash at any point leaves a recoverable, truthful record.

## B. Native extraction engine comparison

| Criterion | 7-Zip (`7zz` 23.01) | libarchive (`/usr/bin/bsdtar` 3.7.4) | Info-ZIP `unzip` | zstd CLI |
|---|---|---|---|---|
| License | LGPL-2.1 + unRAR restriction (redistributable with notice) | Apple system binary, consumed in place | Apple system binary | BSD + GPL-2 dual (vendored build, notice included) |
| Formats | 7z, ZIP, RAR/RAR5, ISO, CAB, WIM, ARJ, LZH, LZMA, Z, XAR, CPIO, DMG, MSI, RPM/DEB, NTFS/HFS/FAT images, split volumes (.7z.001/.zip.001/.z01/.rar.partNN) | tar, tar.gz, tar.bz2, tar.xz, cpio, pax, ISO (read), ZIP (read), 7z (read), single-stage gz/bz2/xz | ZIP only | .zst raw streams, .tar.zst (piped into bsdtar) |
| Integrity | CRC32 verified in-stream during extraction; `t` full test command; RAR5 BLAKE2/7z SHA-256 when present | block header checksums only + codec integrity (gzip CRC32, xz SHA-256, bz2 CRC32); no per-entry hashes for tar | CRC32 | optional frame content checksum (xxhash64); verified when present |
| Large-file behavior | streams, never full-load | streams | streams | streams (piped) |
| Multi-volume | yes (7z, zip, rar) | no | limited (.z01) | n/a |
| Encryption | 7z AES-256, ZipCrypto, AES-128/256 zip, RAR5 AES | no | ZipCrypto only | n/a |
| Unicode | strong (UTF-8, custom UTF-16 handling) | strong | weak (codepage) — avoided | strong |
| Weaknesses | no zstd; progress output is screen-oriented and must be parsed | no RAR5; no encryption; no multi-volume; Apple build lacks zstd/liblz4 | deprecated paths, weak unicode | single-codec only |

**Selection policy** (primary engine per family, with ordered fallbacks):

1. 7z / RAR / RAR5 / ISO / CAB / WIM / ARJ / LZH / LZMA / Z / multi-volume → **7zz**
2. ZIP (incl. encrypted, large, unicode) → **7zz** (unzip rejected: weak unicode, no AES)
3. tar, tar.gz/tgz, tar.bz2, tar.xz, cpio → **bsdtar** (native, streaming) — 7zz fallback
4. .zst / .tar.zst → **zstd CLI** (vendored) piped into bsdtar; if unavailable, format is
   reported **unsupported** (never a silent failure)
5. Compound single-file streams (.gz/.bz2/.xz of unknown inner type) → decode with the
   matching engine, then inner-type detection on the decoded stream, extracted via tar/cpio
   engines or raw-file write

Binary provenance and licensing: `7zz` is fetched by `scripts/fetch-engines.mjs` from
7-zip.org with a pinned SHA-256; the official LGPL text and unRAR restriction notice are
installed under `resources/licenses/`. zstd is built from the pinned upstream source
tarball (universal arm64+x64) by the same script; its license file is bundled. Neither
binary is modified.

## C. Format support matrix (honest capabilities)

| Format | Engine | List | Pre-test | CRC verify | Size verify | Password | Multi-volume | Notes / limits |
|---|---|---|---|---|---|---|---|---|
| zip | 7zz | ✅ | ✅ `t` | ✅ CRC32 in-stream | ✅ | ✅ ZipCrypto+AES | ✅ .zip/.z01 | Solid archives: progress is entry-quantized |
| 7z | 7zz | ✅ | ✅ `t` | ✅ CRC32 in-stream | ✅ | ✅ AES-256 | ✅ .7z.001 | Header-encoded archives with no sizes → progress indeterminate (declared) |
| rar / rar5 | 7zz | ✅ | ✅ `t` | ✅ in-stream | ✅ | ✅ | ✅ .part1.rar | RAR5 only extracts (per unRAR license terms) |
| tar | bsdtar | ✅ | ⚠ header checksums only | — | ✅ | — | — | tar header checksums are weak; stated, not overstated |
| tar.gz / tgz | bsdtar | ⚠ sizes after gzip pass | ⚠ codec CRC | codec CRC32 | ✅ post | — | — | uncompressed total known only from tar headers as read |
| tar.bz2 | bsdtar | ⚠ | ⚠ | codec CRC32 | ✅ post | — | — | bz2 cannot seek; full pass to list |
| tar.xz | bsdtar | ⚠ | ⚠ | xz SHA-256 (if indexed) | ✅ post | — | — | |
| gz / bz2 / xz (raw) | bsdtar+7zz | ⚠ | ⚠ | codec | ✅ post | — | — | inner type auto-detected after decode |
| zst / tar.zst | zstd+bsdtar | ⚠ | ⚠ if frame checksum | xxhash64 if present | ✅ post | — | — | unsupported at runtime if vendored engine missing |
| iso | 7zz | ✅ | ✅ | ⚠ ISO9660 has no per-file CRC (UDF may) | ✅ | — | — | verification level reported honestly |
| cab | 7zz | ✅ | ✅ | ✅ (MSZIP/LZX have CRC) | ✅ | — | — | |
| wim | 7zz | ✅ | ✅ | ✅ (WIM has SHA-1 table) | ✅ | — | — | |
| arj | 7zz | ✅ | ✅ | ✅ CRC32 | ✅ | ⚠ legacy | ⚠ | legacy format; tested best-effort |
| lzh | 7zz | ✅ | ✅ | ⚠ method-dependent | ✅ | — | — | |
| lzma / z | 7zz/bsdtar | — | ⚠ | ⚠ lzma has no frame CRC | ✅ post | — | — | raw codec streams |
| split (7z/zip/rar) | 7zz | ✅ | ✅ | per format | ✅ | per format | ✅ | missing-volume → explicit error naming the part |

Legend: ✅ verified capability · ⚠ best-effort, honestly labeled in UI/report · — not provided by format.

The UI displays the **verification level actually achieved**: `crc-verified`,
`size-verified-only`, `codec-verified`, or `unverified`. It never upgrades a label.

## D. Data-integrity strategy (highest priority)

1. **Preflight** — archive readable (streamed magic + size), destination volume space check
   (listed uncompressed size × 1.05 + padding; heuristic factor ×3 for unknown-size stream
   formats, re-checked every 4 GB during extraction), destination writability probe.
2. **Pre-test** — `7zz t` full archive test for formats that support it (default on;
   user may disable per job). Failures abort before a single file is written.
3. **Extraction** — engines verify embedded CRCs in-stream (7zz fails the entry on CRC
   mismatch and we fail the job per policy). Every engine stderr line is captured,
   classified, and included in the report.
4. **Post-verify** —
   - size check of every regular file against listing values (when listing available);
   - fsync of extracted tree (batched) before finalization;
   - symlink/hardlink audit (fs-safety);
   - expected-entry presence check (no silently missing files).
5. **Finalize** — atomic rename temp→final. Crash between rename and job-record update is
   reconciled by the recovery manager at next launch.
6. **Failure policy** — any failed entry ⇒ job outcome `failed` (or `completed-with-errors`
   only when the user explicitly chose "keep successful files"; successful files are always
   preserved and listed individually). Partial files are never labeled verified.
7. **Never**: delete the source archive · overwrite existing files automatically · claim
   verification the format cannot provide · report success on engine warnings we cannot
   classify (they downgrade to `completed-with-warnings` and are surfaced).

## E. Security threat model

| Threat | Mitigation |
|---|---|
| ZIP Slip / path traversal (`../`, absolute paths, `C:\`, NUL, unicode tricks) | Every listed entry name validated against a normalization+prefix engine before extraction; traversal entries abort the job with a named violation report |
| Symlink/hardlink escape | Post-extract audit: links resolving outside the workspace are removed and reported; archives containing such entries are flagged pre-extraction where listing exposes link info |
| Malicious archive fuzzing crashes engines | Engines run in throwaway utilityProcess children; parser bugs in engines do not compromise main; worker hard-kills on stall (watchdog) |
| Password exposure | Password kept in main-process memory only, delivered to engine via stdin prompt protocol; never in argv, env, logs, or job records |
| Renderer compromise | Sandbox on, node off, contextIsolation on, single validated IPC surface, no raw paths accepted from renderer for arbitrary reads |
| Arbitrary execution | No engine binary is executed from archive content; vendored binaries are SHA-256 pinned at fetch; no "open with" of extracted executables (Finder reveal only) |
| Quarantine bypass of extracted content | Files extracted by CLI engines don't inherit quarantine; we note this in diagnostics and never auto-launch extracted files |
| Overwrite of user data | Atomic temp+rename; if target exists the job resolves to `name-1`, `name-2` … or asks; nothing in the destination tree is ever deleted by the app except app-created temp dirs |
| Disk exhaustion mid-write | Preflight + ENOSPC classification + free-space watchdog; failure reported, partials quarantined for cleanup decision |
| TOCTOU on external drives | Destination volume identity re-checked after extraction (device id comparison); disconnect ⇒ loud failure, no silent truncation |

## F. Project folder structure

```
file_extract/
├── docs/ARCHITECTURE.md            # this document
├── package.json / electron.vite.config.ts / electron-builder.yml / vitest configs
├── scripts/fetch-engines.mjs       # 7zz download (SHA-256 pinned) + zstd source build
├── resources/                      # bin/ (vendored engines), licenses/, icon
├── src/
│   ├── shared/                     # types + format matrix shared by all layers
│   │   ├── ipc-contracts.ts  job-types.ts  formats.ts
│   ├── main/
│   │   ├── index.ts                # app lifecycle, secure window, single instance
│   │   ├── ipc.ts                  # typed handlers + validation
│   │   ├── services/
│   │   │   ├── engines/            # sevenzip.ts libarchive.ts zstd.ts registry.ts output-parser.ts
│   │   │   ├── archive-detect.ts   # magic bytes + extension → format id
│   │   │   ├── extraction/         # orchestrator.ts worker-host.ts job-store.ts recovery.ts
│   │   │   ├── fs-safety.ts        # path validation, link audit, temp workspaces
│   │   │   ├── disk-space.ts  verification.ts  logging.ts
│   │   └── worker/extraction-worker.ts
│   ├── preload/index.ts
│   └── renderer/
│       ├── index.html  src/main.tsx  src/App.tsx
│       ├── src/components/ui/      # vendored shadcn/ui primitives (new-york)
│       ├── src/components/         # DropZone, JobProgress, Summary, History, …
│       ├── src/stores/             # zustand
│       └── src/lib/                # formatters, ipc client, glass utilities
└── tests/
    ├── unit/                       # parsers, safety, store, formatters
    ├── integration/                # real engines against generated fixtures
    ├── heavy/                      # 1/10/50/100 GB, million-entry (env-gated)
    └── fixtures/builders.ts        # deterministic content + SHA-256 manifests
```

## G. Development milestones

| # | Milestone | Done means |
|---|---|---|
| 0 | Scaffold + engines vendored | `npm run engines` produces verified 7zz (+zstd); strict TS compiles; vitest runs |
| 1 | Engine layer | list/test/extract with progress, password, cancel; integration tests green on real fixtures |
| 2 | Safety services | traversal/symlink/disk-space/verification services with unit + integration tests |
| 3 | Orchestrator + IPC | jobs run in utilityProcess, persist, cancel, recover after simulated crash |
| 4 | Renderer | glass UI: drop/progress/completion flows driven by real IPC |
| 5 | Full test suite | incl. heavy tests (env-gated) actually asserting sizes/hashes/peak RSS |
| 6 | Packaging | electron-builder dmg (universal), signing/notarization docs, README limitations |
