"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getExtractionQueue = getExtractionQueue;
const logger_1 = require("@utils/logger");
class ExtractionQueue {
    constructor(maxConcurrent, processFn) {
        this.queue = [];
        this.running = new Set();
        this.maxConcurrent = maxConcurrent;
        this.processFn = processFn;
    }
    enqueue(catalogId) {
        this.queue.push(catalogId);
        logger_1.logger.debug(`Catalog ${catalogId} enqueued for extraction (queue depth: ${this.queue.length})`);
        this.tick();
    }
    getPosition(catalogId) {
        if (this.running.has(catalogId))
            return 0;
        const idx = this.queue.indexOf(catalogId);
        return idx === -1 ? -1 : idx + 1;
    }
    get queueDepth() {
        return this.queue.length;
    }
    get runningCount() {
        return this.running.size;
    }
    tick() {
        while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
            const catalogId = this.queue.shift();
            if (!catalogId)
                break;
            this.running.add(catalogId);
            this.processFn(catalogId)
                .catch((err) => {
                logger_1.logger.error(`Extraction queue: job for catalog ${catalogId} crashed`, { error: err.message });
            })
                .finally(() => {
                this.running.delete(catalogId);
                this.tick();
            });
        }
    }
}
let queueInstance = null;
function getExtractionQueue(maxConcurrent, processFn) {
    if (!queueInstance) {
        queueInstance = new ExtractionQueue(maxConcurrent, processFn);
    }
    return queueInstance;
}
//# sourceMappingURL=extractionQueue.service.js.map