import { existsSync, readFileSync } from "node:fs";

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const manifest = read("manifest.json"), versions = read("versions.json");
const pkg = read("package.json"), lock = read("package-lock.json");
const fail = (message) => { throw new Error(message); };
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) fail("Use an x.y.z version without leading zeros.");
if (!/^[a-z-]+$/.test(manifest.id) || manifest.id.includes("obsidian") || manifest.id.endsWith("plugin")) fail("Invalid public plugin ID.");
if (manifest.id !== "latex-live" || manifest.name !== "LaTeX Live") fail("Unexpected plugin identity.");
if (manifest.description.length > 250 || !manifest.description.endsWith(".")) fail("Invalid plugin description.");
if (!manifest.isDesktopOnly) fail("This plugin requires desktop Node.js APIs.");
if (versions[manifest.version] !== manifest.minAppVersion) fail("versions.json does not match the minimum app version.");
if (pkg.version !== manifest.version || lock.version !== manifest.version || lock.packages[""].version !== manifest.version) fail("Package and manifest versions differ.");
if (pkg.license !== "MIT-0" || lock.packages[""].license !== "MIT-0") fail("Root license metadata differs.");
for (const file of ["README.md", "README_zh-CN.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) if (!existsSync(file)) fail(`Missing ${file}.`);
const tag = process.env.RELEASE_TAG;
if (tag && tag !== manifest.version) fail("The tag must exactly match manifest.version; do not prefix it with v.");
if (process.argv.includes("--assets")) {
  for (const file of ["main.js", "manifest.json", "styles.css"]) if (!existsSync(file) || !readFileSync(file).length) fail(`Missing or empty release asset: ${file}.`);
  const main = readFileSync("main.js", "utf8");
  if (!main.includes("SPDX-License-Identifier: MIT-0") || main.includes("sourceMappingURL=")) fail("Production bundle license or sourcemap boundary is incorrect.");
  if (!main.includes("DOMPurify") || !main.includes("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION")) fail("Bundled DOMPurify license is missing.");
}
console.log(`LaTeX Live ${manifest.version}: release metadata${process.argv.includes("--assets") ? " and assets" : ""} verified.`);
