const fs = require("fs");
const path = require("path");

const appDir = __dirname;
const dataFile = path.join(appDir, "backend", "data", "store.json");
const legacyDataFile = path.join(__dirname, "..", "noodle", "backend", "data", "store.json");

const dataDir = path.dirname(dataFile);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(dataFile) && fs.existsSync(legacyDataFile)) {
  fs.copyFileSync(legacyDataFile, dataFile);
}

process.env.APP_DIR = appDir;
process.env.BITVAULT_DATA_FILE = dataFile;

const { startServer } = require("../noodle/server");

if (require.main === module) {
  startServer()
    .then((server) => {
      const address = server.address();
      const actualPort = address && typeof address === "object" ? address.port : process.env.PORT || 3001;
      console.log(`BitVault server running at http://localhost:${actualPort}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
