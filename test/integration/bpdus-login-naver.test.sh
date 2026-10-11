#!/bin/bash

set -u

TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/bpdus-login-naver.XXXXXX") || exit 1
TEST_HOME="$TEST_ROOT/home"
FAKE_BIN="$TEST_ROOT/fake-bin"
PROFILE="$TEST_HOME/.agbrowse-bpdus/agent-profile"
SCRIPT="$(cd "$(dirname "$0")/../.." && pwd)/bin/bpdus/login-naver.sh"
CHROME_BIN="$TEST_ROOT/fake-chrome"
CHROME_ARGS="$TEST_ROOT/chrome-args"
CHROME_STARTED="$TEST_ROOT/chrome-started"
CHROME_RELEASE="$TEST_ROOT/chrome-release"
CHROME_STDOUT="$TEST_ROOT/chrome-stdout"
CHROME_STDERR="$TEST_ROOT/chrome-stderr"
TEST_TERM_MARKER="$TEST_ROOT/worker-term"
TEST_SLEEP_COUNT="$TEST_ROOT/sleep-count"
TEST_GATEWAY_PID=""
TEST_WORKER_PID=""

cleanup() {
  if [ -n "$TEST_WORKER_PID" ]; then
    kill -TERM "$TEST_WORKER_PID" 2>/dev/null || true
    wait "$TEST_WORKER_PID" 2>/dev/null || true
  fi
  if [ -n "$TEST_GATEWAY_PID" ]; then
    kill -TERM "$TEST_GATEWAY_PID" 2>/dev/null || true
    wait "$TEST_GATEWAY_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

assert_no_chrome() {
  [ ! -e "$CHROME_STARTED" ] || fail "Chrome launched unexpectedly"
}

mkdir -p "$TEST_HOME/.agbrowse-bpdus/agent-profile" "$FAKE_BIN" || fail "could not create test directories"

cat > "$FAKE_BIN/pgrep" <<'EOF'
#!/bin/sh
[ "$#" -eq 2 ] && [ "$1" = "-f" ] && [ "$2" = 'skills/browser/agent-worker[.]mjs' ] || exit 2
case "${FAKE_PGREP_MODE:-none}" in
  none) exit 1 ;;
  error) echo "fake pgrep error" >&2; exit 2 ;;
  worker) printf '%s\n' "$TEST_WORKER_PID"; exit 0 ;;
  term)
    if [ -e "$TEST_TERM_MARKER" ]; then exit 1; fi
    printf '%s\n' "$TEST_WORKER_PID"
    exit 0
    ;;
  timeout) printf '%s\n' "$TEST_WORKER_PID"; exit 0 ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$FAKE_BIN/pgrep" || fail "could not prepare fake pgrep"

cat > "$FAKE_BIN/sleep" <<'EOF'
#!/bin/sh
if [ "${FAKE_SLEEP_MODE:-}" = fast ]; then
  echo x >> "$TEST_SLEEP_COUNT"
  exit 0
fi
exec /bin/sleep "$@"
EOF
chmod +x "$FAKE_BIN/sleep" || fail "could not prepare fake sleep"

cat > "$CHROME_BIN" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$CHROME_ARGS"
: > "$CHROME_STARTED"
if [ "${FAKE_CHROME_MODE:-}" = hold ]; then
  while [ ! -e "$CHROME_RELEASE" ]; do /bin/sleep 0.05; done
fi
exit "${FAKE_CHROME_STATUS:-0}"
EOF
chmod +x "$CHROME_BIN" || fail "could not prepare fake Chrome"

export HOME="$TEST_HOME"
export CHROME_BIN CHROME_ARGS CHROME_STARTED CHROME_RELEASE
export TEST_TERM_MARKER TEST_SLEEP_COUNT
PATH="$FAKE_BIN:/usr/bin:/bin"
export PATH

"$SCRIPT" --help > "$TEST_ROOT/help.out" 2> "$TEST_ROOT/help.err" || fail "--help should succeed"
grep -q -- '--stop-worker' "$TEST_ROOT/help.out" || fail "--help omitted --stop-worker"
if "$SCRIPT" --unknown > "$TEST_ROOT/unknown.out" 2> "$TEST_ROOT/unknown.err"; then
  fail "unknown option should fail"
fi
assert_no_chrome
pass "only the documented options are accepted"

FAKE_PGREP_MODE=worker
TEST_WORKER_PID=987654
export FAKE_PGREP_MODE TEST_WORKER_PID
if "$SCRIPT" > "$TEST_ROOT/refusal.out" 2> "$TEST_ROOT/refusal.err"; then
  fail "a running worker should block login mode"
fi
grep -q 'agent-worker is running' "$TEST_ROOT/refusal.err" || fail "worker refusal message missing"
assert_no_chrome
pass "a running worker blocks login mode without --stop-worker"

FAKE_PGREP_MODE=error
export FAKE_PGREP_MODE
if "$SCRIPT" --stop-worker > "$TEST_ROOT/discovery.out" 2> "$TEST_ROOT/discovery.err"; then
  fail "worker discovery errors should fail closed"
fi
assert_no_chrome
pass "worker discovery errors fail closed"

FAKE_PGREP_MODE=timeout
FAKE_SLEEP_MODE=fast
TEST_WORKER_PID=0
export FAKE_PGREP_MODE FAKE_SLEEP_MODE TEST_WORKER_PID
(
  trap 'touch "$TEST_TERM_MARKER"; exit 0' TERM
  while :; do /bin/sleep 0.05; done
) &
TEST_WORKER_PID=$!
export TEST_WORKER_PID
if "$SCRIPT" --stop-worker > "$TEST_ROOT/timeout.out" 2> "$TEST_ROOT/timeout.err"; then
  fail "a worker that remains discoverable should time out"
