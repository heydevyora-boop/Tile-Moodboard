"""
final_bathroom_engine.py

FINAL BATHROOM ENGINE
PHASE 10

Combines:
    - Moodboard data
    - Fixture recommendations
    - Bathroom requirements
    - Product information

No Gemini API.
No Google Drive.
No Google Sheets.

This module is intentionally deterministic so that the final
bathroom-engine test can run offline.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional


# ============================================================
# CONSTANTS
# ============================================================

DEFAULT_OUTPUT_DIR = Path("output") / "final_bathroom"


# ============================================================
# HELPERS
# ============================================================

def _clean(value: Any) -> str:
    """Convert a value to a clean string."""
    if value is None:
        return ""

    return str(value).strip()


def _normalise_product(product: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize a fixture/product record without destroying
    the original information.
    """

    if not isinstance(product, dict):
        return {}

    normalized = dict(product)

    normalized["product_id"] = (
        normalized.get("product_id")
        or normalized.get("Product ID")
        or normalized.get("id")
        or ""
    )

    normalized["product_name"] = (
        normalized.get("product_name")
        or normalized.get("Product Name")
        or normalized.get("name")
        or ""
    )

    normalized["product_type"] = (
        normalized.get("product_type")
        or normalized.get("Product Type")
        or normalized.get("type")
        or ""
    )

    return normalized


def _extract_products(data: Any) -> List[Dict[str, Any]]:
    """
    Accept products from several possible structures.

    Supported:
        list
        {"products": [...]}
        {"fixtures": [...]}
        {"items": [...]}
    """

    if data is None:
        return []

    if isinstance(data, list):
        return [
            _normalise_product(item)
            for item in data
            if isinstance(item, dict)
        ]

    if isinstance(data, dict):

        for key in (
            "products",
            "fixtures",
            "items",
            "recommendations",
            "fixture_products",
        ):
            value = data.get(key)

            if isinstance(value, list):
                return [
                    _normalise_product(item)
                    for item in value
                    if isinstance(item, dict)
                ]

    return []


def _extract_moodboards(data: Any) -> List[Dict[str, Any]]:
    """
    Extract moodboards from several possible structures.
    """

    if data is None:
        return []

    if isinstance(data, list):
        return [
            item
            for item in data
            if isinstance(item, dict)
        ]

    if isinstance(data, dict):

        for key in (
            "moodboards",
            "moodboard",
            "boards",
        ):
            value = data.get(key)

            if isinstance(value, list):
                return [
                    item
                    for item in value
                    if isinstance(item, dict)
                ]

            if isinstance(value, dict):
                return [value]

    return []


# ============================================================
# BATHROOM REQUIREMENTS
# ============================================================

def default_bathroom_requirements() -> Dict[str, Any]:
    """
    Default bathroom requirements used by the offline engine.
    """

    return {
        "bathroom_required": True,
        "basin_required": True,
        "wc_required": True,
        "faucet_required": True,
        "shower_required": True,
        "bathroom_wall_required": True,
        "shower_area_required": True,
        "highlight_suitable": True,
    }


