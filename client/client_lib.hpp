// client_lib.hpp - tiny TCP client for the KVStore text protocol (shared by kvcli and kvbench).
#pragma once
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>
#include <map>
#include <string>
#include <vector>

struct Reply {
    bool transport_ok = false;
    std::vector<std::string> lines;
    std::map<std::string, std::string> meta;  // key=value pairs from the trailing "END ..." line
    bool ok() const { return transport_ok && !lines.empty() && lines[0].rfind("ERR", 0) != 0; }
};

class Conn {
public:
    ~Conn() { close_conn(); }
    bool connect_to(const std::string& host, int port) {
        addrinfo hints{}, *res = nullptr;
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_STREAM;
        if (getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &res) != 0) return false;
        fd_ = socket(res->ai_family, res->ai_socktype, 0);
        if (fd_ < 0 || ::connect(fd_, res->ai_addr, res->ai_addrlen) != 0) { freeaddrinfo(res); close_conn(); return false; }
        freeaddrinfo(res);
        int one = 1;
        setsockopt(fd_, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
        return true;
    }
    void close_conn() { if (fd_ >= 0) { ::close(fd_); fd_ = -1; } }
    bool connected() const { return fd_ >= 0; }

    // Send one command line and read the response up to (and including) the "END" terminator.
    Reply request(const std::string& cmd) {
        Reply r;
        std::string line = cmd + "\n";
        size_t off = 0;
        while (off < line.size()) {
            ssize_t n = send(fd_, line.data() + off, line.size() - off, 0);
            if (n <= 0) return r;
            off += (size_t)n;
        }
        for (;;) {
            std::string l;
            if (!read_line(l)) return r;
            if (l == "END" || l.rfind("END ", 0) == 0) {
                size_t p = 3;
                while (p < l.size()) {
                    while (p < l.size() && l[p] == ' ') p++;
                    size_t e = l.find(' ', p);
                    std::string tok = l.substr(p, e == std::string::npos ? std::string::npos : e - p);
                    size_t eq = tok.find('=');
                    if (eq != std::string::npos) r.meta[tok.substr(0, eq)] = tok.substr(eq + 1);
                    if (e == std::string::npos) break;
                    p = e + 1;
                }
                r.transport_ok = true;
                return r;
            }
            r.lines.push_back(l);
        }
    }

private:
    bool read_line(std::string& out) {
        for (;;) {
            size_t pos = buf_.find('\n');
            if (pos != std::string::npos) { out = buf_.substr(0, pos); buf_.erase(0, pos + 1); return true; }
            char tmp[8192];
            ssize_t n = recv(fd_, tmp, sizeof tmp, 0);
            if (n <= 0) return false;
            buf_.append(tmp, (size_t)n);
        }
    }
    int fd_ = -1;
    std::string buf_;
};
