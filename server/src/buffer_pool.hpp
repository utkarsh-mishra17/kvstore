// buffer_pool.hpp - Memory Management module: fixed-size frame cache with FIFO / LRU / Clock replacement,
// dirty-page tracking and write-back on eviction.
// choose_victim() is shared by the live BufferPool and the page-replacement simulator.
#pragma once
#include "disk_scheduler.hpp"

namespace kv {

enum class RepPolicy { FIFO = 0, LRU, CLOCK };
inline const char* rep_name(RepPolicy p) {
    static const char* n[] = {"FIFO", "LRU", "CLOCK"};
    return n[(int)p];
}
inline bool parse_rep(const std::string& s, RepPolicy& p) {
    std::string u = upper(s);
    if (u == "FIFO") p = RepPolicy::FIFO;
    else if (u == "LRU") p = RepPolicy::LRU;
    else if (u == "CLOCK") p = RepPolicy::CLOCK;
    else return false;
    return true;
}

struct FrameMeta {
    int block = -1;
    bool valid = false, dirty = false, ref = false;
    uint64_t load_seq = 0, last_use = 0;
    int pin = 0;  // frames in use (or loading) cannot be evicted
};

// Returns the frame index to replace, or -1 if every frame is pinned. `get(i)` returns FrameMeta&.
template <class Get>
int choose_victim(RepPolicy p, size_t n, size_t& hand, Get get) {
    for (size_t i = 0; i < n; i++)  // an empty frame is always preferred
        if (!get(i).valid && get(i).pin == 0) return (int)i;
    switch (p) {
        case RepPolicy::FIFO: {
            int best = -1;
            for (size_t i = 0; i < n; i++)
                if (get(i).pin == 0 && (best < 0 || get(i).load_seq < get((size_t)best).load_seq)) best = (int)i;
            return best;
        }
        case RepPolicy::LRU: {
            int best = -1;
            for (size_t i = 0; i < n; i++)
                if (get(i).pin == 0 && (best < 0 || get(i).last_use < get((size_t)best).last_use)) best = (int)i;
            return best;
        }
        case RepPolicy::CLOCK:  // second chance: clear reference bits until one is already clear
            for (size_t step = 0; step < 2 * n + 1; step++) {
                size_t i = hand % n;
                FrameMeta& f = get(i);
                hand = (i + 1) % n;
                if (f.pin > 0) continue;
                if (f.ref) { f.ref = false; continue; }
                return (int)i;
            }
            return -1;
    }
    return -1;
}

// ---------- Page replacement simulator (reference-string demonstrations) ----------
struct PageRef { int page; bool write; };
struct PageStep {
    PageRef ref;
    bool hit;
    int victim = -1;        // page evicted (or -1)
    bool writeback = false; // victim was dirty
    std::vector<int> frames;
    std::vector<int> refbits;
    std::vector<int> dirty;
    size_t hand = 0;
};
struct PageSim { std::vector<PageStep> steps; int faults = 0, hits = 0, writebacks = 0; };

inline PageSim simulate_pages(RepPolicy p, int nframes, const std::vector<PageRef>& refs) {
    std::vector<FrameMeta> f((size_t)nframes);
    size_t hand = 0;
    uint64_t tick = 0;
    PageSim out;
    for (auto& r : refs) {
        PageStep s;
        s.ref = r;
        int found = -1;
        for (int i = 0; i < nframes; i++) if (f[(size_t)i].valid && f[(size_t)i].block == r.page) found = i;
        if (found >= 0) {
            s.hit = true; out.hits++;
            f[(size_t)found].ref = true;
            f[(size_t)found].last_use = ++tick;
            if (r.write) f[(size_t)found].dirty = true;
        } else {
            s.hit = false; out.faults++;
            int v = choose_victim(p, f.size(), hand, [&](size_t i) -> FrameMeta& { return f[i]; });
            FrameMeta& fm = f[(size_t)v];
            if (fm.valid) {
                s.victim = fm.block;
                if (fm.dirty) { s.writeback = true; out.writebacks++; }
            }
            fm = FrameMeta{};
            fm.block = r.page; fm.valid = true; fm.dirty = r.write; fm.ref = true;
            fm.load_seq = ++tick; fm.last_use = tick;
        }
        for (auto& fm : f) {
            s.frames.push_back(fm.valid ? fm.block : -1);
            s.refbits.push_back(fm.ref ? 1 : 0);
            s.dirty.push_back(fm.dirty ? 1 : 0);
        }
        s.hand = hand;
        out.steps.push_back(std::move(s));
    }
    return out;
}

// ---------- Live buffer pool ----------
struct Frame : FrameMeta {
    bool loading = false;
    char data[BLOCK_SIZE];
};

struct ReplEvent { uint64_t seq; uint64_t t_us; int victim, incoming; bool dirty; std::string policy; };

class BufferPool {
public:
    BufferPool(DiskScheduler& disk, EventLog& log, size_t nframes, RepPolicy p) : disk_(disk), log_(log), policy_(p) {
        init_frames(nframes);
    }

