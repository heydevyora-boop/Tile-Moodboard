"""
backend_sync.py

Bridges pen-drive-extracted products into the Node backend's Postgres
Tile table.

Why this exists
---------------
This service writes extracted products to the Google Sheets MASTER tab
and Drive. It has no Postgres client at all. Combination generation on
the Node side, meanwhile, reads exclusively from the Tile table:

    POST /api/mood-boards/generate
      -> promptBuilder.service.getAvailableTiles()
      -> tileRecommendation.service.getRecommendedTiles()
      -> prisma.tile.findMany(...)

So without this call the two halves never meet, and combinations can
only ever be built from catalogs uploaded through the UI -- never from
a pen drive.

Best-effort by design: a sync failure prints a warning and returns None
rather than raising, so a backend that is down or unconfigured can never
abort a catalog extraction that has already written to Sheets and Drive.
"""

import os

from typing import Any, Dict, Optional

import requests


# Base URL of the Node backend, including its API prefix.
BACKEND_SYNC_URL = os.getenv(
    "BACKEND_SYNC_URL",
    "http://localhost:5000/api/v1/catalog-extractor/master-sync",
)

# Shared secret matching the backend's INTERNAL_SYNC_API_KEY.
INTERNAL_SYNC_API_KEY = os.getenv(
    "INTERNAL_SYNC_API_KEY",
    "",
)

SYNC_TIMEOUT_SECONDS = 15

# Shorter than a real sync: this runs before any work has been done, so a
# backend that is simply down should be reported quickly rather than
# stalling the start of every run.
PREFLIGHT_TIMEOUT_SECONDS = 8


def preflight_internal_sync() -> tuple[bool, str]:
    """Checks BOTH halves of the internal sync before a run starts.

    The failure this exists to prevent is silent and expensive: the key is
    configured on the Python side but not on the Node side, so every
    product uploads to Drive and lands in MASTER, and only the Tile row --
    the thing combination generation actually reads -- is refused, 403 at
    a time, for the whole catalog. Discovering that after dozens of
    uploads means a half-synced catalog to reconcile; discovering it here
    costs one request.

    The probe deliberately sends an EMPTY body. The route runs internalAuth
    before its validator, so the auth outcome is already decided by the
    time the empty payload is rejected -- and productCode/brandName are
    both required, so this request cannot create or modify a Tile row
    whatever the auth result.

    Returns (ok, detail). ok=False means the Tile-row half of the pipeline
    will not work this run; the caller decides whether to continue.
    """
    if not INTERNAL_SYNC_API_KEY:
        return False, (
            "INTERNAL SYNC CONFIGURATION ERROR:\n"
            "INTERNAL_SYNC_API_KEY is missing on catalog_processor\n"
            "  Set it in catalog_processor/.env to the same value as the "
            "backend's INTERNAL_SYNC_API_KEY.\n"
            "  Without it, extracted tiles reach Drive and the MASTER "
            "sheet but never become Tile rows,\n"
            "  so they cannot be used in mood board combinations."
        )

    try:
        response = requests.post(
            BACKEND_SYNC_URL,
            json={},
            headers={"x-internal-key": INTERNAL_SYNC_API_KEY},
            timeout=PREFLIGHT_TIMEOUT_SECONDS,
        )
    except Exception as exc:  # noqa: BLE001 -- a preflight must never raise
        return False, (
            "INTERNAL SYNC CONFIGURATION ERROR:\n"
            f"the backend at {BACKEND_SYNC_URL} is unreachable ({exc})\n"
            "  Start the Node backend, or correct BACKEND_SYNC_URL in "
            "catalog_processor/.env."
        )

    if response.status_code == 403:
        body = (response.text or "").lower()

        if "not configured" in body or "is unset" in body:
            return False, (
                "INTERNAL SYNC CONFIGURATION ERROR:\n"
                "INTERNAL_SYNC_API_KEY is missing on backend\n"
                "  catalog_processor has a key, but the Node backend does "
                "not, so it refuses every sync.\n"
                "  Set INTERNAL_SYNC_API_KEY in backend/.env (local) or the "
                "Vercel project environment\n"
                "  (production) to the same value catalog_processor uses, "
                "then restart the backend."
            )

        return False, (
            "INTERNAL SYNC CONFIGURATION ERROR:\n"
            "INTERNAL_SYNC_API_KEY does not match between catalog_processor "
            "and backend\n"
            "  Both sides have a key configured, but they differ. Make them "
            "identical, then restart the backend."
        )

    # Anything else means the request got past internalAuth -- including
    # the 400 the empty body earns, which is the expected success signal.
    return True, (
        f"internal sync OK -- backend at {BACKEND_SYNC_URL} accepted the "
        f"shared key"
    )


def sync_master_product_to_backend(
    product_code: str,
    brand: str,
    product_name: str = "",
    image_url: str = "",
    size: str = "",
    finish: str = "",
    color_tone: str = "",
    best_room: str = "",
    collection: str = "",
) -> Optional[Dict[str, Any]]:
    """
    POST one MASTER product to the backend so it becomes eligible for
    combination generation.

    Returns the parsed response on success, or None if the sync was
    skipped or failed. Never raises.
    """

    if not INTERNAL_SYNC_API_KEY:
        print(
            "  [backend_sync] SKIPPED: INTERNAL_SYNC_API_KEY is not set. "
            "This product will reach Sheets/Drive but will NOT be "
            "available for combinations."
        )
        return None

    product_code = str(product_code or "").strip()
    brand = str(brand or "").strip()

    if not product_code or not brand:
        print(
            f"  [backend_sync] SKIPPED: productCode and brand are both "
            f"required (got productCode={product_code!r}, brand={brand!r})."
        )
        return None

    payload: Dict[str, Any] = {
        "productCode": product_code,
        "brandName": brand,
    }

    # Only send fields that actually carry a value. MASTER rows are
    # written before classification, so most of these are blank at this
    # stage and the backend schema treats them as optional.
    optional_fields = {
        "productName": product_name,
        "imageUrl": image_url,
        "size": size,
        "finish": finish,
        "colorTone": color_tone,
        "bestRoom": best_room,
        "collection": collection,
    }

    for key, value in optional_fields.items():
        value = str(value or "").strip()
        if value:
            payload[key] = value

    try:

        response = requests.post(
            BACKEND_SYNC_URL,
            json=payload,
            headers={"x-internal-key": INTERNAL_SYNC_API_KEY},
            timeout=SYNC_TIMEOUT_SECONDS,
        )

    except Exception as exc:  # noqa: BLE001 -- sync must never abort extraction
        print(
            f"  [backend_sync] FAILED for {product_code}: {exc}"
        )
        return None

    if response.status_code in (200, 201):
        print(
            f"  [backend_sync] OK: {product_code} is now available for "
            f"combinations."
        )
        return response.json()

    print(
        f"  [backend_sync] FAILED for {product_code}: "
        f"HTTP {response.status_code} {response.text[:300]}"
    )
    return None
