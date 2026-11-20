# Catálogo de comandos publicado por el host

El palette deja de tener comandos propios: consume el catálogo que publica `../gentle-pi` (builtins de pi incluidos), pinta lo que no puede ejecutar como solo-terminal, y ejecuta lo demás por `run_command`.

## Specs

S1 — Fuente única. El catálogo de comandos de un chat es `get_snapshot.commands` del host (sección `commands` de `get_snapshot`, `runnable` por entrada). Mientras ese método no esté anunciado en `capabilities.methods` o la sección no llegue, Desktop conserva el catálogo de hoy (`get_commands`) como degradación explícita: nunca se mezclan los dos ni se completa uno con el otro.

S2 — `ChatCommand` conserva `name`, `description`, `source` y añade `runnable: boolean` y `args?: string`. `source` pasa a `"builtin" | "extension" | "prompt" | "skill"`. Un `source` fuera de ese conjunto sigue descartándose (fail-closed).

S3 — El palette pinta el catálogo completo agrupado por `source`, con el grupo Builtin después de Extension. La ejecución de una fila se decide por contrato, nunca por una lista de nombres en el cliente:

| entrada | ejecución |
| --- | --- |
| `runnable: true` | `run_command` del host (S4) |
| `source` `extension` / `prompt` / `skill` con `runnable: false` | envío de `/name` como prompt al hijo, que es el camino ya probado hoy: pi despacha esos comandos antes de llegar al modelo |
| `source` `builtin` con `runnable: false` | solo-terminal: se muestra, no se despacha, y el status line dice por qué |

Una entrada se muestra siempre: es información del host, no ruido. El aviso de solo-terminal existe para no fingir que algo corrió, no para esconder lo que el host publica.

S4 — Ejecución uniforme. Una entrada `runnable: true` se ejecuta con `bridge.runCommand(hostId, name, args?)`; main la traduce a la petición `run_command` del host, con la misma puerta de capacidad que el resto de métodos (`advertisedMethods`). Respuestas: `{executed: true}` limpia el status line; `{executed: false, reason}` lo explica. El error retryable `session_switching` no es un fallo: se informa como "el host está cambiando de sesión, reintenta" y nunca se marca como ejecutado. Ninguna respuesta lanza.

S5 — Desktop no declara comandos. Se retiran `APP_NEW_CHAT`, `APP_RESUME` y la prop `appCommands`: `/new` y `/resume` llegan del catálogo. El único flujo propio que queda es la selección de sesión del `/resume`: el cliente abre su selector y entrega el `path` como `args` a `runCommand`.

S6 — Nada se calla. Un nombre escrito que no esté en el catálogo, o que esté marcado solo-terminal, se anuncia en el status line; nunca se envía al modelo como si fuera un comando.

S7 — Documentación. README y el estado vacío del palette describen la fuente real (catálogo del host, builtins incluidos) y dejan de afirmar que los builtins viven solo en la terminal.

## Tasks

| ID | Specs | Ruta | Commit |
| --- | --- | --- | --- |
| T1 | S1, S2 | Parser del catálogo + petición y fold en `PiSession` + tipos compartidos | — |
| T2 | S3, S5 | Palette por catálogo, retirada de `appCommands`, flujo del selector de sesión | — |
| T3 | S4, S6 | `run_command` de punta a punta (IPC, preload, main) + avisos del composer | — |
| T4 | S7 | README y copias del palette | — |

Contrato del host: `../gentle-pi/odd/tasks/desktop-run-command.md` (S1-S6), implementado en `lib/desktop-rpc-commands.ts` y `lib/desktop-feed.ts` de ese repo.

## Log

L1 (petición original, verbatim):

> En la lista de comandos ofrecidos por el spotlight no veo que se estén listando absolutamente todos. Por ejemplo me falta el comando /new para iniciar una nueva sesión de chat y otros comandos como /gentle:profiles no hacen nada

L2 (decisión del dueño, verbatim):

> La solución para mi pasa por utilizar el canal rpc ya implementado en ../gentle-pi pero quiero validarlo
>
> 1. ¿Confirmas esta forma de contrato para gentle-pi? — Sí: runnable + run_command
> 2. ¿Hasta dónde puedo escribir en ../gentle-pi? — Sí, contrato y ejecución allí

L3 (estado previo, verificado): Desktop nunca pidió `get_snapshot`; su único catálogo era `get_commands` de pi y `parseCommandList` descartaba cualquier `source` fuera de extension/prompt/skill, así que un `builtin` se perdía antes de llegar al palette. La lista de skills del footer sigue leyendo `source === "skill"`, que el catálogo del host conserva.

