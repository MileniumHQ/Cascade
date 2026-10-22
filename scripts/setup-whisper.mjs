// Build self-contained whisper-cli (transcription) and cascade-align (Qwen3-ForcedAligner word timing, on
// CrispASR's ggml port; source in native/cascade-align). No npm dependencies are installed.
// `--target win32-x64` cross-compiles the Windows binaries from Linux with llvm-mingw (downloaded into vendor/).
import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync, renameSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'

const tag = 'v1.9.5'
const commit = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'
// CrispASR pins its ggml fork as a submodule; that commit comes along with this one.
const CRISPASR = { tag: 'v0.8.43', commit: 'eb633d908120cc5f44b8af8cd4aeb1191f16bfd8' }
const root = fileURLToPath(new URL('../', import.meta.url))
const source = join(root, 'vendor/whisper.cpp')
const crispasr = join(root, 'vendor/CrispASR')
const host = `${process.platform}-${process.arch}`
const targetArg = process.argv.indexOf('--target')
const target = targetArg > 0 ? process.argv[targetArg + 1] : host
const cross = target !== host
if (cross && !(target === 'win32-x64' && host === 'linux-x64')) throw new Error(`Cross builds support linux-x64 → win32-x64 only (asked ${host} → ${target})`)
const output = join(root, `resources/whisper/${target}`)
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
if (!existsSync(join(crispasr, '.git'))) {
  run('git', ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/CrispStrobe/CrispASR.git', crispasr])
  run('git', ['-C', crispasr, 'checkout', '--quiet', CRISPASR.commit])
}
const crispHead = run('git', ['-C', crispasr, 'rev-parse', 'HEAD'], { stdio: 'pipe' })
if (crispHead !== CRISPASR.commit) throw new Error(`Expected CrispASR ${CRISPASR.tag} (${CRISPASR.commit}), found ${crispHead}. Remove vendor/CrispASR and retry.`)
// Only ggml; the c2pa-audio submodule is for CrispASR's own CLI.
run('git', ['-C', crispasr, 'submodule', 'update', '--init', '--depth', '1', 'ggml'])
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
const LLVM_MINGW = '20261006'
function crossArgs() {
  if (!cross) return []
  const name = `llvm-mingw-${LLVM_MINGW}-ucrt-ubuntu-22.04-x86_64`
  const dir = join(root, 'vendor', name)
  if (!existsSync(join(dir, 'bin'))) {
    const archive = join(root, 'vendor', `${name}.tar.xz`)
    run('curl', ['-fL', '--retry', '3', '-o', archive, `https://github.com/mstorsjo/llvm-mingw/releases/download/${LLVM_MINGW}/${name}.tar.xz`])
    run('tar', ['-xJf', archive, '-C', join(root, 'vendor')])
  }
  const bin = (tool) => join(dir, 'bin', `x86_64-w64-mingw32-${tool}`)
  // Static: no libc++/libunwind DLLs to ship. ggml's own threadpool instead of OpenMP.
  // v1.9.5's examples/common.cpp uses std::partial_sort without <algorithm>, which libc++ doesn't pull in transitively.
  return ['-DCMAKE_CXX_FLAGS=-include algorithm', '-DCMAKE_SYSTEM_NAME=Windows', '-DCMAKE_SYSTEM_PROCESSOR=x86_64', `-DCMAKE_C_COMPILER=${bin('clang')}`, `-DCMAKE_CXX_COMPILER=${bin('clang++')}`,
    `-DCMAKE_RC_COMPILER=${bin('windres')}`, '-DCMAKE_EXE_LINKER_FLAGS=-static', '-DGGML_OPENMP=OFF',
    // CPU only for now (a Vulkan exe hard-links vulkan-1.dll and wouldn't start without GPU drivers); assume AVX2-era CPUs (2013+).
    '-DGGML_AVX=ON', '-DGGML_AVX2=ON', '-DGGML_FMA=ON', '-DGGML_F16C=ON']
}
// Linux: runs on glibc 2.34+ (Ubuntu 22.04, the Flatpak runtime), not just the build machine's glibc. Static
// libstdc++/libgcc, ggml's threadpool instead of libgomp, sqrtf inlined (glibc 2.43 versioned it) and glibc 2.38's
// C23 __isoc23_strto* redirects wrapped back to the plain functions. Checked after the build.
const MAX_GLIBC = '2.34'
function portableArgs(vulkan) {
  if (cross || process.platform !== 'linux') return []
  const dir = join(source, 'cascade-compat')
  mkdirSync(dir, { recursive: true })
  const names = ['strtol', 'strtoul', 'strtoll', 'strtoull']
  const types = { strtol: 'long', strtoul: 'unsigned long', strtoll: 'long long', strtoull: 'unsigned long long' }
  // C11 without _GNU_SOURCE, so strtol here binds to the original symbol. Static libstdc++'s random_device
  // calls arc4random (glibc 2.36); getrandom is 2.25. glibc 2.43 re-versioned log10f (CrispASR's mel);
  // the wrapper binds the original version.
  writeFileSync(join(dir, 'compat.c'), `#include <stdlib.h>\n#include <stdint.h>\n#include <sys/random.h>
${names.map(n => `${types[n]} __wrap___isoc23_${n}(const char *s, char **end, int base) { return ${n}(s, end, base); }`).join('\n')}
uint32_t __wrap_arc4random(void) { uint32_t v = 0; while (getrandom(&v, sizeof v, 0) != sizeof v) {} return v; }
float cascade_log10f(float);
__asm__(".symver cascade_log10f,log10f@GLIBC_2.2.5");
float __wrap_log10f(float x) { return cascade_log10f(x); }\n`)
  run('cc', ['-std=c11', '-O2', '-fPIC', '-c', join(dir, 'compat.c'), '-o', join(dir, 'compat.o')])
  // libgcc stays shared: its static unwinder needs _dl_find_object (glibc 2.35), and every distro has libgcc_s.
  const wraps = [...names.map(n => `__isoc23_${n}`), 'arc4random', 'log10f'].map(n => `-Wl,--wrap=${n}`).join(' ')
  return ['-DCMAKE_C_FLAGS=-fno-math-errno', '-DCMAKE_CXX_FLAGS=-fno-math-errno', '-DGGML_OPENMP=OFF', ...(vulkan ? vulkanHeaders() : []),
    `-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ ${join(dir, 'compat.o')} ${wraps}`]
}
// Header-only, so missing system packages (Arch: vulkan-headers, spirv-headers) are downloaded into a vendor/
// prefix instead of required. Same Vulkan SDK release as the loader.
const VULKAN_SDK = '1.4.363'
function vulkanHeaders() {
  const prefix = join(root, 'vendor', `vulkan-${VULKAN_SDK}`)
  const fetch = (repo, tag, check) => {
    if (existsSync(check)) return
    const src = join(root, 'vendor', `${repo}-${tag.replace(/^v(?=\d)/, '')}`) // GitHub drops the tag's v
    if (!existsSync(join(src, 'CMakeLists.txt'))) {
      const archive = `${src}.tar.gz`
      run('curl', ['-fL', '--retry', '3', '-o', archive, `https://github.com/KhronosGroup/${repo}/archive/refs/tags/${tag}.tar.gz`])
      run('tar', ['-xzf', archive, '-C', join(root, 'vendor')])
    }
    run('cmake', ['-S', src, '-B', join(src, 'build'), `-DCMAKE_INSTALL_PREFIX=${prefix}`, '-DBUILD_TESTS=OFF'])
    run('cmake', ['--install', join(src, 'build')])
  }
  const args = []
  if (!existsSync('/usr/include/vulkan/vulkan.h')) {
    fetch('Vulkan-Headers', `v${VULKAN_SDK}`, join(prefix, 'include/vulkan/vulkan.h'))
    args.push(`-DVulkan_INCLUDE_DIR=${join(prefix, 'include')}`)
  }
  if (!existsSync('/usr/share/cmake/SPIRV-Headers') && !existsSync('/usr/lib/cmake/SPIRV-Headers')) {
    fetch('SPIRV-Headers', `vulkan-sdk-${VULKAN_SDK}.0`, join(prefix, 'share/cmake/SPIRV-Headers'))
    args.push(`-DCMAKE_PREFIX_PATH=${prefix}`)
  }
  return args
}
function checkPortable(binary) {
  if (cross || process.platform !== 'linux') return
  const symbols = spawnSync('objdump', ['-T', binary], { encoding: 'utf8' }).stdout ?? ''
  const newer = [...new Set(symbols.match(/GLIBC_2\.\d+/g) ?? [])].filter(v => Number(v.split('.')[1]) > Number(MAX_GLIBC.split('.')[1]))
  const runtime = [...new Set(symbols.match(/(GLIBCXX|CXXABI|GOMP|OMP)_[\d.]+/g) ?? [])]
  if (newer.length || runtime.length) throw new Error(`${binary.split('/').at(-1)} isn't portable: needs ${[...newer, ...runtime].join(', ')} (max glibc ${MAX_GLIBC}, no libstdc++/libgomp)`)
}
let gpu = !process.argv.includes('--cpu') && !cross
function build(vulkan) {
  const dir = join(source, `build-cascade-${target}-${vulkan ? 'vulkan' : 'cpu'}`)
  run('cmake', ['-S', source, '-B', dir, '-DCMAKE_BUILD_TYPE=Release', `-DGGML_VULKAN=${vulkan ? '1' : '0'}`, ...crossArgs(), ...portableArgs(vulkan),
    '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF',
    '-DWHISPER_CURL=OFF'])
  run('cmake', ['--build', dir, '--config', 'Release', '--target', 'whisper-cli', '-j', String(Math.min(8, availableParallelism()))])
  return dir
}
// CrispASR must be the top-level CMake project; native/cascade-align/CMakeLists.txt adds the target through
// its project() include hook. No BLAS or OpenMP (portable binary; ggml's threadpool does the work).
function buildAligner(vulkan) {
  const dir = join(crispasr, `build-cascade-${target}-${vulkan ? 'vulkan' : 'cpu'}`)
  run('cmake', ['-S', crispasr, '-B', dir, '-DCMAKE_BUILD_TYPE=Release', `-DGGML_VULKAN=${vulkan ? '1' : '0'}`, ...crossArgs(), ...portableArgs(vulkan),
    `-DCMAKE_PROJECT_crispasr_INCLUDE=${join(root, 'native/cascade-align/CMakeLists.txt')}`,
    '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DGGML_CCACHE=OFF', '-DGGML_BLAS=OFF', '-DCRISPASR_MEL_BLAS=OFF',
    '-DCMAKE_DISABLE_FIND_PACKAGE_OpenMP=ON', '-DCRISPASR_BUILD_TESTS=OFF', '-DCRISPASR_BUILD_EXAMPLES=OFF',
    '-DCRISPASR_BUILD_SERVER=OFF', '-DCRISPASR_CURL=OFF', '-DCRISPASR_NO_C2PA_NATIVE=ON'])
  run('cmake', ['--build', dir, '--config', 'Release', '--target', 'cascade-align', '-j', String(Math.min(8, availableParallelism()))])
  return dir
}
let dir
try { dir = build(gpu) } catch (error) {
  if (!gpu) throw error
  console.warn(`Vulkan build failed (${error.message}); falling back to CPU.`)
  gpu = false
  dir = build(false)
}
const alignerDir = buildAligner(gpu)
mkdirSync(output, { recursive: true })
const suffix = target.startsWith('win32') ? '.exe' : ''
function install(dir, name) {
  const exe = name + suffix
  const binary = [join(dir, 'bin', exe), join(dir, 'bin/Release', exe), join(dir, exe), join(dir, 'Release', exe)].find(existsSync)
  if (!binary) throw new Error(`Build succeeded but ${exe} was not found`)
  checkPortable(binary)
  copyFileSync(binary, join(output, `${exe}.tmp`))
  chmodSync(join(output, `${exe}.tmp`), 0o755)
  renameSync(join(output, `${exe}.tmp`), join(output, exe))
}
install(dir, 'whisper-cli')
install(alignerDir, 'cascade-align')
writeFileSync(join(output, 'build.json'), JSON.stringify({ tag, commit, crispasr: CRISPASR, target, timestampPatch: 1, gpu, backend: gpu ? 'vulkan' : 'cpu', seconds: (Date.now() - started) / 1000 }, null, 2))
copyFileSync(join(source, 'LICENSE'), join(output, 'LICENSE'))
copyFileSync(join(crispasr, 'LICENSE'), join(output, 'LICENSE-crispasr'))
console.log(`whisper.cpp ${tag} + cascade-align (CrispASR ${CRISPASR.tag}): ${gpu ? 'Vulkan' : 'CPU'} build in ${((Date.now() - started) / 1000).toFixed(1)}s → ${output}`)
