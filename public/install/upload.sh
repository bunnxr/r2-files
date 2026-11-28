#!/usr/bin/env bash
# =====================================================================
#  r2 by bunnxr: terminal upload client (macOS, Linux, Git Bash, WSL)
#
#  Run it with:   curl -fsSL https://u.bunnxr.com | bash
#  To upload to Zenith (your own server) instead of R2:
#                 curl -fsSL https://u.bunnxr.com/local | bash
#
#  Nothing is installed and nothing is written to this computer: no copy
#  of this script, no config file, no temporary files. Each chunk is read
#  straight out of the source file and piped into curl, and the password
#  is only ever held in a shell variable.
#
#  Sections below:
#    1. settings            6. one file
#    2. small helpers       7. one folder
#    3. path cleaning       8. the prompt
#    4. the API             9. start
#    5. progress display
# =====================================================================

# -u catches typos in variable names; pipefail makes a failing dd or curl
# inside a pipeline visible. -e is deliberately NOT set: every request is
# checked by hand so the prompt can survive a failed upload.
set -u
set -o pipefail

# ---------------------------------------------------------------------
#  1. Settings
# ---------------------------------------------------------------------
API="https://files.bunnxr.com"   # the Worker; /cli/* is password-protected
DEST=""                          # folder inside the bucket, "" = top level
TARGET="R2"                      # shown in messages; u.bunnxr.com/local serves DEST="zenith:/" TARGET="Zenith"
MB=1048576                       # 1 MiB: the block size used for reading and for progress
RETRIES=3                        # tries per chunk before a file is given up on
BAR_WIDTH=30                     # widest the progress bar gets; it shrinks to fit narrow windows

# ---------------------------------------------------------------------
#  2. Small helpers
# ---------------------------------------------------------------------
# Piping the script into bash means stdin is the script itself, so every
# prompt has to be read from the terminal device instead.
if [ -r /dev/tty ] && [ -w /dev/tty ]; then
  TTY=/dev/tty
else
  echo "This needs a terminal: run it in an interactive shell." >&2
  exit 1
fi

# macOS and the BSDs spell the "size of this file" flag differently from Linux.
case "$(uname -s)" in
  Darwin|*BSD*) file_size() { stat -f%z "$1"; } ;;
  *)            file_size() { stat -c%s "$1"; } ;;
esac

say()  { printf '%s\n' "$*" > "$TTY"; }
warn() { printf '%s\n' "$*" > "$TTY"; }

for need in curl dd awk sed find; do
  command -v "$need" > /dev/null 2>&1 || { echo "Missing required command: $need" >&2; exit 1; }
done

# 1234567 -> "1.2 MB"
human() {
  awk -v b="$1" 'BEGIN {
    split("B KB MB GB TB", u, " "); i = 1
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    if (i == 1) printf "%d %s", b, u[i]; else printf "%.1f %s", b, u[i]
  }'
}

# 95 -> "1m 35s"
clock() {
  awk -v s="$1" 'BEGIN {
    s = int(s + 0.5)
    if (s < 0) s = 0
    h = int(s / 3600); m = int((s % 3600) / 60); r = s % 60
    if (h > 0) printf "%dh %02dm", h, m; else if (m > 0) printf "%dm %02ds", m, r; else printf "%ds", r
  }'
}

