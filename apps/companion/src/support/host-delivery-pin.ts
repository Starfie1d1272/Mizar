import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, safePath } from '../resource-store/files.js';
import { readHostPin, type IncidentParticipant } from './retention.js';

/** Private local-file handshake with DesktopLog, never a caller-supplied path or receipt.
 * The request remains present until the ACK operation has finished. Host retention
 * holds committed delivery pins while this exact process instance owns that request,
 * including across Host restarts and an elapsed admission deadline. */
export function hostDeliveryParticipant(root: string, signal: AbortSignal): IncidentParticipant {
  const directory = join(root, 'host-delivery-pins');
  let ownerInstance: string | undefined;
  const request = async (pinId: string, action: 'prepare' | 'commit') => {
    if (signal.aborted) throw new Error('ack_cleanup_cancelled');
    if (!/^[a-f0-9-]{36}$/.test(pinId)) throw new Error('host_pin_id_invalid');
    await safePath(root);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await safePath(directory);
    const requestId = randomUUID();
    const deadline = Date.now() + 5000;
    await atomicJson(join(directory, `${pinId}.json`), {
      schema: 'mizar-host-delivery-request/1',
      pinId,
      requestId,
      action,
      ownerPid: process.pid,
      ...(ownerInstance ? { ownerInstance } : {}),
      expiresAt: deadline,
    });
    while (!signal.aborted && Date.now() < deadline) {
      try {
        const path = await safePath(directory, `${pinId}.response.json`);
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const meta = await file.stat();
          if (!meta.isFile() || meta.nlink !== 1 || meta.size > 4096)
            throw new Error('host_delivery_response_unsafe');
          const value = JSON.parse(await file.readFile('utf8')) as {
            schema: string;
            pinId: string;
            requestId: string;
            ownerPid: number;
            ownerInstance?: string;
            error?: string;
          };
          if (
            value.schema === 'mizar-host-delivery-response/1' &&
            value.pinId === pinId &&
            value.requestId === requestId &&
            value.ownerPid === process.pid
          ) {
            if (value.error)
              throw new Error('host_delivery_request_failed', { cause: value.error });
            if (!value.ownerInstance || (ownerInstance && ownerInstance !== value.ownerInstance))
              throw new Error('host_delivery_owner_changed');
            ownerInstance = value.ownerInstance;
            return await readHostPin(root, pinId, 'delivery');
          }
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await delay(50, undefined, { signal });
    }
    throw new Error(signal.aborted ? 'ack_cleanup_cancelled' : 'host_delivery_request_timeout');
  };
  return {
    producerId: 'host',
    prepare: (pinId) => request(pinId, 'prepare'),
    commit: (pinId) => request(pinId, 'commit'),
    release: async (pinId) => {
      // Withdraw before deleting the response. A late native prepare/commit cannot
      // resurrect a hold without the request; native owns receipt cleanup.
      await safePath(directory, `${pinId}.json`)
        .then(unlink)
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      await safePath(directory, `${pinId}.response.json`)
        .then(unlink)
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
    },
  };
}
