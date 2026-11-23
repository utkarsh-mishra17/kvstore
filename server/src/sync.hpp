// sync.hpp - Synchronization module: per-block readers-writers locks (pthread_rwlock_t).
// Many readers may hold a block concurrently; a writer gets exclusive access.
// Deadlock prevention for multi-key operations is enforced by the caller acquiring in ascending block order.
#pragma once
#include <pthread.h>
#include "common.hpp"

namespace kv {

class BlockLocks {
public:
    BlockLocks() { for (auto& l : rw_) pthread_rwlock_init(&l, nullptr); }
    ~BlockLocks() { for (auto& l : rw_) pthread_rwlock_destroy(&l); }
    BlockLocks(const BlockLocks&) = delete;
    BlockLocks& operator=(const BlockLocks&) = delete;

    void read_lock(int b) {
        if (pthread_rwlock_tryrdlock(&rw_[b]) != 0) { contended_++; pthread_rwlock_rdlock(&rw_[b]); }
        readers_[b]++; total_readers_++; rd_acq_++;
    }
    void read_unlock(int b) {
        readers_[b]--; total_readers_--;
        pthread_rwlock_unlock(&rw_[b]);
    }
    // timeout_ms < 0 blocks forever. A finite timeout is only used when ordered locking is disabled,
    // to *detect* (not prevent) circular wait for the deadlock demonstration.
    bool write_lock(int b, int timeout_ms = -1) {
        if (pthread_rwlock_trywrlock(&rw_[b]) != 0) {
            contended_++;
            if (timeout_ms < 0) pthread_rwlock_wrlock(&rw_[b]);
            else {
                auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
                for (;;) {
                    sleep_us(500);
                    if (pthread_rwlock_trywrlock(&rw_[b]) == 0) break;
                    if (std::chrono::steady_clock::now() >= deadline) { timeouts_++; return false; }
                }
            }
        }
        writers_[b]++; total_writers_++; wr_acq_++;
        return true;
    }
    void write_unlock(int b) {
        writers_[b]--; total_writers_--;
        pthread_rwlock_unlock(&rw_[b]);
    }

    int total_readers() const { return total_readers_; }
    int total_writers() const { return total_writers_; }
    uint64_t rd_acquisitions() const { return rd_acq_; }
    uint64_t wr_acquisitions() const { return wr_acq_; }
    uint64_t contended() const { return contended_; }
    uint64_t timeouts() const { return timeouts_; }
    void reset_stats() { rd_acq_ = wr_acq_ = contended_ = timeouts_ = 0; }

    // Blocks currently locked: [{"block":b,"readers":r,"writers":w}, ...]
    std::string active_json() const {
        std::string o = "[";
        bool first = true;
        for (int b = 0; b < NUM_BLOCKS; b++) {
            int r = readers_[b], w = writers_[b];
            if (!r && !w) continue;
            if (!first) o += ",";
            first = false;
            o += cat("{\"block\":", b, ",\"readers\":", r, ",\"writers\":", w, "}");
        }
        return o + "]";
    }

private:
    pthread_rwlock_t rw_[NUM_BLOCKS];
    std::atomic<int> readers_[NUM_BLOCKS]{};
    std::atomic<int> writers_[NUM_BLOCKS]{};
    std::atomic<int> total_readers_{0}, total_writers_{0};
    std::atomic<uint64_t> rd_acq_{0}, wr_acq_{0}, contended_{0}, timeouts_{0};
};

}  // namespace kv
