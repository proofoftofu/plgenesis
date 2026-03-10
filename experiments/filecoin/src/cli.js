import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareExperiment } from "./lib/payload.js";

async function main() {
  const inputPath = process.argv[2];
  const outputDir = process.argv[3] ?? "output";

  if (!inputPath) {
    throw new Error("Usage: node src/cli.js <input.json> [outputDir]");
  }

  const raw = await readFile(inputPath, "utf8");
  const experiment = prepareExperiment(JSON.parse(raw));

  await mkdir(outputDir, { recursive: true });

  for (const [name, contents] of Object.entries(experiment.files)) {
    await writeFile(path.join(outputDir, name), `${contents}\n`);
  }

  await writeFile(
    path.join(outputDir, "summary.json"),
    `${JSON.stringify(experiment.summary, null, 2)}\n`
  );

  process.stdout.write(`${JSON.stringify(experiment.summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
