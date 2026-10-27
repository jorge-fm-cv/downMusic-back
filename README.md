# downMusic Backend

API REST en Node.js/Express que actúa como backend de **downMusic**: busca vídeos en YouTube, obtiene sus metadatos y descarga su audio en **MP3** o **M4A** usando `yt-dlp` (y `ffmpeg` para la conversión).

El audio se transmite en *streaming* al cliente en cuanto hay datos disponibles, por lo que no es necesario esperar a que el archivo se descargue por completo en el servidor ni almacenarlo en disco.

## Características

- Búsqueda de vídeos en YouTube sin API key (mediante `ytsearch` de `yt-dlp`).
- Metadatos de un vídeo a partir de su URL (título, duración, canal, miniatura, etc.).
- Descarga de audio en streaming con dos formatos: `mp3` (remuestreo con ffmpeg) y `m4a` (remux directo).
- Calidad MP3 configurable (bitrate de 64 a 320 kbps).
- Nombres de archivo saneados y codificados para `Content-Disposition`.
- Limpieza de procesos hijos (`yt-dlp`/`ffmpeg`) si el cliente corta la descarga.
- CORS habilitado, listo para consumirse desde la app móvil.
- Límite de peticiones y de descargas simultáneas por IP (anti-DoS).
- Instalación automática de `yt-dlp` y `ffmpeg` en el build si no están en el sistema.

## Requisitos

- **Node.js 18+** (el proyecto usa `"type": "module"` y ESM).
- **yt-dlp** y **ffmpeg**. En local puedes instalarlos con el gestor de tu sistema; si no están
  en el `PATH`, `npm install` descarga binarios estáticos en `./bin` automáticamente
  (`scripts/install-binaries.mjs`, vía `postinstall`). También puedes fijarlos con
  `YTDLP_BIN` / `FFMPEG_BIN`.

Instalación de las dependencias del sistema en macOS:

```bash
brew install yt-dlp ffmpeg
```

## Instalación

```bash
git clone https://github.com/jorge-fm-cv/downMusic-back.git
cd downMusic-back
npm install
```

`npm install` ejecuta el `postinstall`, que:

1. Reutiliza `YTDLP_BIN` / `FFMPEG_BIN` si están definidos.
2. Reutiliza los binarios de `./bin` si ya existen y funcionan.
3. Reutiliza los binarios del `PATH` del sistema (brew, apt…).
4. Si no encuentra ninguno, descarga `yt-dlp` (última release oficial) y `ffmpeg`
   (build estático) en `./bin`, que `server.js` usa automáticamente.

Para omitir la descarga: `SKIP_BINARY_DOWNLOAD=1 npm install`.

## Uso

```bash
# Producción
npm start

# Desarrollo (reinicio automático con --watch)
npm run dev
```

Por defecto el servidor escucha en `http://0.0.0.0:4000`.

```bash
curl http://localhost:4000/api/health
# {"ok":true,"service":"downmusic-backend","ytdlp":"yt-dlp","ffmpeg":"ffmpeg","uptime":1.23}
```

## Despliegue en Render

En el plan gratuito de Render **no hay acceso a `apt`**, así que `yt-dlp` y `ffmpeg` no vienen
instalados. El proyecto lo resuelve en el propio build: al ejecutarse `npm install`, el
`postinstall` descarga ambos binarios estáticos en `./bin` y `server.js` los detecta solo.

Pasos:

1. Sube los cambios a GitHub y haz **Manual Deploy → Deploy latest commit** (o deja el auto-deploy).
2. Comprueba el log del build: deben aparecer líneas como
   `[binaries] yt-dlp: instalado en bin/ (…)` y `[binaries] ffmpeg: instalado en bin/ (…)`.
3. Verifica en el servicio desplegado:

   ```bash
   curl https://downmusic-back.onrender.com/api/health
   # {"ok":true,...,"ytdlp":"/opt/render/project/src/bin/yt-dlp","ffmpeg":"/opt/render/project/src/bin/ffmpeg",...}
   ```

Si `ytdlp` o `ffmpeg` siguen mostrando solo el nombre, revisa que el **Build Command** sea
`npm install` (el de por defecto) y que el build haya terminado sin errores.

Notas para el plan gratuito:

- El servicio se **duerme tras ~15 minutos sin tráfico**; la primera petición tarda en despertar.
- El disco es **efímero**: los binarios se reinstalan en cada deploy, que es justo lo que queremos
  para tener siempre un `yt-dlp` actualizado.
