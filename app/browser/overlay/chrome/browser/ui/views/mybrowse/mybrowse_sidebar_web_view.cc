// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/ui/views/mybrowse/mybrowse_sidebar_web_view.h"

#include <utility>

#include "base/memory/ptr_util.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_constants.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_tab_service.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_window_context.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "url/gurl.h"

namespace {
constexpr int kDefaultWidth = 240;
}  // namespace

// static
std::unique_ptr<MyBrowseSidebarWebView> MyBrowseSidebarWebView::MaybeCreate(
    BrowserWindowInterface* browser) {
  if (!browser ||
      !mybrowse::IsUsableWindow(browser, browser->GetProfile())) {
    return nullptr;
  }
  return base::WrapUnique(new MyBrowseSidebarWebView(browser));
}

MyBrowseSidebarWebView::MyBrowseSidebarWebView(BrowserWindowInterface* browser)
    : views::WebView(browser->GetProfile()) {
  std::unique_ptr<content::WebContents> contents = content::WebContents::Create(
      content::WebContents::CreateParams(browser->GetProfile()));
  // Fix the owner window before the page loads so that its PageHandler can
  // only ever act on this window.
  mybrowse::MyBrowseWindowContext::SetOwner(contents.get(), browser);
  SetOwnedWebContents(std::move(contents));
  LoadInitialURL(GURL(mybrowse::kChromeUIMyBrowseSidebarURL));
}

MyBrowseSidebarWebView::~MyBrowseSidebarWebView() = default;

gfx::Size MyBrowseSidebarWebView::CalculatePreferredSize(
    const views::SizeBounds& available_size) const {
  const int width = available_size.width().is_bounded()
                        ? available_size.width().value()
                        : kDefaultWidth;
  return gfx::Size(width, kPreferredHeight);
}

gfx::Size MyBrowseSidebarWebView::GetMinimumSize() const {
  return gfx::Size(0, kMinimumHeight);
}

BEGIN_METADATA(MyBrowseSidebarWebView)
END_METADATA
