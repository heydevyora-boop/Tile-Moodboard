import { logger } from '@utils/logger';
import { registerProcessor } from './jobQueue.service';
import { generatePrintBoard } from './printBoard.service';
import { GeneratePrintBoardInput } from '@validators/printBoard.validators';

interface ExportPayload {
  input: GeneratePrintBoardInput;
  actorId: string;
}

/**
 * Reuses generatePrintBoard exactly as-is — the queue is purely a
 * different way of *invoking* the same rendering/DB-write logic the
 * synchronous POST /print-boards/generate endpoint already uses and 43
 * existing tests already cover. Nothing about how a board actually gets
 * rendered changes; only whether the caller waits for it inline or polls
 * a job id, which matters most for large/high-DPI exports.
 */
async function processExportJob(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { input, actorId } = payload as unknown as ExportPayload;
  const board = await generatePrintBoard(input, actorId);
  return { printBoardId: board.id, fileUrl: board.fileUrl };
}

export function registerExportQueue(): void {
  registerProcessor('EXPORT', processExportJob, { concurrency: 2 });
  logger.info('Export Queue worker registered');
}
