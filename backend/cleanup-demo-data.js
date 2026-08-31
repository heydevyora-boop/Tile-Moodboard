require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM print_boards');
    await client.query('DELETE FROM mood_boards');
    await client.query('DELETE FROM reference_images');
    await client.query('DELETE FROM tiles');
    await client.query('DELETE FROM catalogs');
    await client.query('DELETE FROM brands');
    await client.query('COMMIT');
    console.log('Demo data removed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Cleanup failed, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
