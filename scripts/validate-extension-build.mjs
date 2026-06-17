import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist-extension");

const requiredFiles = [
  "manifest.json",
  "service-worker-loader.js",
  "popup.html",
  "downloader.html",
  "offscreen.html",
  "rules.json",
  "vendor/hls.min.js",
  "vendor/mux-mp4.min.js",
  "assets/icon16.png",
  "assets/icon32.png",
  "assets/icon48.png",
  "assets/icon128.png",
];

const failures = [];

for (const file of requiredFiles) {
  assertFile(file);
}

const manifest = readJson("manifest.json");
assertEqual(manifest.manifest_version, 3, "manifest_version must be 3");
assertEqual(manifest.background?.type, "module", "background must be a module service worker");
assertFile(manifest.background?.service_worker, "background service worker");
assertFile(manifest.action?.default_popup, "action.default_popup");

for (const iconPath of Object.values(manifest.icons || {})) {
  assertFile(iconPath, "manifest icon");
}
for (const iconPath of Object.values(manifest.action?.default_icon || {})) {
  assertFile(iconPath, "action icon");
}
for (const rule of manifest.declarative_net_request?.rule_resources || []) {
  assertFile(rule.path, "declarativeNetRequest rule");
}

validateHtmlReferences("popup.html");
validateHtmlReferences("downloader.html");
validateHtmlReferences("offscreen.html");
validateServiceWorkerLoader(manifest.background?.service_worker);

if (failures.length) {
  console.error(failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log("extension build validation passed");

function readJson(file) {
  return JSON.parse(readText(file));
}

function readText(file) {
  return readFileSync(resolveDistPath(file), "utf8");
}

function validateHtmlReferences(file) {
  const html = readText(file);
  const refs = [
    ...extractAttributeRefs(html, "script", "src"),
    ...extractAttributeRefs(html, "link", "href"),
    ...extractAttributeRefs(html, "img", "src"),
  ];

  for (const ref of refs) {
    if (isExternalRef(ref)) {
      continue;
    }
    assertFile(stripQueryAndHash(ref), `${file} reference`);
  }

  assertNotIncludes(html, 'src="downloader.js"', `${file} must not reference raw downloader.js`);
  assertNotIncludes(html, 'src="popup.js"', `${file} must not reference raw popup.js`);
  assertNotIncludes(html, 'src="offscreen.js"', `${file} must not reference raw offscreen.js`);
}

function validateServiceWorkerLoader(file) {
  const source = readText(file);
  for (const ref of extractStaticImports(source)) {
    assertFile(stripQueryAndHash(ref), `${file} import`);
  }
}

function extractAttributeRefs(html, tag, attr) {
  const refs = [];
  const pattern = new RegExp(`<${tag}\\b[^>]*\\s${attr}=["']([^"']+)["']`, "gi");
  let match;
  while ((match = pattern.exec(html))) {
    refs.push(match[1]);
  }
  return refs;
}

function extractStaticImports(source) {
  const refs = [];
  const pattern = /import\s+["'](.+?)["'];?/g;
  let match;
  while ((match = pattern.exec(source))) {
    refs.push(match[1]);
  }
  return refs;
}

function assertFile(file, label = "file") {
  if (!file) {
    failures.push(`${label} path is missing`);
    return;
  }
  if (!existsSync(resolveDistPath(file))) {
    failures.push(`${label} not found: ${file}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    failures.push(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNotIncludes(value, needle, message) {
  if (value.includes(needle)) {
    failures.push(message);
  }
}

function resolveDistPath(file) {
  const normalized = normalize(stripLeadingSlash(file));
  return join(distDir, normalized);
}

function stripLeadingSlash(value) {
  return String(value || "").replace(/^\/+/, "");
}

function stripQueryAndHash(value) {
  return String(value || "").split(/[?#]/, 1)[0];
}

function isExternalRef(value) {
  return /^(?:https?:)?\/\//.test(value) || value.startsWith("data:");
}
