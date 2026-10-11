import "../silence";
import path from "node:path";
import { loadConfig } from "../config";
import { revokeAllSessions } from "../gateway/auth";
import { Db } from "../memory/db";

/** `pnpm run sessions:revoke`: log out every device (all sessions and the capture token), even while the server runs. */
const cfg = loadConfig();
const db = new Db(path.join(cfg.dataDir, "synapse.db"));
revokeAllSessions(db);
db.close();
console.log("All devices are logged out. Sign in again with SYNAPSE_PASSCODE (open WebSockets close within a minute).");
