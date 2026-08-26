from pathlib import Path

from app.catalog_pipeline import (
    process_catalog
)


def main():

    print()
    print("=" * 60)
    print("CATALOG PROCESSOR")
    print("=" * 60)

    pdf_input = input(
        "\nEnter the full PDF path:\n> "
    ).strip().strip('"')

    pdf_path = Path(
        pdf_input
    )

    if not pdf_path.exists():

        print(
            "\nERROR: PDF not found."
        )

        return

    if pdf_path.suffix.lower() != ".pdf":

        print(
            "\nERROR: Please select a PDF."
        )

        return

    print()
    print(
        f"Selected PDF:\n{pdf_path}"
    )

    confirmation = input(
        "\nStart processing? (yes/no): "
    ).strip().lower()

    if confirmation not in [
        "yes",
        "y"
    ]:

        print(
            "Processing cancelled."
        )

        return

    try:

        process_catalog(
            pdf_path=pdf_path,
            output_root="output"
        )

    except Exception as error:

        print()
        print(
            "=" * 60
        )

        print(
            "PROCESSING FAILED"
        )

        print(
            "=" * 60
        )

        print(
            error
        )


if __name__ == "__main__":
    main()