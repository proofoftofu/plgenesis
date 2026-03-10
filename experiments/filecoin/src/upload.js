import path from "node:path";
import { runFilecoinUpload } from "./lib/filecoin-upload.js";

const cwd = process.cwd();

runFilecoinUpload({
  cwd,
  envPath: path.join(cwd, ".env"),
  outputDir: path.join(cwd, "output")
})
  .then((manifest) => {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
