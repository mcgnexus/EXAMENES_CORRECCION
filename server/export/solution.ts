import PDFDocument from 'pdfkit';

function writeInline(doc: PDFKit.PDFDocument, text: string, fontSize = 10): void {
  const segments = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  for (const segment of segments) {
    const bold = segment.startsWith('**') && segment.endsWith('**');
    const code = segment.startsWith('`') && segment.endsWith('`');
    const value = bold ? segment.slice(2, -2) : code ? segment.slice(1, -1) : segment;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).text(value, {
      continued: segment !== segments.at(-1),
    });
  }
  doc.font('Helvetica').fontSize(fontSize);
}

export async function buildSolutionPdf(input: {
  title: string;
  activityTitle: string;
  markdown: string;
}): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: { Title: input.title, Subject: input.activityTitle },
  });
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.fillColor('#526178').font('Helvetica').fontSize(9).text(input.activityTitle.toUpperCase());
  doc.moveDown(0.35);
  doc.fillColor('#17233b').font('Helvetica-Bold').fontSize(21).text(input.title);
  doc.moveDown(0.55);
  doc.moveTo(48, doc.y).lineTo(547, doc.y).strokeColor('#d8e0eb').stroke();
  doc.moveDown(1);

  const lines = input.markdown.replace(/\r\n?/g, '\n').split('\n');
  let inCode = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      doc.moveDown(0.3);
      continue;
    }
    if (!line.trim()) {
      doc.moveDown(0.45);
      continue;
    }
    if (inCode) {
      doc.font('Courier').fontSize(9).fillColor('#334155').text(line, { indent: 12 });
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      doc.moveDown(level === 1 ? 0.6 : 0.35);
      doc
        .font('Helvetica-Bold')
        .fontSize(level === 1 ? 16 : level === 2 ? 13 : 11)
        .fillColor(level === 1 ? '#243b63' : '#26344b')
        .text(heading[2].replace(/\s+#+\s*$/, ''));
      doc.moveDown(0.2);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    const content = bullet?.[1] ?? numbered?.[1] ?? quote?.[1] ?? line;
    doc.fillColor(quote ? '#526178' : '#26344b');
    if (bullet || numbered) {
      doc.font('Helvetica').fontSize(10).text(bullet ? '• ' : `${line.match(/^\s*(\d+)/)?.[1]}. `, {
        continued: true,
        indent: 8,
      });
      writeInline(doc, content, 10);
      doc.moveDown(0.25);
    } else {
      writeInline(doc, content, 10);
      doc.moveDown(0.35);
    }
  }

  doc.end();
  return finished;
}
