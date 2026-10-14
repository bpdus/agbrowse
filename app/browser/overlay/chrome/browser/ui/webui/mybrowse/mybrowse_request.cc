// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "chrome/browser/ui/webui/mybrowse/mybrowse_request.h"

#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <utility>

#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/uuid.h"
#include "chrome/browser/ui/webui/mybrowse/mybrowse_constants.h"

namespace mybrowse {

namespace {

constexpr int64_t kMaxSafeInteger = 9007199254740991;
constexpr int kMaxPageLimit = 200;
constexpr size_t kMaxIdBytes = 128;
constexpr size_t kMaxHostBytes = 256;
constexpr size_t kMaxTextBytes = 32 * 1024;
constexpr size_t kMaxErrorMessageBytes = 512;

bool OnlyKeys(const base::DictValue& dict,
              std::initializer_list<std::string_view> allowed) {
  for (const auto [key, value] : dict) {
    bool found = false;
    for (std::string_view name : allowed) {
      found |= (key == name);
    }
    if (!found) {
      return false;
    }
  }
  return true;
}

// JSON numbers above 32 bits arrive as doubles; accept integral safe values.
std::optional<int64_t> SafeInteger(const base::Value* value) {
  if (!value) {
    return std::nullopt;
  }
  if (value->is_int()) {
    return *value->GetIfInt();
  }
  if (value->is_double()) {
    const double number = *value->GetIfDouble();
    if (std::isfinite(number) && std::trunc(number) == number &&
        std::fabs(number) <= static_cast<double>(kMaxSafeInteger)) {
      return static_cast<int64_t>(number);
    }
  }
  return std::nullopt;
}

bool IsIdString(const std::string* value) {
  if (!value || value->empty() || value->size() > kMaxIdBytes) {
    return false;
  }
  for (char c : *value) {
    const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                    (c >= '0' && c <= '9') || c == '_' || c == '-';
    if (!ok) {
      return false;
    }
  }
  return true;
}

bool IsCode(const std::string* value) {
  if (!value || value->empty() || value->size() > 64) {
    return false;
  }
  for (char c : *value) {
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) {
      return false;
    }
  }
  return true;
}

bool InSet(const std::string* value,
           std::initializer_list<std::string_view> allowed) {
  if (!value) {
    return false;
  }
  for (std::string_view name : allowed) {
    if (*value == name) {
      return true;
    }
  }
  return false;
}

bool ValidOptionalLimit(const base::DictValue& dict) {
  const base::Value* limit = dict.Find("limit");
  if (!limit) {
    return true;
  }
  std::optional<int64_t> number = SafeInteger(limit);
  return number && *number >= 1 && *number <= kMaxPageLimit;
}

// Replaces dict["id"] with the normalized UUID, or returns false.
bool NormalizeIdField(base::DictValue& dict) {
  const std::string* id = dict.FindString("id");
  std::optional<std::string> uuid = id ? NormalizeUuid(*id) : std::nullopt;
  if (!uuid) {
    return false;
  }
  dict.Set("id", *uuid);
  return true;
}

bool ValidatePayloadFields(mojom::AgentOp op, base::DictValue& dict) {
  switch (op) {
    case mojom::AgentOp::kHealth:
      return dict.empty();
    case mojom::AgentOp::kList: {
      if (!OnlyKeys(dict, {"before_rowid", "limit"})) {
        return false;
      }
      if (const base::Value* before = dict.Find("before_rowid")) {
        std::optional<int64_t> number = SafeInteger(before);
        if (!number || *number < 1) {
          return false;
        }
      }
      return ValidOptionalLimit(dict);
    }
    case mojom::AgentOp::kGet:
      return OnlyKeys(dict, {"id"}) && NormalizeIdField(dict);
    case mojom::AgentOp::kCreate: {
      if (!OnlyKeys(dict, {"prompt", "host", "engine", "mode", "client_id",
                           "request_id"})) {
        return false;
      }
      const std::string* prompt = dict.FindString("prompt");
      const std::string* host = dict.FindString("host");
      // opencodex stays unsupported until it has its own verification.
      return prompt && !prompt->empty() && prompt->size() <= kMaxTextBytes &&
             host && !host->empty() && host->size() <= kMaxHostBytes &&
             InSet(dict.FindString("engine"), {"codex", "claude"}) &&
             InSet(dict.FindString("mode"), {"chat", "browser"}) &&
             IsIdString(dict.FindString("client_id")) &&
             IsIdString(dict.FindString("request_id"));
    }
    case mojom::AgentOp::kCommand: {
      if (!OnlyKeys(dict, {"id", "action", "text", "expected_revision",
                           "request_id"})) {
        return false;
      }
      if (const base::Value* text = dict.Find("text")) {
        const std::string* text_value = text->GetIfString();
        if (!text_value || text_value->size() > kMaxTextBytes) {
          return false;
        }
      }
      std::optional<int64_t> revision =
          SafeInteger(dict.Find("expected_revision"));
      return revision && *revision >= 0 &&
             InSet(dict.FindString("action"),
                   {"resume", "stop", "steer", "queue"}) &&
             IsIdString(dict.FindString("request_id")) &&
             NormalizeIdField(dict);
    }
    case mojom::AgentOp::kEvents: {
      if (!OnlyKeys(dict, {"id", "after_seq", "limit"})) {
        return false;
      }
      std::optional<int64_t> after = SafeInteger(dict.Find("after_seq"));
      return after && *after >= 0 && ValidOptionalLimit(dict) &&
             NormalizeIdField(dict);
    }
  }
  return false;
}

}  // namespace

