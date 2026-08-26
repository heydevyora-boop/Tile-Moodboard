from app.product_attributes import (
    resolve_finish,
    resolve_budget,
)


print("================================")
print("PRODUCT ATTRIBUTE TEST")
print("================================")


# Test 1
finish, source = resolve_finish(
    product_override="GLOSS",
    catalog_default="MATTE",
)

print("\nTest 1")
print("Finish:", finish)
print("Source:", source)


# Test 2
finish, source = resolve_finish(
    product_override="",
    catalog_default="MATTE",
)

print("\nTest 2")
print("Finish:", finish)
print("Source:", source)


# Test 3
finish, source = resolve_finish(
    product_override="",
    catalog_default="",
    extracted_finish="POLISHED",
)

print("\nTest 3")
print("Finish:", finish)
print("Source:", source)


# Test 4
finish, source = resolve_finish()

print("\nTest 4")
print("Finish:", finish)
print("Source:", source)


# Test 5
budget, source = resolve_budget(
    product_override="HIGH RANGE",
    catalog_default="MID RANGE",
)

print("\nTest 5")
print("Budget:", budget)
print("Source:", source)


# Test 6
budget, source = resolve_budget(
    product_override="",
    catalog_default="MID RANGE",
)

print("\nTest 6")
print("Budget:", budget)
print("Source:", source)


print("\n================================")
print("TEST COMPLETE")
print("================================")