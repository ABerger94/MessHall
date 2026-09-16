// Vercel serverless entry. Vercel wraps an exported Express app as a
// serverless function; vercel.json rewrites /api/* here.
module.exports = require('../server/app');
