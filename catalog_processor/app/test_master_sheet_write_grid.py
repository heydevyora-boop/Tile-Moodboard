"""
test_master_sheet_write_grid.py

Offline proof for the bug that kept every extracted product out of
the Google Sheet.

No real Google API call is made. The fake Sheets service below
enforces the one rule the real API enforces and this code base was
violating: a values range may not reach past the tab's grid, and a
tab created without explicit gridProperties is only 26 columns wide.

    MASTER schema          -> 47 columns
    tab created by addSheet -> 26 columns (Google's default)
    append range used       -> "'MASTER'!A:ZZ" == column 702

Google answers that with 400 "exceeds grid limits", so append_brand()
-- the first sheet write of every catalog -- threw before a single
image was uploaded, and the catalog was reported only as
"FAILED: <pdf>". Nothing ever reached BRANDS, CATALOGS or MASTER.
"""

import pytest

from app import google_services as service


# ============================================================
# FAKE GOOGLE SHEETS API (grid limits enforced)
# ============================================================

def _column_index(letters):
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - ord("A") + 1)
    return index


def _max_column_in_range(cell_range):
    """Highest column the range reaches, or None for a row-only range."""

    if "!" not in cell_range:
        return None

    _, span = cell_range.split("!", 1)

    highest = None

    for part in span.split(":"):
        letters = "".join(c for c in part if c.isalpha()).upper()
        if not letters:
            continue
        column = _column_index(letters)
        if highest is None or column > highest:
            highest = column

    return highest


class GridLimitError(RuntimeError):
    pass


class FakeSheetsApi:

    def __init__(self, tabs):
        # tabs: {title: {"sheetId": int, "columnCount": int}}
        self.tabs = tabs
        self.rows = {title: [] for title in tabs}

    # -- range checking -------------------------------------

    def _tab_of(self, cell_range):
        title = cell_range.split("!", 1)[0].strip("'")
        if title not in self.tabs:
            raise GridLimitError(
                f"Unable to parse range: {cell_range}"
            )
        return title

    def _check(self, cell_range):
        title = self._tab_of(cell_range)
        width = self.tabs[title]["columnCount"]
        reach = _max_column_in_range(cell_range)

        if reach is not None and reach > width:
            raise GridLimitError(
                f"Range ({cell_range}) exceeds grid limits. "
                f"Max columns: {width}"
            )

        return title

    def _check_row_width(self, title, row):
        width = self.tabs[title]["columnCount"]
        if len(row) > width:
            raise GridLimitError(
                f"Tried writing {len(row)} values into '{title}', "
                f"which has only {width} columns."
            )

    # -- API surface ----------------------------------------

    def spreadsheets(self):
        return self

    def values(self):
        return self

    def get(self, spreadsheetId, range=None, fields=None):
        if range is None:
            return _Exec(
                {
                    "sheets": [
                        {
                            "properties": {
                                "sheetId": tab["sheetId"],
                                "title": title,
                                "index": position,
                                "gridProperties": {
                                    "rowCount": 1000,
                                    "columnCount": (
                                        tab["columnCount"]
                                    ),
                                },
                            }
                        }
                        for position, (title, tab)
                        in enumerate(self.tabs.items())
                    ]
                }
            )

        title = self._check(range)
        return _Exec({"values": list(self.rows[title])})

    def append(
        self,
        spreadsheetId,
        range,
        valueInputOption=None,
        insertDataOption=None,
        body=None,
    ):
        title = self._check(range)
        for row in body["values"]:
            self._check_row_width(title, row)
            self.rows[title].append(row)
        return _Exec({})

    def update(
        self,
        spreadsheetId,
        range,
        valueInputOption=None,
        body=None,
    ):
        title = self._check(range)
        for row in body["values"]:
            self._check_row_width(title, row)
            self.rows[title].append(row)
        return _Exec({})

    def batchUpdate(self, spreadsheetId, body):
        for request in body["requests"]:

            if "addSheet" in request:
                properties = request["addSheet"]["properties"]
                title = properties["title"]
                grid = properties.get("gridProperties", {})
                self.tabs[title] = {
                    "sheetId": len(self.tabs) + 1,
                    # Google's default when unspecified.
                    "columnCount": grid.get("columnCount", 26),
                }
                self.rows[title] = []

            if "updateSheetProperties" in request:
                properties = (
                    request["updateSheetProperties"]["properties"]
                )
                for title, tab in self.tabs.items():
                    if tab["sheetId"] == properties["sheetId"]:
                        tab["columnCount"] = (
                            properties["gridProperties"]["columnCount"]
                        )

        return _Exec({})


