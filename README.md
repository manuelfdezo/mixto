# Mixto

App local para Windows que reúne **Claude Code y Codex** con proyectos, conversaciones y memoria compartida. Usa las sesiones de las herramientas oficiales instaladas; no guarda ni extrae sus contraseñas o tokens.

## Abrir

Haz doble clic en **Abrir-Mixto.cmd**. La interfaz se abre en tu navegador, en `http://127.0.0.1:4317`. Necesita Node.js 24 o posterior, Claude Code y Codex instalados y con sesión iniciada. No hay paquetes adicionales que instalar.

También puedes ejecutar `npm start` desde esta carpeta. Cierra esa terminal para detener ese servidor. Si lo abriste con el acceso de doble clic, el servidor queda en segundo plano. Haz doble clic en **Cerrar-Mixto.cmd** para detenerlo y conservar los datos.

## Trabajar

Junto al cuadro de escritura eliges el **agente principal** y el **modo**:

- **Orquesta**: el agente principal estudia la carpeta, responde o propone un plan, y revisa el resultado. Es el modo que se describe a continuación.
- **Directo**: hablas con un solo agente, con sesión continua, sin plan ni revisión. Es el modo para el trabajo iterativo del día a día: cada mensaje cuesta un turno. La sesión se conserva por conversación y agente aunque cambies de modelo; cambiar entre consulta y trabajo la reinicia. Cada turno con escritura se puede ver y deshacer, y se puede redirigir mientras trabaja.
- **Reparto a mano**: tú planteas la tarea y decides las sub-tareas, quién hace cada una (Codex o Claude Code), con qué modelo, alcance y permisos. No hay turno de planificación; las sub-tareas arrancan directamente y el agente principal revisa el conjunto al final si lo marcas. Sin revisión, los cambios de varias sub-tareas quedan a la espera de que los apliques o descartes tú.

1. Crea la carpeta de proyectos `mixto-projects` junto a la carpeta de Mixto. Cada subcarpeta directa aparece automáticamente en el selector **Proyectos**; también puedes crear una con el botón **+**.
2. Elige qué agente **orquesta**. El modelo y el nivel de razonamiento predeterminados se configuran en **Agentes**.
3. **Solo consultar** viene activado. Desmárcalo cuando quieras que los agentes modifiquen archivos: es el techo de permisos de toda la tarea y el plan no puede ampliarlo, solo restringirlo. Las solicitudes de permisos compatibles aparecen dentro de la conversación, indicando de qué sub-tarea vienen.
4. Envía tu petición. El orquestador estudia la carpeta sin modificar nada y conoce al equipo del proyecto. Si es una pregunta o algo que puede resolver con lo que acaba de ver, **responde directamente** y la tarea termina ahí, en un solo turno. Si hace falta trabajar, propone un plan: cuántas sub-tareas hacen falta, qué agente y modelo se ocupa de cada una, con qué alcance y por qué, más un **contexto** con lo que descubrió para que ninguna sub-tarea tenga que volver a explorarlo.
5. Revisa el plan antes de que empiece nadie. En cada sub-tarea puedes **reasignarla al otro agente**, cambiar el modelo y el nivel de razonamiento para ajustar el consumo, o limitarla a solo lectura; o descartar el plan. En **Agentes** puedes activar que los planes de una sola sub-tarea, o los de solo lectura, arranquen sin pedirte aprobación. Si el plan tiene una sola sub-tarea asignada al mismo agente que planificó, la hace él en su propia sesión, que ya conoce el proyecto, sin arrancar otro proceso en frío.
6. Las sub-tareas se ejecutan, hasta tres a la vez. Cada una informa de su estado y de su consumo por separado. Puedes detener la tarea y retomar la conversación después.
7. Al terminar, el mismo orquestador revisa el conjunto desde una copia con todos los cambios ya aplicados: busca trabajo duplicado, contradicciones y lo que falte, puede ejecutar los tests del proyecto para comprobarlo, y decide si procede integrar. Una sola sub-tarea de consulta no se revisa: su respuesta ya es la respuesta.
8. Si la revisión no convence, **Corregir** reanuda la sesión de la sub-tarea que elijas, en su misma copia, con la revisión del arquitecto y tus indicaciones. No se replanifica ni se repiten las demás; al terminar se vuelve a revisar el conjunto.

