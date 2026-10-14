#include "chrome/browser/ui/webui/mybrowse/ipc_client_mac.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>

#include "base/containers/span.h"

namespace mybrowse {
namespace {

using Clock = std::chrono::steady_clock;

constexpr size_t kMaxFrameBytes = 1024 * 1024;
constexpr size_t kMaxPathBytes = 103;
constexpr int kMinTimeoutMs = 1;
constexpr int kMaxTimeoutMs = 60000;

IpcReply Fail(IpcError error) {
  IpcReply reply;
  reply.error = error;
  return reply;
}

// Owns a file descriptor. Closing preserves errno and never retries close().
class ScopedFd {
 public:
  explicit ScopedFd(int fd = -1) : fd_(fd) {}
  ScopedFd(const ScopedFd&) = delete;
  ScopedFd& operator=(const ScopedFd&) = delete;
  ~ScopedFd() {
    if (fd_ >= 0) {
      int saved = errno;
      ::close(fd_);
      errno = saved;
    }
  }
  int get() const { return fd_; }

 private:
  int fd_;
};

bool ValidPath(const std::string& path) {
  if (path.size() < 2 || path.size() > kMaxPathBytes) return false;
  if (path.find('\0') != std::string::npos) return false;
  if (path[0] != '/') return false;
  size_t start = 1;
  while (true) {
    size_t end = path.find('/', start);
    size_t len = (end == std::string::npos ? path.size() : end) - start;
    if (len == 0) return false;  // "//" or trailing '/'
    if (path.compare(start, len, ".") == 0 ||
        path.compare(start, len, "..") == 0) {
      return false;
    }
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return true;
}

// lstat (never follows symlinks): exact type, owner and permission bits.
bool CheckOwned(const std::string& path, mode_t type_bits, mode_t perms,
                uid_t uid) {
  struct stat st;
  if (::lstat(path.c_str(), &st) != 0) return false;
  if ((st.st_mode & S_IFMT) != type_bits) return false;
  if (st.st_uid != uid) return false;
  if ((st.st_mode & 07777) != perms) return false;
  return true;
}

// Absolute monotonic deadline.
class Deadline {
 public:
  explicit Deadline(int timeout_ms)
      : end_(Clock::now() + std::chrono::milliseconds(timeout_ms)) {}
  // Remaining time rounded up to whole ms; 0 when expired.
  int RemainingMs() const {
    Clock::duration left = end_ - Clock::now();
    if (left <= Clock::duration::zero()) return 0;
    std::chrono::milliseconds ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(left);
    if (ms < left) ms += std::chrono::milliseconds(1);
    return static_cast<int>(ms.count());
  }

 private:
  Clock::time_point end_;
};

enum class WaitResult { kReady, kTimeout, kFailure };

WaitResult WaitFd(int fd, short events, const Deadline& deadline) {
  while (true) {
    int remaining = deadline.RemainingMs();
    if (remaining <= 0) return WaitResult::kTimeout;
    struct pollfd pfd;
    pfd.fd = fd;
    pfd.events = events;
    pfd.revents = 0;
    int rc = ::poll(&pfd, 1, remaining);
    if (rc < 0) {
      if (errno == EINTR) continue;  // remaining is recomputed
      return WaitResult::kFailure;
    }
    if (rc == 0) continue;  // deadline re-checked at the top
    if (pfd.revents & POLLNVAL) return WaitResult::kFailure;
    return WaitResult::kReady;  // POLLERR/POLLHUP surface via read/write
  }
}

bool SetupFd(int fd) {
  int fl = ::fcntl(fd, F_GETFL, 0);
  if (fl < 0 || ::fcntl(fd, F_SETFL, fl | O_NONBLOCK) != 0) return false;
  int fdfl = ::fcntl(fd, F_GETFD, 0);
  if (fdfl < 0 || ::fcntl(fd, F_SETFD, fdfl | FD_CLOEXEC) != 0) return false;
  int one = 1;
  return ::setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one)) == 0;
}

IpcError Connect(int fd, const std::string& path, const Deadline& deadline) {
  struct sockaddr_un addr;
  std::memset(&addr, 0, sizeof(addr));
  addr.sun_family = AF_UNIX;
  addr.sun_len = static_cast<uint8_t>(sizeof(addr));
  base::span(addr.sun_path).copy_prefix_from(base::span(path));  // size <= 103
  if (deadline.RemainingMs() <= 0) return IpcError::kTimeout;
  int rc = ::connect(fd, reinterpret_cast<struct sockaddr*>(&addr),
                     sizeof(addr));
  if (rc == 0) return IpcError::kNone;
  if (errno != EINPROGRESS && errno != EINTR) return IpcError::kSocketFailure;
  WaitResult w = WaitFd(fd, POLLOUT, deadline);
  if (w == WaitResult::kTimeout) return IpcError::kTimeout;
  if (w == WaitResult::kFailure) return IpcError::kSocketFailure;
  int err = 0;
  socklen_t len = sizeof(err);
  if (::getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
    return IpcError::kSocketFailure;
  }
  return IpcError::kNone;
}

IpcError WriteAll(int fd, const std::string& data, const Deadline& deadline) {
  size_t off = 0;
  while (off < data.size()) {
    if (deadline.RemainingMs() <= 0) return IpcError::kTimeout;
    const std::string_view rest = std::string_view(data).substr(off);
    ssize_t n = ::write(fd, rest.data(), rest.size());
    if (n > 0) {
      off += static_cast<size_t>(n);
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      WaitResult w = WaitFd(fd, POLLOUT, deadline);
      if (w == WaitResult::kTimeout) return IpcError::kTimeout;
      if (w == WaitResult::kFailure) return IpcError::kSocketFailure;
      continue;
    }
    return IpcError::kSocketFailure;
  }
  return IpcError::kNone;
}

// Reads exactly one frame followed by a clean EOF.
IpcReply ReadFrame(int fd, const Deadline& deadline) {
  std::string in;
  size_t expected = 0;  // payload length once the header is known
  bool have_header = false;
  char buf[16384];
  while (true) {
    if (deadline.RemainingMs() <= 0) return Fail(IpcError::kTimeout);
    ssize_t n = ::read(fd, buf, sizeof(buf));
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        WaitResult w = WaitFd(fd, POLLIN, deadline);
        if (w == WaitResult::kTimeout) return Fail(IpcError::kTimeout);
        if (w == WaitResult::kFailure) return Fail(IpcError::kSocketFailure);
        continue;
      }
      return Fail(IpcError::kSocketFailure);
    }
    if (n == 0) {  // EOF
      if (!have_header || in.size() != 4 + expected) {
        return Fail(IpcError::kProtocol);
      }
      IpcReply reply;
      reply.error = IpcError::kNone;
      reply.body = in.substr(4);
      return reply;
    }
    in.append(buf, static_cast<size_t>(n));
    if (!have_header && in.size() >= 4) {
      auto byte = [&in](size_t i) {
        return static_cast<uint32_t>(static_cast<unsigned char>(in[i]));
      };
      uint32_t len =
          (byte(0) << 24) | (byte(1) << 16) | (byte(2) << 8) | byte(3);
      if (len == 0) return Fail(IpcError::kProtocol);
      if (len > kMaxFrameBytes) return Fail(IpcError::kResponseTooLarge);
      expected = len;
      have_header = true;
    }
    if (have_header && in.size() > 4 + expected) {
      return Fail(IpcError::kProtocol);  // trailing bytes
    }
  }
}

}  // namespace

