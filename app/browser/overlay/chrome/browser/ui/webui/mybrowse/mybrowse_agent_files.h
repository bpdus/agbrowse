// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_AGENT_FILES_H_
#define CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_AGENT_FILES_H_

#include <optional>
#include <string>

#include "base/files/file_path.h"

namespace mybrowse {

// Daemon endpoint read from the private Agent data directory. The token never
// leaves the browser process.
struct AgentConnection {
  AgentConnection();
  AgentConnection(AgentConnection&&);
  AgentConnection& operator=(AgentConnection&&);
  ~AgentConnection();

  std::string socket_path;
  std::string token;
};

// Agent directory used when no development override is given:
// ~/Library/Application Support/MyBrowse/Agent. Returns an empty path if HOME
// is unknown.
base::FilePath DefaultAgentDir();

// Blocking. Must run on a thread that may block, never on the UI thread.
//
// Opens |agent_dir| with O_NOFOLLOW and requires a directory owned by the
// current user with mode 0700. Opens connection.json and token relative to that
// descriptor with O_NOFOLLOW and requires regular files owned by the current
// user with mode 0600 and a single link. connection.json must be at most 64 KiB
// and token must be 64 lowercase hex characters. Returns nullopt for anything
// else; file contents are never logged.
std::optional<AgentConnection> ReadAgentConnection(
    const base::FilePath& agent_dir);

}  // namespace mybrowse

#endif  // CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_AGENT_FILES_H_
