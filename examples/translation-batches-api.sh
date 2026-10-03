#!/usr/bin/env bash
# 译者整批译文回填完整调用示例（按一种目标语言把整批译文写回当前字幕）。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/translation-batches-api.sh [BASE_URL]
# 例如：bash examples/translation-batches-api.sh http://localhost:3000
#
# 流程：新建项目并排版 → 整批回填（新建）→ 幂等重放/编号冲突 → 各类失败示例
#       （非法/不存在字幕/版本过期/规则违规，均整批不写入、不占编号）
#       → 覆盖待复核译文 → 批次清单查询 → 既有逐行操作/单语言导出/多语交付读取回填结果。
set -euo pipefail

BASE="${1:-http://localhost:3000}"

req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
body_of() { sed '$d'; }
code_of() { tail -1; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版（准备源字幕） ==="
WORDS='{"name":"整批回填 API 示例","words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}'
out="$(req POST /api/projects "$WORDS")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID"
out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
echo "源字幕 id=$SID1 / $SID2（行版本均为 1，字幕集 v1，规则 v1）"

echo
echo "=== 1. 整批回填：一种语言一次提交（批次编号 + 字幕集/规则版本 + 逐行清单） ==="
# 每行：字幕 ID、读取时源行版本 cue_version、译文版本 version（新建传 0/省略）、非空文本
B1="$(python3 -c "import json; print(json.dumps({
  'batch_no': 'EN-2026-001',
  'sub_version': 1,
  'rules_version': 1,
  'items': [
    {'subtitle_id': $SID1, 'cue_version': 1, 'text': 'Hello world'},
    {'subtitle_id': $SID2, 'cue_version': 1, 'text': 'Welcome'},
  ]}))")"
out="$(req POST "/api/projects/$PID/translations/en/batches" "$B1")"
echo "HTTP $(echo "$out" | code_of)："
echo "$out" | body_of | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("  批次", d["batch_no"], "新建", d["created_count"], "更新", d["updated_count"])
for i in d["items"]: print("  字幕#{} {} → v{}".format(i["subtitle_id"], i["action"], i["version"]))'

echo
echo "=== 2. 幂等：同号同内容重提（逐行顺序不同也算同一批）→ 200 返回首次结果，不再次写入 ==="
B1_REORDER="$(python3 -c "import json; print(json.dumps({
  'batch_no': 'EN-2026-001',
  'sub_version': 1,
  'rules_version': 1,
  'items': [
    {'subtitle_id': $SID2, 'cue_version': 1, 'text': 'Welcome'},
    {'subtitle_id': $SID1, 'cue_version': 1, 'text': 'Hello world'},
  ]}))")"
out="$(req POST "/api/projects/$PID/translations/en/batches" "$B1_REORDER")"
echo "HTTP $(echo "$out" | code_of)（replayed=$(echo "$out" | body_of | jget replayed)），译文版本仍为上批结果"

echo
echo "=== 3. 幂等：同号不同内容 → 409 冲突，不写入 ==="
B1_DIFF="$(python3 -c "import json; print(json.dumps({
  'batch_no': 'EN-2026-001',
  'sub_version': 1,
  'rules_version': 1,
  'items': [{'subtitle_id': $SID1, 'cue_version': 1, 'text': 'Different'}],
}))")"
req POST "/api/projects/$PID/translations/en/batches" "$B1_DIFF" | body_of

echo
echo "=== 4. 请求级拒绝（400）：同批重复 ID / 不存在的字幕 / 无效语言 ==="
echo "同批重复字幕 ID："
req POST "/api/projects/$PID/translations/en/batches" "$(python3 -c "import json; print(json.dumps({
  'batch_no': 'EN-2026-002', 'sub_version': 1, 'rules_version': 1,
  'items': [
    {'subtitle_id': $SID1, 'cue_version': 1, 'version': 1, 'text': 'A'},
    {'subtitle_id': $SID1, 'cue_version': 1, 'version': 1, 'text': 'B'},
  ]}))")" | body_of
echo "不存在的字幕："
req POST "/api/projects/$PID/translations/en/batches" "$(python3 -c "import json; print(json.dumps({
  'batch_no': 'EN-2026-002', 'sub_version': 1, 'rules_version': 1,
  'items': [{'subtitle_id': 99999, 'cue_version': 1, 'text': 'Ghost'}],
}))")" | body_of
echo "无效语言代号（路径）："
req POST "/api/projects/$PID/translations/zh%20CN/batches" "$(python3 -c "import json; print(json.dumps({
  'batch_no': 'X', 'sub_version': 1, 'rules_version': 1,
  'items': [{'subtitle_id': $SID1, 'cue_version': 1, 'text': '你好'}],
}))")" | body_of

echo
echo "=== 5. 提交时重新核对：版本过期 → 409 按行返回当前值；规则违规 → 422 按行返回原因 ==="
echo "字幕集版本过期（当前 v1，提交 v99）："
req POST "/api/projects/$PID/translations/en/batches" "$(python3 -c "import json; print(json.dumps({
  'batch_no': 'EN-2026-002', 'sub_version': 99, 'rules_version': 1,
  'items': [{'subtitle_id': $SID1, 'cue_version': 1, 'version': 1, 'text': 'Hi'}],
}))")" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ", d["error"])'
echo "译文版本过期（当前 v1，提交 v9）："
req POST "/api/projects/$PID/translations/en/batches" "$(python3 -c "import json; print(json.dumps({
  'batch_no': 'EN-2026-002', 'sub_version': 1, 'rules_version': 1,
  'items': [{'subtitle_id': $SID1, 'cue_version': 1, 'version': 9, 'text': 'Hi'}],
}))")" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
print(" ", d["error"])
for i in d["items"]: print("  行", i["subtitle_id"], i["reasons"], "当前译文 v"+str(i["current"]["translation"]["version"]))'
echo "译文超当前最大字数（默认 30 字，给 31 字）→ 422："
req POST "/api/projects/$PID/translations/en/batches" "$(python3 -c "import json; print(json.dumps({
  'batch_no': 'EN-2026-002', 'sub_version': 1, 'rules_version': 1,
  'items': [{'subtitle_id': $SID1, 'cue_version': 1, 'version': 1, 'text': 'x'*31}],
}))")" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
print(" ", d["error"])
for i in d["items"]: print("  行", i["subtitle_id"], i["reasons"])'
echo "（以上失败均整批不写入、不占编号：EN-2026-002 仍可重新提交）"

echo
echo "=== 6. 源字幕变更 → 译文待复核；整批回填允许覆盖待复核译文 ==="
req PATCH "/api/projects/$PID/subtitles/$SID1" '{"version":1,"text":"你好呀世界"}' >/dev/null
SUBV="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"
state="$(req GET "/api/projects/$PID/translations/en" | body_of | jget entries.0.state)"
echo "源文本修改后第一条译文状态=$state（review）"
B2="$(python3 -c "import json; print(json.dumps({
  'batch_no': 'EN-2026-002',
  'sub_version': $SUBV,
  'rules_version': 1,
  'items': [
    {'subtitle_id': $SID1, 'cue_version': 2, 'version': 1, 'text': 'Hi there world'},
    {'subtitle_id': $SID2, 'cue_version': 1, 'version': 1, 'text': 'Welcome!'},
  ]}))")"
out="$(req POST "/api/projects/$PID/translations/en/batches" "$B2")"
echo "覆盖回填 HTTP $(echo "$out" | code_of)："
echo "$out" | body_of | python3 -c 'import json,sys
d=json.load(sys.stdin)
print("  新建", d["created_count"], "更新", d["updated_count"])
for i in d["items"]:
    t=i["translation"]
    print("  字幕#{} {} → v{} 状态={} 源快照={!r}".format(i["subtitle_id"], i["action"], i["version"], t["status"], t["src_text"]))'

echo
echo "=== 7. 批次清单与单批查询 ==="
req GET "/api/projects/$PID/translations/en/batches" | body_of | python3 -m json.tool --no-ensure-ascii
echo "单批（首次结果原样返回）：GET /api/projects/$PID/translations/en/batches/EN-2026-002"
req GET "/api/projects/$PID/translations/en/batches/EN-2026-002" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  行数:", d["item_count"], "提交于:", d["created_at"])'

echo
echo "=== 8. 兼容：既有逐行操作 / 单语言导出 / 多语交付直接读取回填结果 ==="
echo "逐行更新（带当前译文版本 2）→ 200："
req PUT "/api/projects/$PID/translations/en/subtitles/$SID2" \
  '{"text":"Welcome!!","cue_version":1,"version":2}' | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); t=d["translation"]; print("  现在:", t["text"], "v"+str(t["version"]))'
