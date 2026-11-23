// disk_scheduler.hpp - Disk Scheduling module: FCFS, SSTF, SCAN, C-SCAN, LOOK, C-LOOK.
// HeadScheduler is a pure algorithm object (head position + direction + seek accounting).
// It is used by the live disk thread AND by the simulator, so seek distances shown in the dashboard
// are produced by the same code that orders real block I/O.
#pragma once
#include "event_log.hpp"
#include "storage.hpp"

namespace kv {

enum class DiskAlg { FCFS = 0, SSTF, SCAN, CSCAN, LOOK, CLOOK };
inline const char* disk_name(DiskAlg a) {
    static const char* n[] = {"FCFS", "SSTF", "SCAN", "C-SCAN", "LOOK", "C-LOOK"};
    return n[(int)a];
}
inline bool parse_disk(const std::string& s, DiskAlg& a) {
    std::string u = upper(s);
    if (u == "FCFS") a = DiskAlg::FCFS;
    else if (u == "SSTF") a = DiskAlg::SSTF;
    else if (u == "SCAN") a = DiskAlg::SCAN;
    else if (u == "CSCAN" || u == "C-SCAN") a = DiskAlg::CSCAN;
    else if (u == "LOOK") a = DiskAlg::LOOK;
    else if (u == "CLOOK" || u == "C-LOOK") a = DiskAlg::CLOOK;
    else return false;
    return true;
}

struct PathPt { int pos; char kind; };  // kind: 'H' start, 'S' served request, 'E' travelled to disk edge, 'J' jump (C-SCAN/C-LOOK return)

class HeadScheduler {
public:
    DiskAlg alg = DiskAlg::FCFS;
    int head = 0;
    bool up = true;               // current sweep direction (toward higher block numbers)
    int max_track = NUM_BLOCKS - 1;
    uint64_t total_seek = 0, jump_seek = 0;
    bool record_path = false;
    std::vector<PathPt> path;

    static constexpr size_t NONE = (size_t)-1;

    // Pick which pending block to serve next (index into `b`, which is in arrival order) and move the head there.
    size_t next(const std::vector<int>& b, int& seek_out) {
        const uint64_t before = total_seek;
        size_t idx = 0;
        switch (alg) {
            case DiskAlg::FCFS: idx = 0; break;
            case DiskAlg::SSTF: {
                int best = abs(b[0] - head);
                for (size_t i = 1; i < b.size(); i++) if (abs(b[i] - head) < best) { best = abs(b[i] - head); idx = i; }
                break;
            }
            case DiskAlg::SCAN:  // sweep to the physical edge, then reverse
                for (;;) {
                    idx = up ? find_up(b) : find_down(b);
                    if (idx != NONE) break;
                    move_to(up ? max_track : 0, 'E');
                    up = !up;
                }
                break;
            case DiskAlg::CSCAN:  // one-directional: sweep up to the edge, jump back to track 0
                up = true;
                idx = find_up(b);
                if (idx == NONE) {
                    move_to(max_track, 'E');
                    jump_seek += (uint64_t)max_track;
                    total_seek += (uint64_t)max_track;
                    head = 0;
                    if (record_path) path.push_back({0, 'J'});
                    idx = find_up(b);
                }
                break;
            case DiskAlg::LOOK:  // like SCAN but reverse at the last request instead of the edge
                for (;;) {
                    idx = up ? find_up(b) : find_down(b);
                    if (idx != NONE) break;
                    up = !up;
                }
                break;
            case DiskAlg::CLOOK:
                up = true;
                idx = find_up(b);
                if (idx == NONE) {  // jump from the highest request straight to the lowest one
                    size_t lo = 0;
                    for (size_t i = 1; i < b.size(); i++) if (b[i] < b[lo]) lo = i;
                    uint64_t d = (uint64_t)abs(head - b[lo]);
                    jump_seek += d;
                    total_seek += d;
                    head = b[lo];
                    if (record_path) path.push_back({head, 'J'});
                    idx = lo;
                }
                break;
        }
        move_to(b[idx], 'S');
        seek_out = (int)(total_seek - before);
        return idx;
    }

private:
    size_t find_up(const std::vector<int>& b) const {  // lowest block >= head
        size_t r = NONE;
        for (size_t i = 0; i < b.size(); i++) if (b[i] >= head && (r == NONE || b[i] < b[r])) r = i;
        return r;
    }
    size_t find_down(const std::vector<int>& b) const {  // highest block <= head
        size_t r = NONE;
        for (size_t i = 0; i < b.size(); i++) if (b[i] <= head && (r == NONE || b[i] > b[r])) r = i;
        return r;
    }
    void move_to(int pos, char kind) {
        total_seek += (uint64_t)abs(pos - head);
        head = pos;
        if (record_path) path.push_back({pos, kind});
    }
};

struct DiskSimStep { int block; int seek; };
struct DiskSimResult {
    std::vector<DiskSimStep> order;
    std::vector<PathPt> path;
    uint64_t total_seek = 0, jump_seek = 0;
};
inline DiskSimResult simulate_disk(DiskAlg alg, int head, std::vector<int> reqs, int max_track, bool up) {
    HeadScheduler hs;
    hs.alg = alg; hs.head = head; hs.up = up; hs.max_track = max_track; hs.record_path = true;
    hs.path.push_back({head, 'H'});  // starting head position
    DiskSimResult r;
    while (!reqs.empty()) {
        int seek;
        size_t i = hs.next(reqs, seek);
        r.order.push_back({reqs[i], seek});
        reqs.erase(reqs.begin() + i);
    }
    r.path = hs.path;
    r.total_seek = hs.total_seek;
    r.jump_seek = hs.jump_seek;
    return r;
}

// ---------- Live disk layer ----------
struct IOReq {
    int block;
    bool write;
    char* buf;
    bool done = false;
    IOReq(int b, bool w, char* p) : block(b), write(w), buf(p) {}
};
struct DiskOp { uint64_t seq; int block; bool write; int from; int seek; uint64_t t_us; int pending_after; std::string alg; };

class DiskScheduler {
public:
    DiskScheduler(StorageEngine& st, EventLog& log, DiskAlg alg) : st_(st), log_(log) {
        hs_.alg = alg;
        hs_.head = 0;
        th_ = std::thread([this] { loop(); });
    }
    ~DiskScheduler() {
        { std::lock_guard<std::mutex> lk(m_); stop_ = true; }
        cv_work_.notify_all();
        th_.join();
    }
    void submit(IOReq* r) {
        { std::lock_guard<std::mutex> lk(m_); pending_.push_back(r); }
        cv_work_.notify_one();
    }
    void wait(IOReq* r) {
        std::unique_lock<std::mutex> lk(m_);
        cv_done_.wait(lk, [&] { return r->done; });
    }
    void sync() { st_.sync(); }
    void set_alg(DiskAlg a) { std::lock_guard<std::mutex> lk(m_); hs_.alg = a; }
    void set_head(int h) { std::lock_guard<std::mutex> lk(m_); hs_.head = std::max(0, std::min(h, NUM_BLOCKS - 1)); }
    void reset_stats() {
        std::lock_guard<std::mutex> lk(m_);
        hs_.total_seek = 0; hs_.jump_seek = 0; reads_ = writes_ = 0; history_.clear();
    }
    std::atomic<int> window_us{0};     // batching window: lets requests accumulate so reordering is observable
    std::atomic<int> io_delay_us{0};   // simulated seek latency per track travelled (0 = real speed)

