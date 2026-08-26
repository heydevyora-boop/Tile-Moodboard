import database


print("\nDatabase tables:")


connection = database.get_connection()

cursor = connection.cursor()

cursor.execute(
    """
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name
    """
)

tables = cursor.fetchall()


if not tables:
    print("No tables found.")
else:
    for table in tables:
        print("-", table[0])


connection.close()