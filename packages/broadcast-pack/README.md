# Broadcast pack contract

This package validates the version 1 manifest and verifies bytes supplied by a caller. The package digest is SHA-256 of the canonical JSON manifest, not the ZIP bytes. Duplicate JSON keys and invalid Unicode are rejected before hashing.

The ZIP32 reader checks archive structure, bounded expansion, CRC and the manifest file list without extracting to disk. It does not authorize or install a package. Callers must validate safe member types, each domain payload and embedded dependency with its provider, and publish resources before creating drafts. The ZIP32 writer checks the manifest and supplied bytes before producing a deterministic stored archive. These functions do not change active configuration or start playback.

`analyzePackDrafts` verifies the complete envelope first, then reports each module and preset separately, including preset bindings. `prepare` constructs only selected entries whose templates can be decoded, with independent module copies for each preset. Provider availability and the persistent import index remain the caller's responsibility; the caller must reanalyze at commit and report skipped entries. Missing local dependencies do not authorize replacing or disabling a preset binding.