    // Return the frame holding `block`, pinned. On a miss, evict a victim (writing it back if dirty)
    // and read the block through the disk scheduler. The pool mutex is NOT held during disk I/O, so
    // several workers can have requests pending at once - which is what gives the disk scheduler a queue to reorder.
    Frame* pin(int block, bool& hit, bool quiet = false) {
        std::unique_lock<std::mutex> lk(m_);
        for (;;) {
            auto it = index_.find(block);
            if (it != index_.end()) {
                Frame* f = frames_[it->second].get();
                f->pin++;
                f->ref = true;
                f->last_use = ++tick_;
                cv_.wait(lk, [&] { return !f->loading; });
                hits_++;
                hit = true;
                if (!quiet) log_.log("CACHE", cat("HIT block=", block, " frame=", it->second, " policy=", rep_name(policy_)));
                return f;
            }
            if (writing_back_.count(block)) { cv_.wait(lk); continue; }  // an evicted dirty copy is still being written
            int v = choose_victim(policy_, frames_.size(), hand_, [&](size_t i) -> FrameMeta& { return *frames_[i]; });
            if (v < 0) { cv_.wait(lk); continue; }                      // all frames pinned: wait for an unpin
            Frame* f = frames_[(size_t)v].get();
            const bool had = f->valid, wb = had && f->dirty;
            const int old = f->block;
            std::unique_ptr<char[]> wbuf;
            if (wb) {
                wbuf.reset(new char[BLOCK_SIZE]);
                memcpy(wbuf.get(), f->data, BLOCK_SIZE);
                writing_back_.insert(old);
            }
            if (had) {
                index_.erase(old);
                evictions_++;
                if (wb) writebacks_++;
                history_.push_back({++repl_seq_, mono_us(), old, block, wb, rep_name(policy_)});
                if (history_.size() > 300) history_.pop_front();
                log_.log("PAGE", cat("REPLACE ", rep_name(policy_), " frame=", v, " evict block=", old, (wb ? " (dirty, write-back)" : " (clean)"), " load block=", block));
            }
            f->block = block; f->valid = true; f->dirty = false; f->ref = true;
            f->load_seq = ++tick_; f->last_use = tick_; f->pin = 1; f->loading = true;
            index_[block] = (size_t)v;
            misses_++;
            lk.unlock();
            if (!quiet) log_.log("CACHE", cat("MISS block=", block, " frame=", v, " policy=", rep_name(policy_)));
            IOReq rd(block, false, f->data);
            IOReq wr(old, true, wbuf.get());
            disk_.submit(&rd);
            if (wb) disk_.submit(&wr);
            disk_.wait(&rd);
            if (wb) disk_.wait(&wr);
            lk.lock();
            f->loading = false;
            if (wb) writing_back_.erase(old);
            cv_.notify_all();
            hit = false;
            return f;
        }
    }

    void unpin(Frame* f, bool dirtied) {
        std::lock_guard<std::mutex> lk(m_);
        if (dirtied) f->dirty = true;
        f->pin--;
        cv_.notify_all();
    }

