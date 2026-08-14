exports.shorthands = undefined;

// SOMET-324: registered remote AI image services. Until now the only image
// generator was the local sprite-gen container, reached through the
// SPRITE_GEN_URL env var (services/spriteGen.js). That is a deploy-time
// constant: changing it means editing compose and restarting the backend, and
// there is exactly one of it. This table makes "which service draws the
// pixels" runtime admin state instead.
//
// WHY PROFILES RATHER THAN A SINGLE SETTINGS ROW: the machine running the
// image model is somebody's desktop. It is not always on, and it is not always
// the same box. A single row would mean retyping a URL, an auth header and a
// whole JSON request template every time the admin switches between (say) a
// desktop with a GPU and a laptop. Rows are cheap; retyping a template is not.
//
// WHY A JSON TEMPLATE RATHER THAN TYPED COLUMNS: there is no standard image
// generation API. Automatic1111 wants {prompt, steps, cfg_scale, ...},
// OpenAI-compatible endpoints want {model, prompt, size}, and ComfyUI wants a
// whole node graph. Modelling the union of those as columns would be a schema
// migration every time the admin points this at something new. Storing the
// body verbatim, with {{prompt}}-style placeholders substituted at call time,
// means a new service is configuration rather than a release.
exports.up = (pgm) => {
  pgm.createTable('ai_providers', {
    // Serial rather than uuid, matching the sibling admin catalogs
    // (entity_types, item_types, creature_behaviors) so the routes can reuse
    // index.js's existing invalidId integer guard.
    id: { type: 'serial', primaryKey: true },
    name: { type: 'text', notNull: true, unique: true },
    base_url: { type: 'text', notNull: true },

    // Optional auth. Split into header NAME and VALUE because services
    // disagree: some want `Authorization: Bearer x`, some a bare `X-Api-Key`.
    // Storing the name makes that the admin's choice rather than ours.
    //
    // auth_token is plaintext at rest, deliberately and with eyes open: this
    // is a self-hosted game backend whose DATABASE_URL is already in compose,
    // so encrypting here would protect the token from nobody who cannot
    // already read the key. What it is NOT allowed to do is leave the server
    // -- serializeProvider in services/aiProviders.js strips it from every
    // read, and SOMET-333 covers keeping it out of logs and errors too.
    auth_header_name: { type: 'text' },
    auth_token: { type: 'text' },

    // The POST body, verbatim, with {{prompt}} / {{model}} / {{seed}} /
    // {{width}} / {{height}} placeholders. jsonb (not text) so a malformed
    // template cannot be stored at all.
    request_template: { type: 'jsonb', notNull: true },
    model: { type: 'text' },

    // Model discovery, kept generic on purpose -- see SOMET-325. models_path
    // is appended to base_url's origin; models_pointer extracts the list from
    // whatever shape comes back. That pair is why A1111, ComfyUI and Ollama
    // all work without a provider-kind enum in the code.
    models_path: { type: 'text' },
    models_pointer: { type: 'text' },
    models_cache: { type: 'jsonb', notNull: true, default: '[]' },
    models_fetched_at: { type: 'timestamptz' },

    // Where the image sits in the generate response. NULL means "the response
    // body IS the image" (a service returning image/png directly).
    response_image_pointer: { type: 'text' },

    enabled: { type: 'boolean', notNull: true, default: true },
    is_active: { type: 'boolean', notNull: true, default: false },

    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // EXACTLY ONE ACTIVE PROFILE, enforced by the database rather than by the
  // service that happens to write it. A partial unique index on a constant
  // expression permits any number of is_active = false rows and at most one
  // is_active = true row.
  //
  // This is not belt-and-braces over setActive()'s transaction -- it is the
  // thing that makes a SECOND writer safe. The admin UI, a future seeder and
  // a psql session are all capable of setting is_active, and only the index
  // constrains all three.
  pgm.sql(`
    CREATE UNIQUE INDEX ai_providers_single_active_index
      ON ai_providers ((true)) WHERE is_active
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('ai_providers');
};