# Minimal JSON readers. The Worker answers with one flat object per request,
# so a line of sed is enough and there is no dependency on jq.
jget() { printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'; }
jnum() { printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p'; }

# Quote a value so it can go inside a JSON string.
jesc() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

# ---------------------------------------------------------------------
#  3. Path cleaning
#
#  Dragging a file or folder onto the terminal pastes its path at the
#  cursor, and every platform decorates it differently:
#    macOS / Linux   My\ Files/report.pdf      backslash-escaped spaces
#    quoted          "My Files/report.pdf"     or 'My Files/report.pdf'
#    Git Bash / WSL  C:\Users\me\My Files      backslashes as separators
#  so the text is tidied up here before it is used.
# ---------------------------------------------------------------------
clean_path() {
  local p="$1"
  # trim leading and trailing whitespace
  p="${p#"${p%%[![:space:]]*}"}"
  p="${p%"${p##*[![:space:]]}"}"
  # a matching pair of surrounding quotes
  if [ ${#p} -ge 2 ]; then
    if [[ $p == \'*\' || $p == \"*\" ]]; then p="${p:1:${#p}-2}"; fi
  fi
  case "$p" in
    [A-Za-z]:[\\/]*|'\\\\'*|//*)
      # A Windows path: here a backslash is a separator, so it must be turned
      # into a forward slash rather than dropped (Git Bash and MSYS accept
      # C:/Users/... just as happily as C:\Users\...).
      p="${p//\\//}"
      ;;
    *)
      # A macOS or Linux path: the backslashes are escapes, so they go.
      p="${p//\\/}"
      ;;
  esac
  # ~ is only expanded by the shell when it is typed bare, not when it arrives
  # as the value of a variable, so expand it here.
  p="${p/#\~/$HOME}"
  # Under WSL a dragged Windows path points at the Windows drive, which lives
  # under /mnt. Only used when the path as given does not exist.
  if [ ! -e "$p" ]; then
    case "$p" in
      [A-Za-z]:/*)
        local letter rest
        letter=$(printf '%s' "${p:0:1}" | tr 'A-Z' 'a-z')
        rest="${p:3}"
        if [ -e "/mnt/$letter/$rest" ]; then p="/mnt/$letter/$rest"; fi
        ;;
    esac
  fi
  printf '%s' "$p"
}

# ---------------------------------------------------------------------
#  4. The API
#
#  Every /cli/ request carries the password as a bearer token. The password
#  is never written to a file and never appears in a URL.
# ---------------------------------------------------------------------
PASSWORD=""
BODY=""
CODE=""

api_post() { # api_post <path> <json body>
  local out
  out=$(printf '%s' "$2" | curl -sS -X POST \
        -H "Authorization: Bearer $PASSWORD" \
        -H "Content-Type: application/json" \
        --data-binary @- \
        -w '\n%{http_code}' \
        "$API$1" 2>/dev/null)
  CODE=${out##*$'\n'}
  BODY=${out%$'\n'*}
  [ "$CODE" = "200" ]
}

# The message the Worker sent, or a sensible stand-in.
api_error() {
  local m
  m=$(jget "$BODY" error)
  if [ -n "$m" ]; then printf '%s' "$m"
  elif [ "$CODE" = "401" ]; then printf '%s' "the upload password was rejected"
  elif [ -z "$CODE" ]; then printf '%s' "could not reach $API"
  else printf 'the server answered with HTTP %s' "$CODE"
  fi
}

ask_password() {
  while : ; do
    printf 'Upload password: ' > "$TTY"
    IFS= read -r -s PASSWORD < "$TTY" || { printf '\n' > "$TTY"; return 1; }
    printf '\n' > "$TTY"
    if [ -z "$PASSWORD" ]; then
      warn "Nothing entered."
    elif api_post "/cli/verify" '{}'; then
      return 0
    else
      warn "Rejected: $(api_error)"
    fi
    printf 'Try again? [Y/n] ' > "$TTY"
    local again
    IFS= read -r again < "$TTY" || return 1
    case "$again" in [Nn]*) return 1 ;; esac
  done
}

# ---------------------------------------------------------------------
#  5. Progress display
#
#  One line, redrawn in place. The byte counter is fed by the block loop
#  that pipes the file into curl, so it tracks real upload progress (it can
#  run ahead by at most one pipe buffer, around 64 KB).
#
#    ██████████████████▍              14.6 MB / 34.8 MB  3.1 MB/s  ETA 6s
#
#  A solid bar (in cyan, on a dark grey track) that fills in eighths of a
#  block, then the sizes, then speed, ETA and the file name, dimmed. The line
#  is fitted to the window width so it never wraps. A terminal without UTF-8
#  gets a plain # / - bar; without colours (or with NO_COLOR set), no colours.
# ---------------------------------------------------------------------
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) BAR_UTF=1 ;;
  *) BAR_UTF=0 ;;
esac
if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then BAR_ANSI=1; else BAR_ANSI=0; fi
if [ "$BAR_UTF" = 1 ]; then
  B_FULL=$'\xe2\x96\x88'                                   # █
  B_PART=("" $'\xe2\x96\x8f' $'\xe2\x96\x8e' $'\xe2\x96\x8d' $'\xe2\x96\x8c' $'\xe2\x96\x8b' $'\xe2\x96\x8a' $'\xe2\x96\x89') # ▏▎▍▌▋▊▉ (1/8 … 7/8)
  if [ "$BAR_ANSI" = 1 ]; then B_TRACK=$B_FULL; else B_TRACK=$'\xe2\x96\x91'; fi # grey █, or ░ without colours
else
  B_FULL="#"; B_PART=("" "" "" "" "" "" "" ""); B_TRACK="-"
fi
if [ "$BAR_ANSI" = 1 ]; then
  C_BAR=$'\033[36m'; C_TRACK=$'\033[90m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_BAR=""; C_TRACK=""; C_DIM=""; C_OFF=""
fi
term_cols() { # the window width, read again when the window is resized
  local c
  c=$(stty size 2>/dev/null < "$TTY" | awk '{print $2}')
  case "$c" in ''|*[!0-9]*) c=80 ;; esac
  [ "$c" -gt 0 ] || c=80
  COLS=$c
}
term_cols
trap 'term_cols' WINCH

J_TOTAL=0    # bytes in the whole job
J_DONE=0     # bytes finished before the current file
J_START=0    # job start, epoch seconds
J_FILES=1    # how many files in the job
J_INDEX=1    # which one is being sent
J_NAME=""    # its name

draw() { # draw <bytes done in the current file>
  local done=$(( J_DONE + $1 )) elapsed rate left sizes extra file width room eighths full part rest i bar="" track="" pad
  [ "$J_TOTAL" -gt 0 ] && [ "$done" -gt "$J_TOTAL" ] && done=$J_TOTAL

  elapsed=$(( $(date +%s) - J_START ))
  [ "$elapsed" -lt 1 ] && elapsed=1
  rate=$(( done / elapsed ))
  if [ "$rate" -gt 0 ]; then
    left=$(clock $(( (J_TOTAL - done) / rate )))
  else
    left="--"
  fi

  # The text after the bar. What does not fit the window goes: the file name first, then speed / ETA.
  sizes="  $(human "$done") / $(human "$J_TOTAL")"
  extra="  $(human "$rate")/s  ETA $left"
  file=""
  [ "$J_FILES" -gt 1 ] && file="  ($J_INDEX/$J_FILES $J_NAME)"
  width=$BAR_WIDTH
  [ $(( COLS - 3 - ${#sizes} )) -lt "$width" ] && width=$(( COLS - 3 - ${#sizes} ))
  [ "$width" -lt 10 ] && width=10
  room=$(( COLS - 3 - width - ${#sizes} ))
  [ "${#extra}" -gt "$room" ] && extra=""
  room=$(( room - ${#extra} ))
  if [ "${#file}" -gt "$room" ]; then
    if [ "$room" -gt 12 ]; then file="${file:0:$(( room - 4 ))}...)"; else file=""; fi
  fi

  # The bar, in eighths of a block
  if [ "$J_TOTAL" -gt 0 ]; then eighths=$(( done * width * 8 / J_TOTAL )); else eighths=$(( width * 8 )); fi
  full=$(( eighths / 8 )); part=$(( eighths % 8 ))
  [ "$BAR_UTF" = 1 ] || part=0
  i=0
  while [ "$i" -lt "$full" ]; do bar="$bar$B_FULL"; i=$(( i + 1 )); done
  rest=$(( width - full ))
  if [ "$part" -gt 0 ]; then bar="$bar${B_PART[$part]}"; rest=$(( rest - 1 )); fi
  i=0
  while [ "$i" -lt "$rest" ]; do track="$track$B_TRACK"; i=$(( i + 1 )); done

  # \r returns to the start of the line; \033[K (or spaces, without colours) wipes what a
  # longer previous line left behind.
  if [ "$BAR_ANSI" = 1 ]; then
    printf '\r  %s%s%s%s%s%s%s%s%s\033[K' "$C_BAR" "$bar" "$C_TRACK" "$track" "$C_OFF" "$sizes" "$C_DIM" "$extra$file" "$C_OFF" > "$TTY"
  else
    pad=$(( COLS - 3 - width - ${#sizes} - ${#extra} - ${#file} ))
    [ "$pad" -lt 0 ] && pad=0
    printf '\r  %s%s%s%s%s%*s' "$bar" "$track" "$sizes" "$extra" "$file" "$pad" "" > "$TTY"
  fi
}

draw_end() { printf '\n' > "$TTY"; }

# ---------------------------------------------------------------------
#  6. Uploading one file
# ---------------------------------------------------------------------
# Sends one part: reads it from the file a megabyte at a time, pipes it
# straight into curl and returns the ETag the storage gives back (for Zenith
# the URL points at the Worker, which passes the chunk on).
#   send_part <file> <first block, in MiB> <bytes in this part> <url> <bytes already done>
send_part() {
  local f=$1 skipmb=$2 len=$3 url=$4 base=$5
  local out code etag blocks b sent
  blocks=$(( (len + MB - 1) / MB ))

  out=$(
    b=0
    while [ "$b" -lt "$blocks" ]; do
      dd if="$f" bs=$MB skip=$(( skipmb + b )) count=1 2>/dev/null
      b=$(( b + 1 ))
      sent=$(( b * MB ))
      [ "$sent" -gt "$len" ] && sent=$len
      draw $(( base + sent ))
    done | curl -sS -X PUT -T - \
             -H "Content-Length: $len" \
             -H "Transfer-Encoding:" \
             -D - -o /dev/null -w '\n%{http_code}' \
             "$url" 2>/dev/null
  )

  code=${out##*$'\n'}
  if [ "$code" != "200" ] && [ "$code" != "204" ]; then
    PART_ERROR="$TARGET answered with HTTP ${code:-no response}"
    return 1
  fi
  # R2 returns the ETag in quotes; it is passed through exactly as the
  # browser uploader passes it, because that is what the complete call wants.
  etag=$(printf '%s' "$out" | tr -d '\r' | sed -n 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*\(.*\)$/\1/p' | tail -1)
  if [ -z "$etag" ]; then
    PART_ERROR="$TARGET did not return an ETag"
    return 1
  fi
  printf '%s' "$etag"
}

# upload_file <local path> <folder inside the bucket, relative>
upload_file() {
  local path=$1 rel=$2
  local name size key uploadId partSize parts mode
  local n i off len pmb etag parts_json tries ok

  name=$(basename "$path")
  size=$(file_size "$path") || { warn "Could not read $name"; return 1; }
  J_NAME=$name

  if ! api_post "/cli/upload/init" \
      "{\"prefix\":\"$(jesc "$DEST")\",\"rel\":\"$(jesc "$rel")\",\"name\":\"$(jesc "$name")\",\"size\":$size,\"type\":\"\"}"; then
    warn "$name: $(api_error)"
    return 1
  fi

  mode=$(jget "$BODY" mode)
  key=$(jget "$BODY" key)

  # An empty file is stored by the Worker in the init call itself.
  if [ "$mode" = "done" ]; then
    draw 0
    return 0
  fi

  uploadId=$(jget "$BODY" uploadId)
  partSize=$(jnum "$BODY" partSize)
  parts=$(jnum "$BODY" parts)
  if [ -z "$uploadId" ] || [ -z "$partSize" ] || [ -z "$parts" ]; then
    warn "$name: the server sent an upload it could not describe"
    return 1
  fi
  # The Worker always rounds the part size up to a whole number of megabytes,
  # which is what lets dd seek by block instead of by byte.
  pmb=$(( partSize / MB ))

  parts_json=""
  i=0
  while [ "$i" -lt "$parts" ]; do
    n=$(( i + 1 ))
    off=$(( i * partSize ))
    len=$(( size - off ))
    [ "$len" -gt "$partSize" ] && len=$partSize

    ok=0
    tries=1
    while [ "$tries" -le "$RETRIES" ]; do
      PART_ERROR=""
      if ! api_post "/cli/upload/part" \
          "{\"key\":\"$(jesc "$key")\",\"uploadId\":\"$(jesc "$uploadId")\",\"partNumber\":$n}"; then
        PART_ERROR=$(api_error)
      else
        etag=$(send_part "$path" $(( i * pmb )) "$len" "$(jget "$BODY" url)" "$off") && { ok=1; break; }
      fi
      sleep $(( tries * tries ))
      tries=$(( tries + 1 ))
    done

    if [ "$ok" -ne 1 ]; then
      draw_end
      warn "$name: chunk $n failed (${PART_ERROR:-unknown error}). Cleaning up."
      api_post "/cli/upload/abort" "{\"key\":\"$(jesc "$key")\",\"uploadId\":\"$(jesc "$uploadId")\"}" > /dev/null 2>&1 || true
      return 1
    fi

    parts_json="$parts_json{\"PartNumber\":$n,\"ETag\":\"$(jesc "$etag")\"},"
    i=$n
  done

  if ! api_post "/cli/upload/complete" \
      "{\"key\":\"$(jesc "$key")\",\"uploadId\":\"$(jesc "$uploadId")\",\"size\":$size,\"parts\":[${parts_json%,}]}"; then
    draw_end
    warn "$name: $(api_error)"
    api_post "/cli/upload/abort" "{\"key\":\"$(jesc "$key")\",\"uploadId\":\"$(jesc "$uploadId")\"}" > /dev/null 2>&1 || true
    return 1
  fi

  draw "$size"
  return 0
}

# One file on its own: set the job up so the bar covers just this file.
send_one_file() {
  local path=$1 size
  size=$(file_size "$path") || { warn "Could not read that file."; return 1; }
  J_TOTAL=$size; J_DONE=0; J_FILES=1; J_INDEX=1; J_START=$(date +%s)
  say ""
  say "Uploading $(basename "$path")  ($(human "$size"))"
  draw 0
  if upload_file "$path" ""; then
    draw_end
    say "Done: $(basename "$path")"
  else
    return 1
  fi
}

# ---------------------------------------------------------------------
#  7. Uploading one folder, structure kept
# ---------------------------------------------------------------------
send_folder() {
  local root=$1 base rel reldir relpath f size
  local count=0 total=0 failed=0

  # Trim any trailing slash so basename gives the folder's own name.
  while [ "${root%/}" != "$root" ] && [ "$root" != "/" ]; do root="${root%/}"; done
  base=$(basename "$root")

  say ""
  say "Looking through $base ..."

  # A plain while-read over find keeps names with spaces intact. File names
  # containing a newline are not supported, and neither platform's file
  # manager creates them.
  while IFS= read -r f; do
    case "$(basename "$f")" in .DS_Store|Thumbs.db) continue ;; esac
    size=$(file_size "$f" 2>/dev/null) || continue
    count=$(( count + 1 ))
    total=$(( total + size ))
  done <<EOF
$(find "$root" -type f -print)
EOF

  if [ "$count" -eq 0 ]; then
    warn "There are no files in $base."
    return 1
  fi

  say "$count $( [ "$count" -eq 1 ] && echo file || echo files ), $(human "$total")"
  J_TOTAL=$total; J_DONE=0; J_FILES=$count; J_INDEX=0; J_START=$(date +%s)

  while IFS= read -r f; do
    case "$(basename "$f")" in .DS_Store|Thumbs.db) continue ;; esac
    size=$(file_size "$f" 2>/dev/null) || continue
    J_INDEX=$(( J_INDEX + 1 ))

    # Rebuild the path the file had inside the folder, so the structure
    # is recreated in the bucket under the folder's own name.
    relpath="${f#"$root"/}"
    reldir=$(dirname "$relpath")
    if [ "$reldir" = "." ]; then rel="$base"; else rel="$base/$reldir"; fi

    if upload_file "$f" "$rel"; then
      J_DONE=$(( J_DONE + size ))
    else
      failed=$(( failed + 1 ))
      J_DONE=$(( J_DONE + size ))   # keep the bar honest about what is left
    fi
  done <<EOF
$(find "$root" -type f -print)
EOF

  draw_end
  if [ "$failed" -eq 0 ]; then
    say "Done: $base ($count $( [ "$count" -eq 1 ] && echo file || echo files ))"
  else
    warn "Finished $base with $failed of $count failed."
  fi
}

# ---------------------------------------------------------------------
#  8. The prompt
# ---------------------------------------------------------------------
usage() {
  say ""
  say "  file <path>     upload one file"
  say "  folder <path>   upload a folder and everything in it"
  say "  <path>          same thing, worked out from the path itself"
  say "  exit            quit"
  say ""
  say "  Drag a file or folder onto this window to paste its path."
}

prompt_loop() {
  local line cmd arg target
  while : ; do
    printf '\nupload> ' > "$TTY"
    IFS= read -r line < "$TTY" || { say ""; return 0; }

    # Split off a leading keyword, if there is one.
    cmd=${line%% *}
    if [ "$line" = "$cmd" ]; then arg=""; else arg=${line#* }; fi

    case "$cmd" in
      "")               continue ;;
      exit|quit|q)      return 0 ;;
      help|\?)          usage; continue ;;
      file|folder)
        if [ -z "$arg" ]; then warn "Give a path after $cmd, or just paste the path on its own."; continue; fi
        target=$(clean_path "$arg")
        ;;
      *)                target=$(clean_path "$line") ;;
    esac

    if [ -z "$target" ]; then
      warn "No path given."
      continue
    fi
    if [ ! -e "$target" ]; then
      warn "Nothing at: $target"
      warn "Check the path, or drag the file or folder onto this window."
      continue
    fi

    # The path decides what happens, not the keyword that was typed.
    if [ -d "$target" ]; then
      send_folder "$target" || true
    elif [ -f "$target" ]; then
      send_one_file "$target" || true
    else
      warn "That is neither a file nor a folder: $target"
    fi
  done
}

# ---------------------------------------------------------------------
#  9. Start
# ---------------------------------------------------------------------
cleanup() { PASSWORD=""; printf '\n' > "$TTY" 2>/dev/null || true; }
trap 'cleanup; exit 130' INT
trap 'cleanup' EXIT

printf '\033[36m' > "$TTY"
cat > "$TTY" <<'BANNER'

   ____    _
  / __ \  | |__   _   _  _ __   _ __  __  __ _ __
 / / _` | | '_ \ | | | || '_ \ | '_ \ \ \/ /| '__|
| | (_| | | |_) || |_| || | | || | | | >  < | |
 \ \__,_| |_.__/  \__,_||_| |_||_| |_|/_/\_\|_|
  \____/

BANNER
printf '\033[0m' > "$TTY"
say "r2 by bunnxr: terminal upload to $TARGET"
say "$API"

if ! ask_password; then
  say "Stopped."
  exit 1
fi

say "Password accepted."
usage
prompt_loop
say "Bye."
exit 0
