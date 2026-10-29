import io
p = 'server/llm/providers.ts'
s = io.open(p, encoding='utf-8').read()
anchor = chr(47)*2 + ' ' + '-'*63 + ' Simulado'
assert anchor in s, 'anchor missing'
block = open('temp_scripts/deepseek_block.txt', encoding='utf-8').read()
s = s.replace(anchor, block + anchor, 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('insertado ok')
