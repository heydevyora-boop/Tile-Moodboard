"""
test_google_master_persistence.py

Offline test for google_master_persistence.py.

No real Google Sheets request is made.

The Sheets API is simulated with an in-memory fake service.
"""

from typing import Any, Dict, List

import app.google_master_persistence as service


# ============================================================
# FAKE GOOGLE SHEETS
# ============================================================

class FakeRequest:

    def __init__(
        self,
        result: Dict[str, Any],
    ):
        self.result = result

    def execute(self):
        return self.result


class FakeValuesAPI:

    def __init__(
        self,
        owner,
    ):
        self.owner = owner

    def get(
        self,
        spreadsheetId,
        range,
    ):
        return FakeRequest(
            self.owner.values_get(
                range
            )
        )

    def append(
        self,
        spreadsheetId,
        range,
        valueInputOption,
        insertDataOption,
        body,
    ):
        return FakeRequest(
            self.owner.values_append(
                body
            )
        )

    def update(
        self,
        spreadsheetId,
        range,
        valueInputOption,
        body,
    ):
        return FakeRequest(
            self.owner.values_update(
                range,
                body,
            )
        )


class FakeSpreadsheetsAPI:

    def __init__(
        self,
        owner,
    ):
        self.owner = owner

    def values(self):
        return FakeValuesAPI(
            self.owner
        )


class FakeSheetsService:

    def __init__(self):
        self.headers = [
            "Record Type",
            "Record ID",
            "Catalog ID",
            "Name",
            "Category",
            "Style",
            "Budget",
            "Product ID",
            "Product Name",
            "Surface",
            "Scene ID",
            "Image",
            "Drive URL",
            "Status",
            "Source",
            "Created At",
            "Notes",
        ]

        self.rows: List[List[str]] = []

        self.spreadsheet_api = (
            FakeSpreadsheetsAPI(
                self
            )
        )

    def spreadsheets(self):
        return self.spreadsheet_api

    def values_get(
        self,
        range_name,
    ):
        if (
            range_name
            == "'MASTER'!A1:ZZ1"
        ):

            return {
                "values": [
                    self.headers
                ]
            }

        if (
            range_name
            == "'MASTER'!A:ZZ"
        ):

            return {
                "values": [
                    self.headers,
                    *self.rows,
                ]
            }

        return {
            "values": []
        }

    def values_append(
        self,
        body,
    ):
        values = body.get(
            "values",
            [],
        )

        for row in values:
            self.rows.append(
                list(row)
            )

        return {
            "updates": {
                "updatedRows": len(
                    values
                )
            }
        }

    def values_update(
        self,
        range_name,
        body,
    ):
        values = body.get(
            "values",
            [],
        )

        if not values:
            return {}

        row_number = int(
            range_name.split(
                "!"
            )[1].split(
                "A"
            )[-1].split(
                ":"
            )[0]
        )

        row_index = row_number - 2

        if (
            0
            <= row_index
            < len(self.rows)
        ):
            self.rows[
                row_index
            ] = list(
                values[0]
            )

        return {
            "updatedRows": 1
        }


# ============================================================
# MAIN
# ============================================================

