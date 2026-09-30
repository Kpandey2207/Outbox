import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { emailQueue } from './emailQueue.js';

export const BULL_BOARD_PATH = '/admin/queues';

export function bullBoardRouter() {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);
  createBullBoard({
    queues: [new BullMQAdapter(emailQueue(), { readOnlyMode: false })],
    serverAdapter,
    options: { uiConfig: { boardTitle: 'Outbox queues' } },
  });
  return serverAdapter.getRouter();
}
