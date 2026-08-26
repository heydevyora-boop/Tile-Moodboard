from pathlib import Path
import hashlib

from .database import get_connection


def calculate_hash(file_path):

    sha256 = hashlib.sha256()

    with open(
        file_path,
        "rb"
    ) as file:

        while True:

            chunk = file.read(
                1024 * 1024
            )

            if not chunk:
                break

            sha256.update(chunk)

    return sha256.hexdigest()


def register_catalog(
    pdf_path,
    brand="UNKNOWN",
    version="UNKNOWN"
):

    pdf_path = Path(pdf_path)

    file_hash = calculate_hash(
        pdf_path
    )

    connection = get_connection()

    cursor = connection.cursor()

    cursor.execute("""
        SELECT catalog_id
        FROM catalogs
        WHERE file_hash = ?
    """, (file_hash,))

    existing = cursor.fetchone()

    if existing:

        connection.close()

        return {
            "catalog_id":
                existing[0],
            "new": False
        }

    catalog_id = (
        pdf_path.stem.upper()
    )

    cursor.execute("""
        INSERT INTO catalogs
        (
            catalog_id,
            brand,
            pdf_name,
            version,
            file_hash,
            status
        )
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        catalog_id,
        brand,
        pdf_path.name,
        version,
        file_hash,
        "NEW"
    ))

    connection.commit()

    connection.close()

    return {
        "catalog_id":
            catalog_id,
        "new": True
    }