const char* AgentOpName(mojom::AgentOp op) {
  switch (op) {
    case mojom::AgentOp::kHealth:
      return "health";
    case mojom::AgentOp::kList:
      return "list";
    case mojom::AgentOp::kGet:
      return "get";
    case mojom::AgentOp::kCreate:
      return "create";
    case mojom::AgentOp::kCommand:
      return "command";
    case mojom::AgentOp::kEvents:
      return "events";
  }
  return nullptr;
}

std::optional<std::string> NormalizeUuid(std::string_view value) {
  base::Uuid uuid = base::Uuid::ParseCaseInsensitive(value);
  if (!uuid.is_valid()) {
    return std::nullopt;
  }
  return uuid.AsLowercaseString();
}

std::optional<base::DictValue> ValidateRequestPayload(
    mojom::AgentOp op,
    std::string_view payload_json,
    std::string* error) {
  if (!AgentOpName(op)) {
    *error = kErrorInvalidRequest;
    return std::nullopt;
  }
  if (payload_json.size() > kMaxRequestPayloadBytes) {
    *error = kErrorPayloadTooLarge;
    return std::nullopt;
  }
  std::optional<base::DictValue> dict =
      base::JSONReader::ReadDict(payload_json, base::JSON_PARSE_RFC);
  if (!dict || !ValidatePayloadFields(op, *dict)) {
    *error = kErrorInvalidRequest;
    return std::nullopt;
  }
  return dict;
}

std::string NewRequestId() {
  return base::Uuid::GenerateRandomV4().AsLowercaseString();
}

std::optional<std::string> BuildRequestFrame(mojom::AgentOp op,
                                             const std::string& request_id,
                                             const std::string& token,
                                             base::DictValue payload) {
  const char* name = AgentOpName(op);
  if (!name) {
    return std::nullopt;
  }
  base::DictValue frame;
  frame.Set("version", 1);
  frame.Set("id", request_id);
  frame.Set("token", token);
  frame.Set("op", name);
  frame.Set("payload", std::move(payload));
  return base::WriteJson(frame);
}

std::optional<std::string> SanitizeResponseFrame(
    std::string_view response_json,
    const std::string& request_id,
    const std::string& token) {
  if (response_json.find(token) != std::string_view::npos) {
    return std::nullopt;
  }
  std::optional<base::DictValue> dict =
      base::JSONReader::ReadDict(response_json, base::JSON_PARSE_RFC);
  if (!dict) {
    return std::nullopt;
  }
  std::optional<int> version = dict->FindInt("version");
  const std::string* id = dict->FindString("id");
  std::optional<bool> ok = dict->FindBool("ok");
  if (version != 1 || !id || *id != request_id || !ok) {
    return std::nullopt;
  }

  base::DictValue out;
  out.Set("version", 1);
  out.Set("id", request_id);
  out.Set("ok", *ok);
  if (*ok) {
    const base::DictValue* data = dict->FindDict("data");
    if (!data) {
      return std::nullopt;
    }
    out.Set("data", data->Clone());
  } else {
    const base::DictValue* error = dict->FindDict("error");
    if (!error) {
      return std::nullopt;
    }
    std::optional<int> status = error->FindInt("status");
    const std::string* code = error->FindString("code");
    const std::string* message = error->FindString("message");
    if (!status || *status < 100 || *status > 599 || !IsCode(code) ||
        !message) {
      return std::nullopt;
    }
    base::DictValue error_out;
    error_out.Set("status", *status);
    error_out.Set("code", *code);
    error_out.Set("message",
                  message->size() <= kMaxErrorMessageBytes ? *message : *code);
    out.Set("error", std::move(error_out));
  }
  return base::WriteJson(out);
}

}  // namespace mybrowse
