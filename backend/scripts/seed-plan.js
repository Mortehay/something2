#!/usr/bin/env node
// What seed-art.js and seed-audio.js would copy right now, for the seed dialog on the Orange Pi tab (SOMET-722).
// Reads the database and lists the store; writes nothing. Prints art_pending, art_total, audio_pending, audio_total,
// one per line. Animation sheets are their own step and are not counted.

const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore.js');
const { planArt } = require('../src/services/artSeed.js');
const { planAudio } = require('../src/services/audioSeed.js');

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  // The two plans each list the bucket; one listing serves both. A bucket not made yet holds nothing.
  let listed = null;
  const store = {
    listObjectKeys() {
      if (!listed) {
        listed = assetStore.listObjectKeys().catch((e) => {
          if (e && e.code === 'NoSuchBucket') return [];
          throw e;
        });
      }
      return listed;
    },
  };
  Promise.all([planArt({ db: pool, store }), planAudio({ db: pool, store })])
    .then(([art, audio]) => {
      console.log(`art_pending=${art.pending}\nart_total=${art.total}\naudio_pending=${audio.pending}\naudio_total=${audio.total}`);
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
