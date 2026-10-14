// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_CONSTANTS_H_
#define CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_CONSTANTS_H_

#include <stddef.h>

namespace mybrowse {

inline constexpr char kChromeUIMyBrowseHost[] = "mybrowse";
inline constexpr char kChromeUIMyBrowseURL[] = "chrome://mybrowse/";
inline constexpr char kChromeUIMyBrowseSidebarURL[] =
    "chrome://mybrowse/?surface=sidebar";
inline constexpr char kSessionQueryKey[] = "session";

// Development switch naming the Agent data directory. Without it the browser
// uses ~/Library/Application Support/MyBrowse/Agent.
inline constexpr char kAgentDirSwitch[] = "mybrowse-agent-dir";

// Payload bound; stays below the daemon's 1 MiB frame limit.
inline constexpr size_t kMaxRequestPayloadBytes = 64 * 1024;
inline constexpr size_t kMaxConnectionFileBytes = 64 * 1024;
inline constexpr size_t kTokenLength = 64;
inline constexpr int kAgentExchangeTimeoutMs = 35000;

inline constexpr size_t kMaxTabsReported = 200;
inline constexpr size_t kMaxBookmarksReported = 200;
inline constexpr size_t kMaxReportedStringBytes = 2048;
inline constexpr size_t kMaxOpenTabUrlBytes = 2048;

}  // namespace mybrowse

#endif  // CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_CONSTANTS_H_
