import database
import scene_manager


# ============================================================
# SCENE DATABASE CHECK
# ============================================================

def check_scenes():

    print("")
    print("=" * 70)
    print("LOCKED SCENE DATABASE CHECK")
    print("=" * 70)

    connection = database.get_connection()
    cursor = connection.cursor()

    # --------------------------------------------------------
    # GET ALL SCENES
    # --------------------------------------------------------

    cursor.execute(
        """
        SELECT
            scene_id,
            moodboard_id,
            layout,
            shower,
            partition,
            style,
            colors,
            finishes,
            status,
            created_at
        FROM scenes
        ORDER BY created_at DESC
        """
    )

    scenes = cursor.fetchall()

    connection.close()

    # --------------------------------------------------------
    # NO SCENES
    # --------------------------------------------------------

    if not scenes:

        print("")
        print("No locked scenes found.")
        print("")
        print(
            "The database is ready, but no final bathroom "
            "scene has been created yet."
        )
        print("")

        return

    # --------------------------------------------------------
    # SCENE COUNT
    # --------------------------------------------------------

    print("")
    print(
        f"Total scenes: {len(scenes)}"
    )
    print("")

    # --------------------------------------------------------
    # DISPLAY SCENES
    # --------------------------------------------------------

    for index, scene in enumerate(
        scenes,
        start=1
    ):

        (
            scene_id,
            moodboard_id,
            layout,
            shower,
            partition,
            style,
            colors,
            finishes,
            status,
            created_at,
        ) = scene

        print("-" * 70)

        print(
            f"Scene #{index}"
        )

        print(
            f"  Scene ID     : {scene_id}"
        )

        print(
            f"  Moodboard ID : {moodboard_id}"
        )

        print(
            f"  Layout       : {layout}"
        )

        print(
            f"  Shower       : {shower}"
        )

        print(
            f"  Partition    : {partition}"
        )

        print(
            f"  Style        : {style}"
        )

        print(
            f"  Colors       : {colors}"
        )

        print(
            f"  Finishes     : {finishes}"
        )

        print(
            f"  Status       : {status}"
        )

        print(
            f"  Created At   : {created_at}"
        )

        # ----------------------------------------------------
        # GET GENERATED ANGLES
        # ----------------------------------------------------

        angles = scene_manager.get_scene_angles(
            scene_id
        )

        print(
            f"  Generated Angles: {len(angles)}"
        )

        if angles:

            for angle in angles:

                print(
                    f"    - {angle['angle']}"
                )

        else:

            print(
                "    - None yet"
            )

    # --------------------------------------------------------
    # COMPLETE
    # --------------------------------------------------------

    print("")
    print("=" * 70)
    print("SCENE CHECK COMPLETE")
    print("=" * 70)
    print("")


# ============================================================
# MAIN
# ============================================================

if __name__ == "__main__":
    check_scenes()