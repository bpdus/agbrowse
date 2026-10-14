// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_PAGE_HANDLER_H_
#define CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_PAGE_HANDLER_H_

#include <stdint.h>

#include <string>

#include "base/files/file_path.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse.mojom.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/receiver.h"

class BrowserWindowInterface;
class Profile;

namespace content {
class WebContents;
}  // namespace content

namespace mybrowse {

struct AgentResult;

// Browser-side handler for chrome://mybrowse. It owns the daemon connection
// details for this page (the page never sees a token, socket path or file
// path) and acts only on the window that owns the page.
class MyBrowsePageHandler : public mojom::PageHandler {
 public:
  MyBrowsePageHandler(mojo::PendingReceiver<mojom::PageHandler> receiver,
                      content::WebContents* web_contents);
  MyBrowsePageHandler(const MyBrowsePageHandler&) = delete;
  MyBrowsePageHandler& operator=(const MyBrowsePageHandler&) = delete;
  ~MyBrowsePageHandler() override;

  // mojom::PageHandler:
  void Request(mojom::AgentOp op,
               const std::string& payload_json,
               RequestCallback callback) override;
  void GetTabs(GetTabsCallback callback) override;
  void OpenTab(const std::string& url, OpenTabCallback callback) override;
  void ActivateTab(int32_t tab_id, ActivateTabCallback callback) override;
  void CloseTab(int32_t tab_id, CloseTabCallback callback) override;
  void OpenSession(const std::string& session_id,
                   OpenSessionCallback callback) override;
  void OpenHome(OpenHomeCallback callback) override;
  void GetBookmarks(GetBookmarksCallback callback) override;

 private:
  // The window that owns this page, or nullptr. A sidebar WebContents uses its
  // explicit MyBrowseWindowContext owner (cleared when that window closes); a
  // normal MyBrowse tab uses the window of its TabInterface. There is no
  // fallback to the last active window or to another profile.
  BrowserWindowInterface* ResolveOwnerWindow() const;

  void OnAgentResult(RequestCallback callback, AgentResult result);

  mojo::Receiver<mojom::PageHandler> receiver_;
  const raw_ptr<content::WebContents> web_contents_;
  const raw_ptr<Profile> profile_;
  const base::FilePath agent_dir_override_;
  base::WeakPtrFactory<MyBrowsePageHandler> weak_factory_{this};
};

}  // namespace mybrowse

#endif  // CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_PAGE_HANDLER_H_
