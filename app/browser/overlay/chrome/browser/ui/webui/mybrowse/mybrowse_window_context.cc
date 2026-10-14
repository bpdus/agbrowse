// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/ui/webui/mybrowse/mybrowse_window_context.h"

#include "base/check.h"
#include "base/functional/bind.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "content/public/browser/web_contents.h"

namespace mybrowse {

MyBrowseWindowContext::MyBrowseWindowContext(content::WebContents* contents,
                                             BrowserWindowInterface* browser)
    : content::WebContentsUserData<MyBrowseWindowContext>(*contents),
      browser_(browser->GetWeakPtr()),
      close_subscription_(browser->RegisterBrowserDidClose(
          base::BindRepeating(&MyBrowseWindowContext::OnBrowserDidClose,
                              base::Unretained(this)))) {}

MyBrowseWindowContext::~MyBrowseWindowContext() = default;

// static
void MyBrowseWindowContext::SetOwner(content::WebContents* contents,
                                     BrowserWindowInterface* browser) {
  CHECK(contents);
  CHECK(browser);
  MyBrowseWindowContext::CreateForWebContents(contents, browser);
}

void MyBrowseWindowContext::OnBrowserDidClose(BrowserWindowInterface* browser) {
  browser_.reset();
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(MyBrowseWindowContext);

}  // namespace mybrowse
