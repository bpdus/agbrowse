#!/bin/bash

usage() {
  cat <<'EOF'
Usage: login-naver.sh [--stop-worker] [--help]

Open the dedicated Chrome profile at the Naver login page.
  --stop-worker  Send SIGTERM to agent-worker processes and wait for exit.
  --help         Show this help.
EOF
}

STOP_WORKER=0
SHOW_HELP=0
for arg in "$@"; do
  case "$arg" in
    --stop-worker) STOP_WORKER=1 ;;
    --help) SHOW_HELP=1 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done
if [ "$SHOW_HELP" -eq 1 ]; then
  usage
  exit 0
fi

if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
  echo "HOME must name an existing directory." >&2
  exit 1
fi

AGBROWSE_HOME="$HOME/.agbrowse-bpdus"
PROFILE="$AGBROWSE_HOME/agent-profile"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [ ! -x "$CHROME_BIN" ]; then
  echo "Chrome executable is missing or not executable: $CHROME_BIN" >&2
  exit 1
fi

check_profile_path() {
  if [ -L "$AGBROWSE_HOME" ]; then
    echo "Refusing symlinked profile directory: $AGBROWSE_HOME" >&2
    return 1
  fi

  if [ -e "$AGBROWSE_HOME" ] && [ ! -d "$AGBROWSE_HOME" ]; then
    echo "Profile parent is not a directory: $AGBROWSE_HOME" >&2
    return 1
  fi

  if [ -d "$AGBROWSE_HOME" ]; then
    if [ ! -w "$AGBROWSE_HOME" ]; then
      echo "Profile parent is not writable: $AGBROWSE_HOME" >&2
      return 1
    fi
  elif [ ! -w "$HOME" ]; then
    echo "Profile parent cannot be created under HOME: $HOME" >&2
    return 1
  fi

  if [ -L "$PROFILE" ]; then
    echo "Refusing symlinked profile path: $PROFILE" >&2
    return 1
  fi

  if [ -e "$PROFILE" ]; then
    if [ ! -d "$PROFILE" ]; then
      echo "Profile path is not a directory: $PROFILE" >&2
      return 1
    fi
    if [ ! -w "$PROFILE" ]; then
      echo "Profile is not writable: $PROFILE" >&2
      return 1
    fi
  fi
  return 0
}

check_profile_locks() {
  for lock_path in \
    "$AGBROWSE_HOME/profile.lock" \
    "$AGBROWSE_HOME/profile.lock.reclaiming" \
    "$PROFILE/SingletonLock" \
    "$PROFILE/SingletonSocket" \
    "$PROFILE/SingletonCookie"
  do
    if [ -e "$lock_path" ] || [ -L "$lock_path" ]; then
      echo "Refusing to open a profile with an existing lock: $lock_path" >&2
      return 1
    fi
  done
  return 0
}

discover_workers() {
  worker_output=$(pgrep -f 'skills/browser/agent-worker[.]mjs' 2>/dev/null)
  pgrep_status=$?
  case "$pgrep_status" in
    0)
      if [ -z "$worker_output" ]; then
        echo "Worker discovery returned no process IDs." >&2
        return 2
      fi
      verified_worker_pids=""
      for candidate_pid in $worker_output; do
        case "$candidate_pid" in
          ''|*[!0-9]*)
            echo "Worker discovery returned an invalid process ID." >&2
            return 2
            ;;
        esac

        worker_args=$(ps -o args= -p "$candidate_pid" 2>/dev/null)
        ps_status=$?
        if [ "$ps_status" -ne 0 ]; then
          if kill -0 "$candidate_pid" 2>/dev/null; then
            echo "Could not verify process arguments for PID $candidate_pid." >&2
            return 2
          fi
          continue
        fi
        if [ -z "$worker_args" ]; then
          continue
        fi

        read -r executable script_arg _ <<EOF
$worker_args
EOF
        executable=${executable##*/}
        if [ "$executable" = "node" ] && [ "$script_arg" = "skills/browser/agent-worker.mjs" ]; then
          if [ -n "$verified_worker_pids" ]; then
            verified_worker_pids="$verified_worker_pids
$candidate_pid"
          else
            verified_worker_pids="$candidate_pid"
          fi
        fi
      done
      WORKER_PIDS="$verified_worker_pids"
      if [ -n "$WORKER_PIDS" ]; then
        return 0
      fi
      return 1
      ;;
    1)
      WORKER_PIDS=""
      return 1
      ;;
    *)
      echo "Could not discover agent-worker processes (pgrep status $pgrep_status)." >&2
      return 2
      ;;
  esac
}

if ! check_profile_path; then
  exit 1
fi

discover_workers
discovery_status=$?
if [ "$discovery_status" -eq 2 ]; then
  exit 1
fi

if [ "$discovery_status" -eq 0 ]; then
  if [ "$STOP_WORKER" -ne 1 ]; then
    echo "An agent-worker is running. Stop it before opening the login profile, or use --stop-worker." >&2
    exit 1
  fi

  for worker_pid in $WORKER_PIDS; do
    if ! kill -TERM "$worker_pid" 2>/dev/null; then
      if kill -0 "$worker_pid" 2>/dev/null; then
        echo "Could not send SIGTERM to agent-worker PID $worker_pid." >&2
        exit 1
      fi
    fi
  done

  remaining=15
  while [ "$remaining" -gt 0 ]; do
    discover_workers
    discovery_status=$?
    if [ "$discovery_status" -eq 1 ]; then
      break
    fi
    if [ "$discovery_status" -eq 2 ]; then
      exit 1
    fi
    sleep 1
    remaining=$((remaining - 1))
  done

  if [ "$remaining" -eq 0 ]; then
    discover_workers
    discovery_status=$?
    if [ "$discovery_status" -eq 0 ]; then
      echo "Timed out waiting for agent-worker processes to stop." >&2
      exit 1
    fi
    if [ "$discovery_status" -eq 2 ]; then
      exit 1
    fi
  fi
fi

if ! check_profile_path || ! check_profile_locks; then
  exit 1
fi

discover_workers
discovery_status=$?
if [ "$discovery_status" -eq 2 ]; then
  exit 1
fi
if [ "$discovery_status" -eq 0 ]; then
  echo "An agent-worker is running; refusing to launch Chrome." >&2
  exit 1
fi

"$CHROME_BIN" \
  "--user-data-dir=$PROFILE" \
  'https://nid.naver.com/nidlogin.login'
chrome_status=$?

echo "Chrome exited. macOS may keep Chrome running after its last window closes; choose Quit Chrome before restarting the worker."
echo "When both services are stopped, restart with ~/.agbrowse-bpdus/bin/start-in-herdr.sh. If the gateway remains running, restart only node skills/browser/agent-worker.mjs in the existing herdr worker pane."
exit "$chrome_status"
