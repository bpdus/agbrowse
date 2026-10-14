// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_AGENT_CLIENT_H_
#define CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_AGENT_CLIENT_H_

#include <string>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse.mojom.h"

namespace mybrowse {

// Exactly one member is non-empty.
struct AgentResult {
  AgentResult();
  AgentResult(AgentResult&&);
  AgentResult& operator=(AgentResult&&);
  ~AgentResult();

  // Sanitized daemon response frame.
  std::string response_json;
  // One of the fixed names in mybrowse_request.h.
  std::string error_name;
};

using AgentResultCallback = base::OnceCallback<void(AgentResult)>;

// Development override for the Agent directory from --mybrowse-agent-dir. The
// result is empty when the switch is absent. Reads only the command line.
base::FilePath AgentDirOverrideFromCommandLine();

// Validates |payload_json| on the calling (UI) sequence, then reads the
// connection files and exchanges one frame with the daemon on a ThreadPool task
// that may block. |callback| runs on the calling sequence. A request is sent at
// most once: this function never retries, so a mutating request with an
// unclear outcome is left to the user to repeat.
//
// |agent_dir_override| empty selects the default Agent directory.
void SendAgentRequest(mojom::AgentOp op,
                      const std::string& payload_json,
                      const base::FilePath& agent_dir_override,
                      AgentResultCallback callback);

}  // namespace mybrowse

#endif  // CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_AGENT_CLIENT_H_
