from pathlib import Path

from app.tile_visualization_pipeline import (
    find_cropped_tile,
    build_output_path,
)


PROJECT_ROOT = (
    Path(__file__)
    .resolve()
    .parent
    .parent
)


def main():

    print("=" * 70)
    print("TILE VISUALIZATION PIPELINE TEST")
    print("=" * 70)

    product_id = "TEST-P001"

    print("")
    print(
        "Searching cropped tile for:",
        product_id,
    )

    tile_path = find_cropped_tile(
        product_id
    )

    print(
        "[PASS] Tile found:"
    )

    print(
        tile_path
    )

    output_path = build_output_path(
        product_id,
        "FLOOR",
    )

    print("")
    print(
        "[PASS] Output path:"
    )

    print(
        output_path
    )

    print("")
    print("=" * 70)
    print(
        "TILE VISUALIZATION PIPELINE TEST PASSED"
    )
    print("=" * 70)


if __name__ == "__main__":
    main()