'use strict';
const API = 'http://localhost:11434';
const $ = s => document.querySelector(s);
const MIN_SCORE = 0.3;

// ---------- Ajustes ----------
const cfg = {
  get chat() { return localStorage.getItem('chatModel') || ''; },
  set chat(v) { localStorage.setItem('chatModel', v); },
  get emb() { return localStorage.getItem('embModel') || 'nomic-embed-text'; },
  set emb(v) { localStorage.setItem('embModel', v.trim() || 'nomic-embed-text'); },
};

// ---------- IndexedDB (memoria) ----------
const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = t => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

const db = new Promise((res, rej) => {
  const r = indexedDB.open('incidentes', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('docs', { keyPath: 'id', autoIncrement: true });
    r.result.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true }).createIndex('docId', 'docId');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

async function saveDoc(doc, chunks) {
  const t = (await db).transaction(['docs', 'chunks'], 'readwrite');
  const id = await rq(t.objectStore('docs').add(doc));
  const cs = t.objectStore('chunks');
  chunks.forEach(c => cs.add({ ...c, docId: id }));
  await done(t);
}
async function listDocs() {
  return rq((await db).transaction('docs').objectStore('docs').getAll());
}
async function deleteDoc(id) {
  const t = (await db).transaction(['docs', 'chunks'], 'readwrite');
  t.objectStore('docs').delete(id);
  const cs = t.objectStore('chunks');
  const keys = await rq(cs.index('docId').getAllKeys(id));
  keys.forEach(k => cs.delete(k));
  await done(t);
}
async function clearAll() {
  const t = (await db).transaction(['docs', 'chunks'], 'readwrite');
  t.objectStore('docs').clear();
  t.objectStore('chunks').clear();
  await done(t);
}

// ---------- Ollama ----------
async function errMsg(r) {
  let m = `HTTP ${r.status}`;
  try { m = (await r.json()).error || m; } catch {}
  if (r.status === 403) m += ' (Ollama rechazó el origen: define OLLAMA_ORIGINS=chrome-extension://* y reinicia Ollama)';
  if (r.status === 404) m += ' (¿falta el modelo? Ejecuta: ollama pull <modelo>)';
  return m;
}
async function post(path, body, signal) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok) throw new Error(await errMsg(r));
  return r;
}
const norm = v => {
  let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1;
  return Float32Array.from(v, x => x / s);
};
async function embed(texts, prefix) {
  // nomic-embed-text rinde mejor con prefijos de tarea
  const r = await post('/api/embed', { model: cfg.emb, input: texts.map(t => prefix + t) });
  return (await r.json()).embeddings.map(norm);
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i]; return s; };

