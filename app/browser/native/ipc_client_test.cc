// Standalone harness: ipc_client_test <socket_path> <request_body> [timeout_ms]
// Success: response body to stdout, exit 0.
// Failure: IpcError integer to stderr, exit 1. Never prints request/token.
#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <string>

#include "browser/native/ipc_client_mac.h"

namespace {

int Failure(mybrowse::IpcError error) {
  std::fprintf(stderr, "%d\n", static_cast<int>(error));
  return 1;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3 || argc > 4) return Failure(mybrowse::IpcError::kInvalidInput);
  int timeout_ms = 35000;
  if (argc == 4) {
    const char* s = argv[3];
    char* end = nullptr;
    errno = 0;
    long v = std::strtol(s, &end, 10);
    if (*s == '\0' || *end != '\0' || errno != 0 || v < INT_MIN ||
        v > INT_MAX) {
      return Failure(mybrowse::IpcError::kInvalidInput);
    }
    timeout_ms = static_cast<int>(v);
  }
  mybrowse::IpcReply reply =
      mybrowse::ExchangeAgentFrame(argv[1], argv[2], timeout_ms);
  if (reply.error != mybrowse::IpcError::kNone) return Failure(reply.error);
  if (!reply.body.empty() &&
      std::fwrite(reply.body.data(), 1, reply.body.size(), stdout) !=
          reply.body.size()) {
    return Failure(mybrowse::IpcError::kSocketFailure);
  }
  std::fflush(stdout);
  return 0;
}
