// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/ui/webui/mybrowse/mybrowse_bookmarks.h"

#include <utility>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/bookmarks/bookmark_model_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_constants.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_request.h"
#include "components/bookmarks/browser/bookmark_model.h"
#include "components/bookmarks/browser/bookmark_node.h"
#include "url/gurl.h"

namespace mybrowse {

namespace {

constexpr size_t kMaxBookmarkTitleUtf16Units = 256;
constexpr size_t kMaxFolderDepth = 8;

struct Frame {
  raw_ptr<const bookmarks::BookmarkNode> folder;
  size_t next_child;
};

}  // namespace

mojom::BookmarkListResultPtr ListBookmarks(Profile* profile) {
  auto result = mojom::BookmarkListResult::New();
  bookmarks::BookmarkModel* model =
      BookmarkModelFactory::GetForBrowserContext(profile);
  if (!model || !model->loaded()) {
    result->loaded = false;
    return result;
  }
  result->loaded = true;

  const bookmarks::BookmarkNode* roots[] = {
      model->bookmark_bar_node(), model->other_node(), model->mobile_node()};
  for (const bookmarks::BookmarkNode* root : roots) {
    if (!root) {
      continue;
    }
    // Iterative depth-first walk with a depth bound and a result bound.
    std::vector<Frame> stack;
    stack.push_back({root, 0});
    while (!stack.empty() &&
           result->bookmarks.size() < kMaxBookmarksReported) {
      Frame& top = stack.back();
      if (top.next_child >= top.folder->children().size()) {
        stack.pop_back();
        continue;
      }
      const bookmarks::BookmarkNode* child =
          top.folder->children()[top.next_child++].get();
      if (child->is_folder()) {
        if (stack.size() < kMaxFolderDepth) {
          stack.push_back({child, 0});
        }
        continue;
      }
      const GURL& url = child->url();
      if (!url.is_valid() || !url.SchemeIsHTTPOrHTTPS() ||
          url.spec().size() > kMaxReportedStringBytes) {
        continue;
      }
      std::u16string title(child->GetTitle());
      if (title.size() > kMaxBookmarkTitleUtf16Units) {
        title.resize(kMaxBookmarkTitleUtf16Units);
      }
      auto info = mojom::BookmarkInfo::New();
      info->title = base::UTF16ToUTF8(title);
      info->url = url.spec();
      result->bookmarks.push_back(std::move(info));
    }
  }
  return result;
}

}  // namespace mybrowse
