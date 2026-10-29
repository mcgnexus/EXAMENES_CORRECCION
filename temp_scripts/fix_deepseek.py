import io

p = 'server/llm/providers.ts'
s = io.open(p, encoding='utf-8').read()

old1 = '    text: \\DeepSeek no procesa im\u00e1genes: se omiten \\ imagen(es) (\\). Trabaja solo con el texto disponible y se\u00f1\u00e1lalo en tus comentarios si afecta a la respuesta.\\,'
new1 = "    text: `DeepSeek no procesa im\\u00e1genes: se omiten ${images.length} imagen(es) (${images.map((i) => i.label).join('; ')}). Trabaja solo con el texto disponible y se\\u00f1\\u00e1lalo en tus comentarios si afecta a la respuesta.`,"
assert old1 in s, 'old1 missing'
s = s.replace(old1, new1, 1)

old2 = '    return \\Conexi\\u00f3n correcta con DeepSeek (\\)\\;'
new2 = "    return `Conexi\\u00f3n correcta con DeepSeek (${text.trim() || 'sin respuesta'})`;"
assert old2 in s, 'old2 missing'
s = s.replace(old2, new2, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('done')
EOF