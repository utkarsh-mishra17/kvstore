// request_queue.hpp - bounded producer/consumer queue.
//   * `slots_` counts free capacity (producers P() before inserting).
//   * `items_` counts queued requests (consumers P() before removing).
//   * `m_` protects the container itself.
// Consumers do not take the head: the CPU scheduling policy decides WHICH queued request is next.
#pragma once
#include "request.hpp"

namespace kv {

class RequestQueue {
public:
    explicit RequestQueue(size_t capacity) : cap_(capacity), slots_((unsigned)capacity), items_(0) {}

    // Producer side (client handler threads). Blocks while the queue is full.
    void push(const RequestPtr& r) {
        blocked_producers_++;
        slots_.wait();
        blocked_producers_--;
        {
            std::lock_guard<std::mutex> lk(m_);
            q_.push_back(r);
            produced_++;
            max_depth_ = std::max<uint64_t>(max_depth_, q_.size());
        }
        items_.post();
    }

    // Round Robin preemption: a half-finished request re-enters at the tail without needing a slot
    // (it released its slot when first dispatched), so workers can never block on a full queue.
    void requeue(const RequestPtr& r) {
        {
            std::lock_guard<std::mutex> lk(m_);
            q_.push_back(r);
            requeued_++;
        }
        items_.post();
    }

    // Consumer side (workers). Returns nullptr when the queue is shutting down.
    RequestPtr pop(size_t& depth_seen) {
        items_.wait();
        std::unique_lock<std::mutex> lk(m_);
        cv_.wait(lk, [&] { return !paused_ || stopping_; });
        if (q_.empty()) return nullptr;
        depth_seen = q_.size();
        size_t idx = pick_index(policy_, q_);
        RequestPtr r = q_[idx];
        q_.erase(q_.begin() + idx);
        r->dispatch_seq = ++dispatch_counter_;
        r->policy_at_dispatch = policy_;
        consumed_++;
        if (!r->slot_released) { r->slot_released = true; slots_.post(); }
        return r;
    }

    void stop(int workers) {
        { std::lock_guard<std::mutex> lk(m_); stopping_ = true; }
        cv_.notify_all();
        for (int i = 0; i < workers + 1; i++) items_.post();
    }
    void set_policy(CpuPolicy p) { std::lock_guard<std::mutex> lk(m_); policy_ = p; }
    CpuPolicy policy() { std::lock_guard<std::mutex> lk(m_); return policy_; }
    void set_paused(bool p) { { std::lock_guard<std::mutex> lk(m_); paused_ = p; } cv_.notify_all(); }
    bool paused() { std::lock_guard<std::mutex> lk(m_); return paused_; }

    size_t capacity() const { return cap_; }
    size_t depth() { std::lock_guard<std::mutex> lk(m_); return q_.size(); }
    uint64_t produced() const { return produced_; }
    uint64_t consumed() const { return consumed_; }
    uint64_t requeued() const { return requeued_; }
    uint64_t max_depth() const { return max_depth_; }
    int blocked_producers() const { return blocked_producers_; }

    // JSON snapshot of the currently queued requests (in arrival order).
    std::string snapshot_json() {
        std::lock_guard<std::mutex> lk(m_);
        uint64_t now = mono_us();
        std::string o = "[";
        for (size_t i = 0; i < q_.size(); i++) {
            const Request& r = *q_[i];
            if (i) o += ",";
            o += cat("{\"id\":", r.id, ",\"op\":", jstr(op_name(r.op)), ",\"priority\":", r.priority,
                     ",\"remaining\":", r.remaining, ",\"age_us\":", now - r.arrival_us, "}");
        }
        return o + "]";
    }

private:
    size_t cap_;
    Semaphore slots_, items_;
    std::mutex m_;
    std::condition_variable cv_;
    std::vector<RequestPtr> q_;
    CpuPolicy policy_ = CpuPolicy::FCFS;
    bool paused_ = false, stopping_ = false;
    uint64_t dispatch_counter_ = 0;
    std::atomic<uint64_t> produced_{0}, consumed_{0}, requeued_{0}, max_depth_{0};
    std::atomic<int> blocked_producers_{0};
};

}  // namespace kv
