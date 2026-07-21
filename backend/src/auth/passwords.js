const bcrypt = require('bcryptjs');

const COST_FACTOR = 12;

async function hashPassword(plain) {
  return bcrypt.hash(plain, COST_FACTOR);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

module.exports = { hashPassword, verifyPassword };