- Define `TRUST_PROXY=1` si añades un proxy/CDN delante para que los límites por IP sigan siendo válidos.
- En local puedes seguir usando los binarios del sistema (`brew install yt-dlp ffmpeg`); el script no descarga nada si ya los encuentra.

## Variables de entorno

| Variable                   | Por defecto | Descripción                                                                                      |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `PORT`                     | `4000`      | Puerto HTTP del servidor.                                                                        |
| `HOST`                     | `0.0.0.0`   | Interfaz de red en la que escucha.                                                               |
| `YTDLP_BIN`                | `./bin/yt-dlp` o `yt-dlp` | Ruta del ejecutable. Si está vacío se usa `./bin` y luego el `PATH`.                |
| `FFMPEG_BIN`               | `./bin/ffmpeg` o `ffmpeg` | Ruta del ejecutable. Si está vacío se usa `./bin` y luego el `PATH`.                |
| `RATE_LIMIT_WINDOW_MS`     | `60000`     | Tamaño de la ventana del límite de peticiones (ms).                                              |
| `RATE_LIMIT_MAX`           | `120`       | Peticiones por IP y ventana para el resto de `/api` (`/api/health` no cuenta).                   |
| `DOWNLOAD_RATE_LIMIT_MAX`  | `20`        | Descargas por IP y ventana.                                                                      |
| `DOWNLOAD_MAX_CONCURRENT`  | `2`         | Descargas simultáneas por IP (cada una lanza `yt-dlp`/`ffmpeg`).                                 |
| `TRUST_PROXY`              | *(vacío)*   | Confianza en `X-Forwarded-For`. Usa `1`/`true` o una lista de IPs/subredes si hay proxy delante. |

Ejemplo:

```bash
PORT=8080 YTDLP_BIN=/usr/local/bin/yt-dlp npm start
```

## Límites de peticiones (anti-DoS)

Todas las rutas de `/api` están protegidas por IP mediante un limitador en memoria
(`rate-limit.js`), sin dependencias externas:

- **Límite general**: `RATE_LIMIT_MAX` peticiones por `RATE_LIMIT_WINDOW_MS` en cualquier endpoint de `/api`.
  `/api/health` queda excluido para no romper los healthchecks.
- **Límite de descargas**: `DOWNLOAD_RATE_LIMIT_MAX` peticiones a `/api/download` por ventana.
- **Concurrencia**: como máximo `DOWNLOAD_MAX_CONCURRENT` descargas a la vez por IP, para evitar
  que un cliente sature CPU/procesos con `yt-dlp` y `ffmpeg`.

Al superar un límite la API responde `429 Too Many Requests` con `Retry-After` y un cuerpo JSON:

```json
{ "error": "Demasiadas peticiones. Inténtalo de nuevo más tarde.", "retryAfter": 42 }
```

También se envían las cabeceras `RateLimit-Limit`, `RateLimit-Remaining` y `RateLimit-Reset`
(expuestas por CORS para clientes web).

> **Importante detrás de un proxy/balanceador** (nginx, Cloudflare, Railway, Render…):
> configura `TRUST_PROXY` para que `req.ip` sea la IP real del cliente. Si no, todas las
> peticiones comparten el cubo de la IP del proxy. En despliegues con varias instancias,
> cada proceso mantiene su propio contador (no es un límite global); para eso necesitarías
> un almacén compartido como Redis.

## Endpoints

Base URL: `http://localhost:4000`

### `GET /api/health`

Comprueba que el servicio está vivo.

**Respuesta**

```json
{
  "ok": true,
  "service": "downmusic-backend",
  "ytdlp": "yt-dlp",
  "ffmpeg": "ffmpeg",
  "uptime": 42.5
}
```

### `GET /api/search`

Busca vídeos en YouTube.

| Query   | Requerido | Descripción                                        |
| ------- | --------- | -------------------------------------------------- |
| `q`     | Sí        | Texto de búsqueda.                                 |
| `limit` | No        | Número de resultados (1–20, por defecto 12).       |

```bash
curl "http://localhost:4000/api/search?q=daft%20punk&limit=5"
```

**Respuesta**

