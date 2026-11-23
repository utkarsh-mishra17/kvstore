// main.cpp - entry point: parse flags, start the server, wait for SIGINT/SIGTERM or the SHUTDOWN command.
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <unistd.h>
#include "server.hpp"

static volatile sig_atomic_t g_signal = 0;
static void on_signal(int) { g_signal = 1; }

int main(int argc, char** argv) {
    kv::Config cfg;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto val = [&]() -> std::string { return (i + 1 < argc) ? argv[++i] : ""; };
        if (a == "--port") cfg.port = atoi(val().c_str());
        else if (a == "--workers") cfg.workers = std::max(1, std::min(64, atoi(val().c_str())));
        else if (a == "--queue") cfg.queue_cap = std::max(1, atoi(val().c_str()));
        else if (a == "--frames") cfg.frames = std::max(2, std::min(128, atoi(val().c_str())));
        else if (a == "--data") cfg.data_file = val();
        else if (a == "--log") cfg.log_file = val();
        else if (a == "--cpu") { if (!kv::parse_cpu(val(), cfg.cpu)) { fprintf(stderr, "bad --cpu\n"); return 2; } }
        else if (a == "--disk") { if (!kv::parse_disk(val(), cfg.disk)) { fprintf(stderr, "bad --disk\n"); return 2; } }
        else if (a == "--cache") { if (!kv::parse_rep(val(), cfg.cache)) { fprintf(stderr, "bad --cache\n"); return 2; } }
        else {
            printf("KVStore server\n  --port N (7070)  --workers N (4)  --queue N (64)  --frames N (8)\n"
                   "  --data FILE (data/data.db)  --log FILE (data/kvstore.log)\n"
                   "  --cpu fcfs|sjf|priority|rr  --disk fcfs|sstf|scan|cscan|look|clook  --cache fifo|lru|clock\n");
            return a == "--help" || a == "-h" ? 0 : 2;
        }
    }
    signal(SIGPIPE, SIG_IGN);
    struct sigaction sa{};
    sa.sa_handler = on_signal;
    sigaction(SIGINT, &sa, nullptr);
    sigaction(SIGTERM, &sa, nullptr);

    kv::Server server(cfg);
    if (!server.start()) return 1;
    printf("KVStore listening on port %d (workers=%d queue=%d frames=%d)\n", cfg.port, cfg.workers, cfg.queue_cap, cfg.frames);
    fflush(stdout);
    while (!g_signal && !server.shutdown_requested()) usleep(50 * 1000);
    server.shutdown();
    printf("KVStore stopped cleanly (dirty pages flushed to %s)\n", cfg.data_file.c_str());
    fflush(stdout);
    _exit(0);
}