    // Write every dirty, unpinned frame to disk (shutdown / FLUSH command).
    int flush_all() {
        std::unique_lock<std::mutex> lk(m_);
        int n = 0;
        for (auto& fp : frames_) {
            Frame* f = fp.get();
            if (!(f->valid && f->dirty && !f->loading && f->pin == 0)) continue;
            IOReq w(f->block, true, f->data);
            disk_.submit(&w);
            disk_.wait(&w);
            f->dirty = false;
            n++;
        }
        lk.unlock();
        disk_.sync();
        return n;
    }

    // Change the number of frames at runtime (flushes first, waits for all pins to drain).
    bool resize(size_t n) {
        if (n < 2 || n > 128) return false;
        std::unique_lock<std::mutex> lk(m_);
        cv_.wait(lk, [&] { for (auto& f : frames_) if (f->pin > 0) return false; return true; });
        for (auto& fp : frames_) {
            if (fp->valid && fp->dirty) { IOReq w(fp->block, true, fp->data); disk_.submit(&w); disk_.wait(&w); }
        }
        index_.clear();
        init_frames(n);
        cv_.notify_all();
        return true;
    }

    void set_policy(RepPolicy p) { std::lock_guard<std::mutex> lk(m_); policy_ = p; }
    RepPolicy policy() { std::lock_guard<std::mutex> lk(m_); return policy_; }
    void reset_stats() { std::lock_guard<std::mutex> lk(m_); hits_ = misses_ = evictions_ = writebacks_ = 0; history_.clear(); }

    struct Stats { size_t frames, occupied, dirty; uint64_t hits, misses, evictions, writebacks; RepPolicy policy; };
    Stats stats() {
        std::lock_guard<std::mutex> lk(m_);
        Stats s{frames_.size(), 0, 0, hits_, misses_, evictions_, writebacks_, policy_};
        for (auto& f : frames_) { if (f->valid) s.occupied++; if (f->valid && f->dirty) s.dirty++; }
        return s;
    }
    std::string frames_json() {
        std::lock_guard<std::mutex> lk(m_);
        std::string o = cat("{\"policy\":", jstr(rep_name(policy_)), ",\"hand\":", hand_, ",\"frames\":[");
        for (size_t i = 0; i < frames_.size(); i++) {
            const Frame& f = *frames_[i];
            if (i) o += ",";
            o += cat("{\"index\":", i, ",\"block\":", f.valid ? f.block : -1, ",\"dirty\":", f.dirty ? "true" : "false",
                     ",\"ref\":", f.ref ? "true" : "false", ",\"pinned\":", f.pin, ",\"loading\":", f.loading ? "true" : "false",
                     ",\"load_seq\":", f.load_seq, ",\"last_use\":", f.last_use, "}");
        }
        o += "],\"history\":[";
        bool first = true;
        for (auto& h : history_) {
            if (!first) o += ",";
            first = false;
            o += cat("{\"seq\":", h.seq, ",\"t_us\":", h.t_us, ",\"victim\":", h.victim, ",\"incoming\":", h.incoming,
                     ",\"dirty\":", h.dirty ? "true" : "false", ",\"policy\":", jstr(h.policy), "}");
        }
        return o + "]}";
    }

private:
    void init_frames(size_t n) {
        frames_.clear();
        for (size_t i = 0; i < n; i++) { frames_.push_back(std::make_unique<Frame>()); memset(frames_.back()->data, 0, BLOCK_SIZE); }
        hand_ = 0;
    }

    DiskScheduler& disk_;
    EventLog& log_;
    std::mutex m_;
    std::condition_variable cv_;
    std::vector<std::unique_ptr<Frame>> frames_;
    std::unordered_map<int, size_t> index_;
    std::unordered_set<int> writing_back_;
    std::deque<ReplEvent> history_;
    RepPolicy policy_;
    size_t hand_ = 0;
    uint64_t tick_ = 0, repl_seq_ = 0;
    uint64_t hits_ = 0, misses_ = 0, evictions_ = 0, writebacks_ = 0;
};

}  // namespace kv
