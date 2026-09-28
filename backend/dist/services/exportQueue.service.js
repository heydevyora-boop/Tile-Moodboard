"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerExportQueue = registerExportQueue;
const logger_1 = require("@utils/logger");
const jobQueue_service_1 = require("./jobQueue.service");
const printBoard_service_1 = require("./printBoard.service");
async function processExportJob(payload) {
    const { input, actorId } = payload;
    const board = await (0, printBoard_service_1.generatePrintBoard)(input, actorId);
    return { printBoardId: board.id, fileUrl: board.fileUrl };
}
function registerExportQueue() {
    (0, jobQueue_service_1.registerProcessor)('EXPORT', processExportJob, { concurrency: 2 });
    logger_1.logger.info('Export Queue worker registered');
}
//# sourceMappingURL=exportQueue.service.js.map