# Mixto

App local para Windows que reúne **Claude Code y Codex** con proyectos, conversaciones y memoria compartida. Usa las sesiones de las herramientas oficiales instaladas; no guarda ni extrae sus contraseñas o tokens.

## Abrir

Haz doble clic en **Abrir-Mixto.cmd**. La interfaz se abre en tu navegador, en `http://127.0.0.1:4317`. Necesita Node.js 24 o posterior, Claude Code y Codex instalados y con sesión iniciada. No hay paquetes adicionales que instalar.

También puedes ejecutar `npm start` desde esta carpeta. Cierra esa terminal para detener ese servidor. Si lo abriste con el acceso de doble clic, el servidor queda en segundo plano. Haz doble clic en **Cerrar-Mixto.cmd** para detenerlo y conservar los datos.

## Trabajar

1. Añade una carpeta existente con el botón **+** de Espacio de trabajo.
2. Elige el modelo de cada agente en el panel derecho. En pantallas pequeñas abre **Memoria** para mostrar el panel.
3. Escoge **Un agente**, **Trabajo + revisión** o **Dos perspectivas**.
4. **Solo consultar** viene activado. Desmárcalo cuando quieras que el agente principal modifique los archivos. El revisor y el modo Dos perspectivas solo permiten lectura. Las solicitudes de permisos compatibles aparecen dentro de la conversación.
5. Envía tu petición. Puedes detener una ejecución y retomar la conversación después.

Los modelos se consultan a las instalaciones locales al arrancar y al actualizar conexiones. Se incluyen los modelos ocultos de Codex, identificados como tales; el catálogo no garantiza que todos puedan ejecutarse en tu cuenta. También puedes escribir otro identificador. No se desbloquean modelos ni se eluden límites del plan. Las sesiones y la facturación siguen las configuraciones de las herramientas oficiales; consulta Conexiones para conocer el tipo de cuenta detectado.

## Memoria

- Los **recuerdos** son notas editables que tú decides guardar. Pueden ser de un proyecto o globales.
- Los **registros automáticos** guardan un extracto de cada trabajo terminado (hasta 2.000 caracteres de petición y 8.000 de respuesta). Son registros, no resúmenes verificados por un segundo modelo.
- En cada turno se añaden recuerdos explícitos, hasta cinco registros relevantes de otras conversaciones y la conversación reciente. La selección tiene un límite de tamaño; no se carga todo el historial a la vez.
- Las sesiones nativas se reanudan por agente y por modo de permisos. Cambiar de agente incluye el contexto reciente compartido. Engram permite recuperar los recuerdos también fuera de Mixto; no modifica el contexto ya cargado de una conversación abierta.
- Todo se guarda en **data/mixto.json**, con escrituras atómicas y una copia anterior **data/mixto.json.bak**. Descarga una copia desde Memoria compartida. Para trasladar los datos, cierra Mixto y conserva la carpeta data completa. No hay importación desde la interfaz.

Mixto permite una tarea activa por carpeta, incluso si se registra como dos proyectos. La revisión empieza cuando termina el primer agente. Dos perspectivas se ejecuta de forma secuencial y sin acceso de escritura. Un error no se presenta como éxito ni se guarda como recuerdo automático. Las tareas que quedan abiertas al cerrar la app aparecen como interrumpidas al reiniciar.

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

Si una sesión no está disponible, inicia sesión en la herramienta correspondiente (`codex login` o `claude auth login`) y pulsa **Actualizar conexiones**. La app nunca inicia sesión ni compra créditos automáticamente. Si las herramientas no están en PATH, se pueden indicar rutas mediante `MIXTO_CODEX_PATH` y `MIXTO_CLAUDE_PATH` al iniciar el servidor.

La app escucha únicamente en la interfaz local. Comprueba Host y Origin, exige una cookie local y protege las mutaciones frente a solicitudes de otras páginas. El contenido de las respuestas se muestra con formato limitado y escapado; nunca ejecuta HTML generado por los agentes.

No usa `--dangerously-skip-permissions` ni un modo sin aislamiento de Codex. Claude conserva su configuración nativa; en modo trabajo se permiten las ediciones mediante `acceptEdits` y las solicitudes adicionales se trasladan al usuario. Como en las herramientas originales, los permisos y personalizaciones que tengas configurados afectan a su funcionamiento. Las confirmaciones MCP con esquemas arbitrarios no se implementan: se rechazan explícitamente para que el agente pueda proponer otra vía.

## Desarrollo

`npm test` ejecuta las pruebas locales sin consumir modelos, incluida una base Engram temporal aislada. Requiere el binario Engram instalado; `MIXTO_TEST_ENGRAM_PATH` permite indicar su ubicación. `npm run check` comprueba la sintaxis. Para una instancia de prueba aislada usa **las tres variables** `MIXTO_PORT`, `MIXTO_DATA_DIR` y `ENGRAM_DATA_DIR`; cambiar solo los datos de Mixto no aísla Engram.

Referencias de integración: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude Code programático](https://code.claude.com/docs/en/headless). El protocolo de control de Claude puede variar entre versiones; esta implementación se comprueba contra la instalación local.
