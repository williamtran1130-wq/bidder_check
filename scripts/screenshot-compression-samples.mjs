// LOCAL ONLY. Run with Node 22+: node --experimental-strip-types scripts/screenshot-compression-samples.mjs
// Uses synthetic SVG content and the production encoder; no credentials or network access.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { compressScreenshot } from "../src/lib/screenshot-compression.ts";

const destination = new URL(
  "../docs/screenshot-compression-samples/",
  import.meta.url,
);
const width = 1280;
const height = 860;
const escape = (text) =>
  String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");

function screenshot(dark) {
  const ink = dark ? "#e2e8f0" : "#172033";
  const muted = dark ? "#aebbd0" : "#526075";
  const panel = dark ? "#182438" : "#ffffff";
  const border = dark ? "#3d4c66" : "#cbd5e1";
  const link = dark ? "#95c8ff" : "#075fbb";
  const rows = Array.from({ length: 15 }, (_, index) => {
    const y = 218 + index * 31;
    const url = `https://example.test/jobs/SYN-${String(index + 1).padStart(3, "0")}?tab=details&ref=local_sample`;
    return `<rect x="190" y="${y - 17}" width="1058" height="31" fill="${index % 2 ? panel : dark ? "#202e43" : "#f1f5f9"}"/>
      <text x="201" y="${y}" font-size="12">SYN-${String(index + 1).padStart(3, "0")}</text>
      <text x="277" y="${y}" font-size="12">Example ${["Design", "Build", "Review", "Support"][index % 4]} task ${index + 1}</text>
      <text x="475" y="${y}" font-family="monospace" font-size="10" fill="${link}">${escape(url)}</text>
      <text x="1073" y="${y}" font-size="12">$${(1250 + index * 137).toLocaleString("en-US")}.00</text>
      <text x="1170" y="${y}" font-size="11">${["Draft", "Pending", "Ready"][index % 3]}</text>`;
  }).join("");
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="background" x2="1" y2="1"><stop stop-color="${dark ? "#0c1326" : "#e5edf8"}"/><stop offset="1" stop-color="${dark ? "#253746" : "#fff8eb"}"/></linearGradient>
      <linearGradient id="banner"><stop stop-color="#1954a0"/><stop offset=".5" stop-color="#466a90"/><stop offset="1" stop-color="#307f72"/></linearGradient>
    </defs>
    <rect width="1280" height="860" fill="url(#background)"/>
    <g font-family="Arial, sans-serif" fill="${ink}">
      <rect width="1280" height="64" fill="${panel}"/>
      <text x="22" y="29" font-size="19" font-weight="bold">LOCAL SAMPLE</text>
      <text x="22" y="48" font-size="11" fill="${muted}">Synthetic screenshot · no production data</text>
      <text x="865" y="36" font-size="13">Demo workspace / Example reviewer / 2026-01-15</text>
      <rect y="64" width="169" height="796" fill="${panel}"/>
      ${["Overview", "Sample projects", "Review queue", "Example reports", "Settings"].map((label, index) => `<text x="19" y="${104 + index * 39}" font-size="13" fill="${index === 1 ? link : muted}">${label}</text>`).join("")}
      <text x="190" y="105" font-size="25" font-weight="bold">Synthetic project review</text>
      <text x="190" y="127" font-size="12" fill="${muted}">Small text, punctuation, URLs, currency, thin dividers, gradients and ${dark ? "dark" : "light"} UI.</text>
      <rect x="190" y="143" width="1058" height="42" rx="5" fill="url(#banner)"/>
      <text x="203" y="161" font-size="12" fill="white">SYNTHETIC ONLY — All labels, amounts, URLs and dates below are invented.</text>
      <text x="203" y="177" font-family="monospace" font-size="10" fill="white">Readability stress: 0 O o · 1 I l | · 5 S · 8 B · rn m · {} [] () / \\ : ; @ # %</text>
      ${rows}
      <rect x="190" y="687" width="1058" height="143" rx="6" fill="${panel}" stroke="${border}"/>
      <text x="204" y="710" font-size="13" font-weight="bold">Example notes — inspect at native resolution</text>
      <text x="204" y="732" font-size="12">Reference: SYN-011 • Budget: $2,620.00 • Due: Jan 31, 2026 • Result: pending human review</text>
      <text x="204" y="750" font-family="monospace" font-size="11" fill="${link}">https://example.test/application/SYN-011?review=manual&amp;version=2#screenshots</text>
      <text x="204" y="769" font-size="10" fill="${muted}">10px text: invoice-000123 / 0123456789 / ABCDEFGHIJKLMNOPQRSTUVWXYZ / abcdefghijklmnopqrstuvwxyz</text>
      <text x="204" y="788" font-size="11" fill="${muted}">Compare letter edges, thin strokes, numerals, punctuation, colored links and gradient banding.</text>
      <line x1="204" y1="802" x2="1234" y2="802" stroke="${border}"/>
      <text x="204" y="820" font-size="10" fill="${muted}">Local synthetic evidence only. These files do not establish production readability acceptance.</text>
    </g>
  </svg>`);
}

await mkdir(destination, { recursive: true });
const samples = [];
for (const spec of [
  {
    id: "light-png",
    label: "Light interface · PNG",
    dark: false,
    format: "png",
  },
  { id: "dark-png", label: "Dark interface · PNG", dark: true, format: "png" },
  {
    id: "dark-jpeg",
    label: "Dark interface · JPEG (quality 95)",
    dark: true,
    format: "jpeg",
  },
]) {
  const pipeline = sharp(screenshot(spec.dark));
  const original =
    spec.format === "png"
      ? await pipeline.png({ compressionLevel: 6 }).toBuffer()
      : await pipeline
          .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
          .toBuffer();
  const encoded = await compressScreenshot(original);
  const originalFile = `${spec.id}-original.${spec.format === "jpeg" ? "jpg" : "png"}`;
  const compressedFile = encoded ? `${spec.id}-compressed.webp` : null;
  await writeFile(new URL(originalFile, destination), original);
  if (encoded) {
    // Fully decode the encoder output before presenting it for local review.
    await sharp(encoded.bytes, { failOn: "warning" }).raw().toBuffer();
    await writeFile(new URL(compressedFile, destination), encoded.bytes);
  }
  const stored = encoded?.bytes ?? original;
  const dimensions = await sharp(stored).metadata();
  if (dimensions.width !== width || dimensions.height !== height) {
    throw new Error(`${spec.id}: displayed dimensions changed`);
  }
  samples.push({
    id: spec.id,
    label: spec.label,
    synthetic: true,
    width,
    height,
    originalFile,
    originalMime: `image/${spec.format}`,
    originalBytes: original.length,
    originalSha256: createHash("sha256").update(original).digest("hex"),
    compressedFile,
    storedMime: encoded?.mime ?? `image/${spec.format}`,
    storedBytes: stored.length,
    storedSha256:
      encoded?.sha256 ?? createHash("sha256").update(original).digest("hex"),
    savedBytes: original.length - stored.length,
    savingsPercent: Number(
      ((1 - stored.length / original.length) * 100).toFixed(2),
    ),
    outcome: encoded ? "smaller-webp" : "original-retained-no-savings",
    readabilityApproval: "pending-human-review",
  });
}

const summary = {
  description:
    "LOCAL synthetic examples only; no private or production screenshots. Human readability approval is pending.",
  regenerate:
    "node --experimental-strip-types scripts/screenshot-compression-samples.mjs",
  node: process.version,
  sharp: sharp.versions.sharp,
  vips: sharp.versions.vips,
  source:
    "Deterministic SVG rendered locally with Arial; font rendering can differ across environments.",
  compression:
    "Production compressScreenshot helper: WebP quality 90, alphaQuality 100, effort 4; auto-orient; no resize; metadata stripped; keep original unless strictly smaller.",
  samples,
};
await writeFile(
  new URL("summary.json", destination),
  `${JSON.stringify(summary, null, 2)}\n`,
);

const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local synthetic screenshot compression comparisons</title>
<style>
body{margin:24px;font:15px/1.5 system-ui,sans-serif;color:#172033;background:#f4f6f9}h1{font-size:26px;margin-bottom:8px}p{max-width:1000px}button,select{font:inherit;padding:8px 12px}button[aria-pressed=true]{background:#174e9a;color:white;border:2px solid #174e9a}nav{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:18px 0}.viewport{height:70vh;overflow:auto;background:repeating-conic-gradient(#ddd 0% 25%,white 0% 50%) 0/20px 20px;border:1px solid #9aa9bd}.viewport img{display:block;width:1280px;height:860px;max-width:none}#metrics{font-variant-numeric:tabular-nums}a{color:#075fbb}code{font-size:13px}footer{margin-top:16px;color:#526075}
</style>
<h1>Screenshot compression · local synthetic review</h1>
<p>These invented interfaces contain dense 10–13px text, long URLs, numerals, punctuation, gradients and thin strokes. No production or private screenshots are included. <strong>Readability approval is pending human review.</strong></p>
<p>The image below stays at native 1280 × 860 CSS pixels. Use browser zoom 100% and scroll to inspect. Toggle original/compressed to compare the same position; check small text and colored links carefully.</p>
<nav><label>Sample <select id="sample">${samples.map((sample, index) => `<option value="${index}">${escape(sample.label)}</option>`).join("")}</select></label><button id="original" aria-pressed="true">Original</button><button id="compressed" aria-pressed="false">Compressed WebP</button></nav>
<p id="metrics"></p><p id="files"></p>
<div class="viewport"><img id="comparison" width="1280" height="860" alt="Synthetic interface sample at native resolution"></div>
<footer><a href="summary.json">Measured sizes, hashes and dimensions (JSON)</a><br>Regenerate from the repository root: <code>node --experimental-strip-types scripts/screenshot-compression-samples.mjs</code><br>Encoding uses the production helper. Pixel dimensions and decodability are checked; visual approval requires a human.</footer>
<script>
const samples=${JSON.stringify(samples)};
const selection=document.getElementById('sample');
const image=document.getElementById('comparison');
const original=document.getElementById('original');
const compressed=document.getElementById('compressed');
let showingCompressed=false;
function render(){const sample=samples[Number(selection.value)];image.src=showingCompressed&&sample.compressedFile?sample.compressedFile:sample.originalFile;image.alt=sample.label+(showingCompressed?' compressed':' original')+' — synthetic';original.setAttribute('aria-pressed',String(!showingCompressed));compressed.setAttribute('aria-pressed',String(showingCompressed));compressed.disabled=!sample.compressedFile;document.getElementById('metrics').textContent=sample.width+' × '+sample.height+' pixels · Original '+sample.originalBytes.toLocaleString()+' B → Stored '+sample.storedBytes.toLocaleString()+' B · Saved '+sample.savedBytes.toLocaleString()+' B ('+sample.savingsPercent+'%) · '+sample.outcome;const links=document.getElementById('files');links.replaceChildren();for(const [file,label] of [[sample.originalFile,'Open original'],[sample.compressedFile,'Open compressed WebP']]){if(!file)continue;const anchor=document.createElement('a');anchor.href=file;anchor.textContent=label;anchor.target='_blank';anchor.rel='noopener';links.append(anchor,document.createTextNode(' · '));}}
selection.addEventListener('change',()=>{showingCompressed=false;render()});original.addEventListener('click',()=>{showingCompressed=false;render()});compressed.addEventListener('click',()=>{showingCompressed=true;render()});render();
</script></html>\n`;
await writeFile(new URL("index.html", destination), html);
console.table(
  samples.map(
    ({ id, originalBytes, storedBytes, savingsPercent, outcome }) => ({
      id,
      originalBytes,
      storedBytes,
      savingsPercent,
      outcome,
    }),
  ),
);
console.log(
  `Local comparison: ${fileURLToPath(new URL("index.html", destination))}`,
);
