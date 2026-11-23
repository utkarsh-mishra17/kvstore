// kvbench.cpp - multi-threaded benchmark client. Every client thread opens its own TCP connection;
// all connections are established first (barrier) so the server really sees N simultaneous clients.
// Prints one JSON object with latency / throughput results.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <random>
#include <thread>
#include "client_lib.hpp"

using Clock = std::chrono::steady_clock;

int main(int argc, char** argv) {
    std::string host = "127.0.0.1", op = "MIXED";
    int port = 7070, clients = 10, total = 1000, keyspace = 500, vsize = 32;
    double duration = 0;
    bool prio = false;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto nx = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
        if (a == "-h") host = nx();
        else if (a == "-p") port = atoi(nx().c_str());
        else if (a == "-c") clients = atoi(nx().c_str());
        else if (a == "-n") total = atoi(nx().c_str());
        else if (a == "-d") duration = atof(nx().c_str());
        else if (a == "-o") op = nx();
        else if (a == "--keys") keyspace = atoi(nx().c_str());
        else if (a == "--vsize") vsize = atoi(nx().c_str());
        else if (a == "--prio") prio = true;
        else { fprintf(stderr, "usage: kvbench [-h host] [-p port] [-c clients] [-n total_requests] [-d seconds] [-o SET|GET|DEL|MSET|LIST|MIXED|MIXLIST] [--keys N] [--vsize N] [--prio]\n"); return 2; }
    }
    for (auto& ch : op) ch = (char)toupper((unsigned char)ch);
    clients = std::max(1, clients);
    const int per_client = duration > 0 ? 1 << 30 : std::max(1, total / clients);

    std::atomic<int> connected{0}, failed_connect{0};
    std::atomic<uint64_t> ok{0}, bad{0};
    std::mutex mtx, start_m;
    std::condition_variable start_cv;
    bool go = false;
    std::vector<double> latencies;  // microseconds
    std::vector<std::thread> threads;
    Clock::time_point t_start, t_end;

    for (int c = 0; c < clients; c++) {
        threads.emplace_back([&, c] {
            Conn conn;
            bool up = conn.connect_to(host, port);
            if (up) { conn.request("HELLO bench-" + std::to_string(c)); connected++; } else failed_connect++;
            {
                std::unique_lock<std::mutex> lk(start_m);
                start_cv.wait(lk, [&] { return go; });
            }
            if (!up) return;
            std::mt19937 rng(12345 + (unsigned)c);
            std::vector<double> local;
            const std::string val(std::max(1, std::min(vsize, 256)), 'x');
            const auto stop_at = t_start + std::chrono::microseconds((long long)(duration * 1e6));
            for (int i = 0; i < per_client; i++) {
                if (duration > 0 && Clock::now() >= stop_at) break;
                std::string key = "bench:" + std::to_string(rng() % std::max(1, keyspace));
                std::string cmd, kind = op;
                if (op == "MIXED") { int r = (int)(rng() % 100); kind = r < 60 ? "GET" : r < 95 ? "SET" : "DEL"; }
                else if (op == "MIXLIST") { int r = (int)(rng() % 100); kind = r < 55 ? "GET" : r < 93 ? "SET" : r < 97 ? "GET" : "LIST"; }  // ~3% long scans
                if (kind == "SET") cmd = "SET " + key + " " + val;
                else if (kind == "GET") cmd = "GET " + key;
                else if (kind == "DEL") cmd = "DEL " + key;
                else if (kind == "LIST") cmd = "LIST";
                else if (kind == "MSET") cmd = "MSET " + key + " " + val + " bench:" + std::to_string(rng() % std::max(1, keyspace)) + " " + val;
                else { fprintf(stderr, "bad op %s\n", op.c_str()); return; }
                if (prio) cmd = "@prio=" + std::to_string(1 + (int)(rng() % 3)) + " " + cmd;
                auto a = Clock::now();
                Reply r = conn.request(cmd);
                auto b = Clock::now();
                if (r.ok()) ok++; else bad++;
                local.push_back(std::chrono::duration<double, std::micro>(b - a).count());
                if (!r.transport_ok) break;
            }
            std::lock_guard<std::mutex> lk(mtx);
            latencies.insert(latencies.end(), local.begin(), local.end());
        });
    }
    // wait until every client has attempted its connection, then release them together
    while (connected + failed_connect < clients) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    int connected_now = connected;
    t_start = Clock::now();
    { std::lock_guard<std::mutex> lk(start_m); go = true; }
    start_cv.notify_all();
    for (auto& t : threads) t.join();
    t_end = Clock::now();

    double secs = std::chrono::duration<double>(t_end - t_start).count();
    std::sort(latencies.begin(), latencies.end());
    auto pct = [&](double p) { return latencies.empty() ? 0.0 : latencies[std::min(latencies.size() - 1, (size_t)(p * latencies.size()))]; };
    double sum = 0;
    for (double l : latencies) sum += l;
    uint64_t n = ok + bad;
    printf("{\"operation\":\"%s\",\"clients\":%d,\"connected\":%d,\"connect_failures\":%d,\"total_requests\":%llu,\"successful\":%llu,\"failed\":%llu,"
           "\"duration_s\":%.4f,\"requests_per_sec\":%.2f,\"avg_latency_us\":%.1f,\"min_latency_us\":%.1f,\"max_latency_us\":%.1f,"
           "\"p50_us\":%.1f,\"p95_us\":%.1f,\"p99_us\":%.1f,\"error_rate\":%.6f}\n",
           op.c_str(), clients, connected_now, failed_connect.load(), (unsigned long long)n, (unsigned long long)ok.load(), (unsigned long long)bad.load(),
           secs, secs > 0 ? n / secs : 0.0, latencies.empty() ? 0.0 : sum / latencies.size(), latencies.empty() ? 0.0 : latencies.front(),
           latencies.empty() ? 0.0 : latencies.back(), pct(0.50), pct(0.95), pct(0.99), n ? (double)bad / n : 0.0);
    return 0;
}
