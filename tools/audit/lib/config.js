'use strict';

// Every Plane id literal in this project lives here and nowhere else.
const PLANE = {
  workspace: 'something2',
  projectId: '5af54080-02ab-4ce8-8473-0b20632e0460',
  epicTypeId: '14e6dccc-3a38-4276-8820-f3e74922d09e',
  doneStateId: 'e1cbace7-9999-4847-a54b-6d3f248c6dfe',
  // Cloudflare rejects the default Node UA with a 403 (error code 1010).
  userAgent: 'curl/8.5.0',
  baseUrl: 'https://api.plane.so/api/v1',
};

const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];

const PRIORITY_BY_SEVERITY = {
  P0: 'urgent',
  P1: 'high',
  P2: 'medium',
  P3: 'low',
};

const LENSES = ['dry', 'kiss', 'yagni', 'solid', 'security', 'user-logic'];

const SURFACES = [
  'backend-api',
  'backend-authority',
  'frontend-admin',
  'frontend-game',
  'sprite-gen',
  'infra',
];

const STATUSES = ['open', 'fixed', 'unverified', 'demoted'];

const SOURCES = ['static', 'browser'];

module.exports = {
  PLANE,
  SEVERITIES,
  PRIORITY_BY_SEVERITY,
  LENSES,
  SURFACES,
  STATUSES,
  SOURCES,
};
