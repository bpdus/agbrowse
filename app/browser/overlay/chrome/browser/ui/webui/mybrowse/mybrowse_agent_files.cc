// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/ui/webui/mybrowse/mybrowse_agent_files.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <string_view>
#include <utility>

#include "base/base_paths.h"
#include "base/files/scoped_file.h"
#include "base/json/json_reader.h"
#include "base/path_service.h"
#include "base/posix/eintr_wrapper.h"
#include "base/values.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_constants.h"

namespace mybrowse {

AgentConnection::AgentConnection() = default;
AgentConnection::AgentConnection(AgentConnection&&) = default;
AgentConnection& AgentConnection::operator=(AgentConnection&&) = default;
AgentConnection::~AgentConnection() = default;

namespace {

constexpr mode_t kPermissionMask = 07777;

bool IsPrivateDirectory(const struct stat& info) {
  return S_ISDIR(info.st_mode) && info.st_uid == geteuid() &&
         (info.st_mode & kPermissionMask) == 0700;
}

bool IsPrivateFile(const struct stat& info) {
  return S_ISREG(info.st_mode) && info.st_uid == geteuid() &&
         (info.st_mode & kPermissionMask) == 0600 && info.st_nlink == 1;
}

// Opens |name| inside |dir_fd| without following a final symlink and checks
// the descriptor, not the path, with fstat.
std::optional<std::string> ReadPrivateFile(int dir_fd,
                                           const char* name,
                                           size_t max_bytes) {
  base::ScopedFD fd(HANDLE_EINTR(
      openat(dir_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)));
  if (!fd.is_valid()) {
    return std::nullopt;
  }
  struct stat info;
  if (fstat(fd.get(), &info) != 0 || !IsPrivateFile(info) || info.st_size < 0 ||
      static_cast<size_t>(info.st_size) > max_bytes) {
    return std::nullopt;
  }
  std::string contents;
  contents.reserve(static_cast<size_t>(info.st_size));
  char buffer[4096];
  while (true) {
    ssize_t count = HANDLE_EINTR(read(fd.get(), buffer, sizeof(buffer)));
    if (count < 0) {
      return std::nullopt;
    }
    if (count == 0) {
      break;
    }
    if (contents.size() + static_cast<size_t>(count) > max_bytes) {
      return std::nullopt;
    }
    contents.append(buffer, static_cast<size_t>(count));
  }
  return contents;
}

bool IsLowercaseHex(std::string_view value) {
  for (char c : value) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
      return false;
    }
  }
  return true;
}

// The IPC descriptor may sit at the top level or under endpoint/host. All
// descriptors that are present must agree.
std::optional<std::string> FindSocketPath(const base::DictValue& root) {
  std::optional<std::string> found;
  const base::DictValue* holders[] = {&root, root.FindDict("endpoint"),
                                      root.FindDict("host")};
  for (const base::DictValue* holder : holders) {
    if (!holder) {
      continue;
    }
    const base::DictValue* ipc = holder->FindDict("ipc");
    if (!ipc) {
      continue;
    }
    std::optional<int> version = ipc->FindInt("version");
    const std::string* path = ipc->FindString("socket_path");
    if (version != 1 || !path || path->empty()) {
      return std::nullopt;
    }
    if (found && *found != *path) {
      return std::nullopt;
    }
    found = *path;
  }
  return found;
}

}  // namespace

base::FilePath DefaultAgentDir() {
  base::FilePath home;
  if (!base::PathService::Get(base::DIR_HOME, &home) || home.empty()) {
    return base::FilePath();
  }
  return home.Append("Library")
      .Append("Application Support")
      .Append("MyBrowse")
      .Append("Agent");
}

std::optional<AgentConnection> ReadAgentConnection(
    const base::FilePath& agent_dir) {
  if (!agent_dir.IsAbsolute() || agent_dir.ReferencesParent()) {
    return std::nullopt;
  }
  base::ScopedFD dir_fd(HANDLE_EINTR(
      open(agent_dir.value().c_str(),
           O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)));
  if (!dir_fd.is_valid()) {
    return std::nullopt;
  }
  struct stat dir_info;
  if (fstat(dir_fd.get(), &dir_info) != 0 || !IsPrivateDirectory(dir_info)) {
    return std::nullopt;
  }

  std::optional<std::string> connection_json =
      ReadPrivateFile(dir_fd.get(), "connection.json", kMaxConnectionFileBytes);
  std::optional<std::string> token_text =
      ReadPrivateFile(dir_fd.get(), "token", kTokenLength + 1);
  if (!connection_json || !token_text) {
    return std::nullopt;
  }
  if (!token_text->empty() && token_text->back() == '\n') {
    token_text->pop_back();
  }
  if (token_text->size() != kTokenLength || !IsLowercaseHex(*token_text)) {
    return std::nullopt;
  }

  std::optional<base::DictValue> root =
      base::JSONReader::ReadDict(*connection_json, base::JSON_PARSE_RFC);
  if (!root) {
    return std::nullopt;
  }
  std::optional<std::string> socket_path = FindSocketPath(*root);
  if (!socket_path) {
    return std::nullopt;
  }

  AgentConnection connection;
  connection.socket_path = std::move(*socket_path);
  connection.token = std::move(*token_text);
  return connection;
}

}  // namespace mybrowse
