// cascade-align: Qwen3-ForcedAligner word timing for Cascade, on CrispASR's ggml port.
//
//   cascade-align -m qwen3-forced-aligner.gguf -f audio.wav -j chunks.json -o words.json [-t threads] [-ng]
//
// audio.wav:   16 kHz mono PCM s16le (what src/main/transcribe.ts extracts with ffmpeg).
// chunks.json: {"chunks":[{"start":ms,"end":ms,"words":["hello","world"]}, ...]}   (times in the wav, ms)
// words.json:  {"chunks":[{"start":[ms,...],"end":[ms,...]} | {"error":"..."}, ...]} (absolute ms, one per word)
// stderr:      "progress = N%" lines, plus diagnostics.
// Words are the aligner's units: callers strip punctuation (keep letters, digits, apostrophes) and
// split CJK ideographs, as the upstream Python processor does.
//
// The model loads once; each chunk (≤ 120 s, cut by the caller at pauses) is one forward pass with
// 80 ms timestamp classes. A failed chunk reports an error and the caller keeps its own timing.
#include "qwen3_asr.h"
#include "json.hpp"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <thread>
#include <vector>

using json = nlohmann::json;

static bool read_wav(const char* path, std::vector<float>& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    std::vector<char> b((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (b.size() < 12 || std::memcmp(b.data(), "RIFF", 4) || std::memcmp(b.data() + 8, "WAVE", 4)) return false;
    auto u16 = [&](size_t o) { return (uint32_t)(uint8_t)b[o] | (uint32_t)(uint8_t)b[o + 1] << 8; };
    auto u32 = [&](size_t o) { return u16(o) | u16(o + 2) << 16; };
    uint32_t rate = 0, channels = 0, bits = 0, format = 0;
    for (size_t o = 12; o + 8 <= b.size();) {
        uint32_t size = u32(o + 4);
        size_t body = o + 8, avail = std::min<size_t>(size, b.size() - body);
        if (!std::memcmp(b.data() + o, "fmt ", 4) && avail >= 16) {
            format = u16(body); channels = u16(body + 2); rate = u32(body + 4); bits = u16(body + 14);
        } else if (!std::memcmp(b.data() + o, "data", 4)) {
            if (format != 1 || channels != 1 || rate != 16000 || bits != 16) {
                fprintf(stderr, "cascade-align: expected 16 kHz mono s16 PCM (got format %u, %u ch, %u Hz, %u bit)\n", format, channels, rate, bits);
                return false;
            }
            out.resize(avail / 2);
            for (size_t i = 0; i < out.size(); i++) out[i] = (float)(int16_t)u16(body + i * 2) / 32768.0f;
            return true;
        }
        o = body + size + (size & 1);
    }
    return false;
}

int main(int argc, char** argv) {
    std::string model, wav, chunks_path, out_path;
    int threads = (int)std::min(4u, std::max(1u, std::thread::hardware_concurrency()));
    bool gpu = true;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "-m" && i + 1 < argc) model = argv[++i];
        else if (a == "-f" && i + 1 < argc) wav = argv[++i];
        else if (a == "-j" && i + 1 < argc) chunks_path = argv[++i];
        else if (a == "-o" && i + 1 < argc) out_path = argv[++i];
        else if (a == "-t" && i + 1 < argc) threads = std::max(1, atoi(argv[++i]));
        else if (a == "-ng" || a == "--no-gpu") gpu = false;
        else if (a == "-h" || a == "--help") {
            fprintf(stderr, "usage: cascade-align -m model.gguf -f audio.wav -j chunks.json -o words.json [-t threads] [-ng]\n");
            return 0;
        } else {
            fprintf(stderr, "cascade-align: unknown argument %s\n", a.c_str());
            return 2;
        }
    }
    if (model.empty() || wav.empty() || chunks_path.empty() || out_path.empty()) {
        fprintf(stderr, "cascade-align: -m, -f, -j and -o are required\n");
        return 2;
    }
    json input;
    try {
        std::ifstream in(chunks_path, std::ios::binary);
        input = json::parse(in);
    } catch (const std::exception& e) {
        fprintf(stderr, "cascade-align: invalid chunks JSON %s: %s\n", chunks_path.c_str(), e.what());
        return 2;
    }
    std::vector<float> samples;
    if (!read_wav(wav.c_str(), samples)) {
        fprintf(stderr, "cascade-align: cannot read %s\n", wav.c_str());
        return 3;
    }
    qwen3_asr_context_params params = qwen3_asr_context_default_params();
    params.n_threads = threads;
    params.use_gpu = gpu;
    params.verbosity = 0;
    qwen3_asr_context* ctx = qwen3_asr_init_from_file(model.c_str(), params);
    if (!ctx) {
        fprintf(stderr, "cascade-align: failed to load %s\n", model.c_str());
        return 4;
    }
    if (qwen3_asr_lm_head_dim(ctx) <= 0 || qwen3_asr_lm_head_dim(ctx) > 10000) {
        fprintf(stderr, "cascade-align: %s is not a forced-aligner model\n", model.c_str());
        qwen3_asr_free(ctx);
        return 4;
    }

    const auto& chunks = input.at("chunks");
    json result = json::array();
    for (size_t c = 0; c < chunks.size(); c++) {
        const auto& chunk = chunks[c];
        const int64_t start = chunk.at("start").get<int64_t>(), end = chunk.at("end").get<int64_t>();
        const auto words = chunk.at("words").get<std::vector<std::string>>();
        const int64_t first = std::max<int64_t>(0, start * 16), last = std::min<int64_t>((int64_t)samples.size(), end * 16);
        if (words.empty() || last - first < 1600) {
            result.push_back({ { "error", "empty chunk" } });
        } else {
            std::vector<const char*> ptrs;
            for (const auto& w : words) ptrs.push_back(w.c_str());
            std::vector<int64_t> s(words.size()), e(words.size());
            int rc = qwen3_asr_align_words(ctx, samples.data() + first, (int)(last - first), ptrs.data(), (int)words.size(), s.data(), e.data());
            if (rc != 0) {
                result.push_back({ { "error", "align_words failed (" + std::to_string(rc) + ")" } });
            } else {
                const int64_t offset = first / 16;
                for (size_t i = 0; i < words.size(); i++) { s[i] += offset; e[i] += offset; }
                result.push_back({ { "start", s }, { "end", e } });
            }
        }
        fprintf(stderr, "progress = %d%%\n", (int)((c + 1) * 100 / chunks.size()));
        fflush(stderr);
    }
    qwen3_asr_free(ctx);
    std::ofstream out(out_path, std::ios::binary);
    out << json{ { "chunks", result } }.dump();
    if (!out.good()) {
        fprintf(stderr, "cascade-align: cannot write %s\n", out_path.c_str());
        return 5;
    }
    return 0;
}
