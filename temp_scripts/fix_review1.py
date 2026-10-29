import io

p = 'client/src/pages/ReviewPage.tsx'
s = io.open(p, encoding='utf-8').read()
s = s.replace(
  "  const [bubblesConfirmed, setBubblesConfirmed] = useState(false);",
  "  const [bubblesConfirmed, setBubblesConfirmed] = useState(false);\n  const [overrides, setOverrides] = useState<Record<number,'correct'|'wrong'>>({});",
  1)
s = s.replace(
  "      setBubblesConfirmed(false);\n      setBubbleGrade(null);\n      setTestWorkflow(prev=>prev?{...prev,confirmed:false}:prev);",
  "      setBubblesConfirmed(false);\n      setBubbleGrade(null);\n      setOverrides({});\n      setTestWorkflow(prev=>prev?{...prev,confirmed:false}:prev);",
  1)
s = s.replace(
  "{ answers: bubbleAnswers.map(x => ({question:x.question, answer:x.answer})), config:omrConfig, confirmed:true },",
  "{ answers: bubbleAnswers.map(x => ({question:x.question, answer:x.answer})), config:omrConfig, confirmed:true, overrides },",
  1)
