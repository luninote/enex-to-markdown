import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Yarle's ENEX test files (MIT). They hold third parties' notes and addresses, so not every checkout has them: tests
 * that read them run under `describe.skipIf(!HAS_YARLE)` (or `it.skipIf`).
 */
export const YARLE = join(import.meta.dirname, "..", "fixtures", "yarle");
export const HAS_YARLE = existsSync(YARLE);
