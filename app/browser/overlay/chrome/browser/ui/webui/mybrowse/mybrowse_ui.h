// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_UI_H_
#define CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_UI_H_

#include <memory>

#include "chrome/browser/ui/webui/mybrowse/mybrowse.mojom.h"
#include "content/public/browser/webui_config.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "ui/webui/mojo_web_ui_controller.h"

namespace content {
class BrowserContext;
class WebUI;
}  // namespace content

namespace mybrowse {

class MyBrowsePageHandler;
class MyBrowseUI;

// Enables chrome://mybrowse for regular profiles only. Guest and incognito
// profiles are rejected.
class MyBrowseUIConfig : public content::DefaultWebUIConfig<MyBrowseUI> {
 public:
  MyBrowseUIConfig();

  // content::WebUIConfig:
  bool IsWebUIEnabled(content::BrowserContext* browser_context) override;
};

// Controller for chrome://mybrowse/ (home and conversation) and
// chrome://mybrowse/sidebar.html (bookmarks and conversation list).
class MyBrowseUI : public ui::MojoWebUIController,
                   public mojom::PageHandlerFactory {
 public:
  explicit MyBrowseUI(content::WebUI* web_ui);
  MyBrowseUI(const MyBrowseUI&) = delete;
  MyBrowseUI& operator=(const MyBrowseUI&) = delete;
  ~MyBrowseUI() override;

  // Instantiates the implementor of the mojom::PageHandlerFactory interface.
  void BindInterface(mojo::PendingReceiver<mojom::PageHandlerFactory> receiver);

 private:
  // mojom::PageHandlerFactory:
  void CreatePageHandler(
      mojo::PendingReceiver<mojom::PageHandler> receiver) override;

  std::unique_ptr<MyBrowsePageHandler> page_handler_;
  mojo::Receiver<mojom::PageHandlerFactory> page_factory_receiver_{this};

  WEB_UI_CONTROLLER_TYPE_DECL();
};

}  // namespace mybrowse

#endif  // CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_UI_H_
