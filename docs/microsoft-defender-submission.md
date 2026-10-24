# Duprove: technical description for Microsoft Defender review

I am the author of Duprove, a personal school project developed by me as an
individual student. I am not representing a company. I am requesting a review
of a suspected false-positive detection affecting my application.

Scope: this description was checked against the current source tree on 24 October
2026 (package version 1.0.0). It describes the implemented application, rather
than certifying that a particular executable matches these sources. The submitted
file's name, SHA-256, detection name and Defender security intelligence version
must be recorded separately for that sample.

## Application purpose and components

Duprove is an open-source desktop duplicate-file analysis application licensed
under GPL-3.0-only. The user selects drives and starts the analysis. The current
analysis reads scanned files without modifying, deleting, moving or encrypting
them.

Iteration 2 adds a separate, explicitly confirmed recycle-bin operation for
user-marked duplicates. It resolves paths from a local results catalog, protects
the selected original and rechecks both files. Linux/macOS use Electron
`shell.trashItem`; Windows uses a separate native IFileOperation adapter without
an elevation prompt or connected-file deletion. It has no permanent-deletion fallback. This operation is
separate from scanning; current verification and limitations are recorded in
`docs/iteration2-results.md`. The draft is not a clean verdict for the current EXE.

The desktop interface and application services use TypeScript, React 19.2.0,
React DOM 19.2.0, HTML/CSS, Electron 44.7.1 and Ajv 8.20.0. Electron starts the
bundled C++17 executable `duprove-analyzer.exe` to enumerate drives and analyze
selected locations. They exchange JSON through local standard-input/output
pipes. No network client or child-process launcher is implemented in the native
analyzer; HTTPS operations and update installation belong to the Electron
application.

The same bundled native executable also implements bounded previews, paired
revalidation and the Windows-only recycle operation described above. The Windows
operation uses IFileOperation with an explicit no-elevation policy and checks
whether the item can be recycled before allowing the delete operation to proceed.

## Libraries and build tools

- SQLite 3.50.4: the local file index and comparison cache.
- nlohmann/json 3.12.0: native JSON parsing and serialization.
- PicoSHA2: SHA-256 hashing.
- miniz and pugixml: DOCX ZIP/XML parsing in memory.
- cmark: Markdown parsing.
- LodePNG and libjpeg-turbo: PNG/JPEG decoding for content comparison.
- Ajv: validation of the statistical report against JSON Schema.
- Transitive JavaScript runtime dependencies present in the reviewed installation:
  fast-deep-equal 3.1.3, fast-uri 3.1.8, json-schema-traverse 1.0.0,
  require-from-string 2.0.2 and scheduler 0.27.0.
- TypeScript, Vite, esbuild, CMake and Node.js 24: development and build tools.
- electron-builder and NSIS: Windows packaging and installation.
- @resvg/resvg-js: build-time application icon generation.

The optional statistics receiver is a separate Python service using `jsonschema`
4.26.0, Gunicorn 26.2.0 and SQLite, with an Nginx HTTPS proxy and Docker Compose.
Its Docker image uses Python 3.12; the reviewed local development environment
uses Python 3.14. Python is not required by the packaged desktop application's
analysis path. C++ dependencies are pinned to versions or commits in CMake;
several downloaded source archives also have SHA-256 checks.
The complete npm dependency lockfile is `package-lock.json`; native source
versions/commits and download hashes are declared in the CMake files.

## Data read from the computer

- Available drive paths/names, capacity and free space, and standard user-folder
  locations supplied by the operating system.
- Directory entries, file names and full paths, extensions, sizes, modification
  and change timestamps, and filesystem identifiers within selected locations.
- File bytes for SHA-256 hashing and byte-by-byte duplicate verification. Any
  accessible regular file within those locations may be read, including personal
  files; analysis is not limited to a non-sensitive file-type allowlist.
- If the user enables content comparison: text from TXT, Markdown and DOCX files,
  and decoded pixels from PNG/JPEG images. Parsing does not launch Office,
  execute document macros or execute scanned files.