def main():

    print("")
    print("=" * 70)
    print(
        "GOOGLE MASTER PERSISTENCE TEST"
    )
    print("=" * 70)

    fake_sheets = (
        FakeSheetsService()
    )

    original_get_sheets_service = (
        service.get_sheets_service
    )

    service.get_sheets_service = (
        lambda: fake_sheets
    )

    try:

        spreadsheet_id = (
            "TEST_SPREADSHEET_ID"
        )

        # ----------------------------------------------------
        # Visualization record
        # ----------------------------------------------------

        visualization = {
            "visualization_id": (
                "VIZ_TEST_001"
            ),
            "scene_id": (
                "SCENE_TEST_001"
            ),
            "product_id": (
                "TEST-P001"
            ),
            "product_name": (
                "Test Marble Tile"
            ),
            "surface": "FLOOR",
            "source_scene_image": (
                "input/bathroom.png"
            ),
            "tile_image": (
                "output/crops/"
                "001_TEST-P001.png"
            ),
            "applied_image": (
                "output/tile_visualizations/"
                "TEST-P001_floor.png"
            ),
            "drive_file_id": (
                "DRIVE_TEST_001"
            ),
            "drive_url": (
                "https://drive.google.com/"
                "file/d/DRIVE_TEST_001"
            ),
            "model": (
                "gemini-3.1-flash-image"
            ),
            "status": "UPLOADED",
            "created_at": (
                "2026-08-24T17:00:00+00:00"
            ),
        }

        # ----------------------------------------------------
        # 1. HEADER CHECK
        # ----------------------------------------------------

        print("")
        print(
            "1. Loading MASTER headers..."
        )

        headers = (
            service.get_master_headers(
                fake_sheets,
                spreadsheet_id,
            )
        )

        assert (
            "Record Type"
            in headers
        )

        assert (
            "Record ID"
            in headers
        )

        assert (
            "Product ID"
            in headers
        )

        print(
            "[PASS] MASTER headers."
        )

        # ----------------------------------------------------
        # 2. BUILD ROW
        # ----------------------------------------------------

        print("")
        print(
            "2. Building MASTER row..."
        )

        row = (
            service.build_master_row(
                headers,
                {
                    **visualization,
                    "record_type": (
                        "MOODBOARD"
                    ),
                    "record_id": (
                        "VIZ_VIZ_TEST_001"
                    ),
                    "name": (
                        "Applied Tile - "
                        "TEST-P001 FLOOR"
                    ),
                    "category": (
                        "TILE_VISUALIZATION"
                    ),
                },
            )
        )

        assert (
            row[0]
            == "MOODBOARD"
        )

        assert (
            row[1]
            == "VIZ_VIZ_TEST_001"
        )

        assert (
            "TEST-P001"
            in row[
                headers.index(
                    "Product ID"
                )
            ]
        )

        print(
            "[PASS] MASTER row built."
        )

        # ----------------------------------------------------
        # 3. PERSIST
        # ----------------------------------------------------

        print("")
        print(
            "3. Persisting visualization to MASTER..."
        )

        saved = (
            service.persist_visualization_to_master(
                spreadsheet_id,
                visualization,
                moodboard_id=(
                    "MOOD_TEST_001"
                ),
            )
        )

        assert (
            saved[
                "sheet_status"
            ]
            == "UPLOADED"
        )

        assert (
            len(
                fake_sheets.rows
            )
            == 1
        )

        print(
            "[PASS] Visualization persisted."
        )

        # ----------------------------------------------------
        # 4. DUPLICATE SAFE UPSERT
        # ----------------------------------------------------

        print("")
        print(
            "4. Updating same MASTER record..."
        )

        visualization_updated = dict(
            visualization
        )

        visualization_updated[
            "status"
        ] = "COMPLETED"

        updated = (
            service.persist_visualization_to_master(
                spreadsheet_id,
                visualization_updated,
                moodboard_id=(
                    "MOOD_TEST_001"
                ),
            )
        )

        assert (
            updated[
                "sheet_status"
            ]
            == "UPDATED"
        )

        assert (
            len(
                fake_sheets.rows
            )
            == 1
        )

        print(
            "[PASS] Duplicate-safe update."
        )

        # ----------------------------------------------------
        # 5. FIND ROW
        # ----------------------------------------------------

        print("")
        print(
            "5. Finding MASTER record..."
        )

        row_number = (
            service.find_master_record_row(
                fake_sheets,
                spreadsheet_id,
                "VIZ_VIZ_TEST_001",
            )
        )

        assert (
            row_number
            == 2
        )

        print(
            "[PASS] MASTER record lookup."
        )

        # ----------------------------------------------------
        # FINAL
        # ----------------------------------------------------

        print("")
        print("=" * 70)
        print(
            "GOOGLE MASTER PERSISTENCE TEST PASSED"
        )
        print("=" * 70)

        print("")
        print(
            "MASTER Headers : OK"
        )

        print(
            "Row Generation : OK"
        )

        print(
            "Visualization  : OK"
        )

        print(
            "Duplicate Safe : OK"
        )

        print(
            "Record Lookup  : OK"
        )

        print("")
        print(
            "No real Google Sheets request was made."
        )

    finally:

        service.get_sheets_service = (
            original_get_sheets_service
        )


if __name__ == "__main__":
    main()
