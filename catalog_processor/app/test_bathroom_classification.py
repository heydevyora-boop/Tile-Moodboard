from app.bathroom_classification import (
    classify_bathroom_product,
    is_floor_compatible,
    is_wall_compatible,
    is_shower_compatible,
    is_highlight_compatible,
)


print("=" * 50)
print("BATHROOM CLASSIFICATION TEST")
print("=" * 50)


# ============================================================
# TEST 1
# ============================================================

product = classify_bathroom_product(
    suitable_for_wall="YES",
    suitable_for_floor="YES",
    bathroom_wall="YES",
    bathroom_floor="YES",
    shower_area="YES",
    highlight_suitable="NO",
    floor_wall="FLOOR + WALL",
    source="MANUAL",
)

print("\nTEST 1")
print(product)


# ============================================================
# TEST 2
# ============================================================

unknown_product = classify_bathroom_product()

print("\nTEST 2 - UNKNOWN")
print(unknown_product)


# ============================================================
# TEST 3
# ============================================================

floor_product = {
    "Product ID": "TEST-001",
    "Bathroom Floor": "YES",
    "Bathroom Wall": "NO",
    "Shower Area": "YES",
    "Highlight Suitable": "NO",
}

print("\nTEST 3 - FLOOR")

print(
    "Floor compatible:",
    is_floor_compatible(floor_product)
)

print(
    "Wall compatible:",
    is_wall_compatible(floor_product)
)

print(
    "Shower compatible:",
    is_shower_compatible(floor_product)
)

print(
    "Highlight compatible:",
    is_highlight_compatible(floor_product)
)


# ============================================================
# TEST 4
# ============================================================

unknown_product = {
    "Product ID": "TEST-002",
    "Bathroom Floor": "UNKNOWN",
    "Bathroom Wall": "UNKNOWN",
    "Shower Area": "UNKNOWN",
    "Highlight Suitable": "UNKNOWN",
}

print("\nTEST 4 - UNKNOWN MUST NOT BECOME YES")

print(
    "Floor compatible:",
    is_floor_compatible(unknown_product)
)

print(
    "Wall compatible:",
    is_wall_compatible(unknown_product)
)

print(
    "Shower compatible:",
    is_shower_compatible(unknown_product)
)

print(
    "Highlight compatible:",
    is_highlight_compatible(unknown_product)
)


# ============================================================
# COMPLETE
# ============================================================

print("\n" + "=" * 50)
print("TEST COMPLETE")
print("=" * 50)