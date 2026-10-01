#!/usr/bin/env node
// Package supplied native recordings. No screen capture, UI reconstruction, crop, scaling or speedup.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `Usage: node scripts/package-demo-videos.mjs --input recordings.json [--out ABS_DIR]
  [--captions library.json (repeatable)] [--rail-height 128] [--preset fast] [--crf 18]
Input: {schema:"latex-live-demo-recordings-v1",outputDir?,captionLibraries?,recordings:[{
  id:"safe-slug",title_zh?,title_en?,rawPath:"/absolute/native.mp4",events:[{
    id:"caption-cue-id",start_s:0.5,end_s?:5,status:"verified",details?:{...receipt}
  }]
}]}
Times are seconds relative to the first displayed raw video frame. Missing ends use the next
recorded event start or raw duration. Non-verified events are not captioned; they still end the
previous scene's caption, so a pending scene cannot inherit a verified caption.
Outputs: id.zh.mp4/id.en.mp4, .srt sidecars, chapter indexes and packaging-manifest.json.
Original recordings remain untouched; caption rails are below the native picture. No audio is added.
Optional source audio is copied. ffmpeg/ffprobe/Swift/AppKit must already be installed.
`;
function fail(message) { throw new Error(message); }
function parseArgs(argv) {
  const result = { captions: [], height: 128, preset: 'fast', crf: 18 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]; if (['--help', '-h'].includes(key)) return { help: true };
    const value = argv[++i]; if (value === undefined) fail(`Missing value for ${key}`);
    if (key === '--input') result.input = value;
    else if (key === '--out') result.output = value;
    else if (key === '--captions') result.captions.push(value);
    else if (key === '--rail-height') result.height = Number(value);
    else if (key === '--preset') result.preset = value;
    else if (key === '--crf') result.crf = Number(value);
    else fail(`Unknown argument ${key}`);
  }
  return result;
}
async function run(program, args, { cwd, capture = false, progressLabel = '' } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '', progress = '', lastProgress = 0;
    child.stdout.on('data', chunk => {
      if (capture) output += chunk;
      if (!progressLabel) return;
      progress += chunk.toString();
      const lines = progress.split('\n'); progress = lines.pop() ?? '';
      for (const line of lines) if (line.startsWith('out_time=') && Date.now() - lastProgress >= 30_000) {
        lastProgress = Date.now(); console.log(`  ${progressLabel}: ${line.slice(9)}`);
      }
    });
    child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-16000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolvePromise(output) : reject(new Error(`${program} failed (${code}): ${error}`)));
  });
}
async function probe(path, count = false) {
  return JSON.parse(await run('ffprobe', ['-v', 'error', ...(count ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json', path], { capture: true }));
}
async function sha256(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
const seconds = value => Math.max(0, Math.round(value * 1000));
function stamp(value, decimal = ',') { const ms = seconds(value); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${decimal}${String(ms % 1000).padStart(3, '0')}`; }
function concatPath(path) { return `'${path.replace(/'/g, "'\\''")}'`; }
function normalizeEvents(recording, library, duration) {
  if (!Array.isArray(recording.events)) fail(`${recording.id}: events must be an array`);
  const omitted = recording.events.filter(event => event.status !== 'verified');
  const starts = recording.events.map(event => event.start_s).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const events = recording.events.filter(event => event.status === 'verified').map((event, order) => {
    if (!library.has(event.id)) fail(`${recording.id}: missing caption cue ${event.id}`);
    if (!Number.isFinite(event.start_s) || event.start_s < 0) fail(`${recording.id}: invalid start for ${event.id}`);
    return { ...event, order };
  }).sort((a, b) => a.start_s - b.start_s || a.order - b.order);
  const intervals = [], bounds = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const nextStart = starts.find(start => start > event.start_s);
    const end = event.end_s ?? nextStart ?? duration;
    if (!Number.isFinite(end) || end <= event.start_s) fail(`${recording.id}: invalid end for ${event.id}`);
    if (events[i + 1] && end > events[i + 1].start_s + 0.001) fail(`${recording.id}: overlapping caption events ${event.id} and ${events[i + 1].id}`);
    if (event.start_s >= duration) { bounds.push({ id: event.id, reason: 'event starts outside recorded footage' }); continue; }
    const limited = Math.min(end, duration);
    if (limited !== end) bounds.push({ id: event.id, reason: 'caption end clipped to recorded duration', receipt_end_s: end, caption_end_s: limited });
    const start = seconds(event.start_s) / 1000, stop = seconds(limited) / 1000;
    if (stop > start) intervals.push({ id: event.id, start_s: start, end_s: stop, status: event.status, cue: library.get(event.id) });
  }
  const segments = []; let cursor = 0;
  for (const event of intervals) {
    if (event.start_s > cursor) segments.push({ start_s: cursor, end_s: event.start_s, cue: null });
    segments.push(event); cursor = event.end_s;
  }
  if (cursor < duration) segments.push({ start_s: cursor, end_s: duration, cue: null });
  return { events, omitted, intervals, segments, bounds };
}
function cueTitle(cue, recording, lang) { return cue?.[`title_${lang}`] ?? recording[`title_${lang}`] ?? (lang === 'zh' ? 'Obsidian 原生录制' : 'Native Obsidian recording'); }
async function main() {
  const options = parseArgs(process.argv.slice(2)); if (options.help) { console.log(HELP); return; }
  if (!options.input) fail(HELP);
  if (!Number.isInteger(options.height) || options.height < 96 || options.height % 2) fail('rail-height must be an even integer >=96');
  if (!Number.isFinite(options.crf) || options.crf < 0 || options.crf > 51) fail('crf must be between 0 and 51');
  const inputPath = resolve(options.input), input = JSON.parse(await readFile(inputPath, 'utf8'));
  if (input.schema !== 'latex-live-demo-recordings-v1') fail('Unsupported recordings schema');
  if (!Array.isArray(input.recordings) || !input.recordings.length) fail('recordings must be a nonempty array');
  const out = options.output ?? input.outputDir; if (!out || !isAbsolute(out)) fail('outputDir/--out must be an absolute directory');
  const libraryPaths = options.captions.length ? options.captions : input.captionLibraries ?? [join(repository, 'docs/demo/demo-captions.json')];
  const library = new Map();
  for (const name of libraryPaths) {
    const path = isAbsolute(name) ? name : resolve(dirname(inputPath), name);
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    for (const cue of parsed.cues ?? parsed.segments ?? []) {
      if (!cue.id || !['zh', 'en'].every(lang => typeof cue[`title_${lang}`] === 'string' && typeof cue[`text_${lang}`] === 'string' && cue[`text_${lang}`].split('\n').length <= 2)) fail(`Invalid bilingual cue in ${path}`);
      if (library.has(cue.id) && JSON.stringify(library.get(cue.id)) !== JSON.stringify(cue)) fail(`Conflicting caption cue ${cue.id}`);
      library.set(cue.id, cue);
    }
  }
  const ids = new Set();
  for (const recording of input.recordings) {
    if (!/^[a-z0-9][a-z0-9_-]{0,95}$/i.test(recording.id ?? '') || ids.has(recording.id)) fail('Every recording needs a unique safe id'); ids.add(recording.id);
    if (!isAbsolute(recording.rawPath ?? '')) fail(`${recording.id}: rawPath must be absolute`);
    for (const lang of ['zh', 'en']) if (resolve(recording.rawPath) === resolve(out, `${recording.id}.${lang}.mp4`)) fail('A derived output must not overwrite the native recording');
  }
  await mkdir(out, { recursive: true });
  const work = await mkdtemp(join(out, '.caption-work-'));
  const manifest = { schema: 'latex-live-demo-video-package-v1', input: inputPath, purpose: input.purpose ?? 'native-demo-packaging', timeline_basis: 'seconds relative to the first displayed raw video frame', processing: 'Original recordings retained. Derivatives only append a black text caption rail; video re-encoded, no crop, scaling, speed change or invented UI.', caption_time_resolution_s: 0.001, caption_libraries: libraryPaths, recordings: [] };
  try {
    const renderer = join(work, 'demo-caption-render');
    await run('swiftc', ['-O', join(repository, 'scripts/demo-caption-render.swift'), '-o', renderer]);
    for (const recording of input.recordings) {
      console.log(`Packaging ${recording.id}`);
      const raw = await probe(recording.rawPath, true); const video = raw.streams.find(stream => stream.codec_type === 'video');
      if (!video) fail(`${recording.id}: no video stream`);
      const duration = Number(video.duration ?? raw.format.duration), width = video.width, height = video.height;
      if (!Number.isFinite(duration) || duration <= 0 || width % 2 || (height + options.height) % 2) fail(`${recording.id}: unsupported duration or odd dimensions`);
      const normalized = normalizeEvents(recording, library, duration);
      const packaged = { id: recording.id, rawPath: recording.rawPath, raw_sha256: await sha256(recording.rawPath), raw_probe: raw, original_events: recording.events, omitted_events: normalized.omitted, bounds: normalized.bounds, caption_intervals: normalized.intervals.map(({ cue, ...event }) => event), outputs: {} };
      for (const lang of ['zh', 'en']) {
        const folder = join(work, `${recording.id}-${lang}`); await mkdir(folder);
        const concat = ['ffconcat version 1.0'];
        for (let i = 0; i < normalized.segments.length; i++) {
          const segment = normalized.segments[i], png = join(folder, `caption-${String(i).padStart(4, '0')}.png`);
          await run(renderer, ['--width', String(width), '--height', String(options.height), '--title', cueTitle(segment.cue, recording, lang), '--text', segment.cue?.[`text_${lang}`] ?? '', '--out', png]);
          concat.push(`file ${concatPath(png)}`, 'option framerate 1000', `duration ${(segment.end_s - segment.start_s).toFixed(6)}`);
        }
        const lastPng = join(folder, `caption-${String(normalized.segments.length - 1).padStart(4, '0')}.png`);
        concat.push(`file ${concatPath(lastPng)}`, 'option framerate 1000');
        const list = join(folder, 'rail.ffconcat'); await writeFile(list, concat.join('\n') + '\n');
        const rail = join(folder, 'rail.mp4');
        // Keep the secondary rail alive past the native last frame. The overlay's shortest=1
        // then ends on the native input, rather than dropping native frames at a rail EOF.
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-an', '-vf', 'tpad=stop_mode=clone:stop_duration=1', '-fps_mode', 'vfr', '-enc_time_base', '1:1000', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-t', String(duration + 1), rail]);
        const final = join(out, `${recording.id}.${lang}.mp4`), temporary = join(folder, 'packaged.mp4');
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-stats_period', '5', '-i', recording.rawPath, '-i', rail, '-filter_complex', `[0:v]pad=iw:ih+${options.height}:0:0:black[native];[native][1:v]overlay=0:${height}:eof_action=repeat:repeatlast=1:shortest=1[out]`, '-map', '[out]', '-map', '0:a?', '-c:a', 'copy', '-c:v', 'libx264', '-preset', options.preset, '-crf', String(options.crf), '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-enc_time_base', video.time_base ?? '0', '-movflags', '+faststart', '-metadata', `comment=${manifest.processing}`, temporary], { progressLabel: `${recording.id}/${lang}` });
        const delivered = await probe(temporary, true), resultVideo = delivered.streams.find(stream => stream.codec_type === 'video');
        const outputDuration = Number(resultVideo?.duration ?? delivered.format.duration);
        if (resultVideo?.width !== width || resultVideo?.height !== height + options.height) fail('Packaging unexpectedly altered native geometry');
        if (video.nb_read_frames && resultVideo?.nb_read_frames && video.nb_read_frames !== resultVideo.nb_read_frames) fail(`Packaging unexpectedly changed the native video frame count: ${video.nb_read_frames} -> ${resultVideo.nb_read_frames}`);
        if (Math.abs(outputDuration - duration) > 0.05) fail(`Packaging altered duration: ${duration} -> ${outputDuration}`);
        await rename(temporary, final);
        const srt = normalized.intervals.map((event, i) => `${i + 1}\n${stamp(event.start_s)} --> ${stamp(event.end_s)}\n${event.cue[`text_${lang}`]}\n`).join('\n');
        await writeFile(join(out, `${recording.id}.${lang}.srt`), srt);
        const chapters = normalized.intervals.map(event => ({ id: event.id, title: cueTitle(event.cue, recording, lang), start_s: event.start_s, end_s: event.end_s, start_time: stamp(event.start_s, '.'), status: event.status }));
        await writeFile(join(out, `${recording.id}.${lang}.chapters.json`), JSON.stringify(chapters, null, 2) + '\n');
        await writeFile(join(out, `${recording.id}.${lang}.chapters.md`), chapters.map(chapter => `- ${chapter.start_time} ${chapter.title}`).join('\n') + '\n');
        packaged.outputs[lang] = { path: final, srt: join(out, `${recording.id}.${lang}.srt`), chapters: join(out, `${recording.id}.${lang}.chapters.json`), probe: delivered, sha256: await sha256(final) };
        console.log(`  ${lang}: ${final} (${outputDuration.toFixed(3)} s, ${resultVideo.nb_read_frames ?? '?'} frames)`);
      }
      manifest.recordings.push(packaged);
      await writeFile(join(out, 'packaging-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    }
    console.log(`Package complete: ${out}`);
  } finally { await rm(work, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
