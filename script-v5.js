import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";

const ffmpeg = new FFmpeg();
const $ = (id) => document.getElementById(id);

const dom = {
  body: document.body,
  bgLayer: $("bgLayer"),
  themeToggle: $("themeToggle"),
  themeIcon: $("themeIcon"),
  themeText: $("themeText"),
  mediaFile: $("mediaFile"),
  fileInfo: $("fileInfo"),
  previewWrap: $("previewWrap"),
  segmentGrid: $("segmentGrid"),
  customSecondsInput: $("customSecondsInput"),
  applyCustomSegmentBtn: $("applyCustomSegmentBtn"),
  accentColorInput: $("accentColorInput"),
  accent2ColorInput: $("accent2ColorInput"),
  buttonColorInput: $("buttonColorInput"),
  bgColorInput: $("bgColorInput"),
  resetDesignBtn: $("resetDesignBtn"),
  selectedSegmentLabel: $("selectedSegmentLabel"),
  durationLabel: $("durationLabel"),
  cutButton: $("cutButton"),
  statusText: $("statusText"),
  progressText: $("progressText"),
  progressFill: $("progressFill"),
  resultsList: $("resultsList"),
};

const DB_NAME = "cutflow-db";
const STORE_NAME = "saved-cuts";
const META_KEY = "cutflow-last-session";
const THEME_KEY = "cutflow-theme";
const SEGMENT_KEY = "cutflow-segment-seconds-v5";
const DESIGN_KEY = "cutflow-custom-design-v5";
const DEFAULT_DESIGN = { accent: "#63a9ff", accent2: "#7a7cff", button: "#18b3d2", bg: "#07111f" };

let selectedFile = null;
let selectedSegmentSeconds = 5;
let detectedDuration = 0;
let ffmpegLoaded = false;
let resultUrls = [];
let currentSessionCuts = [];

function setStatus(text, percent = null) {
  if (dom.statusText) dom.statusText.textContent = text;
  if (percent !== null) {
    const safe = Math.max(0, Math.min(100, Math.round(percent)));
    if (dom.progressText) dom.progressText.textContent = `${safe}%`;
    if (dom.progressFill) dom.progressFill.style.width = `${safe}%`;
  }
}

function formatSeconds(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds || 0));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getExtension(filename) {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function clearPreview() { dom.previewWrap.innerHTML = ""; }
function revokeAllUrls() { resultUrls.forEach((url) => URL.revokeObjectURL(url)); resultUrls = []; }
function clearResults() {
  revokeAllUrls();
  currentSessionCuts = [];
  dom.resultsList.innerHTML = `<div class="empty-state">Les segments apparaîtront ici après la découpe.</div>`;
}

function updateSelectedSegmentLabel() { dom.selectedSegmentLabel.textContent = `${selectedSegmentSeconds} secondes`; }
function updateDurationLabel(duration) {
  detectedDuration = duration || 0;
  dom.durationLabel.textContent = detectedDuration > 0 ? formatSeconds(detectedDuration) : "-";
}

function setCssVar(name, value) {
  document.documentElement.style.setProperty(name, value);
  document.body.style.setProperty(name, value);
}

function darkerHex(hex, amount = 18) {
  const clean = String(hex || DEFAULT_DESIGN.bg).replace("#", "");
  const num = parseInt(clean, 16);
  if (Number.isNaN(num)) return "#0d1b2a";
  const r = Math.max(0, ((num >> 16) & 255) - amount);
  const g = Math.max(0, ((num >> 8) & 255) - amount);
  const b = Math.max(0, (num & 255) - amount);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function getSavedDesign() {
  try { return { ...DEFAULT_DESIGN, ...JSON.parse(localStorage.getItem(DESIGN_KEY) || "{}") }; }
  catch { return DEFAULT_DESIGN; }
}
function saveDesign(design) { localStorage.setItem(DESIGN_KEY, JSON.stringify(design)); }
function applyDesign(design) {
  const safe = { ...DEFAULT_DESIGN, ...design };
  setCssVar("--accent", safe.accent);
  setCssVar("--accent-2", safe.accent2);
  setCssVar("--button-main", safe.button);
  setCssVar("--bg", safe.bg);
  setCssVar("--bg-2", darkerHex(safe.bg, 14));
  if (dom.accentColorInput) dom.accentColorInput.value = safe.accent;
  if (dom.accent2ColorInput) dom.accent2ColorInput.value = safe.accent2;
  if (dom.buttonColorInput) dom.buttonColorInput.value = safe.button;
  if (dom.bgColorInput) dom.bgColorInput.value = safe.bg;
}
function getDesignFromInputs() {
  return {
    accent: dom.accentColorInput?.value || DEFAULT_DESIGN.accent,
    accent2: dom.accent2ColorInput?.value || DEFAULT_DESIGN.accent2,
    button: dom.buttonColorInput?.value || DEFAULT_DESIGN.button,
    bg: dom.bgColorInput?.value || DEFAULT_DESIGN.bg,
  };
}
function setupDesignControls() {
  applyDesign(getSavedDesign());
  [dom.accentColorInput, dom.accent2ColorInput, dom.buttonColorInput, dom.bgColorInput].filter(Boolean).forEach((input) => {
    const save = () => { const design = getDesignFromInputs(); applyDesign(design); saveDesign(design); setStatus("Couleurs enregistrées", null); };
    input.addEventListener("input", save);
    input.addEventListener("change", save);
  });
  dom.resetDesignBtn?.addEventListener("click", () => { localStorage.removeItem(DESIGN_KEY); applyDesign(DEFAULT_DESIGN); saveDesign(DEFAULT_DESIGN); setStatus("Couleurs réinitialisées", null); });
}

function applyTheme(theme) {
  dom.body.setAttribute("data-theme", theme);
  dom.themeIcon.textContent = theme === "light" ? "☀️" : "🌙";
  dom.themeText.textContent = theme === "light" ? "Clair" : "Sombre";
  localStorage.setItem(THEME_KEY, theme);
  applyDesign(getSavedDesign());
}
function setupTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || "dark");
  dom.themeToggle.addEventListener("click", () => applyTheme((dom.body.getAttribute("data-theme") || "dark") === "dark" ? "light" : "dark"));
}