class _Exec:
    def __init__(self, payload):
        self._payload = payload

    def execute(self):
        return self._payload


# ============================================================
# TESTS
# ============================================================

def test_master_tab_is_created_wide_enough_for_its_headers():
    """A fresh workbook must get a MASTER tab that fits all 47
    columns -- not Google's 26-column default."""

    api = FakeSheetsApi(tabs={})

    service.ensure_master_workbook(
        sheets_service=api,
        spreadsheet_id="SHEET_ID",
    )

    for title, headers in service.MASTER_SHEETS.items():
        assert api.tabs[title]["columnCount"] >= len(headers), (
            f"tab '{title}' is too narrow for its own header row"
        )


def test_existing_narrow_master_tab_is_widened():
    """A workbook left behind by the old code (MASTER at Google's
    default 26 columns) must be repaired, not left broken."""

    api = FakeSheetsApi(
        tabs={
            "MASTER": {"sheetId": 7, "columnCount": 26},
        }
    )

    service.ensure_master_workbook(
        sheets_service=api,
        spreadsheet_id="SHEET_ID",
    )

    assert api.tabs["MASTER"]["columnCount"] == len(
        service.MASTER_SHEETS["MASTER"]
    )


def test_extracted_product_actually_reaches_the_master_tab():
    """The end-to-end guarantee: after the workbook is prepared, a
    product row written by the extraction pipeline lands in MASTER."""

    api = FakeSheetsApi(tabs={})

    service.ensure_master_workbook(
        sheets_service=api,
        spreadsheet_id="SHEET_ID",
    )

    service.append_brand(
        sheets_service=api,
        spreadsheet_id="SHEET_ID",
        brand_id="BRAND-EXOTICA",
        brand_name="Exotica",
        parent_folder="FOLDER_ID",
    )

    service.append_product(
        sheets_service=api,
        spreadsheet_id="SHEET_ID",
        product_id="EXOTICA-HAMMER-0001",
        brand_id="BRAND-EXOTICA",
        brand="Exotica",
        catalog_id="CAT-EXOTICA-HAMMER",
        catalog="Exotica Hammer 600X1200 Catalogue",
        pdf_name="Exotica Hammer 600X1200 Catalogue.pdf",
        product_name="",
        sku="",
        page=4,
        image_index=1,
        drive_url="https://drive.google.com/file/d/FILE_ID/view",
        image_filename="Exotica_page_4_image_1.webp",
    )

    master_rows = api.rows["MASTER"]

    # Row 1 is the header written by ensure_master_workbook.
    assert len(master_rows) == 2

    product_row = master_rows[1]

    assert product_row[0] == "EXOTICA-HAMMER-0001"
    assert product_row[10] == (
        "https://drive.google.com/file/d/FILE_ID/view"
    )

    assert api.rows["BRANDS"][1][0] == "BRAND-EXOTICA"


def test_same_product_is_not_written_twice():
    """Re-running a catalog must not duplicate rows."""

    api = FakeSheetsApi(tabs={})

    service.ensure_master_workbook(
        sheets_service=api,
        spreadsheet_id="SHEET_ID",
    )

    def write():
        return service.append_product(
            sheets_service=api,
            spreadsheet_id="SHEET_ID",
            product_id="EXOTICA-HAMMER-0001",
            brand_id="BRAND-EXOTICA",
            brand="Exotica",
            catalog_id="CAT-EXOTICA-HAMMER",
            catalog="Exotica Hammer",
            pdf_name="Exotica Hammer.pdf",
            product_name="",
            sku="",
            page=4,
            image_index=1,
            drive_url="https://drive.google.com/file/d/FILE_ID/view",
            image_filename="Exotica_page_4_image_1.webp",
        )

    assert write() is True
    assert write() is False

    assert len(api.rows["MASTER"]) == 2


def test_the_old_wide_range_would_have_been_rejected():
    """Guards the regression itself: the range this code used to send
    ("A:ZZ") is exactly what the API refuses."""

    api = FakeSheetsApi(
        tabs={"MASTER": {"sheetId": 1, "columnCount": 47}}
    )

    with pytest.raises(GridLimitError, match="exceeds grid limits"):
        api.values().get(
            spreadsheetId="SHEET_ID",
            range="'MASTER'!A:ZZ",
        ).execute()
