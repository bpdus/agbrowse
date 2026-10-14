// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/ui/webui/mybrowse/mybrowse_ui.h"

#include <utility>

#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_constants.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_page_handler.h"
#include "chrome/grit/mybrowse_resources.h"
#include "chrome/grit/mybrowse_resources_map.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/common/url_constants.h"
#include "services/network/public/mojom/content_security_policy.mojom.h"
#include "ui/webui/webui_util.h"

namespace mybrowse {

namespace {

void CreateAndAddMyBrowseDataSource(Profile* profile) {
  content::WebUIDataSource* source =
      content::WebUIDataSource::CreateAndAdd(profile, kChromeUIMyBrowseHost);
  webui::SetupWebUIDataSource(source, kMybrowseResources,
                              IDR_MYBROWSE_MYBROWSE_HTML);

  // No frames and no network requests: the page talks to the browser process
  // over Mojo only. The default script and Trusted Types policies stay in
  // place.
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::FrameSrc, "frame-src 'none';");
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::ConnectSrc, "connect-src 'self';");
}

}  // namespace

MyBrowseUIConfig::MyBrowseUIConfig()
    : DefaultWebUIConfig(content::kChromeUIScheme, kChromeUIMyBrowseHost) {}

bool MyBrowseUIConfig::IsWebUIEnabled(
    content::BrowserContext* browser_context) {
  Profile* profile = Profile::FromBrowserContext(browser_context);
  return profile && profile->IsRegularProfile() && !profile->IsOffTheRecord() &&
         !profile->IsGuestSession();
}

MyBrowseUI::MyBrowseUI(content::WebUI* web_ui)
    : ui::MojoWebUIController(web_ui, /*enable_chrome_send=*/false) {
  CreateAndAddMyBrowseDataSource(Profile::FromWebUI(web_ui));
}

MyBrowseUI::~MyBrowseUI() = default;

WEB_UI_CONTROLLER_TYPE_IMPL(MyBrowseUI)

void MyBrowseUI::BindInterface(
    mojo::PendingReceiver<mojom::PageHandlerFactory> receiver) {
  page_factory_receiver_.reset();
  page_factory_receiver_.Bind(std::move(receiver));
}

void MyBrowseUI::CreatePageHandler(
    mojo::PendingReceiver<mojom::PageHandler> receiver) {
  page_handler_ = std::make_unique<MyBrowsePageHandler>(
      std::move(receiver), web_ui()->GetWebContents());
}

}  // namespace mybrowse
