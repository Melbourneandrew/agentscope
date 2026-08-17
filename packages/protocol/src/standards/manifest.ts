import manifest from "./manifest.json" with { type: "json" };

import { deepFreeze } from "../schema/immutable.js";

export const standardsManifest = deepFreeze(manifest);
