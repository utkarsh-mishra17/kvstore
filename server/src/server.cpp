// server.cpp - network handler, worker pool, operation execution, control commands, statistics.
#include "server.hpp"
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>
#include <filesystem>

namespace kv {

// ------------------------------------------------------------------ helpers
static bool send_all(int fd, const std::string& s) {
    size_t off = 0;
    while (off < s.size()) {
        ssize_t n = send(fd, s.data() + off, s.size() - off, 0);
        if (n <= 0) { if (n < 0 && errno == EINTR) continue; return false; }
        off += (size_t)n;
    }
    return true;
}
// Every response is N lines followed by a terminator line "END [key=value ...]" (execution metadata).
static std::string reply(const std::vector<std::string>& lines, const std::string& footer = "") {
    std::string o;
    for (auto& l : lines) { o += l; o += '\n'; }
    o += footer.empty() ? "END\n" : "END " + footer + "\n";
    return o;
}
static std::string reply1(const std::string& l) { return reply({l}); }
static std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n"), b = s.find_last_not_of(" \t\r\n");
    return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}
static bool valid_key(const std::string& k) {
    if (k.empty() || k.size() > (size_t)MAX_KEY_LEN) return false;
    for (unsigned char c : k) if (c <= 32 || c == 127) return false;
    return true;
}
static bool valid_value(const std::string& v) {
    if (v.size() > (size_t)MAX_VALUE_LEN) return false;
    for (unsigned char c : v) if (c < 32 || c == 127) return false;
    return true;
}
static bool to_int(const std::string& s, long lo, long hi, long& out) {
    if (s.empty()) return false;
    char* e = nullptr;
    long v = strtol(s.c_str(), &e, 10);
    if (*e || v < lo || v > hi) return false;
    out = v;
    return true;
}

// Collects metrics once, renders them either as nested JSON (dashboard) or text (STATS command).
class StatsOut {
public:
    void num(const std::string& sec, const std::string& k, double v) { items_.push_back({sec, k, jnum(v), false}); }
    void str(const std::string& sec, const std::string& k, const std::string& v) { items_.push_back({sec, k, jstr(v), true}); }
    void raw(const std::string& sec, const std::string& k, const std::string& json) { items_.push_back({sec, k, json, false}); }
    std::string json() const {
        std::string o = "{";
        std::vector<std::string> secs;
        for (auto& i : items_) if (std::find(secs.begin(), secs.end(), i.sec) == secs.end()) secs.push_back(i.sec);
        for (size_t s = 0; s < secs.size(); s++) {
            if (s) o += ",";
            o += jstr(secs[s]) + ":{";
            bool first = true;
            for (auto& i : items_) if (i.sec == secs[s]) { if (!first) o += ","; first = false; o += jstr(i.key) + ":" + i.val; }
            o += "}";
        }
        return o + "}";
    }
    std::vector<std::string> text() const {
        std::vector<std::string> out;
        std::string cur, line;
        for (auto& i : items_) {
            if (i.sec != cur) { if (!line.empty()) out.push_back(line); cur = i.sec; line = "[" + cur + "]"; }
            if (i.val.size() > 80 && (i.val[0] == '[' || i.val[0] == '{')) continue;  // skip bulky structures in text mode
            std::string v = i.val;
            if (i.str && v.size() >= 2) v = v.substr(1, v.size() - 2);
            line += " " + i.key + "=" + v;
        }
        if (!line.empty()) out.push_back(line);
        return out;
    }
private:
    struct Item { std::string sec, key, val; bool str; };
    std::vector<Item> items_;
};

// ------------------------------------------------------------------ startup / shutdown
bool Server::start() {
    start_us_ = mono_us();
    try {
        auto parent = std::filesystem::path(cfg_.data_file).parent_path();
        if (!parent.empty()) std::filesystem::create_directories(parent);
        auto lp = std::filesystem::path(cfg_.log_file).parent_path();
        if (!lp.empty()) std::filesystem::create_directories(lp);
    } catch (...) {}
    log_.open(cfg_.log_file);
    if (!storage_.open_file(cfg_.data_file)) { fprintf(stderr, "cannot open data file %s\n", cfg_.data_file.c_str()); return false; }
    disk_ = std::make_unique<DiskScheduler>(storage_, log_, cfg_.disk);
    pool_ = std::make_unique<BufferPool>(*disk_, log_, (size_t)cfg_.frames, cfg_.cache);
    queue_ = std::make_unique<RequestQueue>((size_t)cfg_.queue_cap);
    queue_->set_policy(cfg_.cpu);

    listen_fd_ = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t)cfg_.port);
    if (bind(listen_fd_, (sockaddr*)&addr, sizeof addr) != 0 || listen(listen_fd_, 1024) != 0) {
        perror("bind/listen");
        return false;
    }
    for (int i = 0; i < cfg_.workers; i++) workers_.emplace_back([this, i] { worker_loop(i); });
    acceptor_ = std::thread([this] { accept_loop(); });
    acceptor_.detach();
    log_.log("SERVER", cat("STARTUP port=", cfg_.port, " workers=", cfg_.workers, " queue=", cfg_.queue_cap, " frames=", cfg_.frames,
                           " cpu=", cpu_name(cfg_.cpu), " disk=", disk_name(cfg_.disk), " cache=", rep_name(cfg_.cache), " data=", cfg_.data_file));
    return true;
}

void Server::shutdown() {
    log_.log("SERVER", "SHUTDOWN requested: draining in-flight requests");
    stopping_ = true;
    if (listen_fd_ >= 0) { ::shutdown(listen_fd_, SHUT_RDWR); close(listen_fd_); listen_fd_ = -1; }
    queue_->set_paused(false);
    for (int i = 0; i < 500 && inflight_ > 0; i++) sleep_us(10000);  // wait up to 5 s
    queue_->stop(cfg_.workers);
    for (auto& t : workers_) t.join();
    int flushed = pool_->flush_all();
    log_.log("SERVER", cat("SHUTDOWN complete: flushed ", flushed, " dirty block(s) to ", cfg_.data_file));
}

