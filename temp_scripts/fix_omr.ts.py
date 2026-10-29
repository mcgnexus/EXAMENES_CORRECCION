import io

p = 'server/routes/omr.ts'
s = io.open(p, encoding='utf-8').read()

old1 = "const row=await db.prepare('SELECT answers,config FROM submission_omr_answers WHERE submission_id=$1').get<{answers:{question:number;answer:string|null}[];config:unknown}>(submissionId);"
new1 = "const row=await db.prepare('SELECT answers,config,overrides FROM submission_omr_answers WHERE submission_id=$1').get<{answers:{question:number;answer:string|null}[];config:unknown;overrides:Record<string,'correct'|'wrong'>|null}>(submissionId);"
assert old1 in s, 'old1 missing'
s = s.replace(old1, new1, 1)

old2 = "  scoreAnswers(row.answers,config);\n  return {answers:row.answers,config};"
new2 = "  const overrides=row.overrides??{};\n  scoreAnswers(row.answers,config,overrides);\n  return {answers:row.answers,config,overrides};"
assert old2 in s, 'old2 missing'
s = s.replace(old2, new2, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
