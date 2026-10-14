// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_WINDOW_CONTEXT_H_
#define CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_WINDOW_CONTEXT_H_

#include "base/callback_list.h"
#include "base/memory/weak_ptr.h"
#include "content/public/browser/web_contents_user_data.h"

class BrowserWindowInterface;

namespace content {
class WebContents;
}  // namespace content

namespace mybrowse {

// Names the browser window that owns a WebContents which is not a tab, such as
// the MyBrowse sidebar WebView. The owner is fixed when the WebContents is
// created. It is cleared when the window closes and is never replaced by the
// last active window or by a window of another profile.
class MyBrowseWindowContext
    : public content::WebContentsUserData<MyBrowseWindowContext> {
 public:
  MyBrowseWindowContext(const MyBrowseWindowContext&) = delete;
  MyBrowseWindowContext& operator=(const MyBrowseWindowContext&) = delete;
  ~MyBrowseWindowContext() override;

  // Attaches the context. Does nothing if |contents| already has one.
  static void SetOwner(content::WebContents* contents,
                       BrowserWindowInterface* browser);

  // The owner window, or nullptr once it has closed.
  BrowserWindowInterface* browser() const { return browser_.get(); }

 private:
  friend class content::WebContentsUserData<MyBrowseWindowContext>;

  MyBrowseWindowContext(content::WebContents* contents,
                        BrowserWindowInterface* browser);

  void OnBrowserDidClose(BrowserWindowInterface* browser);

  base::WeakPtr<BrowserWindowInterface> browser_;
  base::CallbackListSubscription close_subscription_;

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

}  // namespace mybrowse

#endif  // CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_WINDOW_CONTEXT_H_
