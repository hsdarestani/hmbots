'use strict';

// Mahan requested a single, non-paginated catalog. The core config keeps a
// conservative default for reusable deployments; this production layer allows
// the complete Hetzner catalog (up to the config hard ceiling) to be rendered.
const config = require('./config');
config.catalog.maxVisiblePlans = 100;
