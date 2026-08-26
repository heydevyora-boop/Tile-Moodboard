"""
MASTER PIPELINE INTEGRATION
===========================

Connects the existing catalog pipeline to the
MASTER Google Sheet.

This module does NOT replace catalog_pipeline.py.

Flow:

Google Sheets MASTER
        ↓
google_master_loader.py
        ↓
MasterPipelineContext
        ↓
Existing Catalog Pipeline

Important:
- MASTER is read-only in this phase.
- No existing catalog extraction logic is changed.
- No Gemini call is added here.
- No recommendation engine is changed.
"""

from pathlib import Path
from typing import Any, Dict, List, Optional

from google_master_loader import (
    load_master_records,
    group_master_records,
)


# ============================================================
# CONFIGURATION
# ============================================================

SPREADSHEET_ID = (
    "1y4Ix3erUgmkefN50BFkd-nomAwZyngU7rOCa3Nk1ulI"
)

MASTER_SHEET_NAME = "MASTER"


# ============================================================
# NORMALIZATION
# ============================================================

def clean(value: Any) -> str:
    """
    Convert a Google Sheet value into clean text.
    """

    if value is None:
        return ""

    return str(value).strip()


def upper(value: Any) -> str:
    """
    Return normalized uppercase text.
    """

    return clean(value).upper()


# ============================================================
# MASTER PIPELINE CONTEXT
# ============================================================

class MasterPipelineContext:
    """
    Holds all MASTER records needed by the catalog pipeline.
    """

    def __init__(
        self,
        records: List[Dict[str, Any]]
    ):

        self.records = records

        self.groups = group_master_records(
            records
        )

        self.catalogs = self.groups.get(
            "CATALOG",
            []
        )

        self.products = self.groups.get(
            "PRODUCT",
            []
        )

        self.requirements = self.groups.get(
            "REQUIREMENT",
            []
        )

        self.fixtures = self.groups.get(
            "FIXTURE",
            []
        )

        self.moodboards = self.groups.get(
            "MOODBOARD",
            []
        )

        self.recommendations = self.groups.get(
            "RECOMMENDATION",
            []
        )

        self.designs = self.groups.get(
            "DESIGN",
            []
        )

        self.runs = self.groups.get(
            "RUN",
            []
        )


# ============================================================
# LOAD MASTER
# ============================================================

def load_master_context(
    spreadsheet_id: str = SPREADSHEET_ID,
    sheet_name: str = MASTER_SHEET_NAME,
) -> MasterPipelineContext:
    """
    Load MASTER Google Sheet and create pipeline context.
    """

    print("")
    print("=" * 70)
    print("LOADING MASTER GOOGLE SHEET")
    print("=" * 70)

    records = load_master_records(
        spreadsheet_id=spreadsheet_id,
        sheet_name=sheet_name,
    )

    if not records:

        raise RuntimeError(
            "MASTER Google Sheet returned no records."
        )

    context = MasterPipelineContext(
        records
    )

    print("")
    print(
        f"MASTER records loaded: "
        f"{len(context.records)}"
    )

    print("")
    print("MASTER DATA")

    print(
        f"  Catalogs: "
        f"{len(context.catalogs)}"
    )

    print(
        f"  Products: "
        f"{len(context.products)}"
    )

    print(
        f"  Requirements: "
        f"{len(context.requirements)}"
    )

    print(
        f"  Fixtures: "
        f"{len(context.fixtures)}"
    )

    print(
        f"  Moodboards: "
        f"{len(context.moodboards)}"
    )

    print(
        f"  Recommendations: "
        f"{len(context.recommendations)}"
    )

    print(
        f"  Designs: "
        f"{len(context.designs)}"
    )

    print(
        f"  Runs: "
        f"{len(context.runs)}"
    )

    return context


# ============================================================
# CATALOG LOOKUP
# ============================================================

def find_catalog(
    context: MasterPipelineContext,
    catalog_id: str,
) -> Optional[Dict[str, Any]]:
    """
    Find a CATALOG record by Catalog ID.
    """

    target = upper(catalog_id)

    for catalog in context.catalogs:

        current = upper(
            catalog.get("Catalog ID")
        )

        if current == target:

            return catalog

        current_record_id = upper(
            catalog.get("Record ID")
        )

        if current_record_id == target:

            return catalog

    return None


# ============================================================
# PRODUCT LOOKUP
# ============================================================

def find_product(
    context: MasterPipelineContext,
    product_id: str,
) -> Optional[Dict[str, Any]]:
    """
    Find a PRODUCT record by Product ID.
    """

    target = upper(product_id)

    for product in context.products:

        current = upper(
            product.get("Product ID")
        )

        if current == target:
            return product

        current_record_id = upper(
            product.get("Record ID")
        )

        if current_record_id == target:
            return product

    return None


# ============================================================
# REQUIREMENT LOOKUP
# ============================================================

