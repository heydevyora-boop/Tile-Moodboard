from pathlib import Path
from datetime import datetime
import json
import os
import traceback

from dotenv import load_dotenv

from app.catalog_pipeline import process_catalog


# ============================================================
# ENVIRONMENT
# ============================================================

load_dotenv()


# ============================================================
# PROJECT PATHS
# ============================================================

# This file is:
# catalog_processor/app/run_all_catalogs.py
#
# Therefore:
# .parent       = app
# .parent.parent = catalog_processor

PROJECT_ROOT = Path(__file__).resolve().parent.parent


# ============================================================
# CATALOG SOURCE CONFIGURATION
# ============================================================

# IMPORTANT:
#
# You can later change this from the .env file:
#
# PENDRIVE_ROOT=D:\
#
# or:
#
# PENDRIVE_ROOT=D:\MyCatalogs
#
# or any other valid folder.
#
# If PENDRIVE_ROOT is not present in .env,
# the project will use:
#
# catalog_processor/data
#

DEFAULT_SOURCE_ROOT = PROJECT_ROOT / "data"

PENDRIVE_ROOT = Path(
    os.getenv(
        "PENDRIVE_ROOT",
        str(DEFAULT_SOURCE_ROOT)
    )
).expanduser()


# ============================================================
# OUTPUT CONFIGURATION
# ============================================================

OUTPUT_ROOT = PROJECT_ROOT / "output"

REPORT_FILE = OUTPUT_ROOT / "pendrive_report.json"


# ============================================================
# PATH NORMALIZATION
# ============================================================

def normalize_path(path: Path) -> Path:
    """
    Convert a path into an absolute normalized Path.
    """

    return Path(path).expanduser().resolve()


PENDRIVE_ROOT = normalize_path(PENDRIVE_ROOT)
OUTPUT_ROOT = normalize_path(OUTPUT_ROOT)
REPORT_FILE = normalize_path(REPORT_FILE)


# ============================================================
# OUTPUT DIRECTORY
# ============================================================

def create_output_directory() -> None:
    """
    Create the main output directory if it does not exist.
    """

    OUTPUT_ROOT.mkdir(
        parents=True,
        exist_ok=True
    )


# ============================================================
# VALIDATE SOURCE DIRECTORY
# ============================================================

def validate_source_directory(
    source_path: Path
) -> bool:
    """
    Validate the catalog source directory.

    Returns:
        True  -> valid directory
        False -> invalid/missing directory
    """

    source_path = normalize_path(
        source_path
    )

    print()
    print("=" * 70)
    print("SOURCE DIRECTORY VALIDATION")
    print("=" * 70)

    print(
        f"Source: {source_path}"
    )

    if not source_path.exists():

        print()
        print(
            "SOURCE DIRECTORY NOT FOUND"
        )

        print(
            f"Expected location:\n"
            f"{source_path}"
        )

        return False

    if not source_path.is_dir():

        print()
        print(
            "SOURCE PATH IS NOT A DIRECTORY"
        )

        print(
            f"Path:\n"
            f"{source_path}"
        )

        return False

    print()
    print(
        "SOURCE DIRECTORY: OK"
    )

    return True


# ============================================================
# FIND ALL PDF FILES
# ============================================================

def find_all_pdfs(
    source_path: Path
):
    """
    Recursively find all PDF files.

    Returns:
        list[Path]
    """

    source_path = normalize_path(
        source_path
    )

    if not validate_source_directory(
        source_path
    ):
        return []

    print()
    print("=" * 70)
    print("SCANNING CATALOG SOURCE")
    print("=" * 70)

    print(
        f"Location: {source_path}"
    )

    pdf_files = []

    try:

        for file_path in source_path.rglob("*"):

            # Ignore directories
            if not file_path.is_file():
                continue

            # Only PDF files
            if file_path.suffix.lower() != ".pdf":
                continue

            pdf_files.append(
                file_path
            )

    except PermissionError as error:

        print()
        print(
            "PERMISSION ERROR WHILE SCANNING SOURCE"
        )

        print(
            error
        )

        return []

    except OSError as error:

        print()
        print(
            "OS ERROR WHILE SCANNING SOURCE"
        )

        print(
            error
        )

        return []

    # Sort consistently
    pdf_files.sort(
        key=lambda path: str(path).lower()
    )

    print()
    print(
        f"PDFs found: {len(pdf_files)}"
    )

    if pdf_files:

        for index, pdf_file in enumerate(
            pdf_files,
            start=1
        ):

            print(
                f"{index}. {pdf_file}"
            )

    else:

        print(
            "No PDF files found."
        )

    return pdf_files


