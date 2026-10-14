// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/ui/webui/mybrowse/mybrowse_agent_client.h"

#include <optional>
#include <utility>

#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/ui/webui/mybrowse/ipc_client_mac.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_agent_files.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_constants.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_request.h"

namespace mybrowse {

AgentResult::AgentResult() = default;
AgentResult::AgentResult(AgentResult&&) = default;
AgentResult& AgentResult::operator=(AgentResult&&) = default;
AgentResult::~AgentResult() = default;

namespace {

AgentResult Failure(const char* name) {
  AgentResult result;
  result.error_name = name;
  return result;
}

const char* ErrorName(IpcError error) {
  switch (error) {
    case IpcError::kUnsafeFilesystem:
      return kErrorAgentUnavailable;
    case IpcError::kSocketFailure:
      return kErrorAgentConnectionFailed;
    case IpcError::kPeerMismatch:
      return kErrorAgentPeerMismatch;
    case IpcError::kTimeout:
      return kErrorAgentTimeout;
    case IpcError::kProtocol:
      return kErrorAgentProtocol;
    case IpcError::kResponseTooLarge:
      return kErrorResponseTooLarge;
    case IpcError::kInvalidInput:
    case IpcError::kNone:
      return kErrorInternal;
  }
  return kErrorInternal;
}

// Runs on a ThreadPool task that may block.
AgentResult Exchange(mojom::AgentOp op,
                     base::DictValue payload,
                     base::FilePath agent_dir_override) {
  const base::FilePath agent_dir = agent_dir_override.empty()
                                       ? DefaultAgentDir()
                                       : std::move(agent_dir_override);
  std::optional<AgentConnection> connection = ReadAgentConnection(agent_dir);
  if (!connection) {
    return Failure(kErrorAgentUnavailable);
  }

  const std::string request_id = NewRequestId();
  std::optional<std::string> frame = BuildRequestFrame(
      op, request_id, connection->token, std::move(payload));
  if (!frame) {
    return Failure(kErrorInternal);
  }

  IpcReply reply = ExchangeAgentFrame(connection->socket_path, *frame,
                                      kAgentExchangeTimeoutMs);
  if (reply.error != IpcError::kNone) {
    return Failure(ErrorName(reply.error));
  }

  std::optional<std::string> sanitized =
      SanitizeResponseFrame(reply.body, request_id, connection->token);
  if (!sanitized) {
    return Failure(kErrorBadResponse);
  }
  AgentResult result;
  result.response_json = std::move(*sanitized);
  return result;
}

}  // namespace

base::FilePath AgentDirOverrideFromCommandLine() {
  const base::CommandLine* command_line = base::CommandLine::ForCurrentProcess();
  if (!command_line->HasSwitch(kAgentDirSwitch)) {
    return base::FilePath();
  }
  return command_line->GetSwitchValuePath(kAgentDirSwitch);
}

void SendAgentRequest(mojom::AgentOp op,
                      const std::string& payload_json,
                      const base::FilePath& agent_dir_override,
                      AgentResultCallback callback) {
  std::string error;
  std::optional<base::DictValue> payload =
      ValidateRequestPayload(op, payload_json, &error);
  if (!payload) {
    std::move(callback).Run(Failure(error.c_str()));
    return;
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE,
      {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
       base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN},
      base::BindOnce(&Exchange, op, std::move(*payload), agent_dir_override),
      std::move(callback));
}

}  // namespace mybrowse
