import io

p = 'client/src/pages/ReviewPage.tsx'
s = io.open(p, encoding='utf-8').read()
old = "          {!omrConfig?.keyConfirmed&&<p className=\"notice\">Confirma y guarda la clave en la actividad antes de calcular.</p>}\n          <label style={{display:'block',marginTop:12}}><input type=\"checkbox\" checked={bubblesConfirmed} onChange={e=>{setBubblesConfirmed(e.target.checked);setBubbleGrade(null);}} /> He cotejado las {omrConfig?questionCount(omrConfig.template):bubbleAnswers.length} respuestas y la clave con los documentos originales.</label>"
new = '''          {!omrConfig?.keyConfirmed&&<p className="notice">Confirma y guarda la clave en la actividad antes de calcular.</p>}
          {omrConfig?.keyConfirmed&&<details open style={{marginTop:12}}>
            <summary><strong>Comparación: clave correcta (izquierda) vs respuesta del alumno (derecha)</strong></summary>
            <p className="small muted">Pulsa ✓ para forzar "correcta" o ✗ para forzar "errónea" en una pregunta (override manual). Si no tocas nada, el resultado es el automático. Los overrides recalculan la nota.</p>
            <div className="scroll-x"><table><thead><tr><th>Pregunta</th><th>Clave (correcta)</th><th>Alumno</th><th>Resultado</th><th>Override</th></tr></thead><tbody>
              {bubbleAnswers.map(row=>{
                const key=answerKey[row.question];
                const automatic = row.answer!==null && row.answer===key ? 'correct' : (row.answer===null?'blank':'wrong');
                const verdict = overrides[row.question] ?? automatic;
                const badge = verdict==='correct'?'✓':verdict==='wrong'?'✗':'·';
                return <tr key={`cmp-${row.question}`}>
                  <td>{row.question}</td>
                  <td>{key??'—'}</td>
                  <td>{row.answer??'en blanco'}</td>
                  <td>{badge} {verdict}</td>
                  <td><button className="btn small" onClick={()=>setOverrides(prev=>{const n={...prev}; if(n[row.question]) delete n[row.question]; else n[row.question]='correct'; setBubblesConfirmed(false);setBubbleGrade(null); return n;})}>✓</button>{' '}<button className="btn small" onClick={()=>setOverrides(prev=>{const n={...prev}; n[row.question]='wrong'; setBubblesConfirmed(false);setBubbleGrade(null); return n;})}>✗</button>{overrides[row.question]&&<button className="btn small" onClick={()=>setOverrides(prev=>{const n={...prev}; delete n[row.question]; setBubblesConfirmed(false);setBubbleGrade(null); return n;})}>limpiar</button>}</td>
                </tr>;
              })}
            </tbody></table></div>
          </details>}
          <label style={{display:'block',marginTop:12}}><input type="checkbox" checked={bubblesConfirmed} onChange={e=>{setBubblesConfirmed(e.target.checked);setBubbleGrade(null);}} /> He cotejado las {omrConfig?questionCount(omrConfig.template):bubbleAnswers.length} respuestas y la clave con los documentos originales.</label>'''
assert old in s
s = s.replace(old, new, 1)