Cuando **una sola** sub-tarea modifica archivos, trabaja directamente en tu carpeta y reanuda su sesión nativa, igual que si usaras el agente por tu cuenta; el revisor ve el diff desde el punto en que empezó. Cuando escriben **dos o más**, cada una trabaja sobre una copia aislada de la carpeta, creada con `git worktree`, así que nunca se escriben encima. Esa copia parte del estado real del proyecto, incluido el trabajo que todavía no has guardado en un commit. Los cambios vuelven a tu carpeta como parches, sin crear ramas ni commits: si todos aplican limpios se integran solos; si hay conflicto, o dos sub-tareas tocaron el mismo archivo, no se aplica nada y el informe dice qué ocurrió. `MIXTO_MAX_PARALLEL` cambia cuántas sub-tareas se ejecutan a la vez, tres por defecto.

Si la carpeta no es un repositorio git no hay copias aisladas posibles, y cuando varias sub-tareas escriben Mixto te ofrece dos salidas: convertirla en repositorio, o ejecutarlas de una en una.

### El día a día

Lo que hace falta para que Mixto sea el sitio donde trabajas, no solo donde lanzas tareas grandes:

- **Comandos permitidos por proyecto.** Cuando un agente pide ejecutar un comando, la petición muestra el comando y ofrece **Permitir siempre en este proyecto**: guarda sus dos primeras palabras (`npm test`, `git status`) en la lista del proyecto, que también editas en **Agentes**. A partir de ahí ese prefijo se aprueba solo, en cualquier sub-tarea y también durante la revisión, con los dos agentes; Claude Code lo recibe además como herramienta permitida. `npm test` permite `npm test -- x`, nunca `npm testing`. Una consulta sigue sin poder escalar a escritura.
- **Ver cambios y deshacer.** Cada respuesta que tocó archivos ofrece **Ver cambios**: el diff por archivo, con lo añadido y lo quitado. Si fue un turno directo en tu carpeta, puedes **revertir un archivo** o **deshacer el turno entero** con `git apply -R`, y los archivos que creó se eliminan. Si es un parche todavía sin integrar, puedes **excluir archivos** antes de aplicarlo.
- **Terminal del proyecto.** El botón **Terminal** abre un panel que ejecuta un comando en la carpeta del proyecto, con la salida en vivo, un botón para detenerlo, atajos con los comandos permitidos y **Pasar al mensaje** para pegar la salida en tu siguiente petición. Un comando a la vez por proyecto, con un límite de diez minutos y de un megabyte de salida.
- **Confirmar cambios.** Cuando la carpeta tiene cambios sin confirmar aparece **Confirmar cambios (n)**: eliges los archivos, escribes el mensaje o pides al agente principal que lo **proponga** a partir del diff, y confirmas, con o sin `git push`. Mixto solo crea el commit cuando pulsas; nunca lo hace por su cuenta.
- **Segunda opinión.** El botón **Segunda opinión de …** pide al otro agente que revise, en solo lectura, los cambios sin confirmar del proyecto: lo que acaba de hacer el primero. Lo que escribas en el cuadro va como foco de la revisión.
- **Adjuntos.** Pega, arrastra o elige imágenes y archivos de texto: viajan con el mensaje. Las imágenes llegan como imagen a los dos agentes; el resto se les indica por su ruta para que lo lean si hace falta. Se guardan en `data/uploads`, hasta 6 MB cada uno.
- **Redirigir un turno en marcha.** En modo directo el cuadro sigue activo mientras el agente trabaja: escribe y envía, y Mixto lo detiene y continúa la misma sesión con tu nueva indicación, conservando lo que ya hizo.
- **Avisos y búsqueda.** El botón de la campana pide permiso al navegador para avisarte cuando una tarea termina, falla o necesita algo y no estás mirando; el título de la pestaña lleva la cuenta de lo que espera. La búsqueda de la barra lateral filtra las conversaciones por título y contenido.
- **El arquitecto recuerda.** Dentro de una conversación, el agente principal reanuda su propia sesión nativa en cada tarea nueva: no vuelve a explorar la carpeta ni se le repite el historial. Cada ocho tareas la sesión se renueva para que no crezca sin límite, y si la herramienta ha olvidado la sesión se empieza otra sin que la tarea falle.

### Equipo: personas reales

En **Equipo** añades a las personas que trabajan en cada proyecto: nombre, rol, correo opcional y notas con lo que el arquitecto debe saber para asignarles trabajo. Una misma persona puede estar en varios proyectos.