The Windows scanner excludes the Windows directory, standard root-level Program
Files/ProgramData/recovery directories, Recycle Bin, System Volume Information,
paging/hibernation files and its private analysis directory. Ordinary symlinks
and reparse-point entries are skipped. Access failures are reported rather than
bypassed. Scans can produce sustained disk reads; the implementation includes
read throttling and a maximum of four parallel hashing workers.

## Local storage and retention

Application-managed records are stored under Electron's per-user `userData`
directory, normally `%APPDATA%\Duprove` on Windows:

- `analysis/work/index.sqlite`: file paths/names, metadata, filesystem identities,
  hashes, duplicate membership, content fingerprints and comparison relationships.
  Extracted document text and decoded image buffers are processed in memory and
  are not stored in this index as document/image copies.
- `analysis/job.json`, `analysis/input.json` and `analysis/content.json`: selected
  roots, job settings/progress, recovery state and content-comparison results.
- `analysis/results/catalog.sqlite`: the latest local groups, paths, metadata,
  original selections, decisions and recycle-bin attempt states, limited to
  128 MiB and 30 days of access; expired catalogs are removed when accessed.
- `analysis/reports/*.json` and `analysis/delivery/*.json`: statistical reports,
  local authorization metadata and delivery/retry state.
- `statistics-consent.json`: the statistics setting and its local authorization
  record. Theme and load-mode preferences use renderer local storage.
- `updates/`: downloaded installers, update state and temporary recovery copies.

These SQLite/JSON records have no application-level encryption; filesystem
permissions protect access. Small JSON records are written through temporary
files and replacement. Diagnostic records use fixed codes and counts; arbitrary
analyzer stderr and example file paths are not logged. Selected roots and file
paths still exist in the private records listed above.

After a successfully completed analysis and successful results-catalog capture,
the working index is deleted if larger than 5 MiB. Smaller completed indexes,
interrupted indexes and indexes whose catalog could not be saved are retained.
There is no general time-based expiration for local reports or unfinished work.
SQLite can also create temporary work files in the operating system's temporary
directory.

## Statistics transmission

Statistics transmission is enabled by default on first launch. This default is
recorded separately from an explicit user decision. The user can disable it in
Settings, and a saved refusal is preserved across updates. Sending also requires
a configured `DUPROVE_REPORT_URL`; an unconfigured build keeps reports locally.
Packaged applications do not read a development `.env` file.

The Electron application sends JSON using HTTPS `POST /v1/reports`, with
certificate verification and TLS 1.2 or later. The report is schema-validated
before transmission; unknown fields are rejected. The payload contains:

- Counts of files, empty files, duplicate members, duplicate groups and extra
  copies, plus file-extension distributions.
- Per-report numeric disk indexes and counts by broad location categories:
  Downloads, Documents, Videos, Pictures, Music, Desktop and one combined
  `custom` category.
- Duplicate-group distributions and a schema version/completeness flag.

The report does not include file contents, names, full paths, file hashes,
individual file sizes/timestamps, volume names/serial numbers, custom folder
names/structure, local job identifiers or the local authorization identifier.
Extension strings are sent literally and may contain user-chosen text; this is
not a guarantee that every report is unidentifiable.

A random per-report UUID is sent as an `Idempotency-Key` to prevent duplicate
counting. It is not a stable user/device identifier. Delivery has bounded retries
and a 24-hour retry window. Disabling statistics cancels in-flight requests and
excludes pending reports from future delivery; re-enabling allows newly created
reports, without resending reports from an earlier authorization period. Already
transmitted bytes cannot be recalled by the application.

The receiving server necessarily sees the connection's source IP. In the supplied
deployment configuration, Nginx uses IP addresses for in-memory rate limiting,
access logging is disabled, and IP/user-agent/cookie headers are not forwarded to
the receiver. The receiver stores the validated statistical JSON, receipt ID and
receipt time in SQLite, with a default 30-day retention policy and a periodic
cleanup service. This describes the supplied configuration, not an independently
verified live deployment.

## Updates, installation and startup

Supported managed installations automatically check `frdkss/Duprove` releases
on GitHub. HTTPS update requests are limited to `api.github.com`, `github.com`,
`release-assets.githubusercontent.com` and `objects.githubusercontent.com`.
They retrieve release metadata and application packages, without attaching
analysis reports. The updater checks an Ed25519-signed manifest and the package's
expected size and SHA-512 hash.

