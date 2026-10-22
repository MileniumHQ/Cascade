# Injected into vendor/CrispASR's own configure (CrispASR must be the top-level project) by
# scripts/setup-whisper.mjs:  cmake -S vendor/CrispASR -DCMAKE_PROJECT_crispasr_INCLUDE=<this file>
# Only cascade-align and its dependencies (the qwen3_asr library, ggml) get built.
add_executable(cascade-align ${CMAKE_CURRENT_LIST_DIR}/main.cpp)
target_include_directories(cascade-align PRIVATE ${CMAKE_SOURCE_DIR}/src ${CMAKE_SOURCE_DIR}/examples)
target_link_libraries(cascade-align PRIVATE qwen3_asr)
target_compile_features(cascade-align PRIVATE cxx_std_17)
