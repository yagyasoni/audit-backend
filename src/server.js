// import app from "./app.js";
// import { pool } from "./config/db.js";
// import https from "https";
// import fs from "fs";

// const PORT = process.env.PORT;

// async function startServer() {
//   try {
//     await pool.query("SELECT 1");
//     console.log("Database connected");

//     const options = {
//       pfx: fs.readFileSync("server.pfx"), // make sure this file is in C:\backend
//       passphrase: "1234", // same password you used while exporting
//     };

//     https.createServer(options, app).listen(PORT, () => {
//       console.log(`HTTPS Server running on port ${PORT}`);
//     });
//   } catch (err) {
//     console.error("Database connection failed");
//     console.error(err);
//   }
// }

// startServer();

import app from "./app.js";
import { pool } from "./config/db.js";

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await pool.query("SELECT 1");
    console.log("Database connected");

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Database connection failed");
    console.error(err);
  }
}

startServer();
