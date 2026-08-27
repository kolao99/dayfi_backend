/**
 * Load .env then .env.local (override) so local Docker Postgres wins over Railway .env.
 * Usage: mocha -r ./tests/preload-env.cjs -r ts-node/register ...
 */
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({
  path: path.join(__dirname, '..', '.env.local'),
  override: true,
});
