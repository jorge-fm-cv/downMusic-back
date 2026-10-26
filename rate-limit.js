// ---------------------------------------------------------------
// Limitadores en memoria (sin dependencias externas)
//
// Nota: el estado vive en el proceso. Si el backend corre en varias
// instancias detrás de un balanceador, cada una aplica su propio cupo;
// para un límite global haría falta un almacén compartido (p. ej. Redis).
// ---------------------------------------------------------------

const MAX_ENTRIES = 100_000;

/** IP del cliente (requiere `trust proxy` bien configurado detrás de un proxy). */
function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Límite de peticiones por ventana fija de tiempo y por IP.
 *
 * @param {object} options
 * @param {number} options.windowMs  Duración de la ventana en milisegundos.
 * @param {number} options.max       Peticiones permitidas por ventana.
 * @param {string} options.message   Mensaje devuelto al superar el límite.
 * @param {(req: import('express').Request) => boolean} [options.skip]
 *   Permite excluir peticiones concretas del cómputo.
 */
export function createRateLimiter({ windowMs, max, message, skip }) {
  const buckets = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (now >= entry.resetAt) buckets.delete(key);
    }
  }, windowMs);
  cleanup.unref?.();

  return function rateLimiter(req, res, next) {
    if (skip?.(req)) return next();

    const key = clientKey(req);
    const now = Date.now();
    let entry = buckets.get(key);

    if (!entry || now >= entry.resetAt) {
      // Evita crecimiento sin control si llegan muchísimas IPs distintas.
      if (!entry && buckets.size >= MAX_ENTRIES) {
        buckets.delete(buckets.keys().next().value);
      }
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }

    entry.count += 1;

    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    const remaining = Math.max(0, max - entry.count);

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(resetSeconds));
      return res.status(429).json({ error: message, retryAfter: resetSeconds });
    }

    next();
  };
}

/**
 * Límite de peticiones simultáneas por IP.
 * Pensado para endpoints caros (cada descarga lanza yt-dlp/ffmpeg).
 *
 * @param {object} options
 * @param {number} options.max     Peticiones concurrentes permitidas por IP.
 * @param {string} options.message Mensaje devuelto al superar el límite.
 */
export function createConcurrencyLimiter({ max, message }) {
  const active = new Map();

  return function concurrencyLimiter(req, res, next) {
    const key = clientKey(req);
    const current = active.get(key) || 0;

    if (current >= max) {
      res.setHeader('Retry-After', '10');
      return res.status(429).json({ error: message, retryAfter: 10 });
    }

    active.set(key, current + 1);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (active.get(key) || 1) - 1;
      if (left <= 0) active.delete(key);
      else active.set(key, left);
    };

    // `close` cubre cancelaciones; `finish`, respuestas completas.
    res.on('close', release);
    res.on('finish', release);

    next();
  };
}