IpcReply ExchangeAgentFrame(const std::string& socket_path,
                            const std::string& request_json,
                            int timeout_ms) {
  if (timeout_ms < kMinTimeoutMs || timeout_ms > kMaxTimeoutMs) {
    return Fail(IpcError::kInvalidInput);
  }
  if (request_json.empty() || request_json.size() > kMaxFrameBytes) {
    return Fail(IpcError::kInvalidInput);
  }
  if (!ValidPath(socket_path)) return Fail(IpcError::kInvalidInput);

  const uid_t uid = ::geteuid();
  size_t slash = socket_path.rfind('/');
  const std::string parent = socket_path.substr(0, slash == 0 ? 1 : slash);
  if (!CheckOwned(parent, S_IFDIR, 0700, uid) ||
      !CheckOwned(socket_path, S_IFSOCK, 0600, uid)) {
    return Fail(IpcError::kUnsafeFilesystem);
  }

  const Deadline deadline(timeout_ms);

  ScopedFd fd(::socket(AF_UNIX, SOCK_STREAM, 0));
  if (fd.get() < 0) return Fail(IpcError::kSocketFailure);
  if (!SetupFd(fd.get())) return Fail(IpcError::kSocketFailure);

  IpcError err = Connect(fd.get(), socket_path, deadline);
  if (err != IpcError::kNone) return Fail(err);

  uid_t peer_uid = 0;
  gid_t peer_gid = 0;
  if (::getpeereid(fd.get(), &peer_uid, &peer_gid) != 0) {
    return Fail(IpcError::kSocketFailure);
  }
  if (peer_uid != uid) return Fail(IpcError::kPeerMismatch);

  std::string frame;
  frame.reserve(4 + request_json.size());
  const uint32_t len = static_cast<uint32_t>(request_json.size());
  frame.push_back(static_cast<char>((len >> 24) & 0xff));
  frame.push_back(static_cast<char>((len >> 16) & 0xff));
  frame.push_back(static_cast<char>((len >> 8) & 0xff));
  frame.push_back(static_cast<char>(len & 0xff));
  frame.append(request_json);

  err = WriteAll(fd.get(), frame, deadline);
  if (err != IpcError::kNone) return Fail(err);
  if (::shutdown(fd.get(), SHUT_WR) != 0) {
    return Fail(IpcError::kSocketFailure);
  }

  return ReadFrame(fd.get(), deadline);
}

}  // namespace mybrowse
