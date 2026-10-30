# Rebuilds master_sheet data from "All Plans.csv" + rows of the previous master_sheet whose BIN/PCN/GRP key is missing from it.
# Usage: python3 -I merge_master_sheet.py "<All Plans.csv>" <previous master_sheet dump.csv> <output dir>
# Outputs: master_sheet_merged.csv (full sheet), master_new_rows_review.csv, master_sheet_new.json (load with load_master_sheet.mjs)

import csv, json, sys, collections
ALLPLANS, MASTER, OUTDIR = sys.argv[1], sys.argv[2], sys.argv[3]

PLACEHOLDERS = {"", "SEE ID CARD", "N/A", "NA", "NONE", "NULL"}
def s(v): return (v or "").strip()
def norm_bin(b): return s(b).lstrip("0") or "0"
def pad_bin(b):
    b = s(b); return b.zfill(6) if b.isdigit() and len(b) < 6 else b
def norm_code(v):
    v = s(v).upper(); return "" if v in PLACEHOLDERS else v
def key(b, p, g): return (norm_bin(b), norm_code(p), norm_code(g))

# spelling fixes in the All Plans Processor column (same company, mistyped)
PROC_FIX = {"cv":"CVS/caremark","cvs":"CVS/caremark","prime":"Prime Therapeutics",
            "livin":"Liviniti","Liv":"Liviniti","MagellanRX":"MagellanRx","rx":"RxSense"}
# same company, different spelling: master pbm_name (lowercased) -> All Plans spelling. Nothing else is renamed.
ALIAS = {
  "caremark":"CVS/caremark","cvs caremark":"CVS/caremark","optum":"OptumRx","optumrx":"OptumRx",
  "medimpact":"MedImpact","magellan rx":"MagellanRx","welldyne":"WellDyne","maxorplus":"Maxor","sav-rx":"SavRx",
  "liviniti (southern scripts)":"Liviniti","goodrx":"GoodRx","connective rx":"ConnectiveRx",
  "empirx":"EmpiRx Health","empirx health":"EmpiRx Health","truerx":"TrueRx","truerx health":"TrueRx",
  "hanuma pharmacy":"Humana","humana pharmacy":"Humana","cigna":"Cigna","brightscrip":"BrightScrip",
  "proact rx":"ProAct","rightway healthcare":"RightWay","mitchell scriptadvisor":"Mitchell International",
  "cadence rx":"CadenceRx","alphascrip":"Alpha Scrip","hippo":"Hippo Technologies","medtrak":"MedTrakRx",
  "us-rx care":"US-RxCare","smithrx":"SmithRx","rxadvance":"RxAdvance","procare rx":"ProCare Rx",
  "performrx":"PerformRx","change healthcare":"Change Healthcare","navitus":"Navitus","drexi":"Drexi",
  "benecard":"Benecard","capital rx":"Capital Rx","prime therapeutics":"Prime Therapeutics",
  "express scripts":"Express Scripts","ehim":"EHIM","elixir":"Elixir","fairosrx":"FairosRx",
}
PAYER_MAP = {"commercial":"Commercial","coupon":"Discount Card","copay card":"Discount Card",
             "medicare":"Medicare Part D","medicaid":"Medicaid","workers' compensation":"Workers Comp","workers compensation":"Workers Comp"}

with open(ALLPLANS, encoding="utf-8-sig", newline="") as f:
    rdr = csv.reader(f); header = [h.strip() for h in next(rdr)]
    ap_rows = [dict(zip(header, [x.strip() for x in r])) for r in rdr if any(x.strip() for x in r)]
proc_fixes = collections.Counter()
for d in ap_rows:
    if d["Processor"] in PROC_FIX:
        proc_fixes[(d["Processor"], PROC_FIX[d["Processor"]])] += 1; d["Processor"] = PROC_FIX[d["Processor"]]
# All Plans writes "Workers Comp" 117x and "Workers Compensation" 3x: use the dominant spelling
NET_FIX = {"Workers Compensation": "Workers Comp"}
for d in ap_rows:
    if d["Network"] in NET_FIX: proc_fixes[(d["Network"], NET_FIX[d["Network"]])] += 1; d["Network"] = NET_FIX[d["Network"]]
ap_keys = {key(d["BIN"], d["PCN"], d["Group"]) for d in ap_rows}