fi
wait "$TEST_WORKER_PID" 2>/dev/null || true
TEST_WORKER_PID=""
grep -q 'Timed out waiting' "$TEST_ROOT/timeout.err" || fail "timeout message missing"
assert_no_chrome
pass "SIGTERM is sent only to discovered workers and timeout fails closed"

rm -f "$TEST_TERM_MARKER" "$TEST_SLEEP_COUNT"
FAKE_PGREP_MODE=term
FAKE_SLEEP_MODE=
export FAKE_PGREP_MODE FAKE_SLEEP_MODE
(
  trap 'touch "$TEST_TERM_MARKER"; exit 0' TERM
  while :; do /bin/sleep 0.05; done
) &
TEST_WORKER_PID=$!
export TEST_WORKER_PID
/bin/sleep 0.05
/bin/sleep 30 &
TEST_GATEWAY_PID=$!
if ! "$SCRIPT" --stop-worker > "$TEST_ROOT/term.out" 2> "$TEST_ROOT/term.err"; then
  cat "$TEST_ROOT/term.err" >&2
  fail "--stop-worker should wait for the worker to exit"
fi
wait "$TEST_WORKER_PID" 2>/dev/null || true
TEST_WORKER_PID=""
[ -e "$TEST_TERM_MARKER" ] || fail "worker did not receive SIGTERM"
kill -0 "$TEST_GATEWAY_PID" 2>/dev/null || fail "unrelated gateway fixture did not survive"
grep -q 'Quit Chrome' "$TEST_ROOT/term.out" || fail "restart guidance missing after Chrome exit"
pass "--stop-worker waits for TERM; unrelated gateway survives"

check_lock_refusal() {
  lock_path="$1"
  lock_kind="$2"
  case "$lock_kind" in
    file) : > "$lock_path" ;;
    dir) mkdir "$lock_path" ;;
    dangling) ln -s "$TEST_ROOT/missing-lock-target" "$lock_path" ;;
  esac
  if "$SCRIPT" > "$TEST_ROOT/lock.out" 2> "$TEST_ROOT/lock.err"; then
    fail "profile lock should block launch: $lock_path"
  fi
  assert_no_chrome
  rm -rf "$lock_path"
}

FAKE_PGREP_MODE=none
export FAKE_PGREP_MODE
rm -f "$CHROME_STARTED" "$CHROME_ARGS"
check_lock_refusal "$TEST_HOME/.agbrowse-bpdus/profile.lock" file
check_lock_refusal "$TEST_HOME/.agbrowse-bpdus/profile.lock.reclaiming" dir
check_lock_refusal "$PROFILE/SingletonLock" file
check_lock_refusal "$PROFILE/SingletonSocket" dangling
check_lock_refusal "$PROFILE/SingletonCookie" file
pass "profile lock files, reclaiming directories, and dangling symlinks block launch"

mv "$PROFILE" "$TEST_ROOT/real-profile"
ln -s "$TEST_ROOT/real-profile" "$PROFILE" || fail "could not create profile symlink fixture"
if "$SCRIPT" > "$TEST_ROOT/profile-link.out" 2> "$TEST_ROOT/profile-link.err"; then
  fail "a symlinked profile should be rejected"
fi
assert_no_chrome
rm "$PROFILE"
mv "$TEST_ROOT/real-profile" "$PROFILE"
pass "symlinked profile paths are rejected"

rm -f "$CHROME_STARTED" "$CHROME_ARGS" "$CHROME_RELEASE"
FAKE_CHROME_MODE=hold
export FAKE_CHROME_MODE
"$SCRIPT" > "$CHROME_STDOUT" 2> "$CHROME_STDERR" &
LOGIN_PID=$!
attempt=0
while [ ! -e "$CHROME_STARTED" ] && [ "$attempt" -lt 100 ]; do
  /bin/sleep 0.05
  attempt=$((attempt + 1))
done
[ -e "$CHROME_STARTED" ] || fail "fake Chrome did not start"
kill -0 "$LOGIN_PID" 2>/dev/null || fail "login script did not wait for Chrome"
if grep -q 'restart with' "$CHROME_STDOUT"; then
  fail "restart guidance appeared before Chrome exited"
fi
EXPECTED_ARGS="$TEST_ROOT/expected-args"
printf '%s\n' "--user-data-dir=$PROFILE" 'https://nid.naver.com/nidlogin.login' > "$EXPECTED_ARGS"
cmp "$EXPECTED_ARGS" "$CHROME_ARGS" >/dev/null || fail "Chrome arguments differed from the required pair"
touch "$CHROME_RELEASE"
wait "$LOGIN_PID" || fail "login script failed after fake Chrome exited"
grep -q 'restart with' "$CHROME_STDOUT" || fail "restart guidance missing after Chrome exited"
grep -q 'Quit Chrome' "$CHROME_STDOUT" || fail "macOS Quit Chrome guidance missing"
pass "Chrome receives exactly the required arguments and the script waits before printing guidance"

kill -TERM "$TEST_GATEWAY_PID" 2>/dev/null || true
wait "$TEST_GATEWAY_PID" 2>/dev/null || true
TEST_GATEWAY_PID=""
echo "All Naver login integration checks passed."
