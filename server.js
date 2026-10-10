// Compatibility entry point. The active API and static file server live in backend/server.js.
if (require.main === module) require('./start.js');
else module.exports = require('./backend/server');
