# ============================================================
# PRODUCT DEDUPLICATOR
# ============================================================

import hashlib
import re
import sqlite3
from pathlib import Path

import imagehash
from PIL import Image


DATABASE_FILE = Path("catalog_products.db")

# ------------------------------------------------------------
# VISUAL DUPLICATE THRESHOLDS
# ------------------------------------------------------------

# Lower = stricter
PHASH_THRESHOLD = 8
DHASH_THRESHOLD = 8
WHASH_THRESHOLD = 8


# ============================================================
# DATABASE
# ============================================================

def get_connection():
    connection = sqlite3.connect(
        DATABASE_FILE
    )

    connection.row_factory = sqlite3.Row

    return connection


def initialize_database():

    connection = get_connection()

    cursor = connection.cursor()

    # --------------------------------------------------------
    # MASTER PRODUCTS
    # --------------------------------------------------------

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS products (

            product_id TEXT PRIMARY KEY,

            brand TEXT NOT NULL,

            product_name TEXT,

            product_code TEXT,

            brand_key TEXT,

            product_name_key TEXT,

            product_code_key TEXT,

            primary_image_path TEXT,

            primary_drive_url TEXT,

            primary_catalog TEXT,

            primary_page INTEGER,

            created_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP,

            updated_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # --------------------------------------------------------
    # SOURCE OCCURRENCES
    # --------------------------------------------------------

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS product_sources (

            id INTEGER PRIMARY KEY AUTOINCREMENT,

            product_id TEXT NOT NULL,

            catalog_name TEXT,

            pdf_filename TEXT,

            page_number INTEGER,

            image_index INTEGER,

            source_image TEXT,

            is_primary INTEGER DEFAULT 0,

            sha256 TEXT,

            phash TEXT,

            dhash TEXT,

            whash TEXT,

            created_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # --------------------------------------------------------
    # IMAGE FINGERPRINTS
    # --------------------------------------------------------

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS image_fingerprints (

            id INTEGER PRIMARY KEY AUTOINCREMENT,

            product_id TEXT NOT NULL,

            sha256 TEXT UNIQUE,

            phash TEXT,

            dhash TEXT,

            whash TEXT,

            image_path TEXT,

            drive_url TEXT,

            created_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP
        )
    """)

    connection.commit()

    connection.close()


# ============================================================
# NORMALIZATION
# ============================================================

def normalize_text(value):

    if value is None:
        return ""

    value = str(value).strip().lower()

    value = re.sub(
        r"[^a-z0-9]+",
        " ",
        value
    )

    value = re.sub(
        r"\s+",
        " ",
        value
    )

    return value.strip()


def normalize_code(value):

    value = normalize_text(value)

    return value.replace(
        " ",
        ""
    )


# ============================================================
# SHA256
# ============================================================

def calculate_sha256(
    image_path
):

    sha256 = hashlib.sha256()

    with open(
        image_path,
        "rb"
    ) as file:

        while True:

            chunk = file.read(
                1024 * 1024
            )

            if not chunk:
                break

            sha256.update(
                chunk
            )

    return sha256.hexdigest()


# ============================================================
# VISUAL HASHES
# ============================================================

def calculate_visual_hashes(
    image_path
):

    image = Image.open(
        image_path
    ).convert(
        "RGB"
    )

    return {

        "phash":
            str(
                imagehash.phash(
                    image
                )
            ),

        "dhash":
            str(
                imagehash.dhash(
                    image
                )
            ),

        "whash":
            str(
                imagehash.whash(
                    image
                )
            )
    }


# ============================================================
# HASH DISTANCE
# ============================================================

def hash_distance(
    hash_a,
    hash_b
):

    try:

        return imagehash.hex_to_hash(
            hash_a
        ) - imagehash.hex_to_hash(
            hash_b
        )

    except Exception:

        return 999


# ============================================================
# PRODUCT IDENTITY SEARCH
# ============================================================

def find_existing_product(
    brand,
    product_name=None,
    product_code=None
):

    initialize_database()

    brand_key = normalize_text(
        brand
    )

    code_key = normalize_code(
        product_code
    )

    name_key = normalize_text(
        product_name
    )

    connection = get_connection()

    cursor = connection.cursor()

    # --------------------------------------------------------
    # PRIORITY 1
    # PRODUCT CODE
    # --------------------------------------------------------

    if (
        brand_key
        and code_key
    ):

        cursor.execute(
            """
            SELECT *
            FROM products
            WHERE brand_key = ?
            AND product_code_key = ?
            LIMIT 1
            """,
            (
                brand_key,
                code_key
            )
        )

        row = cursor.fetchone()

        if row:

            connection.close()

            return {
                "match_type":
                    "PRODUCT_CODE",

                "product":
                    dict(row)
            }

    # --------------------------------------------------------
    # PRIORITY 2
    # BRAND + PRODUCT NAME
    # --------------------------------------------------------

    if (
        brand_key
        and name_key
    ):

        cursor.execute(
            """
            SELECT *
            FROM products
            WHERE brand_key = ?
            AND product_name_key = ?
            LIMIT 1
            """,
            (
                brand_key,
                name_key
            )
        )

        row = cursor.fetchone()

        if row:

            connection.close()

            return {
                "match_type":
                    "BRAND_PRODUCT_NAME",

                "product":
                    dict(row)
            }

    connection.close()

    return None


# ============================================================
# EXACT IMAGE DUPLICATE
# ============================================================

def find_exact_duplicate(
    sha256
):

    initialize_database()

    connection = get_connection()

    row = connection.execute(
        """
        SELECT *
        FROM image_fingerprints
        WHERE sha256 = ?
        LIMIT 1
        """,
        (
            sha256,
        )
    ).fetchone()

    connection.close()

    if row:

        return dict(row)

    return None


# ============================================================
# VISUAL DUPLICATE
# ============================================================

def find_visual_duplicate(
    phash,
    dhash,
    whash
):

    initialize_database()

    connection = get_connection()

    rows = connection.execute(
        """
        SELECT *
        FROM image_fingerprints
        """
    ).fetchall()

    connection.close()

    best_match = None

    best_score = 999

    for row in rows:

        row = dict(row)

        p_distance = hash_distance(
            phash,
            row.get("phash")
        )

        d_distance = hash_distance(
            dhash,
            row.get("dhash")
        )

        w_distance = hash_distance(
            whash,
            row.get("whash")
        )

        # ----------------------------------------------------
        # Require strong visual agreement.
        # ----------------------------------------------------

        matches = 0

        if p_distance <= PHASH_THRESHOLD:
            matches += 1

        if d_distance <= DHASH_THRESHOLD:
            matches += 1

        if w_distance <= WHASH_THRESHOLD:
            matches += 1

        if matches >= 2:

            score = (
                p_distance
                + d_distance
                + w_distance
            )

            if score < best_score:

                best_score = score

                best_match = {

                    "match_type":
                        "VISUAL",

                    "product_id":
                        row["product_id"],

                    "sha256":
                        row["sha256"],

                    "phash_distance":
                        p_distance,

                    "dhash_distance":
                        d_distance,

                    "whash_distance":
                        w_distance,

                    "image_path":
                        row["image_path"],

                    "drive_url":
                        row["drive_url"]
                }

    return best_match


# ============================================================
# CREATE PRODUCT
# ============================================================

def create_product(
    brand,
    product_name,
    product_code,
    catalog_name,
    page_number,
    image_path,
    drive_url
):

    initialize_database()

    connection = get_connection()

    cursor = connection.cursor()

    # --------------------------------------------------------
    # Generate sequential product ID
    # --------------------------------------------------------

    cursor.execute(
        """
        SELECT product_id
        FROM products
        WHERE product_id LIKE 'TIL-%'
        ORDER BY id DESC
        LIMIT 1
        """
    )

    row = cursor.fetchone()

    if row:

        try:

            last_number = int(
                row["product_id"]
                .split("-")[-1]
            )

        except Exception:

            last_number = 0

    else:

        last_number = 0

    product_id = (
        f"TIL-{last_number + 1:06d}"
    )

    brand_key = normalize_text(
        brand
    )

    name_key = normalize_text(
        product_name
    )

    code_key = normalize_code(
        product_code
    )

    cursor.execute(
        """
        INSERT INTO products (

            product_id,
            brand,
            product_name,
            product_code,

            brand_key,
            product_name_key,
            product_code_key,

            primary_image_path,
            primary_drive_url,

            primary_catalog,
            primary_page
        )

        VALUES (
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?,
            ?, ?
        )
        """,
        (

            product_id,

            brand or "",

            product_name,

            product_code,

            brand_key,

            name_key,

            code_key,

            str(image_path),

            drive_url,

            catalog_name,

            page_number
        )
    )

    connection.commit()

    connection.close()

    return product_id


# ============================================================
# SAVE IMAGE FINGERPRINT
# ============================================================

def save_image_fingerprint(
    product_id,
    sha256,
    phash,
    dhash,
    whash,
    image_path,
    drive_url
):

    initialize_database()

    connection = get_connection()

    connection.execute(
        """
        INSERT OR IGNORE INTO image_fingerprints (

            product_id,

            sha256,

            phash,
            dhash,
            whash,

            image_path,

            drive_url
        )

        VALUES (
            ?, ?,
            ?, ?, ?,
            ?, ?
        )
        """,
        (

            product_id,

            sha256,

            phash,
            dhash,
            whash,

            str(image_path),

            drive_url
        )
    )

    connection.commit()

    connection.close()


# ============================================================
# SAVE SOURCE
# ============================================================

def save_product_source(
    product_id,
    catalog_name,
    pdf_filename,
    page_number,
    image_index,
    source_image,
    is_primary,
    sha256,
    phash,
    dhash,
    whash
):

    initialize_database()

    connection = get_connection()

    connection.execute(
        """
        INSERT INTO product_sources (

            product_id,

            catalog_name,
            pdf_filename,

            page_number,
            image_index,

            source_image,

            is_primary,

            sha256,

            phash,
            dhash,
            whash
        )

        VALUES (
            ?, ?, ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?, ?, ?
        )
        """,
        (

            product_id,

            catalog_name,
            pdf_filename,

            page_number,
            image_index,

            str(source_image),

            1 if is_primary else 0,

            sha256,

            phash,
            dhash,
            whash
        )
    )

    connection.commit()

    connection.close()


initialize_database()