# ============================================================
# SAVE REPORT
# ============================================================

def save_report(
    report: dict
) -> bool:
    """
    Save processing report as JSON.

    Returns:
        True  -> saved successfully
        False -> save failed
    """

    try:

        create_output_directory()

        REPORT_FILE.write_text(
            json.dumps(
                report,
                indent=4,
                ensure_ascii=False,
                default=str
            ),
            encoding="utf-8"
        )

        print()
        print(
            f"Report saved:"
        )
        print(
            REPORT_FILE
        )

        return True

    except Exception as error:

        print()
        print(
            "WARNING: REPORT COULD NOT BE SAVED"
        )

        print(
            f"Error: {error}"
        )

        traceback.print_exc()

        return False


# ============================================================
# ANALYZE CATALOG RESULTS
# ============================================================

def analyze_results(
    results
) -> dict:
    """
    Analyze image-processing results.

    Expected decision values:

        APPROVED
        REVIEW
        REJECTED
        ERROR
        DRIVE_ERROR
        SHEETS_ERROR
    """

    approved = 0
    review = 0
    rejected = 0
    errors = 0

    if not isinstance(
        results,
        list
    ):

        return {
            "total_images": 0,
            "approved": 0,
            "review": 0,
            "rejected": 0,
            "errors": 0,
        }

    for result in results:

        if not isinstance(
            result,
            dict
        ):
            continue

        decision = str(
            result.get(
                "decision",
                ""
            )
        ).strip().upper()

        if decision == "APPROVED":

            approved += 1

        elif decision == "REVIEW":

            review += 1

        elif decision == "REJECTED":

            rejected += 1

        elif decision in {
            "ERROR",
            "DRIVE_ERROR",
            "SHEETS_ERROR",
        }:

            errors += 1

    return {
        "total_images": len(results),
        "approved": approved,
        "review": review,
        "rejected": rejected,
        "errors": errors,
    }


# ============================================================
# PROCESS SINGLE CATALOG
# ============================================================

def process_single_catalog(
    pdf_path: Path
):
    """
    Process one PDF catalog safely.

    Returns:
        {
            "success": bool,
            "stats": dict,
            "error": str | None
        }
    """

    try:

        print()
        print("=" * 70)
        print(
            "PROCESSING CATALOG"
        )
        print("=" * 70)

        print(
            f"Name: {pdf_path.name}"
        )

        print(
            f"Path: {pdf_path}"
        )

        print("=" * 70)

        # ----------------------------------------------------
        # PROCESS CATALOG
        # ----------------------------------------------------

        results = process_catalog(
            pdf_path=pdf_path,
            output_root=OUTPUT_ROOT
        )

        # ----------------------------------------------------
        # ANALYZE RESULTS
        # ----------------------------------------------------

        stats = analyze_results(
            results
        )

        print()
        print(
            "CATALOG COMPLETED"
        )

        print(
            f"Total images: "
            f"{stats['total_images']}"
        )

        print(
            f"Approved: "
            f"{stats['approved']}"
        )

        print(
            f"Review: "
            f"{stats['review']}"
        )

        print(
            f"Rejected: "
            f"{stats['rejected']}"
        )

        print(
            f"Errors: "
            f"{stats['errors']}"
        )

        return {
            "success": True,
            "stats": stats,
            "error": None,
        }

    except Exception as error:

        print()
        print(
            "CATALOG FAILED"
        )

        print(
            f"File: {pdf_path.name}"
        )

        print(
            f"Error: {error}"
        )

        traceback.print_exc()

        return {
            "success": False,
            "stats": {
                "total_images": 0,
                "approved": 0,
                "review": 0,
                "rejected": 0,
                "errors": 1,
            },
            "error": str(error),
        }


# ============================================================
# PROCESS ALL CATALOGS
# ============================================================

