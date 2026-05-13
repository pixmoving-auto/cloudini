const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const targetFile = path.join(projectRoot, "src", "cloudini_wasm_single.js");

const candidateFiles = [
  path.resolve(projectRoot, "..", "build", "wasm", "cloudini_wasm_single.js"),
  path.resolve(projectRoot, "..", "build_wasm", "cloudini_wasm_single.js"),
  path.resolve(projectRoot, "..", "build", "wasm", "cloudini_wasm.js"),
  path.resolve(projectRoot, "..", "build_wasm", "cloudini_wasm.js"),
];

const existingCandidate = candidateFiles.find((file) => fs.existsSync(file));

function sanitizeEmscriptenBundle(filePath) {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = original
    // Webpack scans the Emscripten Node fallback even though browser builds never
    // execute it. Indirect require keeps the Node path working without creating a
    // bundler-visible "node:fs" dependency.
    .replace(
      'var fs=require("node:fs");',
      'var fs=globalThis.process?.versions?.node?eval("require")( "fs"):undefined;',
    )
    .replace(
      'var fs=require("fs");',
      'var fs=globalThis.process?.versions?.node?eval("require")( "fs"):undefined;',
    );

  if (patched !== original) {
    fs.writeFileSync(filePath, patched, "utf8");
  }
}

if (existingCandidate) {
  fs.copyFileSync(existingCandidate, targetFile);
  sanitizeEmscriptenBundle(targetFile);
  console.log(
    `Prepared Cloudini WASM bundle from ${path.relative(projectRoot, existingCandidate)} to ${path.relative(projectRoot, targetFile)}`,
  );
  process.exit(0);
}

if (fs.existsSync(targetFile)) {
  sanitizeEmscriptenBundle(targetFile);
  console.log(`Using existing ${path.relative(projectRoot, targetFile)}`);
  process.exit(0);
}

console.error("Missing Cloudini WASM bundle.");
console.error("");
console.error("Expected one of these files to exist:");
for (const file of candidateFiles) {
  console.error(`  - ${path.relative(projectRoot, file)}`);
}
console.error("");
console.error("Build it first with Emscripten, for example:");
console.error("  emcmake cmake -B build/wasm -S ./cloudini_lib -DCLOUDINI_BUILD_TOOLS=OFF");
console.error("  cmake --build build/wasm --target cloudini_wasm_single --parallel");
console.error("");
console.error("Then rerun: npm run package");
process.exit(1);
