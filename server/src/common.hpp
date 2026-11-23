// common.hpp - shared constants, timing helpers, portable semaphore, JSON helpers.
#pragma once
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#ifdef __APPLE__
#include <dispatch/dispatch.h>
#else
#include <semaphore.h>
#endif

namespace kv {

constexpr int BLOCK_SIZE = 4096;   // bytes per disk block / buffer frame
constexpr int NUM_BLOCKS = 200;    // tracks on the "disk" (0..199)
constexpr int MAX_KEY_LEN = 64;
constexpr int MAX_VALUE_LEN = 256;
constexpr int MAX_MSET_PAIRS = 32;

// Microseconds since process start (monotonic).
inline uint64_t mono_us() {
    using namespace std::chrono;
    static const auto t0 = steady_clock::now();
    return (uint64_t)duration_cast<microseconds>(steady_clock::now() - t0).count() + 1;
}
inline int64_t epoch_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}
inline std::string wall_string(int64_t ms) {
    time_t s = (time_t)(ms / 1000);
    struct tm tmv;
    localtime_r(&s, &tmv);
    char buf[40];
    strftime(buf, sizeof buf, "%Y-%m-%d %H:%M:%S", &tmv);
    char out[64];
    snprintf(out, sizeof out, "%s.%03d", buf, (int)(ms % 1000));
    return out;
}
inline void sleep_us(uint64_t us) { if (us) std::this_thread::sleep_for(std::chrono::microseconds(us)); }

template <class... A> std::string cat(A&&... a) {
    std::ostringstream o;
    (o << ... << a);
    return o.str();
}

inline std::string jesc(const std::string& s) {
    std::string o;
    o.reserve(s.size() + 2);
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
                else o += (char)c;
        }
    }
    return o;
}
inline std::string jstr(const std::string& s) { return "\"" + jesc(s) + "\""; }
inline std::string jnum(double v) {
    char b[48];
    snprintf(b, sizeof b, "%.3f", v);
    std::string s = b;
    while (s.size() > 1 && s.back() == '0') s.pop_back();
    if (!s.empty() && s.back() == '.') s.pop_back();
    return s;
}

// Key -> block mapping (FNV-1a hash). Deterministic so clients/tests can predict placement.
inline int block_of(const std::string& key) {
    uint32_t h = 2166136261u;
    for (unsigned char c : key) { h ^= c; h *= 16777619u; }
    return (int)(h % NUM_BLOCKS);
}

inline std::vector<std::string> split_ws(const std::string& s) {
    std::vector<std::string> out;
    std::istringstream is(s);
    std::string t;
    while (is >> t) out.push_back(t);
    return out;
}
inline std::string upper(std::string s) { for (auto& c : s) c = (char)toupper((unsigned char)c); return s; }
inline std::string lower(std::string s) { for (auto& c : s) c = (char)tolower((unsigned char)c); return s; }

// Counting semaphore: POSIX sem_t on Linux, libdispatch semaphore on macOS
// (macOS does not implement unnamed POSIX semaphores).
class Semaphore {
public:
    explicit Semaphore(unsigned initial) {
#ifdef __APPLE__
        sem_ = dispatch_semaphore_create(initial);
#else
        sem_init(&sem_, 0, initial);
#endif
    }
    ~Semaphore() {
#ifndef __APPLE__
        sem_destroy(&sem_);
#endif
    }
    Semaphore(const Semaphore&) = delete;
    Semaphore& operator=(const Semaphore&) = delete;
    void wait() {
#ifdef __APPLE__
        dispatch_semaphore_wait(sem_, DISPATCH_TIME_FOREVER);
#else
        while (sem_wait(&sem_) == -1 && errno == EINTR) {}
#endif
    }
    void post() {
#ifdef __APPLE__
        dispatch_semaphore_signal(sem_);
#else
        sem_post(&sem_);
#endif
    }
private:
#ifdef __APPLE__
    dispatch_semaphore_t sem_;
#else
    sem_t sem_;
#endif
};

}  // namespace kv
