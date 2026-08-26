"""
test_visualization_master_service.py

Offline test for visualization_master_service.py.

No real Google Sheets request is made.

The Google Sheets service is replaced with an in-memory fake
implementation that behaves like the parts used by this module.
"""

from typing import Any, Dict, List

import app.visualization_master_service as service


# ============================================================
# FAKE SHEETS SERVICE
# ============================================================

class FakeValuesAPI:

    def __init__(self, owner):
        self.owner = owner

    def get(
        self,
        spreadsheetId,
        range,
    ):
        return FakeRequest(
            self.owner.handle_get(
                spreadsheetId,
                range,
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
            self.owner.handle_update(
                spreadsheetId,
                range,
                body,
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
            self.owner.handle_append(
                spreadsheetId,
                range,
                body,
            )
        )


class FakeSpreadsheetsAPI:

    def __init__(self, owner):
        self.owner = owner

    def get(
        self,
        spreadsheetId,
        fields=None,
    ):
        return FakeRequest(
            self.owner.handle_metadata(
                spreadsheetId
            )
        )

    def batchUpdate(
        self,
        spreadsheetId,
        body,
    ):
        return FakeRequest(
            self.owner.handle_batch_update(
                spreadsheetId,
                body,
            )
        )

    def values(self):
        return FakeValuesAPI(
            self.owner
        )


class FakeRequest:

    def __init__(self, result):
        self.result = result

    def execute(self):
        return self.result


class FakeSheetsService:

    def __init__(self):
        self.sheet_name = None
        self.headers = []
        self.rows: List[List[str]] = []

        self.spreadsheets_api = (
            FakeSpreadsheetsAPI(
                self
            )
        )

    def spreadsheets(self):
        return self.spreadsheets_api

    def handle_metadata(
        self,
        spreadsheet_id,
    ):
        sheets = []

        if self.sheet_name:
            sheets.append(
                {
                    "properties": {
                        "title": self.sheet_name
                    }
                }
            )

        return {
            "sheets": sheets
        }

    def handle_batch_update(
        self,
        spreadsheet_id,
        body,
    ):
        requests = body.get(
            "requests",
            [],
        )

        for request in requests:

            add_sheet = request.get(
                "addSheet"
            )

            if add_sheet:

                self.sheet_name = (
                    add_sheet[
                        "properties"
                    ][
                        "title"
                    ]
                )

        return {
            "replies": [
                {
                    "addSheet": {
                        "properties": {
                            "title": self.sheet_name
                        }
                    }
                }
            ]
        }

    def handle_get(
        self,
        spreadsheet_id,
        range_name,
    ):
        values = []

        if self.headers:
            values.append(
                self.headers
            )

            values.extend(
                self.rows
            )

        return {
            "values": values
        }

    def handle_update(
        self,
        spreadsheet_id,
        range_name,
        body,
    ):
        values = body.get(
            "values",
            [],
        )

        if not values:
            return {}

        first_row = values[0]

        if "1:" in range_name:
            self.headers = list(
                first_row
            )

        else:
            # This is enough for the current test;
            # target row updates are represented by the
            # matching first-column Visualization ID.
            target_id = str(
                first_row[0]
            ).strip()

            for index, row in enumerate(
                self.rows
            ):

                if (
                    row
                    and str(
                        row[0]
                    ).strip()
                    == target_id
                ):
                    self.rows[index] = list(
                        first_row
                    )
                    break

        return {}


    def handle_append(
        self,
        spreadsheet_id,
        range_name,
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

        return {}


# ============================================================
# MAIN TEST
# ============================================================

def main():

    print("")
    print("=" * 70)
    print(
        "VISUALIZATION GOOGLE SHEETS SERVICE TEST"
    )
    print("=" * 70)

    fake_sheets = (
        FakeSheetsService()
    )

    original_get_sheets_service = (
        service.get_sheets_service
    )

    try:

        service.get_sheets_service = (
            lambda: fake_sheets
        )

        spreadsheet_id = (
            "TEST_SPREADSHEET"
        )

        record = {
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
                "DRIVE_FILE_TEST_001"
            ),
            "drive_url": (
                "https://drive.google.com/"
                "file/d/DRIVE_FILE_TEST_001"
            ),
            "model": (
                "gemini-3.1-flash-image"
            ),
            "status": "UPLOADED",
            "created_at": (
                "2026-08-24T17:00:00+00:00"
            ),
            "metadata_path": (
                "output/visualizations/"
                "metadata.json"
            ),
        }

        # ----------------------------------------------------
        # 1. ENSURE SHEET
        # ----------------------------------------------------

        print("")
        print(
            "1. Ensuring VISUALIZATIONS sheet..."
        )

        actual_sheet = (
            service.ensure_visualization_sheet(
                fake_sheets,
                spreadsheet_id,
                "VISUALIZATIONS",
            )
        )

        assert actual_sheet == (
            "VISUALIZATIONS"
        )

        assert (
            fake_sheets.headers
            == service.VISUALIZATION_HEADERS
        )

        print(
            "[PASS] Sheet and headers."
        )

        # ----------------------------------------------------
        # 2. SAVE
        # ----------------------------------------------------

        print("")
        print(
            "2. Saving visualization..."
        )

        saved = (
            service.save_visualization_to_google_sheets(
                spreadsheet_id,
                record,
            )
        )

        assert saved[
            "sheet_status"
        ] == "UPLOADED"

        assert len(
            fake_sheets.rows
        ) == 1

        assert (
            fake_sheets.rows[0][0]
            == "VIZ_TEST_001"
        )

        print(
            "[PASS] Visualization saved."
        )

        # ----------------------------------------------------
        # 3. FIND
        # ----------------------------------------------------

        print("")
        print(
            "3. Finding visualization..."
        )

        found = (
            service.find_visualization_record(
                spreadsheet_id,
                "VIZ_TEST_001",
            )
        )

        assert found is not None

        assert (
            found["Product ID"]
            == "TEST-P001"
        )

        assert (
            found["Surface"]
            == "FLOOR"
        )

        assert (
            found["Status"]
            == "UPLOADED"
        )

        print(
            "[PASS] Visualization lookup."
        )

        # ----------------------------------------------------
        # 4. UPSERT
        # ----------------------------------------------------

        print("")
        print(
            "4. Testing update..."
        )

        updated_record = dict(
            record
        )

        updated_record["status"] = (
            "COMPLETED"
        )

        updated = (
            service.upsert_visualization_record(
                spreadsheet_id,
                updated_record,
            )
        )

        assert updated[
            "sheet_status"
        ] == "UPDATED"

        assert len(
            fake_sheets.rows
        ) == 1

        assert (
            fake_sheets.rows[0][11]
            == "COMPLETED"
        )

        print(
            "[PASS] Visualization update."
        )

        # ----------------------------------------------------
        # 5. LOAD
        # ----------------------------------------------------

        print("")
        print(
            "5. Loading records..."
        )

        records = (
            service.load_visualization_records(
                spreadsheet_id
            )
        )

        assert len(records) == 1

        assert (
            records[0]["Visualization ID"]
            == "VIZ_TEST_001"
        )

        assert (
            records[0]["Status"]
            == "COMPLETED"
        )

        print(
            "[PASS] Records loaded."
        )

        # ----------------------------------------------------
        # FINAL
        # ----------------------------------------------------

        print("")
        print("=" * 70)
        print(
            "VISUALIZATION GOOGLE SHEETS SERVICE TEST PASSED"
        )
        print("=" * 70)

        print("")
        print(
            "Sheet Creation  : OK"
        )

        print(
            "Header Creation  : OK"
        )

        print(
            "Record Insert     : OK"
        )

        print(
            "Record Lookup     : OK"
        )

        print(
            "Record Update     : OK"
        )

        print(
            "Record Load       : OK"
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
