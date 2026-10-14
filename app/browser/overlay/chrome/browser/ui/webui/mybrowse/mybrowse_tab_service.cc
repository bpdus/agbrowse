// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/ui/webui/mybrowse/mybrowse_tab_service.h"

#include <stdint.h>

#include <algorithm>
#include <optional>
#include <utility>

#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_constants.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_request.h"
#include "components/sessions/content/session_tab_helper.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"

namespace mybrowse {

namespace {

constexpr size_t kMaxTitleUtf16Units = 512;

mojom::TabActionResultPtr ActionError(const char* name) {
  auto result = mojom::TabActionResult::New();
  result->error_name = name;
  result->tab_id = 0;
  return result;
}

mojom::TabActionResultPtr ActionOk(int32_t tab_id) {
  auto result = mojom::TabActionResult::New();
  result->tab_id = tab_id;
  return result;
}

int32_t TabIdOf(const content::WebContents* contents) {
  return contents ? sessions::SessionTabHelper::IdForTab(contents).id() : 0;
}

// Returns the tab of |model| whose SessionTabHelper id is |tab_id|, or null.
tabs::TabInterface* FindTabById(TabStripModel* model, int32_t tab_id) {
  if (tab_id <= 0) {
    return nullptr;
  }
  for (int i = 0; i < model->count(); ++i) {
    if (TabIdOf(model->GetWebContentsAt(i)) == tab_id) {
      return model->GetTabAtIndex(i);
    }
  }
  return nullptr;
}

tabs::TabInterface* FindTabByUrl(TabStripModel* model, const GURL& url) {
  for (int i = 0; i < model->count(); ++i) {
    content::WebContents* contents = model->GetWebContentsAt(i);
    if (contents && contents->GetVisibleURL() == url) {
      return model->GetTabAtIndex(i);
    }
  }
  return nullptr;
}

mojom::TabActionResultPtr SelectOrOpen(BrowserWindowInterface* browser,
                                       const GURL& url) {
  TabStripModel* model = browser->GetTabStripModel();
  if (tabs::TabInterface* existing = FindTabByUrl(model, url)) {
    model->ActivateTab(existing);
    return ActionOk(TabIdOf(existing->GetContents()));
  }
  browser->OpenGURL(url, WindowOpenDisposition::NEW_FOREGROUND_TAB);
  tabs::TabInterface* active = browser->GetActiveTabInterface();
  if (!active || !active->GetContents()) {
    return ActionError(kErrorTabOperationFailed);
  }
  return ActionOk(TabIdOf(active->GetContents()));
}

}  // namespace

bool IsUsableWindow(BrowserWindowInterface* browser, Profile* profile) {
  return browser && profile && !browser->IsDeleteScheduled() &&
         browser->GetType() == BrowserWindowInterface::TYPE_NORMAL &&
         browser->GetProfile() == profile && profile->IsRegularProfile();
}

mojom::TabListResultPtr ListTabs(BrowserWindowInterface* browser) {
  auto result = mojom::TabListResult::New();
  TabStripModel* model = browser->GetTabStripModel();
  tabs::TabInterface* active = model->GetActiveTab();
  const int count = std::min<int>(model->count(), kMaxTabsReported);
  for (int i = 0; i < count; ++i) {
    tabs::TabInterface* tab = model->GetTabAtIndex(i);
    content::WebContents* contents = model->GetWebContentsAt(i);
    const int32_t id = TabIdOf(contents);
    if (!tab || id <= 0) {
      continue;
    }
    std::u16string title = tab->GetTitle();
    if (title.size() > kMaxTitleUtf16Units) {
      title.resize(kMaxTitleUtf16Units);
    }
    std::string url = tab->GetURL().spec();
    if (url.size() > kMaxReportedStringBytes) {
      url.clear();
    }
    auto info = mojom::TabInfo::New();
    info->id = id;
    info->title = base::UTF16ToUTF8(title);
    info->url = std::move(url);
    info->active = (tab == active);
    result->tabs.push_back(std::move(info));
  }
  return result;
}

mojom::TabActionResultPtr OpenHttpTab(BrowserWindowInterface* browser,
                                      const std::string& url) {
  if (url.empty() || url.size() > kMaxOpenTabUrlBytes) {
    return ActionError(kErrorInvalidUrl);
  }
  GURL gurl(url);
  if (!gurl.is_valid() || !gurl.SchemeIsHTTPOrHTTPS() || gurl.has_username() ||
      gurl.has_password()) {
    return ActionError(kErrorInvalidUrl);
  }
  browser->OpenGURL(gurl, WindowOpenDisposition::NEW_FOREGROUND_TAB);
  tabs::TabInterface* active = browser->GetActiveTabInterface();
  if (!active || !active->GetContents()) {
    return ActionError(kErrorTabOperationFailed);
  }
  return ActionOk(TabIdOf(active->GetContents()));
}

mojom::TabActionResultPtr ActivateTabById(BrowserWindowInterface* browser,
                                          int32_t tab_id) {
  TabStripModel* model = browser->GetTabStripModel();
  tabs::TabInterface* tab = FindTabById(model, tab_id);
  if (!tab) {
    return ActionError(kErrorInvalidTab);
  }
  model->ActivateTab(tab);
  return ActionOk(tab_id);
}

mojom::TabActionResultPtr CloseTabById(BrowserWindowInterface* browser,
                                       int32_t tab_id) {
  tabs::TabInterface* tab = FindTabById(browser->GetTabStripModel(), tab_id);
  if (!tab) {
    return ActionError(kErrorInvalidTab);
  }
  tab->Close();
  return ActionOk(tab_id);
}

mojom::TabActionResultPtr OpenSessionTab(BrowserWindowInterface* browser,
                                         const std::string& session_id) {
  std::optional<std::string> uuid = NormalizeUuid(session_id);
  if (!uuid) {
    return ActionError(kErrorInvalidSession);
  }
  GURL url(std::string(kChromeUIMyBrowseURL) + "?" + kSessionQueryKey + "=" +
           *uuid);
  CHECK(url.is_valid());
  return SelectOrOpen(browser, url);
}

mojom::TabActionResultPtr OpenHomeTab(BrowserWindowInterface* browser) {
  return SelectOrOpen(browser, GURL(kChromeUIMyBrowseURL));
}

}  // namespace mybrowse
