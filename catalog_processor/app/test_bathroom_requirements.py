from app.bathroom_requirements import (
    create_bathroom_requirements,
    requirements_to_dict,
)


print("=" * 60)
print("BATHROOM REQUIREMENTS TEST")
print("=" * 60)


# ============================================================
# TEST 1 — BASIC BATHROOM
# ============================================================

requirements = create_bathroom_requirements(
    budget="MID RANGE",

    floor_required="YES",
    floor_size="6X4",
    floor_finish="MATTE",

    wall_requirement="REQUIRED",
    wall_size="4X4",
    wall_finish="MATTE",

    highlight_requirement="REQUIRED",

    shower_required="YES",
    shower_type="GLASS PARTITION",
    shower_highlight_required="YES",

    style="MODERN",

    notes="Modern bathroom with warm neutral tones.",
)


print("\nTEST 1")
print(requirements_to_dict(requirements))


# ============================================================
# TEST 2 — SIMPLE BATHROOM
# ============================================================

requirements = create_bathroom_requirements(
    budget="BUDGET FRIENDLY",

    floor_required="YES",
    floor_size="ANY",
    floor_finish="ANY",

    wall_requirement="NOT REQUIRED",

    highlight_requirement="NOT REQUIRED",

    shower_required="NO",

    style="ANY",
)


print("\nTEST 2")
print(requirements_to_dict(requirements))


# ============================================================
# TEST 3 — CUSTOM SIZE
# ============================================================

requirements = create_bathroom_requirements(
    budget="HIGH RANGE",

    floor_required="YES",
    floor_size="CUSTOM",
    floor_size_custom="1200x600",
    floor_finish="POLISHED",

    wall_requirement="REQUIRED",
    wall_size="CUSTOM",
    wall_size_custom="600x1200",
    wall_finish="GLOSS",

    highlight_requirement="REQUIRED",

    shower_required="YES",
    shower_type="GLASS PARTITION",

    style="LUXURY",
)


print("\nTEST 3")
print(requirements_to_dict(requirements))


# ============================================================
# COMPLETE
# ============================================================

print("\n" + "=" * 60)
print("TEST COMPLETE")
print("=" * 60)