with open(MASTER, encoding="utf-8", newline="") as f: master = list(csv.DictReader(f))
covered = 0; new_rows = []; seen = set(); dupes = 0
pbm_changes = collections.Counter(); pbm_kept = collections.Counter(); payer_changes = collections.Counter()
for m in master:
    if key(m["bin"], m["pcn"], m["grp"]) in ap_keys: covered += 1; continue
    pbm0 = s(m["pbm_name"]); pbm = ALIAS.get(pbm0.lower(), pbm0)
    (pbm_changes if pbm != pbm0 else pbm_kept)[(pbm0, pbm) if pbm != pbm0 else pbm0] += 1
    pay0 = s(m["payer_type"]); pay = PAYER_MAP.get(pay0.lower(), pay0)
    payer_changes[(pay0, pay)] += 1
    dk = key(m["bin"], m["pcn"], m["grp"]) + (pbm, pay)
    if dk in seen: dupes += 1; continue
    seen.add(dk)
    new_rows.append({"Processor": pbm, "Plan": "", "BIN": pad_bin(m["bin"]), "PCN": s(m["pcn"]).upper(),
                     "Group": s(m["grp"]).upper(), "Help Desk": "", "EPIC Contract": "", "Network": pay,
                     "_id": m["id"], "_pbm": pbm0, "_pay": pay0})

cols = ["Processor","Plan","BIN","PCN","Group","Help Desk","EPIC Contract","Network"]
merged = ap_rows + new_rows
with open(f"{OUTDIR}/master_sheet_merged.csv", "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f, quoting=csv.QUOTE_ALL); w.writerow(cols); [w.writerow([d[c] for c in cols]) for d in merged]
with open(f"{OUTDIR}/master_new_rows_review.csv", "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f, quoting=csv.QUOTE_ALL); w.writerow(cols + ["master_id","master_pbm","master_payer"])
    [w.writerow([d[c] for c in cols] + [d["_id"], d["_pbm"], d["_pay"]]) for d in new_rows]
# ---------- DB payload: the table has UNIQUE (bin, pcn, grp), so keep exactly one answer per key ----------
PAYER_PRI = ["Commercial","Medicare Part D","Medicaid","Discount Card","Workers Comp","Medicare Part B","Workers Compensation","340B"]
def pri(n): return PAYER_PRI.index(n) if n in PAYER_PRI else (len(PAYER_PRI) if n else len(PAYER_PRI) + 1)
bin_proc = collections.Counter((norm_bin(d["BIN"]), d["Processor"]) for d in ap_rows)
binpcn_net = collections.Counter((norm_bin(d["BIN"]), d["PCN"].upper(), d["Network"]) for d in ap_rows)
groups = {}
for i, d in enumerate(merged):
    groups.setdefault((norm_bin(d["BIN"]), d["PCN"].upper(), d["Group"].upper()), []).append((i, d))
db_rows = []; resolved = []; db_dupes = 0
for k, items in groups.items():
    cands = {}
    for i, d in items: cands.setdefault((d["Processor"], d["Network"]), (i, d))
    db_dupes += len(items) - len(cands)
    if len(cands) > 1:
        best = max(cands.items(), key=lambda kv: (bin_proc[(k[0], kv[0][0])], binpcn_net[(k[0], k[1], kv[0][1])], -pri(kv[0][1]), -kv[1][0]))
        resolved.append((k, best[0], [c for c in cands if c != best[0]]))
    else:
        best = next(iter(cands.items()))
    d = best[1][1]
    db_rows.append([d["BIN"], d["PCN"] or None, d["Group"] or None, d["Processor"] or None, d["Network"] or None])
json.dump(db_rows, open(f"{OUTDIR}/master_sheet_new.json", "w"))

P = print
P(f"All Plans rows: {len(ap_rows)}  spelling fixes in Processor column: {sum(proc_fixes.values())} {dict(proc_fixes)}")
P(f"master rows: {len(master)}  covered by All Plans: {covered}  new: {len(new_rows)}  dupes dropped: {dupes}")
P(f"merged CSV rows: {len(merged)}   DB rows after exact-duplicate removal: {len(db_rows)} (dups: {db_dupes})")
P(f"\n=== {len(resolved)} keys had more than one answer; kept -> dropped ===")
[P(f"  {k[0]:>7}/{k[1] or '-'}/{k[2] or '-'}: kept {keep}  dropped {drop}") for k, keep, drop in resolved]
P("\n=== PBM spelling changes on new rows ==="); [P(f"  {a!r} -> {b!r}: {n}") for (a,b),n in pbm_changes.most_common()]
P("\n=== PBM names kept as-is on new rows ==="); [P(f"  {a!r}: {n}") for a,n in pbm_kept.most_common()]
P("\n=== payer changes on new rows ==="); [P(f"  {a!r} -> {b!r}: {n}") for (a,b),n in payer_changes.most_common()]
