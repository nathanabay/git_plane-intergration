#!/bin/sh
# Runs the whole WEB-42 day-in-the-life loop against a demo instance on $PORT and prints the item state after each step.
PORT=${PORT:-3198}
B=http://127.0.0.1:$PORT
IID=$(curl -s $B/__demo/world | python3 -c "import json,sys;print([i['id'] for i in json.load(sys.stdin)['items'] if i['key']=='WEB-42'][0])")
curl -s -X POST "$B/git-sync/api/workspaces/acme/projects/bb57e81d-c161-441f-b50e-907af28f08c2/work-items/$IID/branches" -H 'cookie: session-id=alex' -H 'origin: http://plane.example.com' -H 'content-type: application/json' -d '{"mappingId":1}'; echo
for s in web42-first-push web42-open-draft web42-ci-pending web42-ci-pass web42-preview web42-ready-for-review web42-review-requested web42-changes-requested web42-fix-push web42-ci-pass-2 web42-approved web42-merged; do
  curl -s $B/__demo/feed -d "{\"step\":\"$s\"}" >/dev/null
  echo "$s → $(curl -s $B/__demo/world | python3 -c "import json,sys;w=json.load(sys.stdin);print([i['state'] for i in w['items'] if i['key']=='WEB-42'][0], [l.split(' -> ')[0] for l in w['links'].get('WEB-42',[]) if l.startswith('[PR]')])")"
done
