exports.shorthands = undefined;

// SOMET-328: per-type choice of which service generates a type's image.
//
// TWO COLUMNS RATHER THAN ONE NULLABLE FK, and the reason is that a single
// ai_provider_id cannot express three distinct intents:
//
//   "whatever is currently active"   -- follow the global default, and keep
//                                       following it when the admin switches
//   "always the local sprite-gen"    -- pin to local even though a remote
//                                       provider IS active
//   "always provider #3"             -- pin to one specific remote service
//
// With one nullable column, the first two collapse into NULL and become
// indistinguishable. That matters: "I have not chosen" must keep tracking the
// active provider, while "use local" must survive somebody activating a
// remote one. Encoding the intent explicitly in a mode column means the
// resolver reads what the admin meant instead of inferring it.
//
// ai_provider_id is only consulted when mode = 'provider'. It is ON DELETE SET
// NULL rather than RESTRICT so deleting a provider cannot wedge the types that
// referenced it -- resolveGenerationTarget treats mode='provider' with a NULL
// id as "fall through to the active provider", which degrades to working
// generation rather than to an error.
const TABLES = ['entity_types', 'tile_types'];

exports.up = (pgm) => {
  for (const table of TABLES) {
    pgm.addColumns(table, {
      ai_provider_mode: {
        type: 'text',
        notNull: true,
        default: 'default',
        check: "ai_provider_mode IN ('default', 'local', 'provider')",
      },
      ai_provider_id: {
        type: 'integer',
        references: 'ai_providers',
        onDelete: 'SET NULL',
      },
    });
  }
};

exports.down = (pgm) => {
  for (const table of TABLES) {
    pgm.dropColumns(table, ['ai_provider_mode', 'ai_provider_id']);
  }
};
