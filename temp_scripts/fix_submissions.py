import io

p = 'server/routes/submissions.ts'
s = io.open(p, encoding='utf-8').read()

old1 = "const body = z.object({answers:z.array(z.object({question:z.number().int().min(1).max(200), answer:z.string().regex(/^[A-H]$/).nullable()})).min(1).max(200), confirmed:z.literal(true),config:z.unknown()}).parse(request.body);"
new1 = "const body = z.object({answers:z.array(z.object({question:z.number().int().min(1).max(200), answer:z.string().regex(/^[A-H]$/).nullable()})).min(1).max(200), confirmed:z.literal(true),config:z.unknown(),overrides:z.record(z.enum(['correct','wrong'])).optional()}).parse(request.body);"
assert old1 in s, 'old1 missing'
s = s.replace(old1, new1, 1)

old2 = "try{result=scoreAnswers(body.answers,config);}catch(error){throw badRequest(error instanceof Error?error.message:'Respuestas inválidas');}"
new2 = "try{result=scoreAnswers(body.answers,config,body.overrides);}catch(error){throw badRequest(error instanceof Error?error.message:'Respuestas inválidas');}"
assert old2 in s, 'old2 missing'
s = s.replace(old2, new2, 1)

old3 = "await db.prepare('INSERT INTO submission_omr_answers(submission_id,answers,config,confirmed_at) VALUES($1,$2::jsonb,$3::jsonb,$4) ON CONFLICT(submission_id) DO UPDATE SET answers=EXCLUDED.answers,config=EXCLUDED.config,confirmed_at=EXCLUDED.confirmed_at').run(submissionId,JSON.stringify(body.answers),JSON.stringify(config),nowIso());"
new3 = "await db.prepare('INSERT INTO submission_omr_answers(submission_id,answers,config,confirmed_at,overrides) VALUES($1,$2::jsonb,$3::jsonb,$4,$5::jsonb) ON CONFLICT(submission_id) DO UPDATE SET answers=EXCLUDED.answers,config=EXCLUDED.config,confirmed_at=EXCLUDED.confirmed_at,overrides=EXCLUDED.overrides').run(submissionId,JSON.stringify(body.answers),JSON.stringify(config),nowIso(),JSON.stringify(body.overrides??{}));"
assert old3 in s, 'old3 missing'
s = s.replace(old3, new3, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
