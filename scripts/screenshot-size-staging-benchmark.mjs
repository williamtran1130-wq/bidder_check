// Guarded synthetic-only staging entry point. Imports have no execution side effects.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBenchmarkRunner } from "./screenshot-size-benchmark-runner.mjs";

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await createBenchmarkRunner().run();
