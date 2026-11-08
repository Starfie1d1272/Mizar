import { parentPort, workerData } from 'node:worker_threads';
import { runArchiveWorker, type ArchiveWorkerData } from './archive-worker.js';

if (!parentPort) throw new Error('archive_worker_requires_parent');
const port = parentPort;
runArchiveWorker(workerData as ArchiveWorkerData, (message) => port.postMessage(message));
