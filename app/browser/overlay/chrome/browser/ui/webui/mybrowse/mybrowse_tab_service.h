// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_TAB_SERVICE_H_
#define CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_TAB_SERVICE_H_

#include <stdint.h>

#include <string>

#include "chrome/browser/ui/webui/mybrowse/mybrowse.mojom.h"

class BrowserWindowInterface;
class Profile;

namespace mybrowse {

// Tab operations on one browser window. Every call looks the tab up again in
// the window's TabStripModel by its SessionTabHelper id. An id that is not in
// the window is an error; it is never turned into an index or applied to
// another window.

// True for a regular (non-incognito, non-guest) normal window of |profile|.
bool IsUsableWindow(BrowserWindowInterface* browser, Profile* profile);

mojom::TabListResultPtr ListTabs(BrowserWindowInterface* browser);

// Opens |url| in a new foreground tab. Only http and https URLs without
// credentials are accepted.
mojom::TabActionResultPtr OpenHttpTab(BrowserWindowInterface* browser,
                                      const std::string& url);

mojom::TabActionResultPtr ActivateTabById(BrowserWindowInterface* browser,
                                          int32_t tab_id);
mojom::TabActionResultPtr CloseTabById(BrowserWindowInterface* browser,
                                       int32_t tab_id);

// Selects the tab showing chrome://mybrowse/?session=|session_id|, or creates
// it. |session_id| must be a UUID.
mojom::TabActionResultPtr OpenSessionTab(BrowserWindowInterface* browser,
                                         const std::string& session_id);

// Selects the tab showing chrome://mybrowse/, or creates it.
mojom::TabActionResultPtr OpenHomeTab(BrowserWindowInterface* browser);

}  // namespace mybrowse

#endif  // CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_TAB_SERVICE_H_
