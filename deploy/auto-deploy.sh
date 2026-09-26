#!/usr/bin/env bash
# main 이 움직이면 웹과 노드를 배포한다. systemd --user 타이머가 몇 분마다 부른다.
#
#   deploy/auto-deploy.sh            # 바뀐 것만 배포
#   deploy/auto-deploy.sh --dry-run  # 무엇을 배포할지 말만 하고 아무것도 안 한다
#   deploy/auto-deploy.sh --force    # 아래 안전장치를 무시하고 지금 main 을 배포
#
# WHY POLLING. GitHub Actions 러너는 이 기계로 들어올 수 없다 — 사설망이고, 들어오는 구멍을
# 내려면 공개 주소에 배포 트리거를 열어야 한다. 나가는 요청 하나(`git ls-remote`)면 같은 일을
# 할 수 있는데 그 대가는 크다. 웹훅으로 바꾸고 싶으면 이 스크립트가 그대로 핸들러가 된다.
#
# WHAT IT COMPARES. 리모트 main 의 sha 와 **지금 서빙 중인 것의 sha**(`build-info.json`)다.
# "마지막으로 배포한 sha" 를 따로 적어 두지 않는 이유는 그 파일이 진실과 갈라질 수 있기
# 때문이다 — 사람이 손으로 배포하거나 롤백하면 메모만 남고 사이트는 다른 것을 서빙한다.
# 서빙본에게 직접 물으면 그런 갈라짐이 없다.
#
# THE TWO GUARDS. 서빙본이 main 이 아니거나(누가 브랜치를 일부러 올려 둔 것) 더티면
# (`--here` 배포) 건너뛴다. 사람이 무언가를 확인하려고 올려 둔 것을 타이머가 조용히
# 지우는 일은 없어야 한다. 그 상태가 정상이 되면 `--force` 로 한 번 되돌린다.
set -uo pipefail

DRY=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=true ;;
    --force) FORCE=true ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# 체크아웃은 origin 주소를 알아내는 데만 쓴다 — 배포에 쓰는 스크립트는 리모트에서 가져온다.
WEB_REPO="${AINIZE_WEB_REPO:-/mnt/newdata/ainize/ainize-web}"
NODE_REPO="${AINIZE_NODE_REPO:-/mnt/newdata/ainize/ainize-node}"
WEB_URL="${AINIZE_WEB_URL:-$(git -C "$WEB_REPO" remote get-url origin 2>/dev/null || echo https://github.com/ainblockchain/ainize-web.git)}"
NODE_URL="${AINIZE_NODE_URL_GIT:-$(git -C "$NODE_REPO" remote get-url origin 2>/dev/null || echo https://github.com/ainblockchain/ainize-node.git)}"
WEB_SERVING="${AINIZE_WEB_ROOT:-$HOME/ainize-web-releases}/current/build-info.json"
NODE_SERVING="${AINIZE_NODE_ROOT:-/mnt/newdata/ainize-node-releases}/current/build-info.json"
LOCK="${XDG_RUNTIME_DIR:-/tmp}/ainize-auto-deploy.lock"
export PATH="${NODE_BIN:-$HOME/.local/node/bin}:$PATH"

# 배포는 몇 분 걸린다. 타이머가 그 사이에 또 부르면 두 배포가 같은 심볼릭 링크를 놓고 겹친다.
exec 9>"$LOCK"
flock -n 9 || { echo "$(date -Is) another run holds the lock; skipping"; exit 0; }

log() { printf '%s %s\n' "$(date -Is)" "$*"; }

# 서빙 중인 것을 읽는다. 없으면 빈 값 — 첫 배포로 친다.
serving_field() {  # $1=build-info.json  $2=field
  node -e 'try{const i=require(process.argv[1]);process.stdout.write(String(i[process.argv[2]]??""))}catch{process.stdout.write("")}' "$1" "$2" 2>/dev/null
}

deploy_one() {  # $1=이름  $2=git URL  $3=레포 안의 배포 스크립트 경로  $4=서빙 build-info
  local name="$1" url="$2" script_path="$3" info="$4"

  local remote
  remote="$(git ls-remote "$url" refs/heads/main 2>/dev/null | cut -f1)"
  if [ -z "$remote" ]; then log "$name: origin/main 을 못 읽었다 — 건너뜀"; return 0; fi

  local serving_sha serving_ref serving_dirty
  serving_sha="$(serving_field "$info" sha)"
  serving_ref="$(serving_field "$info" ref)"
  serving_dirty="$(serving_field "$info" dirty)"

  if [ "$FORCE" = false ]; then
    if [ -n "$serving_ref" ] && [ "$serving_ref" != "main" ]; then
      log "$name: '$serving_ref' 을 서빙 중이라 손대지 않는다 (--force 로 main 복귀)"; return 0
    fi
    if [ "$serving_dirty" = "true" ]; then
      log "$name: 더티 릴리스를 서빙 중이라 손대지 않는다 (--force 로 main 복귀)"; return 0
    fi
  fi

  if [ "$serving_sha" = "$remote" ] && [ "$FORCE" = false ]; then
    log "$name: 그대로 (${remote:0:12})"; return 0
  fi

  log "$name: ${serving_sha:0:12}${serving_sha:+ → }${remote:0:12} 배포"
  if [ "$DRY" = true ]; then log "$name: --dry-run 이라 여기서 멈춘다"; return 0; fi

  # **배포 스크립트도 main 에서 가져온다.** 로컬 체크아웃을 쓰면 그 체크아웃이 뒤처져 있거나
  # 다른 사람의 미커밋 작업을 들고 있을 때 배포가 그것에 좌우된다 — 실제로 노드 쪽이 그래서
  # `No such file or directory` 로 죽었다. 배포하는 것과 배포에 쓰는 도구가 같은 커밋이어야 한다.
  local checkout; checkout="$(mktemp -d)"
  if ! git clone --quiet --depth 1 --branch main "$url" "$checkout" 2>/dev/null; then
    log "$name: main 을 클론하지 못했다 — 건너뜀"; rm -rf "$checkout"; return 1
  fi
  if [ ! -f "$checkout/$script_path" ]; then
    log "$name: main 에 $script_path 가 없다 — 건너뜀"; rm -rf "$checkout"; return 1
  fi

  if timeout 1800 bash "$checkout/$script_path" main; then
    local now; now="$(serving_field "$info" sha)"
    if [ "$now" = "$remote" ]; then log "$name: 배포됨 ${now:0:12}"
    else log "$name: 스크립트는 성공했는데 서빙본이 ${now:0:12} 다 — 확인 필요"; fi
  else
    # 배포 스크립트가 스스로 롤백한다. 여기서는 그 사실만 남긴다 — 다음 타이머가 또 시도한다.
    log "$name: 배포 실패 (스크립트가 롤백했다)"
    rm -rf "$checkout"
    return 1
  fi
  rm -rf "$checkout"
}

status=0
deploy_one web  "$WEB_URL"  "deploy/deploy-web.sh"  "$WEB_SERVING"  || status=1
deploy_one node "$NODE_URL" "deploy/deploy-node.sh" "$NODE_SERVING" || status=1
exit "$status"
