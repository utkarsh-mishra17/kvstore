// storage.hpp - Storage Engine: block-structured data file (data.db) + record layout inside a block.
//   Block layout: [u16 count] then `count` records of [u16 klen][u16 vlen][key bytes][value bytes].
//   Keys hash to exactly one block (see block_of), so a block is the unit of I/O, caching and locking.
#pragma once
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include "common.hpp"

namespace kv {

using Records = std::vector<std::pair<std::string, std::string>>;

namespace blockfmt {
inline Records parse(const char* blk) {
    Records out;
    uint16_t count;
    memcpy(&count, blk, 2);
    size_t off = 2;
    for (uint16_t i = 0; i < count; i++) {
        if (off + 4 > (size_t)BLOCK_SIZE) break;
        uint16_t kl, vl;
        memcpy(&kl, blk + off, 2);
        memcpy(&vl, blk + off + 2, 2);
        off += 4;
        if (off + kl + vl > (size_t)BLOCK_SIZE) break;
        out.emplace_back(std::string(blk + off, kl), std::string(blk + off + kl, vl));
        off += kl + vl;
    }
    return out;
}
// Returns false (and leaves `blk` untouched) if the records do not fit in one block.
inline bool serialize(const Records& recs, char* blk) {
    char tmp[BLOCK_SIZE];
    memset(tmp, 0, sizeof tmp);
    uint16_t count = (uint16_t)recs.size();
    memcpy(tmp, &count, 2);
    size_t off = 2;
    for (auto& r : recs) {
        if (off + 4 + r.first.size() + r.second.size() > (size_t)BLOCK_SIZE) return false;
        uint16_t kl = (uint16_t)r.first.size(), vl = (uint16_t)r.second.size();
        memcpy(tmp + off, &kl, 2);
        memcpy(tmp + off + 2, &vl, 2);
        off += 4;
        memcpy(tmp + off, r.first.data(), kl);
        memcpy(tmp + off + kl, r.second.data(), vl);
        off += kl + vl;
    }
    memcpy(blk, tmp, BLOCK_SIZE);
    return true;
}
inline Records::iterator find(Records& recs, const std::string& key) {
    return std::find_if(recs.begin(), recs.end(), [&](const auto& r) { return r.first == key; });
}
}  // namespace blockfmt

class StorageEngine {
public:
    ~StorageEngine() { if (fd_ >= 0) close(fd_); }
    bool open_file(const std::string& path) {
        fd_ = ::open(path.c_str(), O_RDWR | O_CREAT, 0644);
        if (fd_ < 0) return false;
        struct stat st;
        fstat(fd_, &st);
        const off_t want = (off_t)NUM_BLOCKS * BLOCK_SIZE;
        if (st.st_size < want && ftruncate(fd_, want) != 0) return false;
        return true;
    }
    void read_block(int block, char* buf) {
        size_t got = 0;
        while (got < (size_t)BLOCK_SIZE) {
            ssize_t n = pread(fd_, buf + got, BLOCK_SIZE - got, (off_t)block * BLOCK_SIZE + got);
            if (n <= 0) break;
            got += (size_t)n;
        }
        if (got < (size_t)BLOCK_SIZE) memset(buf + got, 0, BLOCK_SIZE - got);
    }
    void write_block(int block, const char* buf) {
        size_t put = 0;
        while (put < (size_t)BLOCK_SIZE) {
            ssize_t n = pwrite(fd_, buf + put, BLOCK_SIZE - put, (off_t)block * BLOCK_SIZE + put);
            if (n <= 0) break;
            put += (size_t)n;
        }
    }
    void sync() { if (fd_ >= 0) fsync(fd_); }

private:
    int fd_ = -1;
};

}  // namespace kv