echo "单语言导出（读取回填结果）："
out="$(req POST "/api/projects/$PID/translations/en/exports" '{}')"
echo "  HTTP $(echo "$out" | code_of) → en v$(echo "$out" | body_of | jget version)"
echo "多语交付（en+fr 冻结为一批）："
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID1" '{"text":"Bonjour le monde","cue_version":2}' >/dev/null
req PUT "/api/projects/$PID/translations/fr/subtitles/$SID2" '{"text":"Bienvenue","cue_version":1}' >/dev/null
SUBV="$(req GET "/api/projects/$PID" | body_of | jget sub_version)"
DEL="$(python3 - "$PID" "$SID1" "$SID2" "$SUBV" <<'PY'
import json, sys
pid, sid1, sid2, subv = sys.argv[1:5]
print(json.dumps({
  "note": "回填后交付",
  "sub_version": int(subv),
  "rules_version": 1,
  "languages": ["en", "fr"],
  "translations": {
    "en": [{"subtitle_id": int(sid1), "version": 2}, {"subtitle_id": int(sid2), "version": 3}],
    "fr": [{"subtitle_id": int(sid1), "version": 1}, {"subtitle_id": int(sid2), "version": 1}],
  },
}))
PY
)"
out="$(req POST "/api/projects/$PID/deliveries" "$DEL")"
echo "  HTTP $(echo "$out" | code_of)："
echo "$out" | body_of | python3 -c 'import json,sys
d=json.load(sys.stdin)
for f in d["files"]: print("  ", f["kind"], f["lang"], "v"+str(f["version"]), f["download_url"])'

echo
echo "完成。回填批次历史：GET $BASE/api/projects/$PID/translations/en/batches"
