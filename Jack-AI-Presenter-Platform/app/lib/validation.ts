import type { FileKind, UploadedFile } from "../session/types";

export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

const EXTENSION_TO_KIND: Record<string, FileKind> = {
  pdf: "pdf",
  pptx: "pptx",
  ppt: "ppt",
  docx: "docx",
  doc: "doc",
  txt: "txt",
};

export const ACCEPTED_EXTENSIONS = Object.keys(EXTENSION_TO_KIND);

export interface ValidationRejection {
  fileName: string;
  reason: string;
}

export interface ValidationResult {
  accepted: UploadedFile[];
  rejected: ValidationRejection[];
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function dedupeKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function validateAndDedupeFiles(
  incoming: File[],
  existing: UploadedFile[],
): ValidationResult {
  const existingKeys = new Set(existing.map((f) => dedupeKey(f.file)));
  const seenInBatch = new Set<string>();
  const accepted: UploadedFile[] = [];
  const rejected: ValidationRejection[] = [];

  for (const file of incoming) {
    const ext = extensionOf(file.name);
    const kind = EXTENSION_TO_KIND[ext];
    const key = dedupeKey(file);

    if (!kind) {
      rejected.push({
        fileName: file.name,
        reason: `Unsupported format ".${ext || "unknown"}". Accepted: ${ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(", ")}`,
      });
      continue;
    }
    if (file.size > MAX_FILE_SIZE) {
      rejected.push({
        fileName: file.name,
        reason: `File is larger than 100 MB (${(file.size / (1024 * 1024)).toFixed(1)} MB).`,
      });
      continue;
    }
    if (existingKeys.has(key) || seenInBatch.has(key)) {
      rejected.push({
        fileName: file.name,
        reason: "Already added.",
      });
      continue;
    }

    seenInBatch.add(key);
    accepted.push({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      size: file.size,
      kind,
      status: "queued",
    });
  }

  return { accepted, rejected };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