```json
{
  "results": [
    {
      "id": "5NV6Rdv1a3I",
      "title": "Daft Punk - Get Lucky (Official Audio)",
      "duration": 248,
      "durationText": "04:08",
      "channel": "Daft Punk",
      "views": 123456789,
      "thumbnail": "https://i.ytimg.com/vi/5NV6Rdv1a3I/mqdefault.jpg",
      "url": "https://www.youtube.com/watch?v=5NV6Rdv1a3I"
    }
  ]
}
```

### `GET /api/info`

Devuelve los metadatos completos de un vídeo.

| Query | Requerido | Descripción                 |
| ----- | --------- | --------------------------- |
| `url` | Sí        | URL del vídeo de YouTube.   |

```bash
curl "http://localhost:4000/api/info?url=https://www.youtube.com/watch?v=5NV6Rdv1a3I"
```

**Respuesta**

```json
{
  "id": "5NV6Rdv1a3I",
  "title": "Daft Punk - Get Lucky (Official Audio)",
  "thumbnail": "https://i.ytimg.com/vi/5NV6Rdv1a3I/maxresdefault.jpg",
  "duration": 248,
  "durationText": "04:08",
  "channel": "Daft Punk",
  "uploadDate": "20130517",
  "viewCount": 123456789,
  "likeCount": 1234567,
  "url": "https://www.youtube.com/watch?v=5NV6Rdv1a3I"
}
```

### `GET /api/download`

Extrae el audio y lo devuelve como descarga (`Content-Disposition: attachment`).

| Query     | Requerido | Descripción                                                   |
| --------- | --------- | ------------------------------------------------------------- |
| `url`     | Sí        | URL del vídeo de YouTube.                                     |
| `format`  | No        | `mp3` o `m4a` (por defecto `mp3`).                            |
| `quality` | No        | Bitrate MP3 en kbps (64–320, por defecto `128`). Ignorado en `m4a`. |
| `title`   | No        | Nombre base del archivo descargado (por defecto `audio`).     |

```bash
# MP3 a 192 kbps
curl -OJ "http://localhost:4000/api/download?url=https://www.youtube.com/watch?v=5NV6Rdv1a3I&format=mp3&quality=192&title=Get%20Lucky"

# M4A (sin recodificar, más rápido)
curl -OJ "http://localhost:4000/api/download?url=https://www.youtube.com/watch?v=5NV6Rdv1a3I&format=m4a"
```

**Errores**

| Código | Caso                                                        |
| ------ | ----------------------------------------------------------- |
| `400`  | Falta `url` / `q`, o `format` no es `mp3` ni `m4a`.         |
| `500`  | `yt-dlp` o `ffmpeg` fallan (se devuelve el error del proceso). |

Si el fallo ocurre con la respuesta ya iniciada, el servidor cierra la conexión en lugar de enviar JSON.

## Cómo funciona la descarga

1. Se lanza `yt-dlp` con `-o -` para volcar el mejor audio disponible a `stdout`.
2. Según el formato:
   - **m4a**: el stream de `yt-dlp` se envía directamente al cliente (ya es un contenedor válido).
   - **mp3**: el `stdout` de `yt-dlp` se conecta al `stdin` de `ffmpeg`, que recodifica a MP3 con el bitrate solicitado.
3. En el primer chunk recibido se envían las cabeceras y se hace `pipe` de la respuesta.
4. Al cerrarse la petición (fin normal o cancelación del cliente) se matan los procesos hijos para no dejar descargas huérfanas.

## Estructura del proyecto

```
.
├── server.js                  # Servidor Express y todos los endpoints
├── rate-limit.js              # Limitadores en memoria por IP (peticiones y concurrencia)
├── scripts/
│   └── install-binaries.mjs   # Descarga yt-dlp/ffmpeg en bin/ (postinstall)
├── bin/                       # Binarios descargados (gitignored; se crea en el build)
├── package.json               # Dependencias y scripts
├── app.json                   # Configuración de Expo/EAS del cliente
├── eas.json                   # Perfiles de build de EAS
└── README.md
```

## Notas

- Este servicio no almacena audio: todo se procesa y transmite al vuelo.
- `yt-dlp` requiere conexión a Internet y puede necesitar actualizaciones periódicas cuando
  YouTube cambia. En local: `yt-dlp -U` o `brew upgrade yt-dlp`. En Render se descarga la
  última release en cada deploy, así que basta con redesplegar.
- Uso educativo/personal. Respeta los términos de servicio de YouTube y los derechos de autor del contenido que descargues.

## Licencia

Proyecto privado. Todos los derechos reservados.
