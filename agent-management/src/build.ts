import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildId } from "../../rind-runtime-client/build-id.js";

// The management service is its compiled code plus the shared transport.
const dist = path.dirname(fileURLToPath(import.meta.url));
export const managementBuildId = () => buildId([
  { root: dist, extensions: [".js"] },
  { root: path.resolve(dist, "../../rind-runtime-client"), extensions: [".js"] },
]);
