import os, json, urllib.request, sys
DECIDE_URL=os.environ.get("AINIZE_DECIDE_URL","https://ainize.ai/api/decide")
ART={"a1":"모네 인상 해돋이 — 항구의 일출, 주황빛, 배, 유화","a2":"페르메이르 진주 귀걸이 소녀 — 인물 초상, 유화"}
DESC="해질녘 바다 위 작은 배, 주황빛 노을, 유화"
body={"model":"clef-flash","state":{"묘사":DESC,"목록":ART},"questions":{k:{"type":"noul","instructions":"이 작품이 묘사와 일치하는가?"} for k in ART}}
req=urllib.request.Request(DECIDE_URL,data=json.dumps(body,ensure_ascii=False).encode(),headers={"content-type":"application/json"})
r=json.loads(urllib.request.urlopen(req,timeout=180).read())
for i,(k,p) in enumerate(sorted(((k,r["answers"][k]["noul"]) for k in ART),key=lambda x:-x[1]),1): print(f"{i}. {p:.3f} {k}")
