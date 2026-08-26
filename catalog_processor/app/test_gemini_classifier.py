# ============================================================
# GEMINI CLASSIFIER TEST
# ============================================================

from app.gemini_classifier import (
    classify_product,
)

from app.gemini_validation import (
    validate_classification,
)


# ============================================================
# TEST PRODUCT
# ============================================================

product = {

    "Product ID": "TEST-GEMINI-001",

    "Product Name": (
        "Modern Matte Marble Tile"
    ),

    "Brand": "TEST BRAND",

    "Catalog": "TEST COLLECTION",

    "Dimensions": "6X4",

    "Resolved Finish": "MATTE",

    "Bathroom Wall": "UNKNOWN",

    "Bathroom Floor": "UNKNOWN",

    "Shower Area": "UNKNOWN",

    "Image Filename": (
        "test_product.jpg"
    ),
}


# ============================================================
# RUN
# ============================================================

print("")
print("=" * 70)
print("GEMINI CLASSIFIER TEST")
print("=" * 70)


result = classify_product(
    product=product,
)


print("")
print("STATUS:")
print(
    result["status"]
)


# ============================================================
# SUCCESS
# ============================================================

if result["status"] == "SUCCESS":

    classification = (
        validate_classification(
            result["classification"]
        )
    )

    print("")
    print("CLASSIFICATION:")
    print(
        classification
    )

# ============================================================
# QUOTA
# ============================================================

elif result[
    "status"
] == "QUOTA_EXHAUSTED":

    print("")
    print(
        "Gemini API quota is exhausted."
    )

    print(
        "The classifier code is working, "
        "but the API request cannot currently "
        "be completed."
    )

# ============================================================
# ERROR
# ============================================================

else:

    print("")
    print(
        "Gemini classification failed:"
    )

    print(
        result["error"]
    )


print("")
print("=" * 70)
print("GEMINI CLASSIFIER TEST COMPLETE")
print("=" * 70)