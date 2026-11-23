// server.hpp - KVStore server: Network & Client Handler + Worker pool + command layer + statistics.
#pragma once
#include "buffer_pool.hpp"
#include "cpu_scheduler.hpp"
#include "disk_scheduler.hpp"
#include "event_log.hpp"
#include "request_queue.hpp"
#include "storage.hpp"
#include "sync.hpp"

namespace kv {

struct Config {
    int port = 7070;
    int workers = 4;
    int queue_cap = 64;
    int frames = 8;
    std::string data_file = "data/data.db";
    std::string log_file = "data/kvstore.log";
    CpuPolicy cpu = CpuPolicy::FCFS;
    DiskAlg disk = DiskAlg::FCFS;
    RepPolicy cache = RepPolicy::LRU;
};

class Server {
public:
    explicit Server(Config cfg) : cfg_(std::move(cfg)) {}
    bool start();
    void shutdown();
    bool shutdown_requested() const { return shutdown_requested_; }

private:
    struct Client {
        int id = 0, fd = -1;
        std::string name, addr;
        bool monitor = false, counted = false;
        uint64_t connected_us = 0;
        std::atomic<uint64_t> requests{0};
    };
    struct PolStat { uint64_t n = 0; double wait = 0, tat = 0, service = 0; };
    struct ReqRecord {
        uint64_t seq, id, arrival, start, completion, wait, service, tat, response, dispatch_seq;
        int client, prio, cost, slices, worker, hits, misses;
        bool ok;
        std::string op, key, policy, locks;
    };
    struct Slice { uint64_t seq, req; int worker; uint64_t start, end; bool final_slice; std::string op; };

    // network
    void accept_loop();
    void client_loop(std::shared_ptr<Client> c);
    void register_client(Client& c, const std::shared_ptr<Client>& sp);
    std::string handle_line(Client& c, std::string line, bool& quit);
    std::string enqueue_and_wait(Client& c, const RequestPtr& r);
    std::string control(Client& c, const std::string& cmd, const std::string& rest, bool& quit);
    // workers
    void worker_loop(int wid);
    void run_slice(const RequestPtr& r, int wid);
    void exec_point(Request& r);
    void exec_mset(Request& r);
    bool exec_list_slice(Request& r, int quantum_units);
    void finish(const RequestPtr& r, int wid);
    // reporting
    std::string stats_json(std::vector<std::string>* text = nullptr);
    std::string snapshot_json();
    std::string reqs_json(uint64_t since);
    std::string gantt_json(uint64_t since);
    std::string sim_sched(const std::vector<std::string>& t);
    std::string sim_disk(const std::vector<std::string>& t);
    std::string sim_pages(const std::vector<std::string>& t);
    void reset_stats();

    Config cfg_;
    EventLog log_;
    StorageEngine storage_;
    BlockLocks locks_;
    std::unique_ptr<DiskScheduler> disk_;
    std::unique_ptr<BufferPool> pool_;
    std::unique_ptr<RequestQueue> queue_;
    std::vector<std::thread> workers_;
    std::thread acceptor_;
    int listen_fd_ = -1;
    std::atomic<bool> shutdown_requested_{false}, stopping_{false};
    uint64_t start_us_ = 0;

    // runtime knobs
    std::atomic<int> delay_us_{0}, quantum_{16}, lock_hold_us_{0}, lock_timeout_ms_{800};
    std::atomic<bool> lock_ordered_{true};

    // clients
    std::mutex cl_m_;
    std::unordered_map<int, std::shared_ptr<Client>> clients_;
    std::atomic<int> active_{0}, peak_{0};
    std::atomic<uint64_t> total_conn_{0}, rejected_{0}, next_client_{0}, next_req_{0};
    std::atomic<int> inflight_{0};

    // request statistics
    std::atomic<uint64_t> total_requests_{0}, completed_{0}, errors_{0};
    std::atomic<uint64_t> op_count_[5]{};
    std::mutex stat_m_;
    PolStat pol_[4];
    double tot_wait_ = 0, tot_tat_ = 0, tot_service_ = 0, tot_resp_ = 0;
    uint64_t rec_seq_ = 0, gantt_seq_ = 0;
    std::deque<ReqRecord> req_log_;
    std::deque<Slice> gantt_;
    std::atomic<uint64_t> worker_cur_[64]{};
};

}  // namespace kv
