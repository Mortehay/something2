exports.shorthands = undefined;

// SOMET-346: how a provider lays out a multi-frame sprite sheet.
//
// The remote machine draws the sheet whole -- all frames, one image. This side
// only needs to know how to CUT it, which is pure arithmetic over a declared
// grid, so these four columns replace what would otherwise be an image library
// and a stitching step.
//
// They are nullable with sensible fallbacks rather than NOT NULL with defaults
// because a provider that only ever makes single static images should not have
// to think about sheets at all: resolveSheetSpec treats "nothing configured"
// as a 1x1 grid, which is exactly the pre-SOMET-346 behaviour.
exports.up = (pgm) => {
  pgm.addColumns('ai_providers', {
    // 'flat' -> frame keys "0","1",… (tiles and objects, matching what the
    // tile pipeline already produces). 'directional' -> "DIR/idx", one row per
    // direction, which is what creature sprites need.
    sheet_layout: {
      type: 'text',
      check: "sheet_layout IS NULL OR sheet_layout IN ('flat', 'directional')",
    },
    sheet_columns: { type: 'integer' },
    sheet_rows: { type: 'integer' },
    // Comma-separated, in ROW ORDER. Configurable because a service that lays
    // its rows out differently should be a settings change, not a release.
    // Defaults to S,SW,W,NW,N,NE,E,SE when null.
    sheet_directions: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('ai_providers', [
    'sheet_layout', 'sheet_columns', 'sheet_rows', 'sheet_directions',
  ]);
};
