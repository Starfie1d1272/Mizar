# Broadcast pack contract

This package validates the version 1 manifest and verifies bytes supplied by a caller. The package digest is SHA-256 of the canonical JSON manifest, not the ZIP bytes. Duplicate JSON keys and invalid Unicode are rejected before hashing.

This is not an archive reader or an installer. Callers must independently enforce archive limits and safe member types, validate each domain payload and embedded dependency with its provider, and publish resources before creating drafts. Neither function changes active configuration or starts playback.