A downloaded update waits until analysis is inactive, then schedules an automatic
restart with a 60-second notification. On Windows, a bundled PowerShell helper
runs with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, starts the
verified NSIS installer silently for the current user, and restarts the app.
`ExecutionPolicy Bypass` is a parameter of that helper process; it does not change
the machine's persistent execution-policy configuration or Defender settings.
The helper creates and removes application recovery copies and can restore the
previous application files if startup fails.

The Windows installer is configured for per-user installation without elevation.
Optional start-at-login is controlled in application Settings using Electron's
login-item API. Closing the window during an active scan can keep the application
running in the visible system tray. The Help action opens `https://duprove.site/`
in the default browser.

Windows executable signing is disabled in the current packaging configuration
(`win.signExecutable: false`). Update-manifest signatures are separate from
Windows Authenticode signatures. This description does not establish the reason
for a Defender detection or claim that Microsoft has confirmed a false positive.

## Existing submission and request for reconsideration

The user-provided portal screenshot identifies submission
`577b0c29-20c5-434e-8526-5baf17e998d8` for `duprove-analyzer.exe` as Completed.
The analyst's comment states that the files meet Microsoft's malware criteria
and that the detection will remain in place. The detection shown in the related
results screenshot is `Trojan:Win64/Tedy.PGL!MTB`.

The results table also shows child entries named `1` and `.fptable` as Not malware,
while several other entries display Pending. Definition versions differ between
rows. Those child-entry results do not supersede the completed submission's
analyst decision. The screenshots do not establish the specific technical reason
for the classification or identify the sample by its SHA-256.

I am requesting manual reconsideration of that decision in light of the supplied
source code, complete application and technical explanation. Please identify the
specific behavior or component that meets the malware criteria so I can
understand and address the concern.

## Microsoft criteria and limits of this explanation

Reference: [Microsoft's malware and unwanted-software criteria](https://learn.microsoft.com/ru-ru/defender-xdr/criteria).

Relevant sections include user choice, user control, and installation/removal.
The user selects scan targets and can pause or stop analysis; scanned files are
read without being modified. The native analyzer implements file analysis,
without a network client or child-process launcher. These are source-based facts
offered for review, rather than a claim of complete compliance or certification.

Microsoft also calls for notice and consent for data storage/transmission. The
current statistics implementation enables sending on first launch without a
separate affirmative action, subject to an endpoint being configured. A settings
switch is provided, but its existence alone does not establish that consent has
been obtained. Automatic update installation also has no dedicated disable/cancel
control in the current interface. These authorization and disclosure issues need
assessment against the criteria; they are not established causes of the Tedy
classification. The installer notice inconsistency below is another limitation.

Please identify the particular observed behavior and applicable criterion behind
the completed malware determination, so the concern can be addressed precisely.

## Known disclosure inconsistency

The current Windows installer notice in `installer/installer.nsh` still contains
an outdated sentence stating that network transmission is not implemented.
The reviewed source implements conditional HTTPS statistics transmission as
described above. The installer text needs to be brought into agreement with that
behavior before publishing a release based on these sources.

## Source references

- `package.json`, `native/CMakeLists.txt`, `native/cmake/content-dependencies.cmake`
- `native/src/platform.cpp`, `native/src/file_access.cpp`, `native/src/scanner.cpp`
- `native/src/content.cpp`, `native/src/content_text.cpp`, `native/src/content_docx.cpp`
- `electron/main.ts`, `electron/services/job-service.ts`, `electron/services/local-json.ts`
- `contracts/report.schema.json`, `electron/services/report-service.ts`
- `electron/services/consent-service.ts`, `electron/services/delivery-service.ts`
- `electron/services/report-transport.ts`, `electron/services/update-transport.ts`
- `electron/services/update-service.ts`, `electron/services/update-installer.ts`
- `installer/update-windows.ps1`, `electron/services/autostart.ts`
- `backend/duprove_backend/settings.py`, `backend/duprove_backend/storage.py`
- `backend/deploy/nginx.conf`, `backend/deploy/gunicorn.conf.py`, `backend/deploy/compose.yaml`
