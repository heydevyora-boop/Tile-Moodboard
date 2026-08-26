from typing import Optional, List
from pydantic import BaseModel, Field


class ProductIdentification(BaseModel):

    # ========================================================
    # PRODUCT IMAGE CHECK
    # ========================================================

    is_product_image: bool = Field(
        description=(
            "True only when the image contains a standalone "
            "physical tile/product sample that can be kept "
            "for the product database."
        )
    )

    # ========================================================
    # IMAGE ROLE
    # ========================================================

    image_role: str = Field(
        description=(
            "One of: product, lifestyle, installation, logo, "
            "texture, decorative, banner, other"
        )
    )

    # ========================================================
    # PRODUCT COUNT
    # ========================================================

    product_count: int = Field(
        default=0,
        ge=0,
        description=(
            "Number of distinct physical tile/product samples "
            "visible in the image. Return 1 ONLY when exactly "
            "one standalone physical tile/product sample is "
            "clearly present. Return 0 when there is no "
            "standalone product. Return 2 or more when multiple "
            "physical products/tiles are visible."
        )
    )

    # ========================================================
    # PRODUCT INFORMATION
    # ========================================================

    product_name: Optional[str] = Field(
        default=None,
        description=(
            "Product or tile name if clearly identifiable. "
            "Never invent a product name."
        )
    )

    brand: Optional[str] = Field(
        default=None,
        description=(
            "Brand name if clearly identifiable. "
            "Never invent a brand."
        )
    )

    product_code: Optional[str] = Field(
        default=None,
        description=(
            "Product code/SKU if clearly visible in the "
            "supplied text."
        )
    )

    # ========================================================
    # CONFIDENCE
    # ========================================================

    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="Confidence from 0 to 1."
    )

    # ========================================================
    # REASON
    # ========================================================

    reason: str = Field(
        description=(
            "Short explanation for why the image was classified "
            "as a standalone product/tile or rejected."
        )
    )

    # ========================================================
    # PRODUCT BOUNDING BOX
    # ========================================================

    product_bbox: Optional[List[float]] = Field(
        default=None,
        description=(
            "Optional normalized bounding box [x1,y1,x2,y2] "
            "for the SINGLE main product, where coordinates "
            "range from 0 to 1. Return null when the product "
            "cannot be isolated reliably."
        )
    )