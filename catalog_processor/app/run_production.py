import subprocess
import sys


def run_command(
    command,
    step_name
):

    print()
    print("=" * 70)
    print(
        f"RUNNING: {step_name}"
    )
    print("=" * 70)

    print(
        "Command:",
        " ".join(command)
    )

    try:

        result = subprocess.run(
            command,
            check=False
        )

        if result.returncode != 0:

            print()
            print(
                f"STEP FAILED: "
                f"{step_name}"
            )

            return False

        print()
        print(
            f"STEP COMPLETED: "
            f"{step_name}"
        )

        return True

    except Exception as error:

        print()
        print(
            f"STEP ERROR: "
            f"{step_name}"
        )

        print(
            error
        )

        return False


def main():

    print()
    print("=" * 70)
    print("CATALOG PROCESSING PRODUCTION PIPELINE")
    print("=" * 70)

    # --------------------------------------------------------
    # STEP 1
    # --------------------------------------------------------

    success = run_command(
        [
            sys.executable,
            "-m",
            "app.run_all_catalogs",
        ],
        "PROCESS ALL CATALOGS"
    )

    if not success:

        print()
        print(
            "Production pipeline stopped."
        )

        return

    # --------------------------------------------------------
    # STEP 2
    # --------------------------------------------------------

    success = run_command(
        [
            sys.executable,
            "-m",
            "app.product_master",
        ],
        "PRODUCT MASTER / INHERITANCE"
    )

    if not success:

        print()
        print(
            "Product master step failed."
        )

        return

    # --------------------------------------------------------
    # COMPLETE
    # --------------------------------------------------------

    print()
    print("=" * 70)
    print("PRODUCTION PIPELINE COMPLETED")
    print("=" * 70)


if __name__ == "__main__":

    main()