    struct Status { DiskAlg alg; int head; uint64_t seek, jump, reads, writes; std::vector<int> pending; };
    Status status() {
        std::lock_guard<std::mutex> lk(m_);
        Status s{hs_.alg, hs_.head, hs_.total_seek, hs_.jump_seek, reads_, writes_, {}};
        for (auto* r : pending_) s.pending.push_back(r->block);
        return s;
    }
    std::string history_json(uint64_t since) {
        std::lock_guard<std::mutex> lk(m_);
        std::string o = "[";
        bool first = true;
        for (auto& d : history_) {
            if (d.seq <= since) continue;
            if (!first) o += ",";
            first = false;
            o += cat("{\"seq\":", d.seq, ",\"block\":", d.block, ",\"op\":", jstr(d.write ? "WRITE" : "READ"), ",\"from\":", d.from,
                     ",\"seek\":", d.seek, ",\"t_us\":", d.t_us, ",\"pending_after\":", d.pending_after, ",\"alg\":", jstr(d.alg), "}");
        }
        return o + "]";
    }

private:
    void loop() {
        std::unique_lock<std::mutex> lk(m_);
        for (;;) {
            cv_work_.wait(lk, [&] { return stop_ || !pending_.empty(); });
            if (stop_ && pending_.empty()) return;
            int w = window_us.load();
            if (w > 0) { lk.unlock(); sleep_us((uint64_t)w); lk.lock(); }
            while (!pending_.empty()) {
                std::vector<int> blocks;
                blocks.reserve(pending_.size());
                for (auto* r : pending_) blocks.push_back(r->block);
                int from = hs_.head, seek = 0;
                size_t idx = hs_.next(blocks, seek);
                IOReq* r = pending_[idx];
                pending_.erase(pending_.begin() + idx);
                size_t left = pending_.size();
                DiskAlg alg = hs_.alg;
                lk.unlock();
                int d = io_delay_us.load();
                if (d > 0 && seek > 0) sleep_us((uint64_t)d * (uint64_t)seek);
                if (r->write) st_.write_block(r->block, r->buf); else st_.read_block(r->block, r->buf);
                lk.lock();
                (r->write ? writes_ : reads_)++;
                history_.push_back({++seq_, r->block, r->write, from, seek, mono_us(), (int)left, disk_name(alg)});
                if (history_.size() > 400) history_.pop_front();
                log_.log("DISK", cat(r->write ? "WRITE" : "READ", " block=", r->block, " head ", from, "->", r->block,
                                      " seek=", seek, " alg=", disk_name(alg), " pending=", left));
                r->done = true;
                cv_done_.notify_all();
            }
        }
    }

    StorageEngine& st_;
    EventLog& log_;
    std::mutex m_;
    std::condition_variable cv_work_, cv_done_;
    std::vector<IOReq*> pending_;
    HeadScheduler hs_;
    std::deque<DiskOp> history_;
    uint64_t seq_ = 0, reads_ = 0, writes_ = 0;
    bool stop_ = false;
    std::thread th_;
};

}  // namespace kv