- En el **reparto a mano**, cada sub-tarea se asigna a Codex, a Claude Code o a una persona del equipo. En el **plan del arquitecto**, el propio arquitecto puede asignar una parte a una persona cuando requiera criterio humano, accesos o dispositivos que los agentes no tienen, o cuando se lo pidas; y tú puedes reasignar cualquier sub-tarea a una persona, o de una persona a un agente, antes de aprobar.
- Mixto **no ejecuta** las partes de las personas: quedan asignadas y pendientes. La tarea termina cuando los agentes acaban y muestra cuántas partes siguen en manos de personas. Los agentes saben qué partes son de personas para no hacerlas ellos.
- En la tarjeta de la tarea y en el tablero de **Equipo** anotas el estado de cada parte (pendiente, en curso, hecha), una fecha límite y el resultado o enlace que la persona entregó. Nada de esto consume turnos.
- **Copiar encargo**, **Descargar .md** o **Enviar por correo** preparan para cada persona un documento con sus partes pendientes: tarea, instrucciones, alcance y el contexto que descubrió el arquitecto.
- Cuando las personas terminen, **Revisar de nuevo** hace que el revisor compruebe el conjunto en la carpeta del proyecto, con lo que ellas hayan integrado y lo que tú hayas anotado. Cuesta un turno. Una tarea que solo tiene partes de personas no se revisa hasta que lo pidas.

Mixto sigue siendo una app local de un solo usuario: no hay acceso por red ni cuentas. La cooperación entre personas pasa por el repositorio, que ya comparten.

### Cooperación por git

Actívala en **Equipo**. El equipo y los encargos se guardan en una rama propia del repositorio del proyecto, `mixto-encargos`, con un archivo markdown por encargo y `equipo.json`. Mixto la maneja desde una copia oculta en su carpeta de datos: nunca toca tus ramas de código, ni tu copia de trabajo, ni empuja tus commits.

- **Cada persona trabaja en su clon.** Su Mixto, apuntando a ese clon, lee la misma rama, importa el equipo con los mismos identificadores, la reconoce por el `user.email` de su git y le muestra sus encargos. Si su correo no está en el equipo, un botón la añade con esa identidad.
- **Un encargo se da por hecho solo** cuando aparece en cualquier rama un commit con `mixto:<id corto>` en el mensaje (los ocho primeros caracteres del id, que figuran en el propio archivo). La nota registra el commit y su autor.
- **Estado y notas** se cambian desde cualquier Mixto, desde la tarjeta de la tarea o el tablero, o editando el archivo en el repositorio. Los cambios se mezclan por fecha y las notas se unen, así que dos personas pueden anotar a la vez sin conflictos.
- **Publicar** es commit y push de la rama de encargos. Con **Publicar automáticamente** ocurre en cada cambio; si no, el botón **Publicar ahora**. Un push rechazado se resuelve solo: se trae lo del otro, se mezcla y se reintenta.
- **Sincronizar** trae las ramas del remoto y actualiza el tablero y las tareas locales. Ocurre al activar la cooperación, al arrancar, cada minuto en local y cada cinco minutos con el remoto, siempre que no haya una tarea activa en esa carpeta. Un encargo hecho por otra persona actualiza la parte correspondiente de tu tarea y su registro de memoria, sin gastar turnos.
- **Encargos sueltos**: desde el tablero puedes crear un encargo para alguien sin pasar por una tarea. Los agentes de tu Mixto reciben, al planificar, cuántos encargos pendientes tiene ya cada persona.

Sin remoto, el libro queda confirmado solo en tu repositorio. Si dos Mixto usan clones distintos con remotos distintos, cada uno ve su propio libro.

### Consumo y cuota

Cada respuesta muestra los tokens de ese turno y, en la respuesta directa o la revisión, el total de la tarea con todos sus turnos, incluidos el plan y la revisión. Claude Code informa además del coste estimado. La cuota de Codex aparece junto al cuadro de escritura y en **Agentes**, con sus ventanas de uso; se relee al terminar cada tarea y al pulsar **Actualizar**. Claude Code no publica su cuota.