def find_requirement(
    context: MasterPipelineContext,
    requirement_id: str,
) -> Optional[Dict[str, Any]]:
    """
    Find a REQUIREMENT record.
    """

    target = upper(requirement_id)

    for requirement in context.requirements:

        current = upper(
            requirement.get(
                "Requirement ID"
            )
        )

        if current == target:
            return requirement

        current_record_id = upper(
            requirement.get(
                "Record ID"
            )
        )

        if current_record_id == target:
            return requirement

    return None


# ============================================================
# FIXTURE LOOKUP
# ============================================================

def find_fixture(
    context: MasterPipelineContext,
    fixture_id: str,
) -> Optional[Dict[str, Any]]:
    """
    Find a FIXTURE record.
    """

    target = upper(fixture_id)

    for fixture in context.fixtures:

        current = upper(
            fixture.get("Fixture ID")
        )

        if current == target:
            return fixture

        current_record_id = upper(
            fixture.get("Record ID")
        )

        if current_record_id == target:
            return fixture

    return None


# ============================================================
# PRODUCTS FOR CATALOG
# ============================================================

def get_catalog_products(
    context: MasterPipelineContext,
    catalog_id: str,
) -> List[Dict[str, Any]]:
    """
    Return all products belonging to a catalog.
    """

    target = upper(catalog_id)

    products = []

    for product in context.products:

        product_catalog = upper(
            product.get("Catalog ID")
        )

        if product_catalog == target:

            products.append(product)

    return products


# ============================================================
# PRODUCTS FOR SPACE
# ============================================================

def get_products_for_space(
    context: MasterPipelineContext,
    space: str,
) -> List[Dict[str, Any]]:
    """
    Return products compatible with a space.

    This is a basic deterministic filter.
    """

    target = upper(space)

    products = []

    for product in context.products:

        product_space = upper(
            product.get("Space")
        )

        compatible_spaces = upper(
            product.get(
                "Compatible Spaces"
            )
        )

        if product_space == target:

            products.append(product)

            continue

        if target and target in compatible_spaces:

            products.append(product)

    return products


# ============================================================
# REQUIREMENT → CANDIDATE PRODUCTS
# ============================================================

def get_candidate_products(
    context: MasterPipelineContext,
    requirement_id: str,
) -> List[Dict[str, Any]]:
    """
    Get candidate products from MASTER for a requirement.

    Current phase:
        - Space
        - Category
        - Style
        - Color
        - Tone
        - Material
        - Finish

    Budget is optional because your current MASTER
    test did not require it.
    """

    requirement = find_requirement(
        context,
        requirement_id,
    )

    if requirement is None:

        raise ValueError(
            f"Requirement not found: "
            f"{requirement_id}"
        )

    candidates = []

    requirement_space = upper(
        requirement.get("Space")
    )

    requirement_style = upper(
        requirement.get("Style")
    )

    requirement_color = upper(
        requirement.get("Color")
    )

    requirement_tone = upper(
        requirement.get("Tone")
    )

    requirement_material = upper(
        requirement.get("Material")
    )

    requirement_finish = upper(
        requirement.get("Finish")
    )

    for product in context.products:

        # ----------------------------------------------------
        # SPACE
        # ----------------------------------------------------

        product_space = upper(
            product.get("Space")
        )

        compatible_spaces = upper(
            product.get(
                "Compatible Spaces"
            )
        )

        if requirement_space:

            if (
                product_space != requirement_space
                and requirement_space
                not in compatible_spaces
            ):
                continue

        # ----------------------------------------------------
        # STYLE
        # ----------------------------------------------------

        if requirement_style:

            product_style = upper(
                product.get("Style")
            )

            if (
                product_style
                and product_style != requirement_style
            ):
                continue

        # ----------------------------------------------------
        # COLOR
        # ----------------------------------------------------

        if requirement_color:

            product_color = upper(
                product.get("Color")
            )

            if (
                product_color
                and product_color != requirement_color
            ):
                continue

        # ----------------------------------------------------
        # TONE
        # ----------------------------------------------------

        if requirement_tone:

            product_tone = upper(
                product.get("Tone")
            )

            if (
                product_tone
                and product_tone != requirement_tone
            ):
                continue

        # ----------------------------------------------------
        # MATERIAL
        # ----------------------------------------------------

        if requirement_material:

            product_material = upper(
                product.get("Material")
            )

            if (
                product_material
                and product_material != requirement_material
            ):
                continue

        # ----------------------------------------------------
        # FINISH
        # ----------------------------------------------------

        if requirement_finish:

            product_finish = upper(
                product.get("Finish")
            )

            if (
                product_finish
                and product_finish != requirement_finish
            ):
                continue

        candidates.append(product)

    return candidates


# ============================================================
# PIPELINE MASTER CONTEXT
# ============================================================

