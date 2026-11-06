#!/usr/bin/env node
// What seed-art.js and seed-audio.js would copy, for the seed dialog on the Orange Pi tab (SOMET-722). Reads the
// database, the checked-in seeds and a listing of the store; writes nothing. Prints art_pending and audio_pending, one
// per line, which tools/pi-helper/boardJobs.js reads. Animation sheets are their own step and are not counted.

const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const assetStore = require('../src/services/assetStore.js');
const { planArt } = require('../src/services/artSeed.js');
const { planAudio } = require('../src/services/audioSeed.js');

// The two plans each list the bucket; one listing serves both. A bucket not made yet holds nothing.
async function planOutput({ db, store }) {
  let listed = null;
  const once = {
    listObjectKeys() {
      if (!listed) {
        listed = store.listObjectKeys().catch((e) => {
          if (e && e.code === 'NoSuchBucket') return [];
          throw e;
        });
      }
      return listed;
    },
  };
  const [art, audio] = await Promise.all([planArt({ db, store: once }), planAudio({ db, store: once })]);
  return `art_pending=${art.pending}\naudio_pending=${audio.pending}`;
}

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  planOutput({ db: pool, store: assetStore })
    .then((text) => console.log(text))
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}

module.exports = { planOutput };