En **Agentes** puedes fijar un **tope de tokens por tarea**. Se comprueba al cerrar cada turno, así que puede excederse por un turno; al superarlo, la tarea se detiene, lo dice en la conversación y puedes corregir una sub-tarea o volver a pedirla. Para gastar menos: usa el modo directo para el trabajo iterativo, un modelo rápido como agente principal (planifica y revisa) y deja los potentes para las sub-tareas difíciles. Las dos personas del arquitecto están recortadas a lo que ayuda a repartir trabajo, unos 1.500 tokens cada una; aun así, déjala en «Sin persona» salvo que la necesites.

Mixto es únicamente el orquestador: el código de cada producto permanece fuera de su repositorio. La raíz gestionada se puede cambiar con `MIXTO_PROJECTS_ROOT`; debe ser una carpeta existente. Mixto solo descubre sus subcarpetas directas y la interfaz no acepta rutas arbitrarias. Las referencias antiguas guardadas se conservan para no perder conversaciones ni memoria, pero todo proyecto nuevo se crea dentro de la raíz gestionada. Mixto nunca mueve ni elimina automáticamente un proyecto existente.

Los modelos se consultan a las instalaciones locales al arrancar y al actualizar conexiones. Se incluyen los modelos ocultos de Codex, identificados como tales; el catálogo no garantiza que todos puedan ejecutarse en tu cuenta. No se desbloquean modelos ni se eluden límites del plan. Las sesiones y la facturación siguen las configuraciones de las herramientas oficiales; consulta Agentes para conocer el tipo de cuenta detectado.

## Memoria

- Los **recuerdos** son notas editables que tú decides guardar. Pueden ser de un proyecto o globales.
- Los **registros automáticos** guardan un extracto de cada tarea terminada: la respuesta directa o el plan, el resultado de cada sub-tarea y la revisión, en un único registro por tarea y hasta 12.000 caracteres. Una corrección actualiza el registro de su tarea en vez de añadir otro. Son registros, no resúmenes verificados por un segundo modelo.
- En cada turno se añaden recuerdos explícitos, hasta cinco registros relevantes de otras conversaciones y la conversación reciente. La selección tiene un límite de tamaño; no se carga todo el historial a la vez.
- Las sesiones nativas se reanudan por agente y por modo de permisos. Cambiar de agente incluye el contexto reciente compartido. Engram permite recuperar los recuerdos también fuera de Mixto; no modifica el contexto ya cargado de una conversación abierta.
- Todo se guarda en **data/mixto.json**, con escrituras atómicas y una copia anterior **data/mixto.json.bak**. Descarga una copia desde Memoria compartida. Para trasladar los datos, cierra Mixto y conserva la carpeta data completa. No hay importación desde la interfaz.

Mixto permite una tarea orquestada activa por carpeta, incluso si se registra como dos proyectos; el paralelismo ocurre dentro de esa tarea, donde Mixto sabe qué sub-tarea trabaja sobre qué copia. Una sub-tarea que falla no detiene a las demás: su error queda registrado y la revisión lo tiene en cuenta. Un error no se presenta como éxito ni se guarda como recuerdo automático. Las tareas que quedan abiertas al cerrar la app aparecen como interrumpidas al reiniciar, igual que sus sub-tareas.

### Memoria compartida con Engram

Mixto utiliza **Engram 1.20.0** y su misma carpeta de datos que Claude Code y Codex: `%USERPROFILE%\.engram` por defecto. No instala plugins, modifica la configuración de los agentes ni consume modelos para sincronizar. Busca `engram.exe` en `%USERPROFILE%\go\bin` y después en PATH; `MIXTO_ENGRAM_PATH` permite indicar otra ruta y `ENGRAM_DATA_DIR` otra base de memoria.

Al iniciar la versión integrada se crea una copia adicional `data/mixto.json.pre-engram-<fecha>.bak`, verificada con SHA-256 antes de la primera importación. Las conversaciones y mensajes completos permanecen en `mixto.json`; Engram recibe sesiones y observaciones con identificadores estables para evitar duplicados, incluso si se interrumpe un reinicio. Los mensajes se conservan como observaciones completas, no como resúmenes ni como nuevas llamadas a modelos. Esto incluye el texto del historial: revisa su contenido sensible antes de compartir o exportar la base Engram.

La sincronización ocurre al arrancar, al terminar tareas y cada 15 segundos cuando no hay tareas activas. **Memoria compartida** muestra el estado y permite reintentar. Si falla, los datos locales y la última copia de los recuerdos externos siguen disponibles. No reinicies Mixto mientras haya tareas activas.

