#!/usr/bin/env bash
# Faux gh : auth status / pr create / pr view / pr merge. Jamais le vrai gh en test.
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  printf '%s\n' "$*" >>"${FAKE_GH_MERGE_LOG:-/dev/null}"
  if [ "${FAKE_GH_HEAD_MOVED:-0}" != "0" ] && [[ " $* " == *" --match-head-commit "* ]]; then
    echo "Head branch was modified. Review and try the merge again." >&2
    exit 1
  fi
  if [ "${FAKE_GH_MERGE_REFUSED:-0}" != "0" ]; then
    echo "pull request not mergeable: protection de branche active" >&2
    exit 1
  fi
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  [ "${FAKE_GH_UNAUTHENTICATED:-0}" = "0" ] && exit 0
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  exit "${FAKE_GH_CREATE_EXIT:-0}"
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  case "$5" in
    *statusCheckRollup*)
      printf '{"statusCheckRollup": %s, "reviews": %s, "mergeable": "%s", "title": "t", "body": "b", "url": "%s", "headRefOid": "%s", "state": "%s", "number": %s, "baseRefName": "main", "headRefName": "%s"}\n' \
        "${FAKE_GH_CHECKS:-[]}" "${FAKE_GH_REVIEWS:-[]}" "${FAKE_GH_MERGEABLE:-MERGEABLE}" \
        "${FAKE_GH_PR_URL:-https://github.com/test/test/pull/7}" \
        "${FAKE_GH_HEAD:-$(git rev-parse HEAD 2>/dev/null)}" "${FAKE_GH_STATE:-OPEN}" \
        "${FAKE_GH_PR_NUMBER:-7}" "$(git branch --show-current 2>/dev/null)"
      ;;
    *)
      printf '{"number": %s, "url": "%s"}\n' \
        "${FAKE_GH_PR_NUMBER:-7}" "${FAKE_GH_PR_URL:-https://github.com/test/test/pull/7}"
      ;;
  esac
  exit 0
fi
exit 1