L4 (T1–T4 implementados en esta unidad, sin commit): T1 — parser puro `commandCatalog.ts` (fail-closed sobre `{items, truncated}`, orden del host, `args` solo string o ausente) con fixture `__fixtures__/host-commands.json`; `PiSession` pide UNA fuente: `get_snapshot {sections:["commands"]}` si está anunciado (epoch binding, `session_unavailable`/fallo conservan el catálogo previo, nada inventado) y si no `get_commands` como degradación con `runnable: false` en cada entrada; tipos compartidos: `ChatCommandSource` + `"builtin"`, `ChatCommand.runnable`/`args?`, `ChatState.commands` re-documentado. T2 — palette sin `APP_NEW_CHAT`/`APP_RESUME`/`appCommands`/`onNewChat`/`onResumeChat`; grupos Prompt/Skill/Extension/**Builtin**; matriz de ejecución por contrato (runnable → `runCommand`; extension/prompt/skill no-runnable → `/name` como prompt; builtin no-runnable → mostrado, no despachado, status line dice por qué); `/resume` mantiene el selector propio y entrega el path como args a `runCommand` (único caso por nombre). T3 — un canal `chat.runCommand`, `bridge.runCommand(hostId, name, args?)`, handler en main con la misma puerta `advertisedMethods` que `requestWorktree`, tipo `ChatCommandRunResult` (executed / refused terminal_only|unknown_command / session_switching / transport con mensaje); status line: executed limpia, refusal nombra, switching dice que reintente y nunca es "ejecutado", transport muestra su mensaje; `unlistedSlashNotice` (S6): nombre ausente y builtin solo-terminal producen su aviso, y un builtin runnable tecleado también se anuncia (nunca se despacha desde un prompt). T4 — README y estado vacío del palette describen el catálogo del host con builtins incluidos y dejan de afirmar que viven solo en la terminal. RED/GREEN: parser 9 tests (RED por módulo ausente), palette 16 (RED por props/grupo), container 80, PiSession 86, ChatHost +1, registerHandlers +2, sessionList +2, mockBridge +1 — números exactos en la respuesta de la unidad.

L5 (decisión del dueño, verbatim, ampliación de superficies aprobada): la cadena `run_command` necesitaba dos rutas fuera de la lista original: `ChatHost.runCommand(name, args?)` como passthrough nombrado espejo de `stopHelper` (con su test), y `SessionInfoLike.path` llevado a `ChatSummary.path?` en `sessionList.ts` (con test, incluido el caso sin path). El dueño aprobó ambas. Regla añadida: cuando el host no reporta path, la fila de resume dice "path unknown" y se niega a llamar `run_command` (nunca envía el id como si fuera path); `resume` va por `run_command` (`switchSession(args)` del host), no por la ruta legacy `chat.open`. Los mocks (`mockBridge`) simulan la sustitución de sesión en-el-hijo (mismo host id) para `new`/`resume`.

L6 (cierre de la unidad): el dueño aprobó una segunda ampliación de superficie, `Footer.test.tsx`, solo para añadir `runnable: false` a sus cuatro literales de fixture (consecuencia mecánica de que `runnable` sea requerido en `ChatCommand`, S2 — el campo se mantiene requerido). Totales finales: `pnpm vitest run` 1036 tests / 63 archivos, todos verdes; `pnpm typecheck` limpio. La degradación sin `get_snapshot` queda probada por los tests de PiSession ("without the get_snapshot advertisement the catalog stays pi's get_commands", "requests get_commands once, after the probe...") y por el palette-row prompt path del container ("runs a non-runnable extension row as '/name' — the proven prompt path"); que una fila builtin nunca llega a `sendMessage` lo prueban "runs the catalog's runnable /new row through bridge.runCommand" y "shows a terminal-only builtin row, dispatches nothing, and says why" (ambas niegan `sendMessage`). Nada quedó abierto; nada está en commit.

L7 (decisión del dueño, verbo original): «¿El spotlight de la GUI que lógica sigue para mostrar los comandos cuando se escribe en el buscador? Porque escirviendo new veo que muestra comandos que nada tienen que ver con lo escrito». Causa encontrada: el filtro comparaba `includes(needle)` contra el NOMBRE **o** la descripción con la misma importancia y sin ranking, así que "new" traía los skills cuya prosa dice "new skill" y dejaba `/new` al final (el grupo Builtin se pinta último). Opciones ofrecidas; el dueño eligió «Solo por nombre, nunca por descripción». Implementado en `CommandPalette.tsx` (match exclusivo por `name`, sin tocar el orden de grupos ni el orden del host dentro de cada grupo). Tests: el caso "matches the command NAME only" reescrito (`/RE` → `/skill:review` y `/resume`, ya no `plan`/`fork` por prosa) y un test nuevo que fija la regresión reportada ("new" devuelve solo `/new`; una palabra que solo existe en una descripción no devuelve nada y el palette lo dice). Totales: `pnpm vitest run` 1037 tests / 63 archivos verdes; `pnpm typecheck` limpio. Queda sin implementar, y no pedido: desempatar por prefijo antes que por subcadena dentro de cada grupo (cambiaría el orden del host que hoy está fijado por test).