| Comportamiento | Protección |
|---|---|
| Proyectos | Se utiliza el detector nativo de Engram, incluida `.engram/config.json`. Una identidad ambigua, modificada o compartida por carpetas distintas detiene la sincronización. |
| Recuerdos de agentes | Se incorporan solamente los del proyecto exacto y alcance `project`; los recuerdos externos personales o sin proyecto no se incorporan automáticamente. Se gestionan desde Engram y aparecen como contexto no verificado. |
| Notas globales de Mixto | Mantienen su alcance local global y se publican en Engram con alcance `personal`, asociadas al primer proyecto. |
| Ediciones y eliminaciones | Mixto solo modifica sus propios recuerdos identificados. Las eliminaciones son lógicas en Engram. Los cambios externos en notas propias se recuperan, conservando la versión local anterior en `engram.history`. Los cambios simultáneos detienen la sincronización sin sobrescribir el conflicto. |
| Respaldo | No se reemplazan las conversaciones por Engram. Conserva toda la carpeta `data`, incluido el identificador de integración, al mover la app. |

El puente usa las interfaces públicas MCP e importación/exportación, nunca escribe directamente SQLite. La exportación nativa lee la base completa en un archivo temporal del usuario que se elimina al terminar; únicamente los proyectos asociados pasan a la caché local. No publica un servidor Engram adicional ni activa sincronización en la nube. Un cierre forzado del proceso puede dejar un archivo `mixto-transfer-*` en la carpeta temporal del usuario; elimínalo solo cuando Mixto esté cerrado.

Si aparece un conflicto, compara la nota local con su versión en Engram y haz que título y contenido coincidan antes de reintentar. Para separar carpetas que Engram identifica con el mismo nombre, configura nombres distintos en Engram antes de la primera sincronización; no cambies una identidad ya migrada sin planificar su traslado.

## Conexiones

Si una sesión no está disponible, inicia sesión en la herramienta correspondiente (`codex login` o `claude auth login`) y pulsa **Actualizar** en **Agentes**. La app nunca inicia sesión ni compra créditos automáticamente. Si las herramientas no están en PATH, se pueden indicar rutas mediante `MIXTO_CODEX_PATH` y `MIXTO_CLAUDE_PATH` al iniciar el servidor.

La app escucha únicamente en la interfaz local. Comprueba Host y Origin, exige una cookie local y protege las mutaciones frente a solicitudes de otras páginas. El contenido de las respuestas se muestra con formato limitado y escapado; nunca ejecuta HTML generado por los agentes.

No usa `--dangerously-skip-permissions` ni un modo sin aislamiento de Codex. Claude conserva su configuración nativa; en modo trabajo se permiten las ediciones mediante `acceptEdits` y las solicitudes adicionales se trasladan al usuario. El revisor trabaja en solo lectura y, para poder ejecutar comprobaciones, recibe además Bash: con Claude Code solo `git diff`, `git status`, `git log`, `git show` y los comandos permitidos del proyecto pasan sin preguntar, y cualquier otro se rechaza; con Codex los comandos corren en su sandbox de solo lectura. En modo trabajo, los comandos permitidos del proyecto se aprueban solos y el resto te lo pide en la conversación. Como en las herramientas originales, los permisos y personalizaciones que tengas configurados afectan a su funcionamiento. Las confirmaciones MCP con esquemas arbitrarios no se implementan: se rechazan explícitamente para que el agente pueda proponer otra vía.

## Desarrollo

La interfaz recibe el estado por eventos del servidor (`/api/events`, SSE) en cuanto cambia, sin sondeo; solo si esa conexión no está abierta vuelve a consultar `/api/state` cada pocos segundos.

`npm test` ejecuta las pruebas locales sin consumir modelos, incluida una base Engram temporal aislada. Requiere el binario Engram instalado; `MIXTO_TEST_ENGRAM_PATH` permite indicar su ubicación. `npm run check` comprueba la sintaxis. Para una instancia de prueba aislada usa **las tres variables** `MIXTO_PORT`, `MIXTO_DATA_DIR` y `ENGRAM_DATA_DIR`; cambiar solo los datos de Mixto no aísla Engram.

Referencias de integración: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude Code programático](https://code.claude.com/docs/en/headless). El protocolo de control de Claude puede variar entre versiones; esta implementación se comprueba contra la instalación local.
