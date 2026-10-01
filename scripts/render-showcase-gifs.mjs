// Convert verified real-application video ranges to README GIFs. Never changes playback speed.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [inputArg, outArg, cacheArg] = process.argv.slice(2);
if (!inputArg || !outArg || !cacheArg) throw Error("Usage: render-showcase-gifs.mjs ranges.json output-dir ignored-cache-dir");
const input = JSON.parse(readFileSync(inputArg, "utf8"));
const output = resolve(outArg), cache = resolve(cacheArg);
mkdirSync(output, { recursive: true }); mkdirSync(cache, { recursive: true });
const render = resolve("node_modules/.cache/product-demo/bin/demo-caption-render");
if (!existsSync(render)) throw Error("Build scripts/demo-caption-render.swift in the ignored cache first.");
const run = (args) => new Promise((ok, fail) => {
  const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
  let error = ""; child.stderr.on("data", d => { error += d; });
  child.once("exit", code => code === 0 ? ok() : fail(Error(error || `ffmpeg exited ${code}`)));
});
const probe = file => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const receipt = { schema: "latex-live-readme-gifs-v1", playbackSpeed: 1, processing: "Verified temporal excerpts, optional fixed crops, caption rail and proportional resize. GIF frame sampling and palette conversion; no accelerated playback or reconstructed UI.", assets: [] };
for (const asset of input.assets) {
  if (!/^[a-z0-9-]+$/.test(asset.id)) throw Error("Unsafe asset ID");
  const parts = [];
  for (const [i, clip] of asset.clips.entries()) {
    if (clip.verified !== true || !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end <= clip.start) throw Error("Use exact verified video ranges.");
    const raw = probe(clip.path), stream = raw.streams.find(s => s.codec_type === "video");
    const sourceDuration = Number(stream.duration ?? raw.format.duration), duration = clip.end - clip.start;
    if (clip.end > sourceDuration + 0.05) throw Error("Range exceeds native recording");
    const crop = clip.crop ?? { x: 0, y: 0, width: stream.width, height: stream.height };
    if (!Object.values(crop).every(Number.isInteger) || crop.x < 0 || crop.y < 0 || crop.width < 240 || crop.height < 150 || crop.x + crop.width > stream.width || crop.y + crop.height > stream.height) throw Error("Crop must stay within the real recorded frame.");
    const png = join(cache, `${asset.id}-${i}.png`), mp4 = join(cache, `${asset.id}-${i}.mp4`);
    execFileSync(render, ["--width", String(crop.width), "--height", "128", "--title", clip.title ?? asset.title, "--text", clip.caption ?? asset.caption, "--out", png]);
    await run(["-ss", String(clip.start), "-t", String(duration), "-i", clip.path, "-loop", "1", "-i", png,
      "-filter_complex", `[0:v]fps=12,crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},pad=iw:ih+128:0:0:black[n];[n][1:v]overlay=0:${crop.height}:shortest=1:eof_action=repeat:repeatlast=1,scale=1280:-2:flags=lanczos[out]`,
      "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-fps_mode", "passthrough", "-movflags", "+faststart", mp4]);
    parts.push({ file: mp4, source: clip.path, sourceSha256: sha(clip.path), start_s: clip.start, end_s: clip.end, requested_s: duration, ...(clip.crop ? { crop } : {}) });
  }
  const videos = parts.map(p => probe(p.file).streams.find(s => s.codec_type === "video"));
  const maxHeight = Math.max(...videos.map(v => v.height));
  const native = join(cache, `${asset.id}-joined.mp4`);
  if (parts.length === 1) {
    // The single-range source is kept in the cache; do not regenerate its UI or timing.
  } else {
    const args = parts.flatMap(p => ["-i", p.file]);
    const filters = parts.map((_, i) => `[${i}:v]pad=1280:${maxHeight}:0:0:black,settb=1/90000,setpts=PTS-STARTPTS[v${i}]`);
    filters.push(parts.map((_, i) => `[v${i}]`).join("") + `concat=n=${parts.length}:v=1:a=0[out]`);
    await run([...args, "-filter_complex", filters.join(";"), "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-fps_mode", "vfr", native]);
  }
  const src = parts.length === 1 ? parts[0].file : native;
  const palette = join(cache, `${asset.id}-palette.png`), gif = join(output, `${asset.id}.gif`);
  await run(["-i", src, "-vf", "fps=12,palettegen=stats_mode=diff:max_colors=256", "-frames:v", "1", palette]);
  await run(["-i", src, "-i", palette, "-filter_complex", "[0:v]fps=12[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[out]", "-map", "[out]", "-an", "-loop", "0", gif]);
  const result = probe(gif), v = result.streams.find(s => s.codec_type === "video");
  const intended = parts.reduce((n, p) => n + p.requested_s, 0), duration = Number(result.format.duration);
  if (Math.abs(duration - intended) > 0.25) throw Error(`GIF duration changed: ${intended} -> ${duration}`);
  const item = { id: asset.id, path: gif, sha256: sha(gif), width: v.width, height: v.height, duration_s: duration, nativeRangeSum_s: intended,
    bytes: readFileSync(gif).length, montage: parts.length > 1, sources: parts, feature: asset.feature, provenance: asset.provenance };
  receipt.assets.push(item); writeFileSync(join(cache, "showcase-gifs-receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ id: asset.id, duration_s: duration, bytes: item.bytes, speed: 1 }));
}
