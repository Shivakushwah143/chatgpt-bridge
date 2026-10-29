import { HttpError } from '../httpError.js';
import { initSse } from './eventStreams.js';

/**
 * Durable request routes for Kodevra's chatgpt-web transport.
 *
 * These sit beside the OpenAI-compatible `/v1` API and change nothing about it:
 * other consumers keep the synchronous contract, while Kodevra submits a turn,
 * gets a request id back immediately and polls a short status request until the
 * answer materializes. The long duration belongs to the persisted request, not
 * to an HTTP socket.
 *
 * Registered after the API-token middleware, so they are protected exactly like
 * the rest of the local API surface.
 */
export function registerKodevraDurableRoutes(router, { durableRequests, liveResponseStream = null }) {
  router.post('/kodevra/requests', (req, res, next) => {
    try {
      const result = durableRequests.submit(req.body || {});
      res.status(result.replayed ? 200 : 202).json({
        ok: true,
        protocol: 'kodevra-durable-v1',
        request_id: result.record.request_id,
        status: result.record.status,
        replayed: result.replayed,
        created_at: result.record.created_at,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Optional display-only channel for one in-flight turn.
   *
   * It carries response.started / response.delta / response.recovering /
   * response.completed and nothing else. The durable status endpoint above stays
   * authoritative: a client that never opens this stream still gets the exact
   * same answer, and losing the stream cannot fail a turn.
   */
  router.get('/kodevra/requests/:id/events', (req, res, next) => {
    try {
      const record = durableRequests.status(req.params.id);
      if (!record) throw new HttpError(404, `Unknown request: ${req.params.id}`);
      if (!liveResponseStream) throw new HttpError(503, 'Live response streaming is not configured');
      initSse(res);
      res.write(': connected\n\n');
      let closed = false;
      let unsubscribe = () => {};
      const keepalive = setInterval(() => {
        if (!closed) res.write(': keepalive\n\n');
      }, 15_000);
      keepalive.unref?.();
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
      };
      const write = (event) => {
        if (closed) return;
        res.write(`id: ${event.seq}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'response.completed') {
          cleanup();
          res.end();
        }
      };
      const after = Math.max(0, Number(req.query?.after) || 0);
      unsubscribe = liveResponseStream.subscribe(req.params.id, write, { after });
      req.on('close', () => cleanup());
    } catch (err) {
      next(err);
    }
  });

  router.get('/kodevra/requests/:id', (req, res, next) => {
    try {
      const record = durableRequests.status(req.params.id);
      if (!record) throw new HttpError(404, `Unknown request: ${req.params.id}`);
      res.json({ ok: true, protocol: 'kodevra-durable-v1', ...record });
    } catch (err) {
      next(err);
    }
  });

  router.get('/kodevra/requests', (req, res, next) => {
    try {
      res.json({
        ok: true,
        protocol: 'kodevra-durable-v1',
        requests: durableRequests.list({ limit: Number(req.query?.limit) || 50 }),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/kodevra/requests/:id/cancel', (req, res, next) => {
    try {
      const record = durableRequests.cancel(req.params.id, String(req.body?.reason || 'Cancelled by client'));
      if (!record) throw new HttpError(404, `Unknown request: ${req.params.id}`);
      res.json({ ok: true, protocol: 'kodevra-durable-v1', ...record });
    } catch (err) {
      next(err);
    }
  });
}
