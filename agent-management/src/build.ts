import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildId } from "../../runtime/dist/client/build-id.js";

// The management service is its compiled code plus the shared runtime client transport.
const dist = path.dirname(fileURLToPath(import.meta.url));
export const managementBuildId = () => buildId([
  { root: dist, extensions: [".js"] },
  { root: path.resolve(dist, "../../runtime/dist/client"), extensions: [".js"] },
]);
