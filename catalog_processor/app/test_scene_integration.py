import json

from app.final_bathroom_engine import build_final_bathroom_design
from app import scene_manager


# ============================================================
# TEST DATA
# ============================================================
#
# This is intentionally a small mock input.
# It does NOT call Gemini or Google Drive.
#
# The purpose is only to verify:
#
# final_bathroom_engine
#       ↓
# final_design
#       ↓
# scene_manager
#       ↓
# SQLite scenes table
#
# ============================================================

REQUIREMENTS = {
    "style": "Modern",
    "budget": "Premium",
    "layout": "Corner Bathroom",
    "shower": "Separate Shower",
    "partition": "Full Glass",
    "colors": "Warm Beige",
    "finishes": "Matte",
}


MOODBOARDS = [
    {
        "moodboard_id": "TEST_MB_001",
        "name": "Modern Warm Beige",
        "description": "Modern warm beige bathroom",
        "products": [
            {
                "product": {
                    "Product ID": "P001",
                    "Product Name": "Statuario Floor",
                    "Brand": "Test Brand",
                    "Catalog": "Test Catalog",
                    "Dimensions": "600x1200",
                    "Resolved Finish": "Matte",
                    "Resolved Budget": "Premium",
                    "AI Style": "Modern",
                    "AI Color": "Warm Beige",
                    "AI Tone": "Warm",
                    "AI Pattern": "Marble",
                },
                "mood_score": 90,
                "total_score": 92,
                "mood_matches": [
                    "modern",
                    "warm",
                    "premium",
                ],
            }
        ],
    }
]


# ============================================================
# FIXTURE DATA
# ============================================================

FIXTURE_PACKAGES = [
    {
        "moodboard_id": "TEST_MB_001",

        "fixture_package": {
            "BASIN": {
                "fixture": {
                    "Product ID": "B001",
                    "Product Name": "Test Basin",
                    "Brand": "Test Brand",
                    "Category": "BASIN",
                    "Style": "Modern",
                    "Color": "White",
                    "Tone": "Warm",
                    "Finish": "Gloss",
                    "Budget": "Premium",
                },
                "score": 90,
                "technical_verified": True,
                "reasons": [],
            },

            "WC": {
                "fixture": {
                    "Product ID": "W001",
                    "Product Name": "Test WC",
                    "Brand": "Test Brand",
                    "Category": "WC",
                    "Style": "Modern",
                    "Color": "White",
                    "Tone": "Warm",
                    "Finish": "Gloss",
                    "Budget": "Premium",
                },
                "score": 90,
                "technical_verified": True,
                "reasons": [],
            },

            "FAUCET": {
                "fixture": {
                    "Product ID": "F001",
                    "Product Name": "Test Faucet",
                    "Brand": "Test Brand",
                    "Category": "FAUCET",
                    "Style": "Modern",
                    "Color": "Chrome",
                    "Tone": "Cool",
                    "Finish": "Chrome",
                    "Budget": "Premium",
                },
                "score": 90,
                "technical_verified": True,
                "reasons": [],
            },

            "SHOWER": {
                "fixture": {
                    "Product ID": "S001",
                    "Product Name": "Test Shower",
                    "Brand": "Test Brand",
                    "Category": "SHOWER",
                    "Style": "Modern",
                    "Color": "Chrome",
                    "Tone": "Cool",
                    "Finish": "Chrome",
                    "Budget": "Premium",
                },
                "score": 90,
                "technical_verified": True,
                "reasons": [],
            },
        }
    }
]


# ============================================================
# MAIN TEST
# ============================================================