function markSegmentButtons(seconds) {
  const buttons = dom.segmentGrid.querySelectorAll(".segment-btn");
  let matched = false;
  buttons.forEach((button) => {
    const active = Number(button.dataset.seconds) === seconds;
    if (active) matched = true;
    button.classList.toggle("active", active);
  });
  if (!matched) buttons.forEach((button) => button.classList.remove("active"));
}
function applySegmentSeconds(value, source = "custom") {
  const safe = Math.max(1, Math.min(300, Math.round(Number(value) || 5)));
  selectedSegmentSeconds = safe;
  localStorage.setItem(SEGMENT_KEY, String(safe));
  updateSelectedSegmentLabel();
  markSegmentButtons(safe);
  if (dom.customSecondsInput) dom.customSecondsInput.value = String(safe);
  if (source !== "init") { clearResults(); renderSavedActionsIfNeeded(); }
}
function setupSegmentControls() {
  dom.segmentGrid.querySelectorAll(".segment-btn").forEach((button) => {
    button.addEventListener("click", () => { applySegmentSeconds(Number(button.dataset.seconds), "button"); setStatus(`Tranche réglée sur ${button.dataset.seconds} secondes`, null); });
  });
  applySegmentSeconds(Number(localStorage.getItem(SEGMENT_KEY) || 5), "init");
  dom.applyCustomSegmentBtn?.addEventListener("click", () => {
    const value = Number(dom.customSecondsInput.value);
    if (!value || value < 1) return setStatus("Mets un temps valide : minimum 1 seconde", 0);
    if (value > 300) { dom.customSecondsInput.value = "300"; applySegmentSeconds(300, "custom"); return setStatus("Maximum réglé à 300 secondes", null); }
    applySegmentSeconds(value, "custom");
    setStatus(`Tranche personnalisée appliquée : ${Math.round(value)} secondes`, null);
  });
  dom.customSecondsInput?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); dom.applyCustomSegmentBtn.click(); } });
}

function setupParallax() {
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    window.requestAnimationFrame(() => { dom.bgLayer.style.transform = `translate3d(0, ${-(window.scrollY || 0) * 0.12}px, 0) scale(1.08)`; ticking = false; });
    ticking = true;
  }, { passive: true });
}

function getMediaDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const media = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    media.preload = "metadata";
    media.src = url;
    media.onloadedmetadata = () => { const duration = Number.isFinite(media.duration) ? media.duration : 0; URL.revokeObjectURL(url); resolve(duration); };
    media.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
  });
}
function isSupportedFile(file) { return file.type.startsWith("video/") || file.type.startsWith("audio/"); }
function enableCutButtonIfReady() { dom.cutButton.disabled = !(selectedFile && detectedDuration > 0); }
function setupFileInput() {
  dom.mediaFile.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    clearResults(); clearPreview();
    if (!file) { selectedFile = null; updateDurationLabel(0); dom.fileInfo.innerHTML = `<div class="file-pill">Aucun fichier sélectionné</div>`; setStatus("En attente d’un fichier", 0); enableCutButtonIfReady(); return; }
    if (!isSupportedFile(file)) { selectedFile = null; updateDurationLabel(0); dom.fileInfo.innerHTML = `<div class="file-pill">Format non pris en charge</div>`; setStatus("Choisis un fichier audio ou vidéo valide", 0); enableCutButtonIfReady(); return; }
    selectedFile = file;
    const typeLabel = file.type.startsWith("audio/") ? "Audio" : file.type.startsWith("video/") ? "Vidéo" : "Fichier";
    dom.fileInfo.innerHTML = `<div class="file-pill">${typeLabel} : ${file.name}</div>`;
    const url = URL.createObjectURL(file);
    dom.previewWrap.innerHTML = file.type.startsWith("video/") ? `<video controls playsinline preload="metadata" src="${url}"></video>` : `<audio controls preload="metadata" src="${url}"></audio>`;
    setStatus("Analyse du fichier...", 10);
    const duration = await getMediaDuration(file);
    updateDurationLabel(duration);
    if (!duration || duration <= 0) { setStatus("Impossible de lire la durée du fichier", 0); enableCutButtonIfReady(); return; }
    setStatus("Fichier prêt pour la découpe", 0);
    enableCutButtonIfReady();
  });
}

async function loadFFmpegIfNeeded() {
  if (ffmpegLoaded) return;
  setStatus("Chargement du moteur vidéo...", 5);
  const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
  ffmpeg.on("log", ({ message }) => console.log(message));
  await ffmpeg.load({ coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"), wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm") });
  ffmpegLoaded = true;
}
function buildSegmentTimes(duration, segmentSize) {
  const list = [];
  let start = 0;
  let index = 1;
  while (start < duration) { const end = Math.min(start + segmentSize, duration); list.push({ index, start, end, length: end - start }); start += segmentSize; index += 1; }
  return list;
}
function interleaveAudioBuffer(audioBuffer, startSample, endSample) {
  const channels = audioBuffer.numberOfChannels;
  const result = new Float32Array((endSample - startSample) * channels);
  let offset = 0;
  for (let i = 0; i < endSample - startSample; i += 1) for (let channel = 0; channel < channels; channel += 1) result[offset++] = audioBuffer.getChannelData(channel)[startSample + i] || 0;
  return result;
}
function encodeWavFromAudioBuffer(audioBuffer, startTime, endTime) {
  const sampleRate = audioBuffer.sampleRate;
  const channels = audioBuffer.numberOfChannels;
  const startSample = Math.floor(startTime * sampleRate);
  const endSample = Math.floor(endTime * sampleRate);
  const interleaved = interleaveAudioBuffer(audioBuffer, startSample, endSample);
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + interleaved.length * bytesPerSample);
  const view = new DataView(buffer);
  const writeString = (offset, string) => { for (let i = 0; i < string.length; i += 1) view.setUint8(offset + i, string.charCodeAt(i)); };
  let offset = 0;
  writeString(offset, "RIFF"); offset += 4; view.setUint32(offset, 36 + interleaved.length * bytesPerSample, true); offset += 4; writeString(offset, "WAVE"); offset += 4; writeString(offset, "fmt "); offset += 4; view.setUint32(offset, 16, true); offset += 4; view.setUint16(offset, 1, true); offset += 2; view.setUint16(offset, channels, true); offset += 2; view.setUint32(offset, sampleRate, true); offset += 4; view.setUint32(offset, sampleRate * blockAlign, true); offset += 4; view.setUint16(offset, blockAlign, true); offset += 2; view.setUint16(offset, 16, true); offset += 2; writeString(offset, "data"); offset += 4; view.setUint32(offset, interleaved.length * bytesPerSample, true); offset += 4;
  for (let i = 0; i < interleaved.length; i += 1) { let sample = Math.max(-1, Math.min(1, interleaved[i])); sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff; view.setInt16(offset, sample, true); offset += 2; }
  return new Blob([buffer], { type: "audio/wav" });
}

