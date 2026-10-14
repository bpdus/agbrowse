// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_REQUEST_H_
#define CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_REQUEST_H_

#include <optional>
#include <string>
#include <string_view>

#include "base/values.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse.mojom.h"

namespace mybrowse {

// Fixed error names the page can receive. No other text, path or errno leaves
// the browser process.
inline constexpr char kErrorInvalidRequest[] = "invalid_request";
inline constexpr char kErrorPayloadTooLarge[] = "payload_too_large";
inline constexpr char kErrorAgentUnavailable[] = "agent_unavailable";
inline constexpr char kErrorAgentConnectionFailed[] =
    "agent_connection_failed";
inline constexpr char kErrorAgentPeerMismatch[] = "agent_peer_mismatch";
inline constexpr char kErrorAgentTimeout[] = "agent_timeout";
inline constexpr char kErrorAgentProtocol[] = "agent_protocol_error";
inline constexpr char kErrorResponseTooLarge[] = "response_too_large";
inline constexpr char kErrorBadResponse[] = "bad_response";
inline constexpr char kErrorInternal[] = "internal_error";
inline constexpr char kErrorUnsupportedWindow[] = "unsupported_window";
inline constexpr char kErrorInvalidTab[] = "invalid_tab";
inline constexpr char kErrorInvalidUrl[] = "invalid_url";
inline constexpr char kErrorInvalidSession[] = "invalid_session";
inline constexpr char kErrorTabOperationFailed[] = "tab_operation_failed";

// Daemon op name for |op|, or nullptr for a value outside the enum. The page
// can only select among the six known operations.
const char* AgentOpName(mojom::AgentOp op);

// Accepts only canonical session identifiers. Returns the lowercase form.
std::optional<std::string> NormalizeUuid(std::string_view value);

// Parses |payload_json| (at most 64 KiB) and checks the fields, types and
// ranges for |op|. Unknown fields are rejected. On failure returns nullopt and
// stores a fixed error name in |error|.
std::optional<base::DictValue> ValidateRequestPayload(
    mojom::AgentOp op,
    std::string_view payload_json,
    std::string* error);

// Generates a daemon request id (UUID text, within the 1..128 id rule).
std::string NewRequestId();

// Builds the daemon request object with version, id, token, op and payload.
// Returns nullopt if the frame cannot be serialized.
std::optional<std::string> BuildRequestFrame(mojom::AgentOp op,
                                             const std::string& request_id,
                                             const std::string& token,
                                             base::DictValue payload);

// Checks a daemon response frame: version 1, same id, ok with a data object or
// not ok with status, code and message. Rebuilds the JSON from the known
// fields only. Returns nullopt if the frame is malformed or contains |token|.
std::optional<std::string> SanitizeResponseFrame(
    std::string_view response_json,
    const std::string& request_id,
    const std::string& token);

}  // namespace mybrowse

#endif  // CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_REQUEST_H_
