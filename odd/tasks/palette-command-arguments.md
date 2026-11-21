# palette-command-arguments

Resuelve los argumentos de `name`, `model` y `thinking` con el mismo patrón que la TUI: una pantalla
propia, no sintaxis escrita a mano.

## Specs

S1 — La paleta abre una pantalla propia para el valor y lo manda como `args` del `run_command` que ya
existe. Solo `name` pide texto, porque en la TUI tampoco tiene pantalla: el dueño lo describió así,
verbatim: «Revisa como se resuelve en la TUI lo del argumento, porque en la TUI el usuario tampoco
escribe args se le lleva por distintas pantallas».

S2 — `model` abre un selector con búsqueda incremental sobre la lista REAL de modelos disponibles que
reporta el hijo (`get_available_models`, `{models}`), con el modelo actual preseleccionado y primero.
Confirmar manda `provider/id` como `args`. Un modelo sin nombre visible se muestra como
`provider/id`; nunca se inventa un nombre.

S3 — `thinking` ofrece exactamente los niveles que reporta el hijo
(`get_available_thinking_levels`, `{levels}`) y preselecciona el actual; confirmar manda el nivel como
`args`.

S4 — `name` pide texto, prefijado con el nombre actual del chat, y no acepta vacío: el host lo
rechaza, así que la pantalla no puede enviarlo.

S5 — Ningún comando ejecutable se presenta como si viviera solo en la terminal. Un builtin runnable
que necesita argumento dice que necesita un argumento y ofrece su pantalla.

S6 — Sin lista del hijo (host que no la responde, respuesta fallida o vacía) la paleta no inventa
opciones: `model` cae a un campo de búsqueda cuyo texto va como `args`, `thinking` cae a la unión
cerrada ya tipada, y el estado lo dice. El arranque y el resto de la paleta no cambian.

S7 — Tras un `run_command` ejecutado que cambia el modelo, el nivel de pensamiento o el nombre de la
sesión, el estado que la GUI muestra se relee de inmediato: el footer refleja el cambio sin esperar a
una interacción posterior con el chat. El dueño lo reportó así, verbatim: «Lo que está pasando es que
el footer no se actualiza tras realizar los cambios, sino tras realizar una primera interacción con el
chat».

## Tasks

| ID | Specs | Ruta | Commit |
| --- | --- | --- | --- |
| T1 | S2, S3 | `PiSession` + bridge + IPC: `get_available_models` y `get_available_thinking_levels` por el canal RPC nativo, correlacionados y acotados, con tipos compartidos | — |
| T2 | S4 | El nombre actual de la sesión en el estado, decodificado de `get_state`, para prefijar la pantalla | — |
| T3 | S1, S2, S3, S4, S6 | Renderer: tres pantallas y el ruteo desde la paleta | — |
| T4 | S5 | Mensajes de paleta y línea de estado: un runnable con argumento no se manda a la terminal | — |
| T5 | S7 | `PiSession.runCommand`: releer la identidad tras un `executed` de `model`, `thinking` o `name` | — |
| T6 | S8 | `ModelSelectorDialog` y `ThinkingSelectorDialog`: flechas activas con cualquier foco, y la lista acompaña a la selección | — |
| T7 | S9 | Ambas pantallas y `AppDialogs.css`: pie y marca de aplicado en `thinking`, fila y lista compartidas, foco y trampa de Tab alineados | — |
| T10 | S10 | Un solo reborde de selección compartido en las tres superficies (paleta, modelo, nivel) | revertido por L10 |
| T12 | S11 | Paleta, modelo y nivel: flechas activas sin foco en el campo, y foco recuperado al volver a la ventana | — |

## Log

L1 (petición del dueño, verbatim):

> Revisa como se resuelve en la TUI lo del argumento, porque en la TUI el usuario tampoco escribe args se le lleva por distintas pantallas

L2 (decisión del dueño, verbatim, sobre el alcance): «Espejo completo con selector de modelos».

L3 (evidencia de la TUI, verificada en pi 0.85.1): `/model` sin argumento abre un selector a pantalla completa con búsqueda difusa incremental, actual preseleccionado y ordenado primero, default después, refresco en segundo plano con deadline de 15 s; con argumento busca coincidencia exacta y, si no la hay, abre el mismo selector precargado. `/thinking` sin argumento abre un selector con lista y descripción por nivel, marcando actual y default; con argumento válido aplica al instante y con uno inválido muestra la lista. `/name` no abre ninguna pantalla: imprime el nombre actual o `Usage: /name <name>`.

L4 (evidencia de las formas de cable, verificada): `get_available_models` responde `{models}` donde el snapshot es `readonly Model[]` (`dist/modes/rpc/rpc-mode.js:383-385`, `dist/core/model-runtime.d.ts:68`); `get_available_thinking_levels` responde `{levels: string[]}` (`:401-403`). Ambos son comandos RPC nativos de pi en el mismo stdin/stdout que la GUI ya usa para `get_state`, `get_messages` y `get_commands`. El escritorio no tiene hoy ningún control de modelo, nivel ni renombrado: el footer solo los muestra en lectura.

L5 (T1-T4 entregados, sin commit): T1 — dos lecturas nativas en `PiSession` con id de correlación propio, tres resultados (`ok`/`unsupported`/`failed`), lista de modelos acotada a 500 con `truncated` explícito, niveles fuera de la unión cerrada descartados (nunca coercionados), y `sessionName` decodificado de `get_state`; hilos ChatHost → IPC → preload → tipos → mock. T3/T4 — tres pantallas (selector de modelo con búsqueda por subcadena, selector de nivel, input de nombre) siguiendo el patrón de `ResumeSessionDialog`, degradación a input/unión cerrada con etiqueta de fuente cuando el hijo no reporta lista, y el aviso «runs only in its terminal UI» retirado para comandos ejecutables.