// ------------------------------------------------------------------ network handler
void Server::accept_loop() {
    for (;;) {
        int fd = listen_fd_;
        if (fd < 0 || stopping_) return;
        sockaddr_in ca{};
        socklen_t len = sizeof ca;
        int cfd = accept(fd, (sockaddr*)&ca, &len);
        if (cfd < 0) { if (stopping_ || errno == EBADF || errno == EINVAL) return; continue; }
        int one = 1;
        setsockopt(cfd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
        if (active_ >= 4000) {
            rejected_++;
            send_all(cfd, "ERR server busy\nEND\n");
            close(cfd);
            continue;
        }
        auto c = std::make_shared<Client>();
        c->id = (int)++next_client_;
        c->fd = cfd;
        char ip[64];
        inet_ntop(AF_INET, &ca.sin_addr, ip, sizeof ip);
        c->addr = cat(ip, ":", ntohs(ca.sin_port));
        c->name = "client-" + std::to_string(c->id);
        c->connected_us = mono_us();
        std::thread([this, c] { client_loop(c); }).detach();
    }
}

// A connection counts as a client (statistics, logs, client list) from its first command, except for
// dashboard "monitor" connections, which are infrastructure and never counted.
void Server::register_client(Client& c, const std::shared_ptr<Client>& sp) {
    if (c.counted) return;
    c.counted = true;
    {
        std::lock_guard<std::mutex> lk(cl_m_);
        clients_[c.id] = sp;
    }
    int now_active = ++active_;
    total_conn_++;
    int pk = peak_.load();
    while (now_active > pk && !peak_.compare_exchange_weak(pk, now_active)) {}
    log_.log("CLIENT", cat("CONNECTED id=", c.id, " addr=", c.addr, " active=", now_active));
}

void Server::client_loop(std::shared_ptr<Client> c) {
    std::string buf;
    char tmp[4096];
    bool quit = false;
    while (!quit) {
        ssize_t n = recv(c->fd, tmp, sizeof tmp, 0);
        if (n <= 0) break;
        buf.append(tmp, (size_t)n);
        if (buf.size() > 16384 && buf.find('\n') == std::string::npos) { send_all(c->fd, reply1("ERR line too long")); break; }
        size_t pos;
        while (!quit && (pos = buf.find('\n')) != std::string::npos) {
            std::string line = buf.substr(0, pos);
            buf.erase(0, pos + 1);
            std::string t = trim(line);
            if (!c->counted && !c->monitor && !t.empty() && lower(t) != "hello monitor") register_client(*c, c);
            std::string resp = handle_line(*c, line, quit);
            if (!resp.empty() && !send_all(c->fd, resp)) quit = true;
        }
    }
    close(c->fd);
    if (c->counted) {
        {
            std::lock_guard<std::mutex> lk(cl_m_);
            clients_.erase(c->id);
        }
        int left = --active_;
        log_.log("CLIENT", cat("DISCONNECTED id=", c->id, " addr=", c->addr, " requests=", c->requests.load(), " active=", left));
    }
}

// Parses one protocol line. Data commands become Requests for the scheduler; control commands are answered inline.
std::string Server::handle_line(Client& c, std::string line, bool& quit) {
    line = trim(line);
    if (line.empty()) return "";
    int prio = 1;
    if (line[0] == '@') {  // optional prefix "@prio=N" (1 = normal, 2 = high, 3 = admin)
        size_t sp = line.find_first_of(" \t");
        std::string opt = line.substr(1, sp == std::string::npos ? std::string::npos : sp - 1);
        line = sp == std::string::npos ? "" : trim(line.substr(sp));
        long p;
        if (opt.rfind("prio=", 0) != 0 || !to_int(opt.substr(5), 1, 9, p)) return reply1("ERR bad prefix (use @prio=1..9)");
        prio = (int)p;
    }
    size_t sp = line.find_first_of(" \t");
    std::string cmd = upper(line.substr(0, sp));
    std::string rest = sp == std::string::npos ? "" : trim(line.substr(sp));

    if (cmd != "SET" && cmd != "GET" && cmd != "DEL" && cmd != "LIST" && cmd != "MSET") return control(c, cmd, rest, quit);
    if (stopping_) return reply1("ERR server shutting down");

    auto r = std::make_shared<Request>();
    r->priority = prio;
    r->client_id = c.id;
    if (cmd == "SET") {
        r->op = Op::SET;
        size_t s2 = rest.find_first_of(" \t");
        r->key = rest.substr(0, s2);
        r->value = s2 == std::string::npos ? "" : trim(rest.substr(s2));
        if (!valid_key(r->key) || s2 == std::string::npos || r->value.empty()) return reply1("ERR usage: SET <key> <value>");
        if (!valid_value(r->value)) return reply1("ERR value too long (max 256) or contains control characters");
        r->cost = 1;
    } else if (cmd == "GET" || cmd == "DEL") {
        r->op = cmd == "GET" ? Op::GET : Op::DEL;
        r->key = rest;
        if (!valid_key(r->key)) return reply1("ERR usage: " + cmd + " <key>");
        r->cost = 1;
    } else if (cmd == "LIST") {
        r->op = Op::LIST;
        r->cost = NUM_BLOCKS;  // a full scan touches every block
    } else {  // MSET k1 v1 k2 v2 ...
        r->op = Op::MSET;
        auto t = split_ws(rest);
        if (t.size() < 2 || t.size() % 2) return reply1("ERR usage: MSET <k1> <v1> [<k2> <v2> ...]");
        if (t.size() / 2 > (size_t)MAX_MSET_PAIRS) return reply1("ERR too many pairs (max 32)");
        for (size_t i = 0; i < t.size(); i += 2) {
            if (!valid_key(t[i]) || t[i + 1].size() > (size_t)MAX_VALUE_LEN) return reply1("ERR invalid key or value in MSET");
            r->pairs.emplace_back(t[i], t[i + 1]);
        }
        r->cost = (int)r->pairs.size();
    }
    r->remaining = r->cost;
    return enqueue_and_wait(c, r);
}

std::string Server::enqueue_and_wait(Client& c, const RequestPtr& r) {
    r->id = ++next_req_;
    total_requests_++;
    op_count_[(int)r->op]++;
    inflight_++;
    r->arrival_us = mono_us();
    log_.log("REQUEST", cat("RECV req=", r->id, " client=", c.id, " ", op_name(r->op), r->key.empty() ? "" : " key=" + r->key, " prio=", r->priority, " cost=", r->cost));
    queue_->push(r);
    log_.log("QUEUE", cat("ENQUEUED req=", r->id, " depth=", queue_->depth(), "/", queue_->capacity()));
    {
        std::unique_lock<std::mutex> lk(r->m);
        r->cv.wait(lk, [&] { return r->done; });
    }
    c.requests++;
    return reply(r->response_lines, r->footer);
}

// ------------------------------------------------------------------ workers
void Server::worker_loop(int wid) {
    for (;;) {
        size_t depth = 0;
        RequestPtr r = queue_->pop(depth);
        if (!r) return;
        worker_cur_[wid] = r->id;
        log_.log("SCHED", cat("DISPATCH req=", r->id, " ", op_name(r->op), " policy=", cpu_name(r->policy_at_dispatch), " prio=", r->priority,
                              " remaining=", r->remaining, " picked_from_queue_of=", depth, " worker=", wid, " seq=", r->dispatch_seq));
        run_slice(r, wid);
        worker_cur_[wid] = 0;
    }
}

void Server::run_slice(const RequestPtr& r, int wid) {
    Request& q = *r;
    const uint64_t t0 = mono_us();
    if (!q.started) { q.started = true; q.first_start_us = t0; q.worker = wid; }
    bool finished = true;
    switch (q.op) {
        case Op::GET: case Op::SET: case Op::DEL: exec_point(q); break;
        case Op::MSET: exec_mset(q); break;
        case Op::LIST: {
            // Only Round Robin time-slices: a long scan is cut into quantum-sized pieces and re-queued.
            int units = queue_->policy() == CpuPolicy::RR ? std::max(1, quantum_.load()) : NUM_BLOCKS;
            finished = exec_list_slice(q, units);
            break;
        }
    }
    const uint64_t t1 = mono_us();
    q.service_us += t1 - t0;
    q.slices++;
    {
        std::lock_guard<std::mutex> lk(stat_m_);
        gantt_.push_back({++gantt_seq_, q.id, wid, t0, t1, finished, op_name(q.op)});
        if (gantt_.size() > 800) gantt_.pop_front();
    }
    if (!finished) {
        log_.log("SCHED", cat("PREEMPT req=", q.id, " after slice ", q.slices, " (", q.remaining, " units left) -> back of queue"));
        queue_->requeue(r);  // r may be picked up by another worker immediately: do not touch it afterwards
        return;
    }
    finish(r, wid);
}

void Server::exec_point(Request& r) {
    const int b = block_of(r.key);
    const bool write = r.op != Op::GET;
    if (write) locks_.write_lock(b); else locks_.read_lock(b);
    r.lock_blocks.push_back(b);
    log_.log("LOCK", cat("ACQUIRE req=", r.id, " ", write ? "WRITE" : "READ", " block=", b, " readers=", locks_.total_readers(), " writers=", locks_.total_writers()));
    bool hit = false;
    Frame* f = pool_->pin(b, hit);
    (hit ? r.hits : r.misses)++;
    Records recs = blockfmt::parse(f->data);
    auto it = blockfmt::find(recs, r.key);
    bool dirtied = false;
    switch (r.op) {
        case Op::GET:
            r.response_lines = {it == recs.end() ? "NOT_FOUND" : "VALUE " + it->second};
            break;
        case Op::SET:
            if (it != recs.end()) it->second = r.value; else recs.emplace_back(r.key, r.value);
            if (blockfmt::serialize(recs, f->data)) { dirtied = true; r.response_lines = {"OK"}; }
            else { r.ok = false; r.response_lines = {"ERR block " + std::to_string(b) + " is full (hash collision overflow)"}; }
            break;
        case Op::DEL:
            if (it == recs.end()) r.response_lines = {"NOT_FOUND"};
            else { recs.erase(it); blockfmt::serialize(recs, f->data); dirtied = true; r.response_lines = {"DELETED"}; }
            break;
        default: break;
    }
    pool_->unpin(f, dirtied);
    sleep_us((uint64_t)delay_us_.load());  // optional synthetic service time (demo knob), lock held
    if (write) locks_.write_unlock(b); else locks_.read_unlock(b);
    log_.log("LOCK", cat("RELEASE req=", r.id, " ", write ? "WRITE" : "READ", " block=", b));
    r.remaining = 0;
}

// Multi-key write. Deadlock prevention: acquire the distinct block locks in ASCENDING block order, so no two
// requests can ever wait on each other in a cycle (breaks the circular-wait condition).
void Server::exec_mset(Request& r) {
    std::vector<int> blocks;
    for (auto& p : r.pairs) {
        int b = block_of(p.first);
        if (std::find(blocks.begin(), blocks.end(), b) == blocks.end()) blocks.push_back(b);
    }
    const bool ordered = lock_ordered_.load();
    if (ordered) std::sort(blocks.begin(), blocks.end());
    std::string order;
    for (int b : blocks) order += (order.empty() ? "" : ",") + std::to_string(b);
    log_.log("LOCK", cat("PLAN req=", r.id, " MSET lock order=[", order, "] ", ordered ? "(ascending: deadlock-free)" : "(command order: UNSAFE mode)"));

    std::vector<int> held;
    auto release_all = [&]() {
        for (auto it = held.rbegin(); it != held.rend(); ++it) {
            locks_.write_unlock(*it);
            log_.log("LOCK", cat("RELEASE req=", r.id, " WRITE block=", *it));
        }
        held.clear();
    };
    for (int b : blocks) {
        if (!locks_.write_lock(b, ordered ? -1 : lock_timeout_ms_.load())) {
            log_.log("ERROR", cat("DEADLOCK DETECTED req=", r.id, " timed out waiting for block ", b, " while holding ", held.size(), " lock(s): circular wait"));
            release_all();
            r.ok = false;
            r.response_lines = {"ERR deadlock detected (circular wait on block " + std::to_string(b) + "); request aborted"};
            r.remaining = 0;
            return;
        }
        held.push_back(b);
        r.lock_blocks.push_back(b);
        log_.log("LOCK", cat("ACQUIRE req=", r.id, " WRITE block=", b, " (", held.size(), "/", blocks.size(), ")"));
        sleep_us((uint64_t)lock_hold_us_.load());  // demo knob: widens the window in which a deadlock could form
    }
    int applied = 0;
    std::string err;
    for (int b : blocks) {
        bool hit = false;
        Frame* f = pool_->pin(b, hit);
        (hit ? r.hits : r.misses)++;
        Records recs = blockfmt::parse(f->data);
        bool changed = false;
        for (auto& p : r.pairs) {
            if (block_of(p.first) != b) continue;
            auto it = blockfmt::find(recs, p.first);
            Records trial = recs;
            if (it != recs.end()) it->second = p.second; else recs.emplace_back(p.first, p.second);
            if (blockfmt::serialize(recs, f->data)) { changed = true; applied++; }
            else { recs = trial; err = "block " + std::to_string(b) + " full at key " + p.first; }
        }
        pool_->unpin(f, changed);
    }
    sleep_us((uint64_t)delay_us_.load() * r.pairs.size());
    release_all();
    if (!err.empty()) { r.ok = false; r.response_lines = {"ERR " + err + " (" + std::to_string(applied) + " of " + std::to_string(r.pairs.size()) + " applied)"}; }
    else r.response_lines = {"OK " + std::to_string(applied)};
    r.remaining = 0;
}

// Scan `units` blocks starting at the saved cursor. Returns true when the whole scan is complete.
bool Server::exec_list_slice(Request& r, int units) {
    const int from = r.list_cursor, to = std::min(NUM_BLOCKS, from + units);
    int h = 0, m = 0;
    for (int b = from; b < to; b++) {
        locks_.read_lock(b);
        bool hit = false;
        Frame* f = pool_->pin(b, hit, true);
        (hit ? h : m)++;
        for (auto& kvp : blockfmt::parse(f->data)) r.list_out.push_back(kvp.first + " " + kvp.second);
        pool_->unpin(f, false);
        sleep_us((uint64_t)delay_us_.load());
        locks_.read_unlock(b);
    }
    r.hits += h; r.misses += m;
    r.list_cursor = to;
    r.remaining = NUM_BLOCKS - to;
    log_.log("WORKER", cat("LIST req=", r.id, " scanned blocks ", from, "..", to - 1, " hits=", h, " misses=", m));
    if (to < NUM_BLOCKS) return false;
    std::sort(r.list_out.begin(), r.list_out.end());
    r.response_lines.push_back("KEYS " + std::to_string(r.list_out.size()));
    for (auto& l : r.list_out) r.response_lines.push_back(l);
    return true;
}

void Server::finish(const RequestPtr& r, int wid) {
    Request& q = *r;
    q.completion_us = mono_us();
    const uint64_t tat = q.completion_us - q.arrival_us;
    const uint64_t wait = tat > q.service_us ? tat - q.service_us : 0;  // total time spent ready-but-not-running
    const uint64_t resp = q.first_start_us - q.arrival_us;
    std::string locks;
    for (int b : q.lock_blocks) locks += (locks.empty() ? "" : ",") + std::to_string(b);
    if (locks.empty()) locks = "-";
    q.footer = cat("id=", q.id, " op=", op_name(q.op), " prio=", q.priority, " cost=", q.cost, " policy=", cpu_name(q.policy_at_dispatch),
                   " worker=", wid, " dispatch=", q.dispatch_seq, " wait_us=", wait, " service_us=", q.service_us, " turnaround_us=", tat,
                   " response_us=", resp, " slices=", q.slices, " hits=", q.hits, " misses=", q.misses, " locks=", locks);
    {
        std::lock_guard<std::mutex> lk(stat_m_);
        PolStat& ps = pol_[(int)q.policy_at_dispatch];
        ps.n++; ps.wait += (double)wait; ps.tat += (double)tat; ps.service += (double)q.service_us;
        tot_wait_ += (double)wait; tot_tat_ += (double)tat; tot_service_ += (double)q.service_us; tot_resp_ += (double)resp;
        req_log_.push_back({++rec_seq_, q.id, q.arrival_us, q.first_start_us, q.completion_us, wait, q.service_us, tat, resp, q.dispatch_seq,
                            q.client_id, q.priority, q.cost, q.slices, wid, q.hits, q.misses, q.ok, op_name(q.op), q.key,
                            cpu_name(q.policy_at_dispatch), locks});
        if (req_log_.size() > 1500) req_log_.pop_front();
    }
    completed_++;
    if (!q.ok) { errors_++; log_.log("ERROR", cat("req=", q.id, " failed: ", q.response_lines.empty() ? "" : q.response_lines[0])); }
    log_.log("WORKER", cat("DONE req=", q.id, " ", op_name(q.op), " worker=", wid, " wait=", wait, "us service=", q.service_us, "us turnaround=", tat, "us hits=", q.hits, " misses=", q.misses));
    inflight_--;
    std::lock_guard<std::mutex> lk(q.m);
    q.done = true;
    q.cv.notify_all();
}

// ------------------------------------------------------------------ reporting
std::string Server::stats_json(std::vector<std::string>* text) {
    StatsOut s;
    const uint64_t now = mono_us();
    auto ds = disk_->status();
    auto ps = pool_->stats();
    s.num("server", "uptime_s", (double)(now - start_us_) / 1e6);
    s.num("server", "now_us", (double)now);
    s.num("server", "port", cfg_.port);
    s.num("server", "num_blocks", NUM_BLOCKS);
    s.num("server", "block_size", BLOCK_SIZE);
    s.str("server", "data_file", cfg_.data_file);
    s.num("clients", "active", active_);
    s.num("clients", "peak", peak_);
    s.num("clients", "total_connections", (double)total_conn_);
    s.num("clients", "rejected", (double)rejected_);
    uint64_t ops[5];
    for (int i = 0; i < 5; i++) ops[i] = op_count_[i];
    s.num("requests", "total", (double)total_requests_);
    s.num("requests", "completed", (double)completed_);
    s.num("requests", "errors", (double)errors_);
    s.raw("requests", "by_op", cat("{\"SET\":", ops[0], ",\"GET\":", ops[1], ",\"DEL\":", ops[2], ",\"LIST\":", ops[3], ",\"MSET\":", ops[4], "}"));
    int busy = 0;
    for (int i = 0; i < cfg_.workers; i++) if (worker_cur_[i]) busy++;
    s.num("workers", "count", cfg_.workers);
    s.num("workers", "busy", busy);
    s.num("queue", "capacity", (double)queue_->capacity());
    s.num("queue", "size", (double)queue_->depth());
    s.num("queue", "max_depth", (double)queue_->max_depth());
    s.num("queue", "produced", (double)queue_->produced());
    s.num("queue", "consumed", (double)queue_->consumed());
    s.num("queue", "requeued", (double)queue_->requeued());
    s.num("queue", "blocked_producers", queue_->blocked_producers());
    s.raw("queue", "paused", queue_->paused() ? "true" : "false");
    {
        std::lock_guard<std::mutex> lk(stat_m_);
        double n = (double)std::max<uint64_t>(1, pol_[0].n + pol_[1].n + pol_[2].n + pol_[3].n);
        s.str("cpu", "policy", cpu_name(queue_->policy()));
        s.num("cpu", "quantum", quantum_);
        s.num("cpu", "service_delay_us", delay_us_);
        s.num("cpu", "dispatched", (double)queue_->consumed());
        s.num("cpu", "preemptions", (double)queue_->requeued());
        s.num("cpu", "avg_wait_us", tot_wait_ / n);
        s.num("cpu", "avg_turnaround_us", tot_tat_ / n);
        s.num("cpu", "avg_service_us", tot_service_ / n);
        s.num("cpu", "avg_response_us", tot_resp_ / n);
        std::string pp = "{";
        for (int i = 0; i < 4; i++) {
            double c = (double)std::max<uint64_t>(1, pol_[i].n);
            if (i) pp += ",";
            pp += cat(jstr(cpu_name((CpuPolicy)i)), ":{\"n\":", pol_[i].n, ",\"avg_wait_us\":", jnum(pol_[i].wait / c), ",\"avg_turnaround_us\":", jnum(pol_[i].tat / c), "}");
        }
        s.raw("cpu", "per_policy", pp + "}");
    }
    std::string pend = "[";
    for (size_t i = 0; i < ds.pending.size(); i++) pend += (i ? "," : "") + std::to_string(ds.pending[i]);
    s.str("disk", "algorithm", disk_name(ds.alg));
    s.num("disk", "head", ds.head);
    s.num("disk", "total_seek", (double)ds.seek);
    s.num("disk", "return_seek", (double)ds.jump);
    s.num("disk", "reads", (double)ds.reads);
    s.num("disk", "writes", (double)ds.writes);
    s.num("disk", "io_requests", (double)(ds.reads + ds.writes));
    s.num("disk", "avg_seek", (ds.reads + ds.writes) ? (double)ds.seek / (double)(ds.reads + ds.writes) : 0);
    s.num("disk", "pending_count", (double)ds.pending.size());
    s.raw("disk", "pending", pend + "]");
    s.num("disk", "batch_window_us", disk_->window_us);
    s.num("disk", "io_delay_us_per_track", disk_->io_delay_us);
    const double acc = (double)(ps.hits + ps.misses);
    s.str("buffer_pool", "policy", rep_name(ps.policy));
    s.num("buffer_pool", "frames", (double)ps.frames);
    s.num("buffer_pool", "occupied", (double)ps.occupied);
    s.num("buffer_pool", "free", (double)(ps.frames - ps.occupied));
    s.num("buffer_pool", "dirty", (double)ps.dirty);
    s.num("buffer_pool", "hits", (double)ps.hits);
    s.num("buffer_pool", "misses", (double)ps.misses);
    s.num("buffer_pool", "page_faults", (double)ps.misses);
    s.num("buffer_pool", "hit_ratio", acc > 0 ? (double)ps.hits / acc : 0);
    s.num("buffer_pool", "evictions", (double)ps.evictions);
    s.num("buffer_pool", "writebacks", (double)ps.writebacks);
    s.raw("sync", "ordered_locking", lock_ordered_ ? "true" : "false");
    s.num("sync", "lock_hold_us", lock_hold_us_);
    s.num("sync", "active_readers", locks_.total_readers());
    s.num("sync", "active_writers", locks_.total_writers());
    s.num("sync", "read_acquisitions", (double)locks_.rd_acquisitions());
    s.num("sync", "write_acquisitions", (double)locks_.wr_acquisitions());
    s.num("sync", "contended_acquisitions", (double)locks_.contended());
    s.num("sync", "deadlocks_detected", (double)locks_.timeouts());
    if (text) *text = s.text();
    return s.json();
}

std::string Server::snapshot_json() {
    std::string o = cat("{\"now_us\":", mono_us(), ",\"queue\":", queue_->snapshot_json(), ",\"workers\":[");
    for (int i = 0; i < cfg_.workers; i++) o += cat(i ? "," : "", "{\"id\":", i, ",\"req\":", worker_cur_[i].load(), "}");
    o += "],\"locks\":" + locks_.active_json() + ",\"clients\":[";
    {
        std::lock_guard<std::mutex> lk(cl_m_);
        bool first = true;
        int n = 0;
        for (auto& kvp : clients_) {
            const Client& c = *kvp.second;
            if (c.monitor || n++ >= 200) continue;
            if (!first) o += ",";
            first = false;
            o += cat("{\"id\":", c.id, ",\"name\":", jstr(c.name), ",\"addr\":", jstr(c.addr), ",\"requests\":", c.requests.load(), ",\"age_us\":", mono_us() - c.connected_us, "}");
        }
    }
    return o + "]}";
}

std::string Server::reqs_json(uint64_t since) {
    std::lock_guard<std::mutex> lk(stat_m_);
    std::string o = "[";
    bool first = true;
    size_t skip = req_log_.size() > 400 ? req_log_.size() - 400 : 0, i = 0;
    for (auto& r : req_log_) {
        if (i++ < skip || r.seq <= since) continue;
        if (!first) o += ",";
        first = false;
        o += cat("{\"seq\":", r.seq, ",\"id\":", r.id, ",\"client\":", r.client, ",\"op\":", jstr(r.op), ",\"key\":", jstr(r.key), ",\"priority\":", r.prio,
                 ",\"cost\":", r.cost, ",\"arrival_us\":", r.arrival, ",\"start_us\":", r.start, ",\"completion_us\":", r.completion, ",\"wait_us\":", r.wait,
                 ",\"service_us\":", r.service, ",\"turnaround_us\":", r.tat, ",\"response_us\":", r.response, ",\"slices\":", r.slices, ",\"worker\":", r.worker,
                 ",\"dispatch\":", r.dispatch_seq, ",\"hits\":", r.hits, ",\"misses\":", r.misses, ",\"ok\":", r.ok ? "true" : "false",
                 ",\"policy\":", jstr(r.policy), ",\"locks\":", jstr(r.locks), "}");
    }
    return o + "]";
}

std::string Server::gantt_json(uint64_t since) {
    std::lock_guard<std::mutex> lk(stat_m_);
    std::string o = "[";
    bool first = true;
    for (auto& g : gantt_) {
        if (g.seq <= since) continue;
        if (!first) o += ",";
        first = false;
        o += cat("{\"seq\":", g.seq, ",\"req\":", g.req, ",\"worker\":", g.worker, ",\"start_us\":", g.start, ",\"end_us\":", g.end, ",\"final\":", g.final_slice ? "true" : "false", ",\"op\":", jstr(g.op), "}");
    }
    return o + "]";
}

void Server::reset_stats() {
    total_requests_ = completed_ = errors_ = 0;
    for (auto& c : op_count_) c = 0;
    {
        std::lock_guard<std::mutex> lk(stat_m_);
        for (auto& p : pol_) p = PolStat{};
        tot_wait_ = tot_tat_ = tot_service_ = tot_resp_ = 0;
        req_log_.clear();
        gantt_.clear();
    }
    peak_ = active_.load();
    pool_->reset_stats();
    disk_->reset_stats();
    locks_.reset_stats();
    log_.log("CONFIG", "statistics reset");
}

// ------------------------------------------------------------------ simulators (reuse the real algorithm code)
std::string Server::sim_sched(const std::vector<std::string>& t) {
    CpuPolicy pol;
    long quantum;
    if (t.size() < 3 || !parse_cpu(t[0], pol) || !to_int(t[1], 1, 1000, quantum)) return "ERR usage: SIMSCHED <policy> <quantum> name:arrival:burst:prio ...";
    std::vector<SimJob> jobs;
    for (size_t i = 2; i < t.size() && jobs.size() < 50; i++) {
        std::vector<std::string> f;
        std::stringstream ss(t[i]);
        std::string part;
        while (std::getline(ss, part, ':')) f.push_back(part);
        long a, b, p = 1;
        if (f.size() < 3 || !to_int(f[1], 0, 100000, a) || !to_int(f[2], 1, 10000, b) || (f.size() > 3 && !to_int(f[3], 1, 9, p))) return "ERR bad job spec '" + t[i] + "'";
        SimJob j;
        j.name = f[0]; j.arrival = (int)a; j.burst = (int)b; j.priority = (int)p;
        jobs.push_back(j);
    }
    SimResult r = simulate_cpu(pol, (int)quantum, jobs);
    std::string o = cat("{\"policy\":", jstr(cpu_name(pol)), ",\"quantum\":", quantum, ",\"jobs\":[");
    for (size_t i = 0; i < r.jobs.size(); i++) {
        const SimJob& j = r.jobs[i];
        o += cat(i ? "," : "", "{\"name\":", jstr(j.name), ",\"arrival\":", j.arrival, ",\"burst\":", j.burst, ",\"priority\":", j.priority, ",\"start\":", j.start,
                 ",\"completion\":", j.completion, ",\"waiting\":", j.completion - j.arrival - j.burst, ",\"turnaround\":", j.completion - j.arrival, ",\"response\":", j.start - j.arrival, "}");
    }
    o += "],\"gantt\":[";
    for (size_t i = 0; i < r.gantt.size(); i++) o += cat(i ? "," : "", "{\"name\":", jstr(r.gantt[i].name), ",\"start\":", r.gantt[i].start, ",\"end\":", r.gantt[i].end, "}");
    return o + cat("],\"avg_wait\":", jnum(r.avg_wait), ",\"avg_turnaround\":", jnum(r.avg_tat), "}");
}

std::string Server::sim_disk(const std::vector<std::string>& t) {
    DiskAlg alg;
    long head, maxt;
    if (t.size() < 5 || !parse_disk(t[0], alg) || !to_int(t[2], 1, 9999, maxt) || !to_int(t[1], 0, maxt, head)) return "ERR usage: SIMDISK <alg> <head> <max_track> <up|down> <blocks...>";
    std::string dir = lower(t[3]);
    if (dir != "up" && dir != "down") return "ERR direction must be up or down";
    std::vector<int> reqs;
    for (size_t i = 4; i < t.size() && reqs.size() < 200; i++) {
        long b;
        if (!to_int(t[i], 0, maxt, b)) return "ERR block '" + t[i] + "' out of range 0.." + std::to_string(maxt);
        reqs.push_back((int)b);
    }
    DiskSimResult r = simulate_disk(alg, (int)head, reqs, (int)maxt, dir == "up");
    std::string o = cat("{\"algorithm\":", jstr(disk_name(alg)), ",\"head\":", head, ",\"max_track\":", maxt, ",\"requests\":", reqs.size(), ",\"order\":[");
    for (size_t i = 0; i < r.order.size(); i++) o += cat(i ? "," : "", "{\"block\":", r.order[i].block, ",\"seek\":", r.order[i].seek, "}");
    o += "],\"path\":[";
    for (size_t i = 0; i < r.path.size(); i++) o += cat(i ? "," : "", "{\"pos\":", r.path[i].pos, ",\"kind\":\"", r.path[i].kind, "\"}");
    return o + cat("],\"total_seek\":", r.total_seek, ",\"return_seek\":", r.jump_seek, "}");
}

std::string Server::sim_pages(const std::vector<std::string>& t) {
    RepPolicy pol;
    long frames;
    if (t.size() < 3 || !parse_rep(t[0], pol) || !to_int(t[1], 1, 64, frames)) return "ERR usage: SIMPAGE <fifo|lru|clock> <frames> <page[w]> ...  (suffix w = write)";
    std::vector<PageRef> refs;
    for (size_t i = 2; i < t.size() && refs.size() < 200; i++) {
        std::string s = t[i];
        bool w = !s.empty() && (s.back() == 'w' || s.back() == 'W');
        if (w) s.pop_back();
        long p;
        if (!to_int(s, 0, 99999, p)) return "ERR bad page reference '" + t[i] + "'";
        refs.push_back({(int)p, w});
    }
    PageSim r = simulate_pages(pol, (int)frames, refs);
    std::string o = cat("{\"policy\":", jstr(rep_name(pol)), ",\"frames\":", frames, ",\"steps\":[");
    auto arr = [](const std::vector<int>& v) { std::string a = "["; for (size_t i = 0; i < v.size(); i++) a += (i ? "," : "") + std::to_string(v[i]); return a + "]"; };
    for (size_t i = 0; i < r.steps.size(); i++) {
        const PageStep& s = r.steps[i];
        o += cat(i ? "," : "", "{\"page\":", s.ref.page, ",\"write\":", s.ref.write ? "true" : "false", ",\"hit\":", s.hit ? "true" : "false", ",\"victim\":", s.victim,
                 ",\"writeback\":", s.writeback ? "true" : "false", ",\"frames\":", arr(s.frames), ",\"refbits\":", arr(s.refbits), ",\"dirty\":", arr(s.dirty), ",\"hand\":", s.hand, "}");
    }
    double tot = (double)refs.size();
    return o + cat("],\"faults\":", r.faults, ",\"hits\":", r.hits, ",\"writebacks\":", r.writebacks, ",\"hit_ratio\":", jnum(tot ? r.hits / tot : 0), "}");
}

// ------------------------------------------------------------------ control commands (answered inline, not scheduled)
std::string Server::control(Client& c, const std::string& cmd, const std::string& rest, bool& quit) {
    auto t = split_ws(rest);
    auto ok = [&](const std::string& m) { return reply1("OK " + m); };
    long v;
    if (cmd == "PING") return reply1("PONG");
    if (cmd == "QUIT" || cmd == "EXIT") { quit = true; return reply1("OK bye"); }
    if (cmd == "HELLO") {
        if (t.empty()) return reply1("ERR usage: HELLO <name>");
        c.name = t[0];
        if (t[0] == "monitor") c.monitor = true;
        return ok("hello " + c.name);
    }
    if (cmd == "HELP")
        return reply({"Data:    SET k v | GET k | DEL k | LIST | MSET k1 v1 k2 v2 ...   (optional prefix @prio=1..9)",
                      "Info:    STATS | STATSJSON | SNAPSHOT | POOL | EVENTS [since] | REQS [since] | GANTT [since] | DISKLOG [since] | BLOCKOF k",
                      "Config:  POLICY fcfs|sjf|priority|rr [quantum] | DISK fcfs|sstf|scan|cscan|look|clook | CACHE fifo|lru|clock | SETFRAMES n",
                      "Tuning:  DELAY us | IODELAY us | DISKWINDOW us | DISKHEAD n | LOCKORDER on|off | LOCKHOLD us | PAUSE | RESUME",
                      "Admin:   RESET | FLUSH | SHUTDOWN | HELLO name | PING | QUIT",
                      "Sim:     SIMSCHED pol q name:arr:burst:prio.. | SIMDISK alg head max up|down blocks.. | SIMPAGE alg frames pages.."});
    if (cmd == "STATS") { std::vector<std::string> lines; stats_json(&lines); return reply(lines); }
    if (cmd == "STATSJSON") return reply1(stats_json());
    if (cmd == "SNAPSHOT") return reply1(snapshot_json());
    if (cmd == "POOL") return reply1(pool_->frames_json());
    auto since = [&]() -> uint64_t { long s = 0; if (!t.empty()) to_int(t[0], 0, 1L << 60, s); return (uint64_t)s; };
    if (cmd == "EVENTS") return reply1(log_.json_since(since(), t.size() > 1 && to_int(t[1], 1, 2000, v) ? (size_t)v : 500));
    if (cmd == "REQS") return reply1(reqs_json(since()));
    if (cmd == "GANTT") return reply1(gantt_json(since()));
    if (cmd == "DISKLOG") return reply1(disk_->history_json(since()));
    if (cmd == "BLOCKOF") return t.size() == 1 ? ok(std::to_string(block_of(t[0]))) : reply1("ERR usage: BLOCKOF <key>");
    if (cmd == "SIMSCHED") return reply1(sim_sched(t));
    if (cmd == "SIMDISK") return reply1(sim_disk(t));
    if (cmd == "SIMPAGE") return reply1(sim_pages(t));

    // ---- configuration
    if (cmd == "POLICY") {
        CpuPolicy p;
        if (t.empty() || !parse_cpu(t[0], p)) return reply1("ERR usage: POLICY fcfs|sjf|priority|rr [quantum]");
        if (t.size() > 1) { if (!to_int(t[1], 1, 1000, v)) return reply1("ERR quantum must be 1..1000"); quantum_ = (int)v; }
        queue_->set_policy(p);
        log_.log("CONFIG", cat("CPU policy -> ", cpu_name(p), " quantum=", quantum_.load()));
        return ok(std::string("policy ") + cpu_name(p) + " quantum " + std::to_string(quantum_.load()));
    }
    if (cmd == "QUANTUM") { if (t.size() != 1 || !to_int(t[0], 1, 1000, v)) return reply1("ERR usage: QUANTUM 1..1000"); quantum_ = (int)v; log_.log("CONFIG", cat("RR quantum -> ", v)); return ok("quantum " + std::to_string(v)); }
    if (cmd == "DISK") {
        DiskAlg a;
        if (t.empty() || !parse_disk(t[0], a)) return reply1("ERR usage: DISK fcfs|sstf|scan|cscan|look|clook");
        disk_->set_alg(a);
        log_.log("CONFIG", cat("Disk algorithm -> ", disk_name(a)));
        return ok(std::string("disk ") + disk_name(a));
    }
    if (cmd == "CACHE") {
        RepPolicy p;
        if (t.empty() || !parse_rep(t[0], p)) return reply1("ERR usage: CACHE fifo|lru|clock");
        pool_->set_policy(p);
        log_.log("CONFIG", cat("Page replacement -> ", rep_name(p)));
        return ok(std::string("cache ") + rep_name(p));
    }
    if (cmd == "SETFRAMES") {
        if (t.size() != 1 || !to_int(t[0], 2, 128, v) || !pool_->resize((size_t)v)) return reply1("ERR usage: SETFRAMES 2..128");
        log_.log("CONFIG", cat("Buffer pool resized to ", v, " frames"));
        return ok("frames " + std::to_string(v));
    }
    if (cmd == "DELAY") { if (t.size() != 1 || !to_int(t[0], 0, 100000, v)) return reply1("ERR usage: DELAY 0..100000 (us per cost unit)"); delay_us_ = (int)v; log_.log("CONFIG", cat("Synthetic service delay -> ", v, "us/unit")); return ok("delay " + std::to_string(v)); }
    if (cmd == "IODELAY") { if (t.size() != 1 || !to_int(t[0], 0, 10000, v)) return reply1("ERR usage: IODELAY 0..10000 (us per track)"); disk_->io_delay_us = (int)v; log_.log("CONFIG", cat("Simulated disk latency -> ", v, "us/track")); return ok("iodelay " + std::to_string(v)); }
    if (cmd == "DISKWINDOW") { if (t.size() != 1 || !to_int(t[0], 0, 1000000, v)) return reply1("ERR usage: DISKWINDOW 0..1000000 (us)"); disk_->window_us = (int)v; log_.log("CONFIG", cat("Disk batching window -> ", v, "us")); return ok("diskwindow " + std::to_string(v)); }
    if (cmd == "DISKHEAD") { if (t.size() != 1 || !to_int(t[0], 0, NUM_BLOCKS - 1, v)) return reply1("ERR usage: DISKHEAD 0..199"); disk_->set_head((int)v); log_.log("CONFIG", cat("Disk head positioned at ", v)); return ok("head " + std::to_string(v)); }
    if (cmd == "LOCKORDER") {
        if (t.size() != 1 || (lower(t[0]) != "on" && lower(t[0]) != "off")) return reply1("ERR usage: LOCKORDER on|off");
        lock_ordered_ = lower(t[0]) == "on";
        log_.log("CONFIG", cat("Ascending block-order locking -> ", t[0]));
        return ok("lockorder " + lower(t[0]));
    }
    if (cmd == "LOCKHOLD") { if (t.size() != 1 || !to_int(t[0], 0, 2000000, v)) return reply1("ERR usage: LOCKHOLD 0..2000000 (us)"); lock_hold_us_ = (int)v; log_.log("CONFIG", cat("MSET lock hold delay -> ", v, "us")); return ok("lockhold " + std::to_string(v)); }
    if (cmd == "PAUSE") { queue_->set_paused(true); log_.log("CONFIG", "Dispatch PAUSED (requests accumulate in the queue)"); return ok("paused"); }
    if (cmd == "RESUME") { queue_->set_paused(false); log_.log("CONFIG", "Dispatch RESUMED"); return ok("resumed"); }
    if (cmd == "RESET") { reset_stats(); return ok("statistics reset"); }
    if (cmd == "FLUSH") { int n = pool_->flush_all(); log_.log("CONFIG", cat("FLUSH wrote ", n, " dirty block(s)")); return ok("flushed " + std::to_string(n)); }
    if (cmd == "SHUTDOWN") { shutdown_requested_ = true; return ok("shutting down"); }
    return reply1("ERR unknown command '" + cmd + "' (try HELP)");
}

}  // namespace kv
