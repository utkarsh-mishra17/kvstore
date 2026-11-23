// kvcli.cpp - interactive command-line client.
//   ./kvcli [-h host] [-p port]            interactive prompt
//   ./kvcli [-h host] [-p port] -c "GET a"  run one command and exit
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include "client_lib.hpp"

int main(int argc, char** argv) {
    std::string host = "127.0.0.1", once;
    int port = 7070;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "-h" && i + 1 < argc) host = argv[++i];
        else if (a == "-p" && i + 1 < argc) port = atoi(argv[++i]);
        else if (a == "-c" && i + 1 < argc) once = argv[++i];
        else { fprintf(stderr, "usage: kvcli [-h host] [-p port] [-c command]\n"); return 2; }
    }
    Conn c;
    if (!c.connect_to(host, port)) { fprintf(stderr, "cannot connect to %s:%d\n", host.c_str(), port); return 1; }
    auto run = [&](const std::string& cmd) {
        Reply r = c.request(cmd);
        if (!r.transport_ok) { printf("connection closed\n"); return false; }
        for (auto& l : r.lines) printf("%s\n", l.c_str());
        if (!r.meta.empty()) {
            printf("  [");
            bool first = true;
            for (auto& kvp : r.meta) { printf("%s%s=%s", first ? "" : " ", kvp.first.c_str(), kvp.second.c_str()); first = false; }
            printf("]\n");
        }
        return true;
    };
    if (!once.empty()) return run(once) ? 0 : 1;
    printf("Connected to %s:%d. Type HELP for commands, QUIT to exit.\n", host.c_str(), port);
    std::string line;
    for (;;) {
        printf("kv> ");
        fflush(stdout);
        if (!std::getline(std::cin, line)) break;
        if (line.empty()) continue;
        if (!run(line)) break;
        if (line == "QUIT" || line == "quit" || line == "exit") break;
    }
    return 0;
}
