// MessHall — local boot. The app itself lives in app.js so Vercel can
// require it too (see api/index.js).
const app = require('./app');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`messhall listening on :${PORT}`));
