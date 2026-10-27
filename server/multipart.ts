import type { FastifyRequest } from 'fastify';
import { badRequest } from './errors';

export interface MultipartFile {
  buffer: Buffer;
  filename: string;
  mimetype: string;
}

export async function collectMultipart(request: FastifyRequest): Promise<{
  fields: Record<string, string>;
  files: MultipartFile[];
}> {
  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];
  if (!request.isMultipart()) throw badRequest('Se esperaba una petición multipart/form-data');
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (buffer.length > 0) {
        files.push({ buffer, filename: part.filename, mimetype: part.mimetype });
      }
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  return { fields, files };
}
