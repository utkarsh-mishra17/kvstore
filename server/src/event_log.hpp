// event_log.hpp - Logging module: in-memory ring buffer (for the dashboard) + timestamped file log.
#pragma once
#include <cstdio>
#include "common.hpp"

namespace kv {

struct Event {
    uint64_t id;
    uint64_t t_us;
    int64_t epoch_ms;
    std::string type;
    std::string msg;
};

class EventLog {
public:
    ~EventLog() { if (fp_) fclose(fp_); }
    void open(const std::string& path) { fp_ = fopen(path.c_str(), "a"); }

    void log(const std::string& type, const std::string& msg) {
        Event e{0, mono_us(), epoch_ms(), type, msg};
        std::lock_guard<std::mutex> lk(m_);
        e.id = next_++;
        if (fp_ && (type == "SERVER" || type == "CLIENT" || type == "ERROR" || type == "CONFIG")) {
            fprintf(fp_, "%s [%s] %s\n", wall_string(e.epoch_ms).c_str(), type.c_str(), msg.c_str());
            fflush(fp_);
        }
        ring_.push_back(std::move(e));
        if (ring_.size() > CAP) ring_.pop_front();
    }
    uint64_t last_id() { std::lock_guard<std::mutex> lk(m_); return next_ - 1; }

    std::string json_since(uint64_t since, size_t max_items) {
        std::lock_guard<std::mutex> lk(m_);
        std::string o = "[";
        size_t n = 0;
        std::vector<const Event*> sel;  // newest-first scan so we return the most recent max_items
        for (auto it = ring_.rbegin(); it != ring_.rend() && sel.size() < max_items; ++it) {
            if (it->id <= since) break;
            sel.push_back(&*it);
        }
        for (auto it = sel.rbegin(); it != sel.rend(); ++it, ++n) {
            const Event& e = **it;
            if (n) o += ",";
            o += cat("{\"id\":", e.id, ",\"t_us\":", e.t_us, ",\"time\":", jstr(wall_string(e.epoch_ms)),
                     ",\"type\":", jstr(e.type), ",\"msg\":", jstr(e.msg), "}");
        }
        return o + "]";
    }

private:
    static constexpr size_t CAP = 8000;
    std::mutex m_;
    std::deque<Event> ring_;
    uint64_t next_ = 1;
    FILE* fp_ = nullptr;
};

}  // namespace kv