def normalize_bathroom_requirements(
    requirements: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Normalize bathroom requirements.
    """

    result = default_bathroom_requirements()

    if isinstance(requirements, dict):
        result.update(requirements)

    return result


# ============================================================
# FIXTURE GROUPING
# ============================================================

FIXTURE_TYPES = (
    "BASIN",
    "WC",
    "FAUCET",
    "SHOWER",
)


def _fixture_type(product: Dict[str, Any]) -> str:
    """
    Determine fixture type from a product record.
    """

    product_type = _clean(
        product.get("product_type")
    ).upper()

    if product_type:
        return product_type

    name = _clean(
        product.get("product_name")
    ).upper()

    for fixture_type in FIXTURE_TYPES:
        if fixture_type in name:
            return fixture_type

    return ""


def group_fixtures(
    products: List[Dict[str, Any]],
) -> Dict[str, List[Dict[str, Any]]]:
    """
    Group fixture products by bathroom fixture type.
    """

    grouped = {
        "BASIN": [],
        "WC": [],
        "FAUCET": [],
        "SHOWER": [],
    }

    for product in products:

        fixture_type = _fixture_type(product)

        if fixture_type in grouped:
            grouped[fixture_type].append(product)

    return grouped


# ============================================================
# SCORE
# ============================================================

def _get_score(product: Dict[str, Any]) -> float:
    """
    Extract a product score.

    Supports:
        score
        Score
        compatibility_score
        fixture_score
    """

    for key in (
        "score",
        "Score",
        "compatibility_score",
        "fixture_score",
    ):

        value = product.get(key)

        if value is None:
            continue

        try:
            return float(value)
        except (TypeError, ValueError):
            pass

    return 0.0


def sort_products_by_score(
    products: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Sort products from highest to lowest score.
    """

    return sorted(
        products,
        key=_get_score,
        reverse=True,
    )


# ============================================================
# SELECT BEST FIXTURES
# ============================================================

def select_best_fixtures(
    products: List[Dict[str, Any]],
) -> Dict[str, Optional[Dict[str, Any]]]:
    """
    Select the highest scoring product for each fixture type.
    """

    grouped = group_fixtures(products)

    selected = {
        "BASIN": None,
        "WC": None,
        "FAUCET": None,
        "SHOWER": None,
    }

    for fixture_type, items in grouped.items():

        if not items:
            continue

        ordered = sort_products_by_score(items)

        selected[fixture_type] = ordered[0]

    return selected


# ============================================================
# MOODBOARD NAME
# ============================================================

def _moodboard_name(
    moodboard: Dict[str, Any],
) -> str:
    """
    Extract moodboard name.
    """

    return _clean(
        moodboard.get("moodboard")
        or moodboard.get("Moodboard")
        or moodboard.get("name")
        or moodboard.get("Name")
        or "Bathroom Concept"
    )


# ============================================================
# BUILD FINAL BATHROOM
# ============================================================

def build_final_bathroom(
    moodboard: Optional[Dict[str, Any]] = None,
    fixture_products: Optional[List[Dict[str, Any]]] = None,
    bathroom_requirements: Optional[Dict[str, Any]] = None,
    products: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Build the final bathroom package.

    Parameters
    ----------
    moodboard:
        Moodboard metadata.

    fixture_products:
        Fixture-engine products.

    bathroom_requirements:
        Bathroom requirement flags.

    products:
        Alias for fixture_products.
    """

    if fixture_products is None:
        fixture_products = products

    fixture_products = fixture_products or []

    normalized_products = _extract_products(
        fixture_products
    )

    requirements = normalize_bathroom_requirements(
        bathroom_requirements
    )

    if moodboard is None:
        moodboard = {
            "name": "Bathroom Concept",
        }

    selected = select_best_fixtures(
        normalized_products
    )

    fixture_package: Dict[str, Any] = {}

    for fixture_type in FIXTURE_TYPES:

        product = selected.get(
            fixture_type
        )

        if product is None:
            fixture_package[fixture_type] = None
            continue

        fixture_package[fixture_type] = {
            "product_id": product.get(
                "product_id",
                "",
            ),
            "product_name": product.get(
                "product_name",
                "",
            ),
            "product_type": product.get(
                "product_type",
                fixture_type,
            ),
            "score": _get_score(product),
            "source": product,
        }

    available_count = sum(
        1
        for value in fixture_package.values()
        if value is not None
    )

    required_types = []

    if requirements.get("basin_required"):
        required_types.append("BASIN")

    if requirements.get("wc_required"):
        required_types.append("WC")

    if requirements.get("faucet_required"):
        required_types.append("FAUCET")

    if requirements.get("shower_required"):
        required_types.append("SHOWER")

    missing_types = [
        fixture_type
        for fixture_type in required_types
        if fixture_package.get(fixture_type) is None
    ]

    if not missing_types:
        status = "COMPLETED"
    else:
        status = "PARTIAL"

    result = {
        "status": status,

        "bathroom_type": "BATHROOM",

        "moodboard": {
            "name": _moodboard_name(moodboard),
            "source": moodboard,
        },

        "requirements": requirements,

        "fixtures": fixture_package,

        "fixture_count": available_count,

        "required_fixture_count": len(
            required_types
        ),

        "missing_fixtures": missing_types,

        "all_required_fixtures_available": (
            len(missing_types) == 0
        ),
    }

    return result


# ============================================================
# CREATE FINAL BATHROOM PACKAGES
# ============================================================

def create_final_bathroom_packages(
    moodboards: Any,
    fixture_products: Any,
    bathroom_requirements: Optional[
        Dict[str, Any]
    ] = None,
) -> List[Dict[str, Any]]:
    """
    Create a final bathroom package for every moodboard.
    """

    boards = _extract_moodboards(
        moodboards
    )

    products = _extract_products(
        fixture_products
    )

    packages = []

    for moodboard in boards:

        package = build_final_bathroom(
            moodboard=moodboard,
            fixture_products=products,
            bathroom_requirements=(
                bathroom_requirements
            ),
        )

        packages.append(package)

    return packages


# ============================================================
# SINGLE PACKAGE ALIAS
# ============================================================

def create_final_bathroom(
    moodboard: Optional[Dict[str, Any]] = None,
    fixture_products: Optional[
        List[Dict[str, Any]]
    ] = None,
    bathroom_requirements: Optional[
        Dict[str, Any]
    ] = None,
) -> Dict[str, Any]:
    """
    Convenience wrapper for creating one bathroom package.
    """

    return build_final_bathroom(
        moodboard=moodboard,
        fixture_products=fixture_products,
        bathroom_requirements=(
            bathroom_requirements
        ),
    )


# ============================================================
# VALIDATION
# ============================================================

def validate_final_bathroom(
    package: Dict[str, Any],
) -> bool:
    """
    Validate final bathroom package.
    """

    if not isinstance(package, dict):
        return False

    if "status" not in package:
        return False

    if "moodboard" not in package:
        return False

    if "fixtures" not in package:
        return False

    fixtures = package["fixtures"]

    if not isinstance(fixtures, dict):
        return False

    for fixture_type in FIXTURE_TYPES:

        if fixture_type not in fixtures:
            return False

    return True


# ============================================================
# SAVE JSON
# ============================================================

def save_final_bathroom(
    package: Dict[str, Any],
    output_path: Path | str,
) -> Path:
    """
    Save one final bathroom package as JSON.
    """

    output_path = Path(output_path)

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with output_path.open(
        "w",
        encoding="utf-8",
    ) as file:

        json.dump(
            package,
            file,
            indent=2,
            ensure_ascii=False,
        )

    return output_path


# ============================================================
# SAVE ALL PACKAGES
# ============================================================

def save_final_bathroom_packages(
    packages: List[Dict[str, Any]],
    output_dir: Path | str = DEFAULT_OUTPUT_DIR,
) -> List[Path]:
    """
    Save all final bathroom packages.
    """

    output_dir = Path(output_dir)

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    saved_files = []

    for index, package in enumerate(
        packages,
        start=1,
    ):

        moodboard = package.get(
            "moodboard",
            {},
        )

        name = _clean(
            moodboard.get("name")
        )

        if not name:
            name = f"bathroom_{index}"

        safe_name = "".join(
            character
            if character.isalnum()
            or character in (
                "-",
                "_",
            )
            else "_"
            for character in name
        )

        output_path = (
            output_dir
            / f"{safe_name}_final_bathroom.json"
        )

        saved_files.append(
            save_final_bathroom(
                package,
                output_path,
            )
        )

    return saved_files


# ============================================================
# PRINT SUMMARY
# ============================================================

def print_final_bathroom_summary(
    package: Dict[str, Any],
) -> None:
    """
    Print a readable final bathroom summary.
    """

    print("")
    print("=" * 70)
    print("FINAL BATHROOM PACKAGE")
    print("=" * 70)

    moodboard = package.get(
        "moodboard",
        {},
    )

    print(
        f"Moodboard: "
        f"{moodboard.get('name', 'Unknown')}"
    )

    print(
        f"Status: "
        f"{package.get('status', 'UNKNOWN')}"
    )

    print(
        f"Fixtures: "
        f"{package.get('fixture_count', 0)}"
        f"/"
        f"{package.get('required_fixture_count', 0)}"
    )

    print("")

    fixtures = package.get(
        "fixtures",
        {},
    )

    for fixture_type in FIXTURE_TYPES:

        fixture = fixtures.get(
            fixture_type
        )

        if fixture is None:

            print(
                f"{fixture_type}: NOT AVAILABLE"
            )

            continue

        print(
            f"{fixture_type}: "
            f"{fixture.get('product_name', '')} "
            f"(Score: "
            f"{fixture.get('score', 0):.0f})"
        )

    missing = package.get(
        "missing_fixtures",
        [],
    )

    if missing:

        print("")
        print(
            "Missing fixtures: "
            + ", ".join(missing)
        )

    print("=" * 70)
    print("")


# ============================================================
# SUMMARY ALIAS
# ============================================================

def package_summary(
    package: Dict[str, Any],
) -> None:
    """
    Compatibility alias.
    """

    print_final_bathroom_summary(
        package
    )


# ============================================================
# MAIN SELF TEST
# ============================================================

def main() -> None:

    print("")
    print("=" * 70)
    print("FINAL BATHROOM ENGINE SELF TEST")
    print("=" * 70)

    moodboards = [
        {
            "name": "Luxury Retreat",
            "style": "Luxury",
        },
        {
            "name": "Natural Retreat",
            "style": "Natural",
        },
        {
            "name": "Minimal Calm",
            "style": "Minimal",
        },
    ]

    fixture_products = [
        {
            "product_id": "BASIN-001",
            "product_name": "Modern Countertop Basin",
            "product_type": "BASIN",
            "score": 80,
        },
        {
            "product_id": "BASIN-002",
            "product_name": "Natural Stone Basin",
            "product_type": "BASIN",
            "score": 75,
        },
        {
            "product_id": "WC-001",
            "product_name": "Modern Wall Hung WC",
            "product_type": "WC",
            "score": 80,
        },
        {
            "product_id": "WC-002",
            "product_name": "Luxury Rimless WC",
            "product_type": "WC",
            "score": 65,
        },
        {
            "product_id": "FAUCET-001",
            "product_name": "Brushed Steel Basin Faucet",
            "product_type": "FAUCET",
            "score": 35,
        },
        {
            "product_id": "FAUCET-002",
            "product_name": "Bronze Natural Faucet",
            "product_type": "FAUCET",
            "score": 65,
        },
        {
            "product_id": "SHOWER-001",
            "product_name": "Modern Rain Shower",
            "product_type": "SHOWER",
            "score": 35,
        },
        {
            "product_id": "SHOWER-002",
            "product_name": "Natural Rain Shower",
            "product_type": "SHOWER",
            "score": 65,
        },
    ]

    packages = create_final_bathroom_packages(
        moodboards=moodboards,
        fixture_products=fixture_products,
    )

    if len(packages) != 3:
        raise RuntimeError(
            "Expected 3 final bathroom packages."
        )

    for package in packages:

        if not validate_final_bathroom(
            package
        ):
            raise RuntimeError(
                "Invalid final bathroom package."
            )

        print_final_bathroom_summary(
            package
        )

    saved = save_final_bathroom_packages(
        packages
    )

    print(
        f"[PASS] Saved {len(saved)} "
        "final bathroom packages."
    )

    print("")
    print("=" * 70)
    print("FINAL BATHROOM ENGINE TEST COMPLETE")
    print("=" * 70)
    print("")


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":
    main()