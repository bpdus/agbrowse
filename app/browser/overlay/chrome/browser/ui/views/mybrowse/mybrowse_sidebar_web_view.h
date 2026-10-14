// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_UI_VIEWS_MYBROWSE_MYBROWSE_SIDEBAR_WEB_VIEW_H_
#define CHROME_BROWSER_UI_VIEWS_MYBROWSE_MYBROWSE_SIDEBAR_WEB_VIEW_H_

#include <memory>

#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/gfx/geometry/size.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/layout/layout_types.h"

class BrowserWindowInterface;

// Hosts the trusted chrome://mybrowse/sidebar.html page (bookmarks and
// conversation list) above the real vertical tab list of one browser window.
//
// The WebContents is not a tab, so the owning window is recorded explicitly
// with mybrowse::MyBrowseWindowContext when the WebContents is created.
class MyBrowseSidebarWebView : public views::WebView {
  METADATA_HEADER(MyBrowseSidebarWebView, views::WebView)

 public:
  static constexpr int kPreferredHeight = 280;
  static constexpr int kMinimumHeight = 120;

  // Returns nullptr unless |browser| is a regular, non-guest, non-incognito
  // normal window.
  static std::unique_ptr<MyBrowseSidebarWebView> MaybeCreate(
      BrowserWindowInterface* browser);

  MyBrowseSidebarWebView(const MyBrowseSidebarWebView&) = delete;
  MyBrowseSidebarWebView& operator=(const MyBrowseSidebarWebView&) = delete;
  ~MyBrowseSidebarWebView() override;

  // views::WebView:
  gfx::Size CalculatePreferredSize(
      const views::SizeBounds& available_size) const override;
  gfx::Size GetMinimumSize() const override;

 private:
  explicit MyBrowseSidebarWebView(BrowserWindowInterface* browser);
};

#endif  // CHROME_BROWSER_UI_VIEWS_MYBROWSE_MYBROWSE_SIDEBAR_WEB_VIEW_H_
