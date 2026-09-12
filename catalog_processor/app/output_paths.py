"""
output_paths.py

Shared resolution of a writable output root.

Every visualization module writes generated images, caches and registry
files under <catalog_processor>/output. That is correct for local and
Docker runs, but serverless hosts mount the deployment read-only (Vercel
serves it from /var/task), so those writes fail with
OSError [Errno 30] Read-only file system.

This module only probes writability and never creates anything, so it is
safe to call while a module is still being imported.

It imports nothing from `app`, so any module can use it without creating
a circular import.
"""

from __future__ import annotations

from pathlib import Path

import os
import tempfile


FALLBACK_OUTPUT_ROOT = (
    Path(tempfile.gettempdir())
    / "casa-visualization-output"
)


def writable_output_root(preferred: Path | str) -> Path:
    """
    Return `preferred` when it sits on a writable filesystem.

    Otherwise return the equivalent location under the OS temp
    directory, preserving whatever path follows "output" so each
    caller keeps its own separate subtree.
    """

    preferred = Path(preferred)

    probe = preferred
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent

    if probe.exists() and os.access(probe, os.W_OK):
        return preferred

    parts = preferred.parts

    if "output" in parts:
        tail = Path(*parts[parts.index("output") + 1:])
    else:
        tail = Path(preferred.name)

    return FALLBACK_OUTPUT_ROOT / tail
