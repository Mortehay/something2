// The authenticated character-slot API: list an account's characters, list the
// playable classes, create a character, delete one.
//
// Thin by design -- slot allocation, the name and class rules, and the
// ownership check all live in services/characters.js and are tested there.
// This file's only job is auth, request shape, and mapping the service's error
// codes onto HTTP statuses.
//
// Every route acts on req.user.id -- set by requireAuth from the verified,
// revocation-checked token -- and NEVER on an account id read from the request.
// A character id from the path IS accepted, but only ever as an argument to a
// service function that scopes it by req.user.id in the same statement.
const express = require('express');
const { requireAuth } = require('../auth/middleware.js');
const {
  listCharacters, listPlayableClasses, createCharacter, deleteCharacter,
  CharacterError, MAX_CHARACTERS,
} = require('../services/characters.js');

const ERROR_STATUS = {
  bad_name: 400,
  not_playable: 400,
  name_taken: 409,
  no_free_slot: 409,
};

module.exports = function characterRoutes(pool) {
  const router = express.Router();
  const guard = requireAuth(pool);

  router.get('/', guard, async (req, res) => {
    try {
      const characters = await listCharacters(pool, req.user.id);
      res.status(200).json({ characters, maxCharacters: MAX_CHARACTERS });
    } catch (err) {
      console.error('list characters failed:', err);
      res.status(500).json({ error: 'failed to list characters' });
    }
  });

  // Registered BEFORE the '/:id' route below so the literal path is not
  // captured as a character id -- Express matches in declaration order, and a
  // '/:id' declared first would swallow this and 403 on every request.
  router.get('/classes', guard, async (req, res) => {
    try {
      res.status(200).json({ classes: await listPlayableClasses(pool) });
    } catch (err) {
      console.error('list playable classes failed:', err);
      res.status(500).json({ error: 'failed to list classes' });
    }
  });

  router.post('/', guard, async (req, res) => {
    try {
      const body = req.body || {};
      const created = await createCharacter(pool, req.user.id, body.name, body.entity_type_id);
      res.status(201).json(created);
    } catch (err) {
      if (err instanceof CharacterError) {
        return res.status(ERROR_STATUS[err.code] || 400).json({ error: err.code });
      }
      console.error('create character failed:', err);
      return res.status(500).json({ error: 'failed to create character' });
    }
  });

  // 403 for both "not yours" and "does not exist". A 404 for the second would
  // turn this route into an oracle for which character ids are real.
  router.delete('/:id', guard, async (req, res) => {
    try {
      const ok = await deleteCharacter(pool, req.user.id, req.params.id);
      if (!ok) return res.status(403).json({ error: 'forbidden' });
      return res.status(204).end();
    } catch (err) {
      console.error('delete character failed:', err);
      return res.status(500).json({ error: 'failed to delete character' });
    }
  });

  return router;
};