def main():

    print("")
    print("=" * 70)
    print("SCENE INTEGRATION TEST")
    print("=" * 70)

    # --------------------------------------------------------
    # Build final bathroom design
    # --------------------------------------------------------

    print("")
    print("1. Building final bathroom design...")

    final_design = build_final_bathroom_design(
        requirements=REQUIREMENTS,
        moodboards=MOODBOARDS,
        fixture_packages=FIXTURE_PACKAGES,
    )

    print("   Final bathroom design created.")

    # --------------------------------------------------------
    # Check Scene
    # --------------------------------------------------------

    print("")
    print("2. Checking Scene...")

    scene = final_design.get(
        "scene"
    )

    if not scene:
        raise RuntimeError(
            "Scene was not created."
        )

    scene_id = scene.get(
        "scene_id"
    )

    if not scene_id:
        raise RuntimeError(
            "Scene ID was not generated."
        )

    print(
        f"   Scene ID: {scene_id}"
    )

    # --------------------------------------------------------
    # Load Scene from database
    # --------------------------------------------------------

    print("")
    print("3. Loading Scene from database...")

    saved_scene = scene_manager.get_scene(
        scene_id
    )

    if not saved_scene:
        raise RuntimeError(
            "Scene was not found in database."
        )

    print(
        "   Scene successfully loaded."
    )

    # --------------------------------------------------------
    # Verify locked data
    # --------------------------------------------------------

    print("")
    print("4. Verifying locked scene data...")

    print(
        f"   Moodboard ID: "
        f"{saved_scene['moodboard_id']}"
    )

    print(
        f"   Layout: "
        f"{saved_scene['layout']}"
    )

    print(
        f"   Shower: "
        f"{saved_scene['shower']}"
    )

    print(
        f"   Partition: "
        f"{saved_scene['partition']}"
    )

    print(
        f"   Style: "
        f"{saved_scene['style']}"
    )

    print(
        f"   Colors: "
        f"{saved_scene['colors']}"
    )

    print(
        f"   Finishes: "
        f"{saved_scene['finishes']}"
    )

    # --------------------------------------------------------
    # Verify products
    # --------------------------------------------------------

    print("")
    print("5. Verifying locked products...")

    products = saved_scene.get(
        "products",
        {}
    )

    if not products:
        raise RuntimeError(
            "No products were saved in Scene."
        )

    print(
        json.dumps(
            products,
            indent=4,
            ensure_ascii=False
        )
    )

    # --------------------------------------------------------
    # Lock Scene
    # --------------------------------------------------------

    print("")
    print("6. Locking Scene...")

    locked = scene_manager.lock_scene(
        scene_id
    )

    if not locked:
        raise RuntimeError(
            "Scene could not be locked."
        )

    locked_scene = scene_manager.get_scene(
        scene_id
    )

    if not locked_scene:
        raise RuntimeError(
            "Locked Scene could not be loaded."
        )

    if locked_scene["status"] != "LOCKED":
        raise RuntimeError(
            "Scene status is not LOCKED."
        )

    print(
        "   Scene status: LOCKED"
    )

    # --------------------------------------------------------
    # Test angle record
    # --------------------------------------------------------

    print("")
    print("7. Testing Scene angle storage...")

    angle = scene_manager.save_angle(
        scene_id=scene_id,
        angle="LEFT",
        drive_url="",
        status="GENERATED",
    )

    print(
        f"   Scene ID: {angle['scene_id']}"
    )

    print(
        f"   Angle: {angle['angle']}"
    )

    print(
        f"   Status: {angle['status']}"
    )

    # --------------------------------------------------------
    # Retrieve angle
    # --------------------------------------------------------

    saved_angle = scene_manager.get_angle(
        scene_id,
        "LEFT"
    )

    if not saved_angle:
        raise RuntimeError(
            "Scene angle was not saved."
        )

    print(
        "   LEFT angle successfully saved."
    )

    # --------------------------------------------------------
    # Final result
    # --------------------------------------------------------

    print("")
    print("=" * 70)
    print("SCENE INTEGRATION TEST PASSED")
    print("=" * 70)

    print("")
    print(
        f"SCENE_ID: {scene_id}"
    )

    print(
        "Scene: LOCKED"
    )

    print(
        "Angle test: LEFT"
    )

    print(
        "Database: OK"
    )

    print("")
    print("=" * 70)


if __name__ == "__main__":
    main()