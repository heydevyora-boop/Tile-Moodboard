"""
test_master_to_visualization_image_handoff.py

Focused integration test for the exact chain this milestone fixes:

    MASTER PRODUCT record
        -> Drive URL / Drive file ID
        -> actual image bytes fetched through the authenticated
           Google Drive service (get_drive_service(), used elsewhere
           in this app for uploads)
        -> those actual bytes passed into the visualization pipeline
           as tile_image

No real Google Drive/Sheets/Gemini calls are made. The network
boundaries (load_product_master, the authenticated Drive download, and
generate_tile_visualization) are replaced with fakes, matching how the
rest of this app's offline tests are written -- but nothing about the
resolution logic in between (get_product_for_visualization,
resolve_product_image, generate_product_visualization) is faked.

This guards against the actual production bug: catalog_pipeline.py's
uploader does not grant "anyone: reader" on the Drive files it creates,
so an anonymous HTTP fetch of the stored "Drive URL" returns Google's
HTML login/preview page for every real catalog product. That silent
failure used to fall through to _generate_synthetic_product_swatch(),
so Gemini would visualize a fake grid placeholder instead of the real
tile -- with no error raised anywhere.
"""

from pathlib import Path

import pytest

import app.product_visualization_service as service


REAL_CATALOG_IMAGE_BYTES = b"REAL_CATALOG_JPEG_BYTES_NOT_A_PLACEHOLDER"

DRIVE_URL = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view"
DRIVE_FILE_ID = "1AbCdEfGhIjKlMnOpQrSt"


def _master_records_for(product_id):
    """A MASTER row shaped exactly like append_product() actually
    writes one: only a 'Drive URL' column carries the image reference
    -- there is no image_path/crop_path/local_path column at all."""
    return [
        {
            "Record Type": "PRODUCT",
            "Record ID": product_id,
            "Product ID": product_id,
            "Name": "Calacatta Gold Marble",
            "Drive URL": DRIVE_URL,
        }
    ]


@pytest.fixture()
def tmp_output_root(tmp_path, monkeypatch):
    """Redirect the module's cache/output directories into a temp dir
    so this test never touches (or depends on) real repo output."""
    output_root = tmp_path / "output"
    monkeypatch.setattr(service, "OUTPUT_ROOT", output_root)
    monkeypatch.setattr(
        service, "REMOTE_IMAGE_CACHE_DIR", output_root / "remote_image_cache"
    )
    return output_root


def test_real_master_product_image_reaches_visualization_via_drive_api(
    tmp_output_root, tmp_path, monkeypatch
):
    """MASTER product -> Drive URL -> Drive file ID -> authenticated
    Drive download -> real bytes passed as tile_image to the
    visualization pipeline. No synthetic placeholder anywhere."""

    product_id = "PROD-REAL0001"

    # 1. MASTER lookup: real product, only a Drive URL for its image.
    monkeypatch.setattr(
        service,
        "load_product_master",
        lambda spreadsheet_id, sheet_name="MASTER": _master_records_for(product_id),
    )

    # 2. Authenticated Drive download boundary. Proves the resolution
    #    path used is the authenticated Drive API (file ID resolved
    #    from the Drive URL), not an anonymous HTTP GET.
    drive_api_calls = []

    def fake_download_via_drive_api(file_id, cache_key):
        drive_api_calls.append(file_id)
        assert file_id == DRIVE_FILE_ID

        cache_dir = service.REMOTE_IMAGE_CACHE_DIR
        cache_dir.mkdir(parents=True, exist_ok=True)
        cached_path = cache_dir / f"{cache_key}.jpg"
        cached_path.write_bytes(REAL_CATALOG_IMAGE_BYTES)
        return cached_path.resolve()

    monkeypatch.setattr(
        service, "_download_via_drive_api", fake_download_via_drive_api
    )

    # No anonymous HTTP fetch should ever be attempted once the
    # authenticated path succeeds.
    def fail_if_called(*args, **kwargs):
        raise AssertionError(
            "anonymous HTTP GET was used instead of the authenticated "
            "Drive API"
        )

    monkeypatch.setattr(service.requests, "get", fail_if_called, raising=False)

    # 3. Visualization pipeline boundary: capture exactly what image
    #    bytes/path it was handed.
    received = {}

    def fake_generate_tile_visualization(
        scene_image, product_id, surface, tile_image, tile_name, angle=None
    ):
        received["tile_image"] = Path(tile_image)
        received["tile_name"] = tile_name
        return {
            "status": "GENERATED",
            "visualization_id": "VIZ_TEST",
            "scene_id": "SCENE_TEST",
        }

    monkeypatch.setattr(
        service, "generate_tile_visualization", fake_generate_tile_visualization
    )

    scene_image = tmp_path / "scene.png"
    scene_image.write_bytes(b"FAKE_SCENE")
    monkeypatch.setattr(service, "resolve_scene_image", lambda path: Path(path))

    # --------------------------------------------------------------
    # RUN
    # --------------------------------------------------------------

    result = service.generate_product_visualization(
        spreadsheet_id="SHEET_ID",
        product_id=product_id,
        scene_image=scene_image,
    )

    # --------------------------------------------------------------
    # ASSERT: the authenticated Drive API was actually used
    # --------------------------------------------------------------

    assert drive_api_calls == [DRIVE_FILE_ID]

    # --------------------------------------------------------------
    # ASSERT: real catalog bytes reached the visualization pipeline
    # --------------------------------------------------------------

    assert received["tile_image"].read_bytes() == REAL_CATALOG_IMAGE_BYTES
    assert received["tile_name"] == "Calacatta Gold Marble"

    # --------------------------------------------------------------
    # ASSERT: no synthetic placeholder was ever generated or used
    # --------------------------------------------------------------

    assert result["master_source"] == "GOOGLE_SHEETS_MASTER"
    assert result["product_record"].get("synthetic") is not True
    assert not str(received["tile_image"]).startswith(
        str(tmp_output_root / "tile_swatches")
    )


def test_real_master_product_with_unresolvable_image_raises_clear_error(
    tmp_output_root, tmp_path, monkeypatch
):
    """A product that DOES exist in MASTER, but whose Drive image can't
    be fetched by any resolution path, must raise a clear error --
    never fall back to _generate_synthetic_product_swatch()."""

    product_id = "PROD-BROKEN01"

    monkeypatch.setattr(
        service,
        "load_product_master",
        lambda spreadsheet_id, sheet_name="MASTER": _master_records_for(product_id),
    )

    def failing_drive_api(file_id, cache_key):
        raise RuntimeError("Drive API unavailable in test")

    monkeypatch.setattr(service, "_download_via_drive_api", failing_drive_api)

    monkeypatch.setattr(
        service.requests,
        "get",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no network in test")),
        raising=False,
    )

    swatch_calls = []
    monkeypatch.setattr(
        service,
        "_generate_synthetic_product_swatch",
        lambda pid: swatch_calls.append(pid) or pytest.fail(
            "must not synthesize a placeholder for a real MASTER product"
        ),
    )

    scene_image = tmp_path / "scene.png"
    scene_image.write_bytes(b"FAKE_SCENE")
    monkeypatch.setattr(service, "resolve_scene_image", lambda path: Path(path))

    with pytest.raises(FileNotFoundError) as excinfo:
        service.generate_product_visualization(
            spreadsheet_id="SHEET_ID",
            product_id=product_id,
            scene_image=scene_image,
        )

    assert product_id in str(excinfo.value)
    assert swatch_calls == []
