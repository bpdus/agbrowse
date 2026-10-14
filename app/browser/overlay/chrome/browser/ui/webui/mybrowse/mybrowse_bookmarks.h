// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_BOOKMARKS_H_
#define CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_BOOKMARKS_H_

#include "chrome/browser/ui/webui/mybrowse/mybrowse.mojom.h"

class Profile;

namespace mybrowse {

// Lists up to 200 http/https bookmarks of |profile| in tree order, walking the
// bookmark bar first. |loaded| is false while the model is still loading.
mojom::BookmarkListResultPtr ListBookmarks(Profile* profile);

}  // namespace mybrowse

#endif  // CHROME_BROWSER_UI_WEBUI_MYBROWSE_MYBROWSE_BOOKMARKS_H_
