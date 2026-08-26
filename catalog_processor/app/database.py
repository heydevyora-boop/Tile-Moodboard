import sqlite3
from pathlib import Path


DATABASE_FILE = Path("catalog_agent.db")


def get_connection():
    """
    Create and return a SQLite database connection.
    """
    return sqlite3.connect(DATABASE_FILE)


def initialize_database():
    """
    Initialize all required database tables.
    """

    connection = get_connection()
    cursor = connection.cursor()

    # ========================================================
    # EXISTING TABLE
    # ========================================================

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS processed_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_hash TEXT UNIQUE,
            filename TEXT,
            processed_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    # ========================================================
    # LOCKED BATHROOM SCENES
    # ========================================================

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS scenes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            scene_id TEXT UNIQUE NOT NULL,

            moodboard_id TEXT,

            requirements_json TEXT,

            products_json TEXT,

            layout TEXT,

            shower TEXT,

            partition TEXT,

            style TEXT,

            colors TEXT,

            finishes TEXT,

            created_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP,

            status TEXT DEFAULT 'ACTIVE'
        )
        """
    )

    # ========================================================
    # GENERATED SCENE ANGLES
    # ========================================================

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS scene_angles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            scene_id TEXT NOT NULL,

            angle TEXT NOT NULL,

            drive_url TEXT,

            status TEXT DEFAULT 'GENERATING',

            created_at TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP,

            UNIQUE(scene_id, angle),

            FOREIGN KEY (scene_id)
                REFERENCES scenes(scene_id)
        )
        """
    )

    connection.commit()
    connection.close()


def already_processed(file_hash):
    """
    Check whether a file has already been processed.
    """

    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute(
        """
        SELECT id
        FROM processed_files
        WHERE file_hash = ?
        """,
        (file_hash,)
    )

    result = cursor.fetchone()

    connection.close()

    return result is not None


def mark_processed(file_hash, filename):
    """
    Mark a file as processed.
    """

    connection = get_connection()
    cursor = connection.cursor()

    cursor.execute(
        """
        INSERT OR IGNORE INTO processed_files
        (
            file_hash,
            filename
        )
        VALUES (?, ?)
        """,
        (
            file_hash,
            filename
        )
    )

    connection.commit()
    connection.close()


initialize_database()