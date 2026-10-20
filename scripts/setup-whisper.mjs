// Build a self-contained whisper-cli. No npm dependencies are installed.
import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync, renameSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'

const tag = 'v1.9.5'
const commit = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'
const root = fileURLToPath(new URL('../', import.meta.url))
const source = join(root, 'vendor/whisper.cpp')
const output = join(root, `resources/whisper/${process.platform}-${process.arch}`)
const started = Date.now()
function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...opts })
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} exited ${result.status}`)
  return result.stdout?.toString().trim()
}
mkdirSync(resolve(source, '..'), { recursive: true })
if (!existsSync(join(source, '.git'))) run('git', ['clone', '--depth', '1', '--branch', tag, 'https://github.com/ggml-org/whisper.cpp.git', source])
const head = run('git', ['-C', source, 'rev-parse', 'HEAD'], { stdio: 'pipe' })
if (head !== commit) throw new Error(`Expected ${tag} (${commit}), found ${head}. Remove vendor/whisper.cpp and retry.`)
// v1.9.5's full JSON bypasses the VAD-aware token accessors. Map all token
// fields (including DTW) with upstream's segment-aware mapper before serialization.
const cpp = join(source, 'src/whisper.cpp')
const original = `struct whisper_token_data whisper_full_get_token_data(struct whisper_context * ctx, int i_segment, int i_token) {
    return ctx->state->result_all[i_segment].tokens[i_token];
}`
const patched = `static int64_t whisper_map_token_time_segment_aware(int64_t t, const std::vector<whisper_state::vad_segment_info> & segs);
// Cascade: full JSON must use original-media times for VAD + DTW.
struct whisper_token_data whisper_full_get_token_data(struct whisper_context * ctx, int i_segment, int i_token) {
    auto data = ctx->state->result_all[i_segment].tokens[i_token];
    if (ctx->state->has_vad_segments) {
        if (data.t0 >= 0) data.t0 = whisper_map_token_time_segment_aware(data.t0, ctx->state->vad_segments);
        if (data.t1 >= 0) data.t1 = whisper_map_token_time_segment_aware(data.t1, ctx->state->vad_segments);
        if (data.t_dtw >= 0) data.t_dtw = whisper_map_token_time_segment_aware(data.t_dtw, ctx->state->vad_segments);
    }
    return data;
}`
const code = readFileSync(cpp, 'utf8')
if (code.includes(original)) writeFileSync(cpp, code.replace(original, patched))
else if (!code.includes(patched)) throw new Error('VAD timestamp patch no longer applies')
let gpu = !process.argv.includes('--cpu')
function build(vulkan) {
  const dir = join(source, vulkan ? 'build-cascade-vulkan' : 'build-cascade-cpu')
  run('cmake', ['-S', source, '-B', dir, '-DCMAKE_BUILD_TYPE=Release', `-DGGML_VULKAN=${vulkan ? '1' : '0'}`,
    '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF',
    '-DWHISPER_CURL=OFF'])
  run('cmake', ['--build', dir, '--config', 'Release', '--target', 'whisper-cli', '-j', String(Math.min(8, availableParallelism()))])
  return dir
}
let dir
try { dir = build(gpu) } catch (error) {
  if (!gpu) throw error
  console.warn(`Vulkan build failed (${error.message}); falling back to CPU.`)
  gpu = false
  dir = build(false)
}
mkdirSync(output, { recursive: true })
const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
const binary = [join(dir, 'bin', exe), join(dir, 'bin/Release', exe)].find(existsSync)
if (!binary) throw new Error('Build succeeded but whisper-cli was not found')
copyFileSync(binary, join(output, `${exe}.tmp`))
chmodSync(join(output, `${exe}.tmp`), 0o755)
renameSync(join(output, `${exe}.tmp`), join(output, exe))
writeFileSync(join(output, 'build.json'), JSON.stringify({ tag, commit, timestampPatch: 1, gpu, backend: gpu ? 'vulkan' : 'cpu', seconds: (Date.now() - started) / 1000 }, null, 2))
copyFileSync(join(source, 'LICENSE'), join(output, 'LICENSE'))
console.log(`whisper.cpp ${tag}: ${gpu ? 'Vulkan' : 'CPU'} build in ${((Date.now() - started) / 1000).toFixed(1)}s → ${output}`)