// ---------- Ingesta ----------
function chunkText(t, size = 900, overlap = 150) {
  t = t.replace(/\r/g, '').trim();
  const out = []; let i = 0;
  while (i < t.length) {
    let end = Math.min(i + size, t.length);
    if (end < t.length) {
      const cut = Math.max(t.lastIndexOf('\n', end), t.lastIndexOf('. ', end));
      if (cut > i + size * 0.5) end = cut + 1;
    }
    const c = t.slice(i, end).trim();
    if (c) out.push(c);
    if (end >= t.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return out;
}

let pdfjs = null;
async function readPdf(file, label) {
  // pdf.js va empaquetado en lib/ (Chrome no permite cargar scripts remotos en extensiones)
  if (!pdfjs) {
    pdfjs = await import(chrome.runtime.getURL('lib/pdf.min.mjs'));
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');
  }
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    label(`${file.name}: leyendo página ${n} de ${pdf.numPages}`);
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const txt = content.items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim();
    if (txt) pages.push(`[Página ${n}]\n${txt}`);
  }
  await pdf.destroy();
  if (!pages.length) throw new Error('el PDF no contiene texto seleccionable (¿escaneado? haría falta OCR)');
  return pages.join('\n\n');
}

async function readFile(file, label) {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') return readPdf(file, label);
  const text = await file.text();
  if (text.includes('\u0000')) throw new Error('no es un archivo de texto');
  return text;
}

async function ingest(file, label) {
  const text = await readFile(file, label);
  const parts = chunkText(text);
  if (!parts.length) throw new Error('el archivo está vacío');
  const vecs = [];
  for (let i = 0; i < parts.length; i += 16) {
    label(`${file.name}: fragmentos ${Math.min(i + 16, parts.length)} de ${parts.length}`);
    vecs.push(...await embed(parts.slice(i, i + 16), 'search_document: '));
  }
  await saveDoc(
    { name: file.name, size: file.size, chunks: parts.length, model: cfg.emb, added: Date.now() },
    parts.map((text, n) => ({ n: n + 1, text, vec: vecs[n], docName: file.name }))
  );
}

async function retrieve(q, k) {
  const [qv] = await embed([q], 'search_query: ');
  const all = await rq((await db).transaction('chunks').objectStore('chunks').getAll());
  return all.map(c => ({ c, s: dot(qv, c.vec) }))
    .filter(h => h.s >= MIN_SCORE)
    .sort((a, b) => b.s - a.s).slice(0, k);
}

// ---------- Chat ----------
const SYSTEM = `Eres un analista de ciberseguridad (SOC/DFIR). Responde en el idioma del usuario, de forma clara y accionable.
Cuando recibas contexto de la memoria de incidentes, basa la respuesta en él y cita las fuentes como [1], [2].
Si el contexto no contiene la respuesta, dilo explícitamente y responde con conocimiento general indicándolo.
No inventes IOCs, CVEs, fechas ni nombres de actores.`;

const history = [];
let controller = null;
const emptyNode = $('#log .empty').cloneNode(true);

// Render seguro (sin innerHTML): párrafos, listas, código, negrita y citas [n]
function inline(parent, text) {
  text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[\d{1,2}\])/g).forEach(tok => {
    if (!tok) return;
    let el;
    if (/^`.+`$/.test(tok)) { el = document.createElement('code'); el.textContent = tok.slice(1, -1); }
    else if (/^\*\*.+\*\*$/.test(tok)) { el = document.createElement('strong'); el.textContent = tok.slice(2, -2); }
    else if (/^\[\d{1,2}\]$/.test(tok)) {
      el = document.createElement('button'); el.type = 'button'; el.className = 'cite';
      el.dataset.n = tok.slice(1, -1); el.textContent = el.dataset.n; el.title = 'Ver fuente ' + el.dataset.n;
    } else el = document.createTextNode(tok);
    parent.append(el);
  });
}
const LIST = /^\s*([-*]|\d+\.)\s+/;
function render(el, text) {
  const frag = document.createDocumentFragment();
  const lines = text.replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^```/.test(ln)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const pre = document.createElement('pre'), c = document.createElement('code');
      c.textContent = buf.join('\n'); pre.append(c); frag.append(pre);
    } else if (LIST.test(ln)) {
      const list = document.createElement(/^\s*\d+\./.test(ln) ? 'ol' : 'ul');
      while (i < lines.length && LIST.test(lines[i])) {
        const li = document.createElement('li'); inline(li, lines[i].replace(LIST, '')); list.append(li); i++;
      }
      frag.append(list);
    } else if (/^#{1,4}\s+/.test(ln)) {
      const h = document.createElement('h4'); inline(h, ln.replace(/^#{1,4}\s+/, '')); frag.append(h); i++;
    } else if (!ln.trim()) { i++; }
    else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !LIST.test(lines[i]) && !/^#{1,4}\s+/.test(lines[i])) buf.push(lines[i++]);
      const p = document.createElement('p'); inline(p, buf.join('\n')); frag.append(p);
    }
  }
  el.replaceChildren(frag);
}

function addMsg(cls, text = '') {
  const d = document.createElement('div');
  d.className = 'msg ' + cls; d.textContent = text;
  $('#log').querySelector('.empty')?.remove();
  $('#log').append(d); $('#log').scrollTop = 1e9;
  return d;
}
function addSources(hits, msg) {
  const det = document.createElement('details'); det.className = 'src';
  const sm = document.createElement('summary'); sm.textContent = `Fuentes consultadas (${hits.length})`;
  det.append(sm);
  hits.forEach((h, i) => {
    const box = document.createElement('div'); box.className = 'ev';
    const head = document.createElement('div'); head.className = 'ev-head';
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = i + 1;
    const name = document.createElement('b'); name.textContent = h.c.docName;
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = `fragmento ${h.c.n}, similitud ${h.s.toFixed(2)}`;
    head.append(tag, name, meta);
    const p = document.createElement('p');
    p.textContent = h.c.text.slice(0, 400) + (h.c.text.length > 400 ? '…' : '');
    box.append(head, p); det.append(box);
  });
  msg._src = det;
  $('#log').append(det); $('#log').scrollTop = 1e9;
}
function addActions(msg, text) {
  const a = document.createElement('div'); a.className = 'actions';
  const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Copiar';
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copiado'; }
    catch { b.textContent = 'No se pudo copiar'; }
    setTimeout(() => b.textContent = 'Copiar', 1500);
  };
  a.append(b); msg.after(a);
}
function setBusy(on) {
  const b = $('#send');
  b.textContent = on ? 'Detener' : 'Enviar';
  b.classList.toggle('stop', on);
  $('#newChat').disabled = on;
}
function fitInput() {
  const q = $('#q'); q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 160) + 'px';
}

async function ask(q) {
  if (!cfg.chat) { addMsg('err', 'No hay modelo de chat. Descarga uno con "ollama pull" y recarga el panel.'); return; }
  addMsg('user', q);
  const out = addMsg('bot thinking', 'Buscando en la memoria…');
  controller = new AbortController(); setBusy(true);
  let answer = '', raf = 0;
  const paint = () => { raf = 0; render(out, answer); $('#log').scrollTop = 1e9; };
  try {
    let hits = [];
    if ($('#useMem').checked) hits = await retrieve(q, Math.max(1, +$('#topk').value || 5));

    const ctx = hits.length
      ? 'Contexto de la memoria de incidentes:\n' +
        hits.map((h, i) => `[${i + 1}] (${h.c.docName}, fragmento ${h.c.n})\n${h.c.text}`).join('\n\n') +
        `\n\n---\nPregunta: ${q}`
      : q;
    const messages = [{ role: 'system', content: SYSTEM }, ...history.slice(-6), { role: 'user', content: ctx }];

    out.textContent = 'Pensando…';
    const r = await post('/api/chat', { model: cfg.chat, messages, stream: true }, controller.signal);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        if (j.message?.content) {
          answer += j.message.content;
          out.classList.remove('thinking');
          if (!raf) raf = requestAnimationFrame(paint);
        }
      }
    }
    cancelAnimationFrame(raf); out.classList.remove('thinking');
    if (answer) render(out, answer);
    if (hits.length) addSources(hits, out);
    else if ($('#useMem').checked) addMsg('note', 'Ningún fragmento de la memoria era relevante para esta pregunta.');
  } catch (e) {
    cancelAnimationFrame(raf); out.classList.remove('thinking');
    if (e.name === 'AbortError') { answer ? render(out, answer) : out.textContent = '(detenido)'; }
    else { out.className = 'msg err'; out.textContent = 'Error: ' + e.message; }
  } finally {
    if (answer) { history.push({ role: 'user', content: q }, { role: 'assistant', content: answer }); addActions(out, answer); }
    controller = null; setBusy(false);
  }
}

$('#send').addEventListener('click', () => {
  if (controller) return controller.abort();
  const q = $('#q').value.trim(); if (!q) return;
  $('#q').value = ''; fitInput(); ask(q);
});
$('#q').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#send').click(); }
});
$('#q').addEventListener('input', fitInput);
$('#newChat').addEventListener('click', () => {
  history.length = 0;
  $('#log').replaceChildren(emptyNode.cloneNode(true));
});
$('#log').addEventListener('click', e => {
  const c = e.target.closest('.cite');
  if (c) {
    const det = c.closest('.msg')?._src;
    const item = det?.querySelectorAll('.ev')[+c.dataset.n - 1];
    if (item) {
      det.open = true; item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      item.classList.remove('flash'); void item.offsetWidth; item.classList.add('flash');
    }
    return;
  }
  const s = e.target.closest('.suggest');
  if (s && !controller) { $('#q').value = s.textContent; $('#send').click(); }
});

// ---------- Memoria (UI) ----------
const kb = n => n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';

async function renderDocs() {
  const docs = await listDocs();
  const ul = $('#docs'); ul.replaceChildren();
  $('#memCount').textContent = docs.length || '';
  $('#stats').textContent = docs.length
    ? `${docs.length} documento(s), ${docs.reduce((a, d) => a + d.chunks, 0)} fragmentos`
    : 'La memoria está vacía. Sube informes, logs o post-mortems de incidentes.';
  $('#clear').hidden = !docs.length;
  for (const d of docs) {
    const li = document.createElement('li');
    const ext = (d.name.match(/\.([a-z0-9]+)$/i)?.[1] || 'txt').toLowerCase();
    const badge = document.createElement('span');
    badge.className = 'ftype' + (ext === 'pdf' ? ' pdf' : ''); badge.textContent = ext.slice(0, 4);
    const info = document.createElement('div'); info.className = 'info';
    const n = document.createElement('div'); n.className = 'name'; n.textContent = d.name;
    const m = document.createElement('div'); m.className = 'meta';
    m.textContent = `${d.chunks} fragmentos, ${kb(d.size)}, ${new Date(d.added).toLocaleDateString('es-ES')}, ${d.model}`;
    info.append(n, m);
    const del = document.createElement('button'); del.textContent = 'Eliminar';
    del.onclick = async () => { await deleteDoc(d.id); renderDocs(); };
    li.append(badge, info, del); ul.append(li);
  }
}

async function handleFiles(files) {
  const prog = $('#progress'); prog.hidden = false; prog.classList.add('busy');
  for (const f of files) {
    try { await ingest(f, t => prog.textContent = t); prog.textContent = `${f.name}: añadido a la memoria`; }
    catch (e) { prog.textContent = `${f.name}: ${e.message}`; await new Promise(r => setTimeout(r, 2500)); }
    await renderDocs();
  }
  prog.classList.remove('busy');
}
$('#files').addEventListener('change', e => { handleFiles([...e.target.files]); e.target.value = ''; });
const drop = $('#drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); handleFiles([...e.dataTransfer.files]); });
$('#clear').addEventListener('click', async () => {
  if (confirm('¿Borrar todos los documentos y fragmentos de la memoria?')) { await clearAll(); renderDocs(); }
});
$('#embModel').addEventListener('change', e => { cfg.emb = e.target.value; e.target.value = cfg.emb; });

// ---------- Pestañas ----------
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach(x => x.setAttribute('aria-selected', x === b));
  document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== b.dataset.tab);
}));

// ---------- Inicio ----------
async function init() {
  $('#embModel').value = cfg.emb;
  renderDocs();
  const st = $('#status');
  try {
    const r = await fetch(API + '/api/tags');
    if (!r.ok) throw new Error(await errMsg(r));
    const names = (await r.json()).models.map(m => m.name);
    const chatModels = names.filter(n => !/embed/i.test(n));
    const sel = $('#chatModel');
    chatModels.forEach(n => sel.add(new Option(n, n)));
    cfg.chat = chatModels.includes(cfg.chat) ? cfg.chat : (chatModels[0] || '');
    sel.value = cfg.chat;
    sel.addEventListener('change', () => cfg.chat = sel.value);
    st.textContent = 'Ollama activo'; st.className = 'status ok';
    if (!names.some(n => n.startsWith(cfg.emb))) {
      $('#progress').hidden = false;
      $('#progress').textContent = `Falta el modelo de embeddings. Ejecuta: ollama pull ${cfg.emb}`;
    }
  } catch (e) {
    st.textContent = 'Ollama sin conexión'; st.className = 'status err';
    addMsg('err', 'No se pudo conectar con Ollama en ' + API + '. Comprueba que esté en ejecución. Detalle: ' + e.message);
  }
}
init();