L6 (verificador: FAIL y corrección): el verificador independiente dio **FAIL** con un bloqueante real y bien argumentado: el ruteo miraba `entry.args`, pero el host declara `args: null` para `model` y `thinking` (solo `name` lleva `"<name>"`), y `parseCommandCatalog` descarta un `args` nulo, así que las dos pantallas eran código muerto y los tests lo tapaban con filas inventadas (`args: "[filter]"`, un `compress` inexistente). Corrección: tests contra el payload real del host (RED de 8 fallos, con las dos pantallas sin abrirse), ruteo por NOMBRE con una tabla única y un solo `confirmScreen`, y los dos avisos del selector de niveles (lista vacía exitosa distinta de lectura fallida, y el efecto de foco duplicado colapsado). Re-verificación: **PASS**, con prueba de mutación (volver a añadir la condición `args` tumba 12 tests), 114/114 en los archivos tocados, suite completa 1106/1106 y typecheck limpio. Avisos cosméticos aceptados sin tocar.

L7 (S7, el footer tras el cambio): el dueño reportó que el modelo y el razonamiento sí cambian pero el footer solo se entera tras una primera interacción. Causa verificada: la identidad (`get_session_stats` + `get_state`) solo se relee al adoptar el canal y en `agent_settled`, y el brazo `executed` de `runCommand` no disparaba nada, así que el cambio quedaba invisible hasta el siguiente turno asentado. Se reutiliza el helper existente `requestIdentity()` para `model`, `thinking` y `name`, y nada más: `compact` sigue sin releer. Se eligió releer en vez de plegar `session_state_changed` porque ese evento trae el modelo como id pelado, sin nombre ni proveedor, y no trae el nombre de sesión — plegarlo degradaría la etiqueta del footer y dejaría `/name` viejo. Evidencia: RED observado al quitar la línea (1 test falla, faltaba la relectura) y GREEN con ella; `PiSession.test.ts` 104/104 y typecheck limpio.

S8 — La navegación con flechas de las pantallas de selección está activa siempre, tenga el foco el campo de búsqueda o la lista, y la lista se desplaza para mantener visible la opción seleccionada. Vale para `model` y para `thinking`.

S9 — Las dos pantallas de selección comparten un solo contrato visual y de teclado:mismo envoltorio, título y descripción con la misma forma, misma pieza de fila (incluida la marca de valor **aplicado**, independiente del resaltado), mismo pie y mismas acciones (una sola acción de descarte, a la derecha), mismo comportamiento de foco y de trampa de Tab, y una sola regla de lista compartida en lugar de estilos duplicados. Las diferencias que son de tipo se conservan: el campo de filtro y la lista de modelos, el aviso de lista truncada y el orden con el actual primero solo en `model`; el conjunto cerrado de niveles y el modo degradado propio de `thinking`. El dueño lo pidió así, verbatim: «Bien, debemos unificar el estilo de ambas pantallas, lo que yo veo es que en la pantalla "Choose a thinking level" no aparece el "Current" ni tampoco el botón "Close" en el pie derecho de la ventana ¿Existe alguna discrepancia más?».

L8 (reporte del dueño, verbatim): «1. la pantalla "Choose a model" solo permite navegar entre las opciones con las flechas del teclado si el foco lo tiene el text-box de "Filter models..." pero la navegación debería estar siempre activa, además si al navegar con la flecha se accede a modelos que no están a la vista la lista no corre con la slección. 2. La pantalla "Choose a ghinking level" no permite la navetación por el menú con las flechas del teclado».

S10 — El reborde del recuadro de selección es uno solo y el mismo en las tres superficies: la paleta de Ctrl+K, la pantalla de modelo y la de nivel de razonamiento. Se declara una vez, con el mismo color, grosor y desplazamiento, y ninguna pantalla lo redefine.

S11 — La navegación con flechas funciona en la paleta de Ctrl+K y en las pantallas de selección **siempre**, sin depender de que el foco esté en el campo de texto: cada flecha mueve a la opción siguiente o anterior. Y si la ventana de la app pierde el foco (por ejemplo al hacer clic fuera de la GUI) y se vuelve a ella, la superficie abierta recupera el foco de forma que las flechas siguen funcionando sin tener que hacer clic dentro. El dueño lo reportó así, verbatim: «1. Tanto en la ventan de comandos ctrl+k como en la de "Choose a model" es necesario tener el foco en el text-box para poder navegar por la lista con las flechas del teclado y la navegación debería estar habilitada siempre pasando a la opción siguiente o anterior de la lista según se pulsa la flecha hacia abajo o hacia arriba. 2. Revisa por que si hay una ventana abierta la de comandos, model, thinkin y se hace click fuera de la GUI, cuano se vuelve a hacer click dentro de la ventana ya no se puede navegar por ella con las flechas, no recupera el foco».

L9 (reporte del dueño, verbatim): «El reborde del recuadro de selección haz que sea identico, la pantalla de commands ctrl+k y models lo comparten, pero la de thinking no, arreglalo en thinking».

L10 (decisión del dueño, verbatim): «No, revierte estos últimos cambios. Lo único que tienes que cambiar es en la ventana "Choose a thinking level" el reborde del level donde está el foco para que sea igual que en "Choose a model"». T10 se revirtió entero: sin `gc-dialog__selector`, la caja del filtro de modelo vuelve a su propio CSS, la lista de nivel no lleva envoltorio y la fila enfocada de nivel no dibuja anillo propio (`.gc-dialog__row:focus-visible { outline: none }`), así que muestra el mismo reborde que una fila de modelo.
