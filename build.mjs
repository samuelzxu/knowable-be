import { build } from "esbuild";
import { readdirSync } from "fs";
import { join } from "path";

const handlersDir = "src/handlers";
const handlers = readdirSync(handlersDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(handlersDir, f));

await build({
  entryPoints: handlers,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outdir: "dist",
  external: [
    "@aws-sdk/client-bedrock-runtime",
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/client-cognito-identity-provider",
    "@aws-sdk/client-secrets-manager",
    "@aws-sdk/lib-dynamodb",
    "aws-jwt-verify",
  ],
  sourcemap: true,
  minify: false,
});

console.log("Build complete. Handlers:", handlers.map((h) => h.split("/").pop()));
