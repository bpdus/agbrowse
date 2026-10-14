// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/ui/webui/mybrowse/mybrowse_page_handler.h"

#include <utility>

#include "base/functional/bind.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_agent_client.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_bookmarks.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_request.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_tab_service.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_window_context.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/web_contents.h"

namespace mybrowse {

namespace {

mojom::TabActionResultPtr UnsupportedWindowAction() {
  auto result = mojom::TabActionResult::New();
  result->error_name = kErrorUnsupportedWindow;
  return result;
}

}  // namespace

MyBrowsePageHandler::MyBrowsePageHandler(
    mojo::PendingReceiver<mojom::PageHandler> receiver,
    content::WebContents* web_contents)
    : receiver_(this, std::move(receiver)),
      web_contents_(web_contents),
      profile_(Profile::FromBrowserContext(web_contents->GetBrowserContext())),
      agent_dir_override_(AgentDirOverrideFromCommandLine()) {}

MyBrowsePageHandler::~MyBrowsePageHandler() = default;

BrowserWindowInterface* MyBrowsePageHandler::ResolveOwnerWindow() const {
  BrowserWindowInterface* browser = nullptr;
  if (MyBrowseWindowContext* context =
          MyBrowseWindowContext::FromWebContents(web_contents_)) {
    // Explicit owner; null once the window closed. Never fall back.
    browser = context->browser();
  } else if (tabs::TabInterface* tab =
                 tabs::TabInterface::MaybeGetFromContents(web_contents_)) {
    browser = tab->GetBrowserWindowInterface();
  }
  return IsUsableWindow(browser, profile_) ? browser : nullptr;
}

void MyBrowsePageHandler::Request(mojom::AgentOp op,
                                  const std::string& payload_json,
                                  RequestCallback callback) {
  // The IO runs on the ThreadPool; the daemon keeps running a conversation if
  // this page goes away, so a dropped reply only discards the answer.
  SendAgentRequest(
      op, payload_json, agent_dir_override_,
      base::BindOnce(&MyBrowsePageHandler::OnAgentResult,
                     weak_factory_.GetWeakPtr(), std::move(callback)));
}

void MyBrowsePageHandler::OnAgentResult(RequestCallback callback,
                                        AgentResult result) {
  auto reply = mojom::AgentReply::New();
  reply->response_json = std::move(result.response_json);
  reply->error_name = std::move(result.error_name);
  std::move(callback).Run(std::move(reply));
}

void MyBrowsePageHandler::GetTabs(GetTabsCallback callback) {
  BrowserWindowInterface* browser = ResolveOwnerWindow();
  if (!browser) {
    auto result = mojom::TabListResult::New();
    result->error_name = kErrorUnsupportedWindow;
    std::move(callback).Run(std::move(result));
    return;
  }
  std::move(callback).Run(ListTabs(browser));
}

void MyBrowsePageHandler::OpenTab(const std::string& url,
                                  OpenTabCallback callback) {
  BrowserWindowInterface* browser = ResolveOwnerWindow();
  std::move(callback).Run(browser ? OpenHttpTab(browser, url)
                                  : UnsupportedWindowAction());
}

void MyBrowsePageHandler::ActivateTab(int32_t tab_id,
                                      ActivateTabCallback callback) {
  BrowserWindowInterface* browser = ResolveOwnerWindow();
  std::move(callback).Run(browser ? ActivateTabById(browser, tab_id)
                                  : UnsupportedWindowAction());
}

void MyBrowsePageHandler::CloseTab(int32_t tab_id, CloseTabCallback callback) {
  BrowserWindowInterface* browser = ResolveOwnerWindow();
  std::move(callback).Run(browser ? CloseTabById(browser, tab_id)
                                  : UnsupportedWindowAction());
}

void MyBrowsePageHandler::OpenSession(const std::string& session_id,
                                      OpenSessionCallback callback) {
  BrowserWindowInterface* browser = ResolveOwnerWindow();
  std::move(callback).Run(browser ? OpenSessionTab(browser, session_id)
                                  : UnsupportedWindowAction());
}

void MyBrowsePageHandler::OpenHome(OpenHomeCallback callback) {
  BrowserWindowInterface* browser = ResolveOwnerWindow();
  std::move(callback).Run(browser ? OpenHomeTab(browser)
                                  : UnsupportedWindowAction());
}

void MyBrowsePageHandler::GetBookmarks(GetBookmarksCallback callback) {
  if (!profile_->IsRegularProfile()) {
    auto result = mojom::BookmarkListResult::New();
    result->error_name = kErrorUnsupportedWindow;
    std::move(callback).Run(std::move(result));
    return;
  }
  std::move(callback).Run(ListBookmarks(profile_));
}

}  // namespace mybrowse