def build_pipeline_context(
    pdf_path: str,
) -> MasterPipelineContext:
    """
    Load MASTER and verify that the catalog represented
    by the PDF exists or can be identified.

    PDF hierarchy remains owned by the existing pipeline.
    """

    pdf = Path(pdf_path)

    if not pdf.exists():

        raise FileNotFoundError(
            f"PDF not found: {pdf}"
        )

    context = load_master_context()

    catalog_name = pdf.stem.strip()

    print("")
    print(
        f"Pipeline catalog: "
        f"{catalog_name}"
    )

    # --------------------------------------------------------
    # Find catalog by name
    # --------------------------------------------------------

    matched_catalog = None

    for catalog in context.catalogs:

        name = clean(
            catalog.get("Name")
        )

        if (
            name.lower()
            == catalog_name.lower()
        ):

            matched_catalog = catalog
            break

    if matched_catalog:

        print(
            "MASTER catalog match: FOUND"
        )

        print(
            "Catalog ID:",
            matched_catalog.get(
                "Catalog ID",
                ""
            )
        )

        print(
            "Catalog Name:",
            matched_catalog.get(
                "Name",
                ""
            )
        )

    else:

        print(
            "MASTER catalog match: "
            "NOT FOUND"
        )

        print(
            "This is allowed for now."
        )

        print(
            "The existing catalog extraction "
            "pipeline remains responsible for "
            "creating/cataloging new catalogs."
        )

    return context


# ============================================================
# PRINT PIPELINE MASTER SUMMARY
# ============================================================

def print_pipeline_master_summary(
    context: MasterPipelineContext,
):
    """
    Print a compact MASTER summary.
    """

    print("")
    print("=" * 70)
    print("MASTER → PIPELINE CONTEXT")
    print("=" * 70)

    print(
        f"Records:          "
        f"{len(context.records)}"
    )

    print(
        f"Catalogs:         "
        f"{len(context.catalogs)}"
    )

    print(
        f"Products:         "
        f"{len(context.products)}"
    )

    print(
        f"Requirements:     "
        f"{len(context.requirements)}"
    )

    print(
        f"Fixtures:         "
        f"{len(context.fixtures)}"
    )

    print(
        f"Moodboards:       "
        f"{len(context.moodboards)}"
    )

    print(
        f"Recommendations:  "
        f"{len(context.recommendations)}"
    )

    print(
        f"Designs:          "
        f"{len(context.designs)}"
    )

    print(
        f"Runs:             "
        f"{len(context.runs)}"
    )

    print("=" * 70)


# ============================================================
# TEST
# ============================================================

if __name__ == "__main__":

    print("")
    print("=" * 70)
    print("MASTER → CATALOG PIPELINE INTEGRATION TEST")
    print("=" * 70)

    context = load_master_context()

    # --------------------------------------------------------
    # BASIC CHECK
    # --------------------------------------------------------

    assert len(context.records) > 0, (
        "MASTER returned no records."
    )

    print("")
    print(
        "MASTER LOAD: PASSED"
    )

    # --------------------------------------------------------
    # CATALOG CHECK
    # --------------------------------------------------------

    if context.catalogs:

        catalog = context.catalogs[0]

        print("")
        print("CATALOG CHECK: PASSED")

        print(
            "Catalog ID:",
            catalog.get(
                "Catalog ID",
                catalog.get(
                    "Record ID",
                    ""
                )
            )
        )

        print(
            "Name:",
            catalog.get(
                "Name",
                ""
            )
        )

    else:

        print(
            "CATALOG CHECK: "
            "NO CATALOG RECORD"
        )

    # --------------------------------------------------------
    # PRODUCT CHECK
    # --------------------------------------------------------

    print("")
    print(
        f"PRODUCTS LOADED: "
        f"{len(context.products)}"
    )

    for product in context.products[:5]:

        print(
            "  ",
            product.get(
                "Product ID",
                ""
            ),
            "-",
            product.get(
                "Name",
                ""
            )
        )

    # --------------------------------------------------------
    # REQUIREMENT CHECK
    # --------------------------------------------------------

    if context.requirements:

        requirement = context.requirements[0]

        requirement_id = (
            requirement.get(
                "Requirement ID"
            )
            or requirement.get(
                "Record ID"
            )
        )

        print("")
        print(
            "REQUIREMENT FOUND:",
            requirement_id
        )

        candidates = get_candidate_products(
            context,
            requirement_id,
        )

        print(
            "CANDIDATE PRODUCTS:",
            len(candidates)
        )

        for candidate in candidates[:10]:

            print(
                "  ",
                candidate.get(
                    "Product ID",
                    ""
                ),
                "-",
                candidate.get(
                    "Name",
                    ""
                )
            )

    else:

        print(
            "No REQUIREMENT records found."
        )

    # --------------------------------------------------------
    # SUMMARY
    # --------------------------------------------------------

    print_pipeline_master_summary(
        context
    )

    # --------------------------------------------------------
    # FINAL
    # --------------------------------------------------------

    print("")
    print("=" * 70)
    print(
        "MASTER → CATALOG PIPELINE "
        "INTEGRATION TEST PASSED"
    )
    print("=" * 70)