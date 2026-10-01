/**
 * Counts the Workers started in this process. fflate takes `Worker` from `worker_threads`
 * once, when it is first loaded, so a test that wants the count imports this file before
 * anything that loads the library.
 */
import { syncBuiltinESMExports } from 'node:module';
import workerThreads = require('node:worker_threads');

const RealWorker = workerThreads.Worker;
let started = 0;

(workerThreads as { Worker: typeof RealWorker }).Worker = class extends RealWorker {
    constructor(...args: ConstructorParameters<typeof RealWorker>) {
        started++;
        super(...args);
    }
};
syncBuiltinESMExports();

export const workers = {
    get started(): number { return started; },
    reset(): void { started = 0; },
};
