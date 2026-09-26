# Exponential backoff, kept in files because each run is a new process.
#
# WHY. A poller that fails does not fail once. Whatever stopped it — GitHub refusing us, DNS, a commit that cannot
# build — is still there two minutes later, so a fixed interval retries at exactly the rate that made the problem
# worse, unattended, for as long as nobody reads the journal. Doubling the wait makes that a handful of attempts an
# hour instead of thirty, and a success clears it, so the normal case pays nothing.
#
# WHAT DOES NOT COUNT AS FAILURE. "main has not moved" is a success — GitHub answered. Only an error counts.
#
# The state is a file per thing that can fail, holding `<fails> <next-epoch>`. It has to be a file: a variable
# would make every run the first run, which is the bug this fixes.
BACKOFF_DIR="${BACKOFF_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/ainize-auto-deploy}"
BACKOFF_BASE="${BACKOFF_BASE:-300}"     # the first wait after a failure: one timer interval
BACKOFF_CAP="${BACKOFF_CAP:-3600}"      # and never longer, so even a long outage recovers on its own

mkdir -p "$BACKOFF_DIR" 2>/dev/null || true

_backoff_file() { printf '%s/%s.backoff' "$BACKOFF_DIR" "$1"; }

# Are we still waiting out an earlier failure? Prints how much longer, and returns 0 when the answer is yes.
backoff_active() {  # $1=name
  local file fails until_ left
  file="$(_backoff_file "$1")"
  [ -f "$file" ] || return 1
  read -r fails until_ < "$file" 2>/dev/null || return 1
  case "${until_:-}" in ''|*[!0-9]*) rm -f "$file"; return 1 ;; esac
  left=$(( until_ - $(date +%s) ))
  [ "$left" -gt 0 ] || return 1
  printf '%s %s' "$fails" "$left"
  return 0
}

# Record a failure and say when we will try again. Each failure doubles the wait, up to the cap.
backoff_bump() {  # $1=name
  local file fails wait_
  file="$(_backoff_file "$1")"
  fails=0
  [ -f "$file" ] && read -r fails _ < "$file" 2>/dev/null
  case "$fails" in ''|*[!0-9]*) fails=0 ;; esac
  fails=$(( fails + 1 ))
  wait_="$BACKOFF_BASE"
  local i=1
  while [ "$i" -lt "$fails" ] && [ "$wait_" -lt "$BACKOFF_CAP" ]; do wait_=$(( wait_ * 2 )); i=$(( i + 1 )); done
  [ "$wait_" -le "$BACKOFF_CAP" ] || wait_="$BACKOFF_CAP"
  printf '%s %s\n' "$fails" "$(( $(date +%s) + wait_ ))" > "$file"
  printf '%s %s' "$fails" "$wait_"
}

# It worked. Forget the history — the next failure starts from the base wait again.
backoff_clear() {  # $1=name
  rm -f "$(_backoff_file "$1")"
}

# minutes, for a log line a person reads
backoff_mins() { printf '%s' "$(( ($1 + 59) / 60 ))"; }
