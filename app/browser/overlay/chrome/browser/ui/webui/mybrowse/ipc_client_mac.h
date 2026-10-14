#ifndef CHROME_BROWSER_UI_WEBUI_MYBROWSE_IPC_CLIENT_MAC_H_
#define CHROME_BROWSER_UI_WEBUI_MYBROWSE_IPC_CLIENT_MAC_H_

#include <string>

namespace mybrowse {

enum class IpcError {
  kNone,
  kInvalidInput,
  kUnsafeFilesystem,
  kSocketFailure,
  kPeerMismatch,
  kTimeout,
  kProtocol,
  kResponseTooLarge
};

struct IpcReply {
  IpcError error;
  std::string body;
};

// Sends one uint32BE-length-prefixed request frame over the Unix socket at
// |socket_path| and returns the single length-prefixed response frame.
// |timeout_ms| (1..60000) bounds the whole exchange, connect through EOF.
// On any error |body| is empty. Blocking; must not run on the UI thread.
IpcReply ExchangeAgentFrame(const std::string& socket_path,
                            const std::string& request_json,
                            int timeout_ms = 35000);

}  // namespace mybrowse

#endif  // CHROME_BROWSER_UI_WEBUI_MYBROWSE_IPC_CLIENT_MAC_H_
