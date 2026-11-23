// request.hpp - the unit of work that flows through queue -> scheduler -> worker.
#pragma once
#include "common.hpp"
#include "cpu_scheduler.hpp"

namespace kv {

enum class Op { SET = 0, GET = 1, DEL = 2, LIST = 3, MSET = 4 };
inline const char* op_name(Op o) {
    static const char* n[] = {"SET", "GET", "DEL", "LIST", "MSET"};
    return n[(int)o];
}

struct Request : SchedItem {
    uint64_t id = 0;
    int client_id = 0;
    Op op = Op::GET;
    std::string key, value;
    std::vector<std::pair<std::string, std::string>> pairs;  // MSET
    int cost = 1;                 // estimated service cost in units (SJF key, RR slice accounting)
    int list_cursor = 0;          // LIST progress between RR slices
    std::vector<std::string> list_out;
    bool slot_released = false;   // has this request already given its bounded-queue slot back?

    uint64_t arrival_us = 0, first_start_us = 0, completion_us = 0, service_us = 0;
    uint64_t dispatch_seq = 0;
    int slices = 0, worker = -1, hits = 0, misses = 0;
    bool started = false, ok = true;
    std::vector<int> lock_blocks;
    CpuPolicy policy_at_dispatch = CpuPolicy::FCFS;

    // result, handed back to the client thread
    std::vector<std::string> response_lines;
    std::string footer;
    std::mutex m;
    std::condition_variable cv;
    bool done = false;
};
using RequestPtr = std::shared_ptr<Request>;

}  // namespace kv
