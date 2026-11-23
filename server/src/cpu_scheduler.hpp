// cpu_scheduler.hpp - CPU Scheduling module: FCFS, SJF, Priority, Round Robin.
// The same pick_index() function drives both the live request queue and the virtual-time simulator,
// so the dashboard's demonstrations exercise exactly the code that schedules real requests.
#pragma once
#include "common.hpp"

namespace kv {

enum class CpuPolicy { FCFS = 0, SJF = 1, PRIORITY = 2, RR = 3 };

inline const char* cpu_name(CpuPolicy p) {
    switch (p) {
        case CpuPolicy::FCFS: return "FCFS";
        case CpuPolicy::SJF: return "SJF";
        case CpuPolicy::PRIORITY: return "PRIORITY";
        case CpuPolicy::RR: return "RR";
    }
    return "?";
}
inline bool parse_cpu(const std::string& s, CpuPolicy& p) {
    std::string u = upper(s);
    if (u == "FCFS") p = CpuPolicy::FCFS;
    else if (u == "SJF") p = CpuPolicy::SJF;
    else if (u == "PRIORITY" || u == "PRIO") p = CpuPolicy::PRIORITY;
    else if (u == "RR" || u == "ROUNDROBIN") p = CpuPolicy::RR;
    else return false;
    return true;
}

// Anything that can be scheduled: a larger `priority` value is more urgent;
// `remaining` is the (estimated) remaining service cost in units.
struct SchedItem {
    int priority = 1;
    int remaining = 1;
};

// Choose the next item from a ready list kept in arrival order (re-queued RR jobs go to the tail).
template <class V>
size_t pick_index(CpuPolicy p, const V& ready) {
    size_t best = 0;
    switch (p) {
        case CpuPolicy::FCFS:
        case CpuPolicy::RR:  // RR = FCFS order + time slicing (preempted jobs re-enter at the tail)
            return 0;
        case CpuPolicy::SJF:
            for (size_t i = 1; i < ready.size(); i++)
                if (ready[i]->remaining < ready[best]->remaining) best = i;
            return best;
        case CpuPolicy::PRIORITY:
            for (size_t i = 1; i < ready.size(); i++)
                if (ready[i]->priority > ready[best]->priority) best = i;
            return best;
    }
    return 0;
}

// ---------- Virtual-time simulator (non-preemptive FCFS/SJF/Priority, preemptive RR) ----------
struct SimJob : SchedItem {
    std::string name;
    int arrival = 0, burst = 0;
    int start = -1, completion = 0;
};
struct GanttSeg { std::string name; int start, end; };
struct SimResult {
    std::vector<SimJob> jobs;
    std::vector<GanttSeg> gantt;
    double avg_wait = 0, avg_tat = 0;
};

inline SimResult simulate_cpu(CpuPolicy p, int quantum, std::vector<SimJob> jobs) {
    std::stable_sort(jobs.begin(), jobs.end(), [](const SimJob& a, const SimJob& b) { return a.arrival < b.arrival; });
    for (auto& j : jobs) j.remaining = j.burst;
    SimResult r;
    std::vector<SimJob*> ready;
    size_t next = 0, done = 0;
    int t = 0;
    auto admit = [&]() { while (next < jobs.size() && jobs[next].arrival <= t) ready.push_back(&jobs[next++]); };
    while (done < jobs.size()) {
        admit();
        if (ready.empty()) { t = jobs[next].arrival; continue; }
        size_t idx = pick_index(p, ready);
        SimJob* j = ready[idx];
        ready.erase(ready.begin() + idx);
        int slice = (p == CpuPolicy::RR) ? std::min(quantum, j->remaining) : j->remaining;
        if (j->start < 0) j->start = t;
        r.gantt.push_back({j->name, t, t + slice});  // one segment per scheduling slice (not merged)
        t += slice;
        j->remaining -= slice;
        admit();  // arrivals during the slice enter the queue before a preempted job re-joins
        if (j->remaining > 0) ready.push_back(j);
        else { j->completion = t; done++; }
    }
    for (auto& j : jobs) {
        r.avg_tat += j.completion - j.arrival;
        r.avg_wait += j.completion - j.arrival - j.burst;
    }
    if (!jobs.empty()) { r.avg_tat /= jobs.size(); r.avg_wait /= jobs.size(); }
    r.jobs = std::move(jobs);
    return r;
}

}  // namespace kv