function openDatabase() { return new Promise((resolve, reject) => { const request = indexedDB.open(DB_NAME, 1); request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" }); }; request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function clearSavedCutsFromDB() { const db = await openDatabase(); return new Promise((resolve, reject) => { const tx = db.transaction(STORE_NAME, "readwrite"); const request = tx.objectStore(STORE_NAME).clear(); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); }); }
async function saveCutsToDB(cuts) { const db = await openDatabase(); await clearSavedCutsFromDB(); return new Promise((resolve, reject) => { const tx = db.transaction(STORE_NAME, "readwrite"); const store = tx.objectStore(STORE_NAME); cuts.forEach((cut) => store.put(cut)); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }
async function loadCutsFromDB() { const db = await openDatabase(); return new Promise((resolve, reject) => { const tx = db.transaction(STORE_NAME, "readonly"); const request = tx.objectStore(STORE_NAME).getAll(); request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error); }); }
function saveSessionMeta(meta) { localStorage.setItem(META_KEY, JSON.stringify(meta)); }
function getSessionMeta() { try { return JSON.parse(localStorage.getItem(META_KEY) || "null"); } catch { return null; } }

function createFileFromBlob(blob, fileName, mimeType) { return new File([blob], fileName, { type: mimeType || blob.type || "application/octet-stream", lastModified: Date.now() }); }
function cutsToFiles(cuts) { return [...cuts].sort((a, b) => a.index - b.index).map((cut) => createFileFromBlob(cut.blob, cut.fileName, cut.mimeType)); }
function directDownload(blobUrl, fileName) { const a = document.createElement("a"); a.href = blobUrl; a.download = fileName; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); }
async function shareFiles(files, label = "fichier") {
  if (!files.length) { setStatus("Aucun fichier à partager", 0); return false; }
  try {
    if (navigator.canShare && navigator.canShare({ files }) && navigator.share) {
      await navigator.share({ files, title: "Cuts CutFlow", text: `CutFlow - ${files.length} ${label}` });
      setStatus(`${files.length} cut(s) envoyés au menu Android`, 100);
      return true;
    }
  } catch (error) {
    console.warn("Partage refusé ou annulé", error);
    setStatus("Partage annulé ou refusé par Android", 0);
    return false;
  }
  setStatus("Android refuse le partage multiple. Essaie par petits paquets.", 0);
  return false;
}
async function shareOrSaveCut(blob, fileName, mimeType, blobUrl) { const ok = await shareFiles([createFileFromBlob(blob, fileName, mimeType)], "fichier"); if (!ok) directDownload(blobUrl, fileName); }
async function shareAllCuts() { if (!currentSessionCuts.length) return setStatus("Aucun cut à partager", 0); setStatus(`Préparation de ${currentSessionCuts.length} cut(s)...`, 80); const ok = await shareFiles(cutsToFiles(currentSessionCuts), "cuts"); if (!ok && currentSessionCuts.length > 8) setStatus("Trop de cuts pour Android. Essaie les paquets 1-8, 9-16...", 0); }
async function shareCutsRange(startIndex, endIndex) { const cuts = currentSessionCuts.filter((cut) => cut.index >= startIndex && cut.index <= endIndex); if (!cuts.length) return setStatus("Aucun cut dans ce paquet", 0); setStatus(`Préparation du paquet ${startIndex}-${endIndex}...`, 80); await shareFiles(cutsToFiles(cuts), "cuts"); }

function openCut(blobUrl) { window.open(blobUrl, "_blank"); }
function createPlayerPreview(blobUrl, mimeType) { if (mimeType.startsWith("audio/")) return `<audio controls preload="metadata" src="${blobUrl}" style="width:100%; border-radius:14px;"></audio>`; if (mimeType.startsWith("video/")) return `<video controls playsinline preload="metadata" src="${blobUrl}" style="width:100%; border-radius:14px;"></video>`; return ""; }
function renderBulkActions() {
  const oldBox = document.getElementById("bulkCutsBox");
  if (oldBox) oldBox.remove();
  if (currentSessionCuts.length < 2) return;
  const count = currentSessionCuts.length;
  const packageButtons = [];
  for (let start = 1; start <= count; start += 8) { const end = Math.min(start + 7, count); packageButtons.push(`<button class="download-btn package-btn" type="button" data-start="${start}" data-end="${end}">Cuts ${start}-${end}</button>`); }
  const box = document.createElement("div");
  box.className = "result-card";
  box.id = "bulkCutsBox";
  box.innerHTML = `<h4 class="result-title">Téléchargement groupé</h4><div class="result-time">${count} cuts disponibles. Aucun ZIP utilisé.</div><button class="download-btn" id="shareAllCutsBtn" type="button">Partager tous les cuts</button><div class="result-time">Si Android refuse, partage par paquets :</div><div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">${packageButtons.join("")}</div>`;
  dom.resultsList.prepend(box);
  box.querySelector("#shareAllCutsBtn").addEventListener("click", shareAllCuts);
  box.querySelectorAll(".package-btn").forEach((btn) => btn.addEventListener("click", () => shareCutsRange(Number(btn.dataset.start), Number(btn.dataset.end))));
}
function createResultCard({ index, start, end, blob, fileName, extension, mimeType }) {
  const blobUrl = URL.createObjectURL(blob);
  resultUrls.push(blobUrl);
  const wrapper = document.createElement("article");
  wrapper.className = "result-card";
  wrapper.innerHTML = `<div class="result-top"><div><h4 class="result-title">Cut ${index}</h4><div class="result-time">${formatSeconds(start)} à ${formatSeconds(end)}</div></div></div><div class="result-badges"><span class="badge">${Math.round(end - start)}s</span><span class="badge">${extension.toUpperCase()}</span></div>${createPlayerPreview(blobUrl, mimeType)}<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;"><button class="download-btn open-btn" type="button">Ouvrir</button><button class="download-btn share-btn" type="button">Partager / enregistrer</button></div><button class="download-btn save-btn" type="button" style="background:linear-gradient(135deg,var(--accent),var(--accent-2));">Télécharger classique</button>`;
  wrapper.querySelector(".open-btn").addEventListener("click", () => openCut(blobUrl));
  wrapper.querySelector(".share-btn").addEventListener("click", () => shareOrSaveCut(blob, fileName, mimeType, blobUrl));
  wrapper.querySelector(".save-btn").addEventListener("click", () => directDownload(blobUrl, fileName));
  return { element: wrapper, cutData: { id: fileName, index, start, end, fileName, extension, mimeType, blob } };
}
async function persistCurrentCuts() { if (!currentSessionCuts.length) return; try { await saveCutsToDB(currentSessionCuts); saveSessionMeta({ savedAt: new Date().toISOString(), count: currentSessionCuts.length }); setStatus("Découpe terminée et cuts sauvegardés", 100); } catch (error) { console.error(error); setStatus("Découpe terminée, mais sauvegarde locale impossible", 100); } }
function renderSavedActionsIfNeeded() {
  const oldBox = document.getElementById("savedCutsBox"); if (oldBox) oldBox.remove(); const meta = getSessionMeta(); if (!meta || !meta.count) return;
  const box = document.createElement("div"); box.className = "result-card"; box.id = "savedCutsBox"; box.innerHTML = `<h4 class="result-title">Cuts sauvegardés</h4><div class="result-time">${meta.count} cut(s) enregistrés localement</div><div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px;"><button class="download-btn" id="reloadSavedCutsBtn" type="button">Recharger</button><button class="download-btn" id="deleteSavedCutsBtn" type="button">Tout effacer</button></div>`; dom.resultsList.prepend(box);
  box.querySelector("#reloadSavedCutsBtn").addEventListener("click", restoreSavedCuts);
  box.querySelector("#deleteSavedCutsBtn").addEventListener("click", async () => { if (!window.confirm("Supprimer tous les cuts sauvegardés ?")) return; await clearSavedCutsFromDB(); localStorage.removeItem(META_KEY); clearResults(); setStatus("Sauvegarde locale effacée", 0); });
}
async function restoreSavedCuts() { try { revokeAllUrls(); dom.resultsList.innerHTML = ""; const cuts = await loadCutsFromDB(); if (!cuts.length) { dom.resultsList.innerHTML = `<div class="empty-state">Aucun cut sauvegardé.</div>`; return; } currentSessionCuts = cuts.sort((a, b) => a.index - b.index); currentSessionCuts.forEach((cut) => dom.resultsList.appendChild(createResultCard(cut).element)); renderBulkActions(); renderSavedActionsIfNeeded(); setStatus("Cuts sauvegardés rechargés", 100); } catch (error) { console.error(error); setStatus("Impossible de recharger les cuts sauvegardés", 0); } }

async function cutAudioNative(file) { setStatus("Chargement audio...", 5); const AudioContextClass = window.AudioContext || window.webkitAudioContext; const audioContext = new AudioContextClass(); const arrayBuffer = await file.arrayBuffer(); const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0)); const segments = buildSegmentTimes(audioBuffer.duration, selectedSegmentSeconds); dom.resultsList.innerHTML = ""; currentSessionCuts = []; for (let i = 0; i < segments.length; i += 1) { const segment = segments[i]; setStatus(`Découpe audio ${segment.index} sur ${segments.length}...`, ((i + 0.2) / segments.length) * 100); const blob = encodeWavFromAudioBuffer(audioBuffer, segment.start, segment.end); const fileName = `cut_${segment.index}.wav`; const { element, cutData } = createResultCard({ index: segment.index, start: segment.start, end: segment.end, blob, fileName, extension: "wav", mimeType: "audio/wav" }); currentSessionCuts.push(cutData); dom.resultsList.appendChild(element); setStatus(`Cut audio ${segment.index} prêt`, ((i + 1) / segments.length) * 100); } if (audioContext.state !== "closed") await audioContext.close(); renderBulkActions(); await persistCurrentCuts(); renderSavedActionsIfNeeded(); }
async function cutVideoWithFFmpeg(file) { await loadFFmpegIfNeeded(); const ext = getExtension(file.name) || "mp4"; const inputName = `input.${ext}`; const outputExt = ext === "webm" ? "webm" : "mp4"; await ffmpeg.writeFile(inputName, await fetchFile(file)); const segments = buildSegmentTimes(detectedDuration, selectedSegmentSeconds); dom.resultsList.innerHTML = ""; currentSessionCuts = []; for (let i = 0; i < segments.length; i += 1) { const segment = segments[i]; const outputName = `cut_${segment.index}.${outputExt}`; setStatus(`Découpe vidéo ${segment.index} sur ${segments.length}...`, ((i + 0.2) / segments.length) * 100); const args = outputExt === "webm" ? ["-ss", String(segment.start), "-t", String(segment.length), "-i", inputName, "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libvorbis", outputName] : ["-ss", String(segment.start), "-t", String(segment.length), "-i", inputName, "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart", outputName]; await ffmpeg.exec(args); const data = await ffmpeg.readFile(outputName); const mimeType = outputExt === "webm" ? "video/webm" : "video/mp4"; const blob = new Blob([data.buffer], { type: mimeType }); const { element, cutData } = createResultCard({ index: segment.index, start: segment.start, end: segment.end, blob, fileName: outputName, extension: outputExt, mimeType }); currentSessionCuts.push(cutData); dom.resultsList.appendChild(element); try { await ffmpeg.deleteFile(outputName); } catch {} setStatus(`Cut vidéo ${segment.index} prêt`, ((i + 1) / segments.length) * 100); } try { await ffmpeg.deleteFile(inputName); } catch {} renderBulkActions(); await persistCurrentCuts(); renderSavedActionsIfNeeded(); }
async function startCutting() { if (!selectedFile || !detectedDuration) return; dom.cutButton.disabled = true; clearResults(); setStatus(`Préparation découpe ${selectedSegmentSeconds}s...`, 2); try { if (selectedFile.type.startsWith("audio/")) await cutAudioNative(selectedFile); else if (selectedFile.type.startsWith("video/")) await cutVideoWithFFmpeg(selectedFile); else throw new Error("Type de fichier non pris en charge"); } catch (error) { console.error(error); setStatus("Erreur pendant la découpe. Teste d’abord un MP3 ou MP4 léger.", 0); } finally { dom.cutButton.disabled = false; } }
function init() { setupTheme(); setupDesignControls(); setupSegmentControls(); setupParallax(); setupFileInput(); dom.cutButton.addEventListener("click", startCutting); renderSavedActionsIfNeeded(); setStatus("En attente d’un fichier", 0); }
init();
