# Python scripts

Scripts in this folder are invoked by the Node backend via
`src/utils/pythonRunner.ts` (spawned as child processes — the backend
never re-implements this logic in JS).

- `extract.py` — Part 1, Catalog Extractor. Reads a tile catalog PDF,
  extracts candidate tile images with PyMuPDF, and heuristically tags each
  one (size, finish, type, room, color, product code) from the
  surrounding page text. Saves images locally by default; uploads to
  Google Drive + appends rows to a Google Sheet instead if
  `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` is configured. Run it standalone for
  testing:
  ```bash
  python3 extract.py --pdf /path/to/catalog.pdf --brand "Somany" --output-dir ./extracted
  ```
  Prints `PROGRESS: ...` lines as it works and exactly one
  `RESULT_JSON: {...}` line at the end — that's the line the Node backend
  parses; everything else on stdout is for human reading.

Setup on the machine running the backend:

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```
