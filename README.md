# Memoria de incidentes (Ollama)

Extensión de Chrome (panel lateral) para consultar un modelo de IA local sobre ciberseguridad, apoyándose en una memoria propia creada a partir de archivos de incidentes. Todo funciona en local con Ollama: ni los archivos ni las preguntas salen del equipo.

## Cómo funciona

1. **Memoria:** subes informes, logs o PDF (con texto). Se dividen en fragmentos y `nomic-embed-text` genera un vector por fragmento. Se guardan en IndexedDB, en el navegador.
2. **Consulta:** la pregunta se vectoriza, se recuperan los fragmentos más parecidos (similitud coseno) y se pasan como contexto al modelo de chat, que responde citando las fuentes `[1]`, `[2]`.

## Requisitos

- Windows con [Ollama](https://ollama.com) instalado y en ejecución
- Google Chrome 114 o superior (por la API de panel lateral)

## Comandos

Descargar los modelos (el de chat puede ser cualquiera que ya uses):

```
ollama pull nomic-embed-text
ollama pull llama3.1
```

Comprobar que Ollama responde y qué modelos hay:

```
ollama list
curl http://localhost:11434/api/tags
```

Probar el endpoint de embeddings (el mismo que usa la extensión):

```
curl http://localhost:11434/api/embed -d "{\"model\":\"nomic-embed-text\",\"input\":\"The sky is blue because of Rayleigh scattering\"}"
```

Solo si Ollama rechaza la extensión con error 403 (CORS). Después, reinicia Ollama desde la bandeja del sistema:

```
setx OLLAMA_ORIGINS "chrome-extension://*"
```

Cómo se obtuvo pdf.js, ya incluido en `lib/` (no hace falta repetirlo):

```
npm install pdfjs-dist@4.10.38
```

## Instalación

1. Abre `chrome://extensions` y activa el **Modo desarrollador**.
2. Pulsa **Cargar descomprimida** y elige esta carpeta.
3. Pulsa el icono de la extensión para abrir el panel.
4. Tras cualquier cambio en los archivos, pulsa **Recargar** en la tarjeta de la extensión.

## Archivos

| Archivo | Función |
|---|---|
| `manifest.json` | Configuración y permisos (Manifest V3) |
| `rules.json` | Regla que quita la cabecera `Origin` para que Ollama acepte las peticiones |
| `background.js` | Abre el panel lateral al pulsar el icono |
| `sidepanel.html/css/js` | Interfaz y lógica: embeddings, memoria, búsqueda y chat |
| `lib/` | pdf.js y su worker, para leer PDF sin conexión |

## Limitaciones

- Los PDF escaneados (solo imagen) no se pueden leer; haría falta OCR.
- Si cambias el modelo de embeddings, borra la memoria y vuelve a subir los archivos.