def process_all_catalogs():

    # --------------------------------------------------------
    # INITIALIZE OUTPUT
    # --------------------------------------------------------

    create_output_directory()

    # --------------------------------------------------------
    # DISPLAY CONFIGURATION
    # --------------------------------------------------------

    print()
    print("=" * 70)
    print("CATALOG AUTOMATION")
    print("=" * 70)

    print(
        f"Project Root : {PROJECT_ROOT}"
    )

    print(
        f"Source Root  : {PENDRIVE_ROOT}"
    )

    print(
        f"Output Root  : {OUTPUT_ROOT}"
    )

    print(
        f"Report File  : {REPORT_FILE}"
    )

    print("=" * 70)

    # --------------------------------------------------------
    # FIND PDF FILES
    # --------------------------------------------------------

    pdf_files = find_all_pdfs(
        PENDRIVE_ROOT
    )

    if not pdf_files:

        print()
        print("=" * 70)
        print(
            "NO CATALOGS TO PROCESS"
        )
        print("=" * 70)

        print(
            f"Source checked:\n"
            f"{PENDRIVE_ROOT}"
        )

        return

    # --------------------------------------------------------
    # INITIAL REPORT
    # --------------------------------------------------------

    report = {

        "started_at":
            datetime.now().isoformat(),

        "project_root":
            str(PROJECT_ROOT),

        "source_root":
            str(PENDRIVE_ROOT),

        "output_root":
            str(OUTPUT_ROOT),

        "report_file":
            str(REPORT_FILE),

        "total_pdfs":
            len(pdf_files),

        "completed": [],

        "failed": [],

        "summary": {

            "total_images": 0,

            "approved": 0,

            "review": 0,

            "rejected": 0,

            "errors": 0,
        }
    }

    # --------------------------------------------------------
    # START PROCESSING
    # --------------------------------------------------------

    print()
    print("=" * 70)
    print("STARTING ALL CATALOG PROCESSING")
    print("=" * 70)

    print(
        f"Total catalogs: {len(pdf_files)}"
    )

    # --------------------------------------------------------
    # PROCESS EACH PDF
    # --------------------------------------------------------

    for index, pdf_path in enumerate(
        pdf_files,
        start=1
    ):

        print()
        print()
        print("=" * 70)

        print(
            f"CATALOG {index}/{len(pdf_files)}"
        )

        print(
            f"Name: {pdf_path.name}"
        )

        print("=" * 70)

        result = process_single_catalog(
            pdf_path
        )

        # ----------------------------------------------------
        # SUCCESS
        # ----------------------------------------------------

        if result["success"]:

            stats = result["stats"]

            # Update global summary

            for key in (
                "total_images",
                "approved",
                "review",
                "rejected",
                "errors",
            ):

                report["summary"][key] += (
                    stats[key]
                )

            # Add completed catalog

            report["completed"].append({

                "pdf":
                    str(pdf_path),

                "name":
                    pdf_path.name,

                **stats,

                "status":
                    "COMPLETED",
            })

        # ----------------------------------------------------
        # FAILURE
        # ----------------------------------------------------

        else:

            error_message = result["error"]

            report["summary"]["errors"] += 1

            report["failed"].append({

                "pdf":
                    str(pdf_path),

                "name":
                    pdf_path.name,

                "status":
                    "FAILED",

                "error":
                    error_message,
            })

            # Important:
            # Continue with the next catalog.

            print()
            print(
                "Continuing with next catalog..."
            )

    # --------------------------------------------------------
    # FINISH REPORT
    # --------------------------------------------------------

    report["finished_at"] = (
        datetime.now().isoformat()
    )

    # --------------------------------------------------------
    # SAVE REPORT
    # --------------------------------------------------------

    save_report(
        report
    )

    # --------------------------------------------------------
    # FINAL SUMMARY
    # --------------------------------------------------------

    print()
    print("=" * 70)
    print("ALL CATALOGS FINISHED")
    print("=" * 70)

    print(
        f"Total PDFs: "
        f"{report['total_pdfs']}"
    )

    print(
        f"Completed: "
        f"{len(report['completed'])}"
    )

    print(
        f"Failed: "
        f"{len(report['failed'])}"
    )

    print()

    print(
        f"Total images: "
        f"{report['summary']['total_images']}"
    )

    print(
        f"Approved: "
        f"{report['summary']['approved']}"
    )

    print(
        f"Review: "
        f"{report['summary']['review']}"
    )

    print(
        f"Rejected: "
        f"{report['summary']['rejected']}"
    )

    print(
        f"Errors: "
        f"{report['summary']['errors']}"
    )

    print("=" * 70)


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":

    try:

        process_all_catalogs()

    except KeyboardInterrupt:

        print()
        print("=" * 70)
        print(
            "PROCESSING STOPPED BY USER"
        )
        print("=" * 70)

    except Exception as error:

        print()
        print("=" * 70)
        print(
            "BATCH PROCESSING FAILED"
        )
        print("=" * 70)

        print(
            f"Error: {error}"
        )

        traceback.print_exc()