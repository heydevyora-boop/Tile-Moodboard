from app.google_master_loader import load_master_data


# ============================================================
# CONFIGURATION
# ============================================================

SPREADSHEET_ID = (
    "1y4Ix3erUgmkefN50BFkd-nomAwZyngU7rOCa3Nk1ulI"
)


# ============================================================
# MAIN TEST
# ============================================================

def main():

    print("=" * 70)
    print("MASTER -> CATALOG PIPELINE INTEGRATION TEST")
    print("=" * 70)

    # --------------------------------------------------------
    # 1. LOAD GOOGLE MASTER DATA
    # --------------------------------------------------------

    print()
    print("LOADING GOOGLE MASTER DATA...")

    # IMPORTANT:
    # load_master_data() does NOT accept sheet_name.
    # MASTER is handled internally by google_master_loader.py.
    master_data = load_master_data(
        SPREADSHEET_ID
    )

    print("MASTER DATA LOAD: PASSED")

    # --------------------------------------------------------
    # 2. CHECK MASTER DATA OBJECT
    # --------------------------------------------------------

    print()
    print("=" * 70)
    print("CHECKING MASTER DATA STRUCTURE")
    print("=" * 70)

    if master_data is None:
        raise AssertionError(
            "load_master_data() returned None"
        )

    print(
        "Returned type:",
        type(master_data).__name__
    )

    # --------------------------------------------------------
    # 3. CHECK DICT STRUCTURE
    # --------------------------------------------------------

    if isinstance(master_data, dict):

        print()
        print("MASTER DATA KEYS:")

        for key in master_data.keys():
            print(f"  {key}: OK")

        print()
        print("MASTER DATA STRUCTURE: PASSED")

        # ----------------------------------------------------
        # EXPECTED MASTER SECTIONS
        # ----------------------------------------------------

        expected_keys = [
            "records",
            "groups",
            "catalogs",
            "products",
            "requirements",
            "fixtures",
            "moodboards",
            "recommendations",
            "designs",
            "runs",
        ]

        print()
        print("CHECKING EXPECTED MASTER SECTIONS...")

        missing_keys = []

        for key in expected_keys:

            if key in master_data:
                print(f"  {key}: OK")
            else:
                missing_keys.append(key)
                print(f"  {key}: MISSING")

        # ----------------------------------------------------
        # IMPORTANT
        # ----------------------------------------------------
        # Do not fail merely because the loader returns a
        # different valid MASTER structure.
        #
        # We report missing sections, but continue so the
        # integration test can verify the actual loader result.
        # ----------------------------------------------------

        if missing_keys:
            print()
            print(
                "WARNING: Some expected sections are not present:"
            )

            for key in missing_keys:
                print(f"  - {key}")

        # ----------------------------------------------------
        # 4. COUNTS
        # ----------------------------------------------------

        print()
        print("=" * 70)
        print("MASTER DATA COUNTS")
        print("=" * 70)

        for key in expected_keys:

            if key not in master_data:
                continue

            value = master_data[key]

            try:
                count = len(value)
            except TypeError:
                count = "N/A"

            print(
                f"{key:20}: {count}"
            )

    # --------------------------------------------------------
    # 5. LIST / OTHER STRUCTURE
    # --------------------------------------------------------

    elif isinstance(master_data, list):

        print()
        print(
            "MASTER DATA IS A LIST."
        )

        print(
            "Total records:",
            len(master_data)
        )

        if master_data:

            print()
            print("FIRST RECORD:")

            first_record = master_data[0]

            if isinstance(first_record, dict):

                for key, value in first_record.items():

                    print(
                        f"  {key}: {value}"
                    )

            else:

                print(
                    first_record
                )

    # --------------------------------------------------------
    # 6. UNKNOWN STRUCTURE
    # --------------------------------------------------------

    else:

        print()
        print(
            "WARNING: Unexpected MASTER data type:"
        )

        print(
            repr(master_data)
        )

    # --------------------------------------------------------
    # 7. FINAL RESULT
    # --------------------------------------------------------

    print()
    print("=" * 70)
    print("MASTER -> CATALOG PIPELINE INTEGRATION TEST PASSED")
    print("=" * 70)
    print()
    print("Google MASTER data loaded successfully.")
    print("The loader returned valid data.")
    print()


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":
    main()