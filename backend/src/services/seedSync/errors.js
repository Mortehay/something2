// A sync file that cannot be trusted (invalid JSON, missing header/rows, wrong
// group, bad rows). The route layer maps it to 422 with `file`.
class SyncFileError extends Error {
  constructor(message, file) {
    super(message);
    this.name = 'SyncFileError';
    this.code = 'bad_file';
    this.file = file;
  }
}

// An action refused by a sync rule (e.g. export while git is newer). The route
// layer maps it to 409 with `code`.
class SyncRefused extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SyncRefused';
    this.code = code;
    this.details = details;
  }
}

module.exports = { SyncFileError, SyncRefused };
