import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";

const ffmpeg = new FFmpeg();

const dom = {
  body: document.body,
  bgLayer: document.getElementById("bgLayer"),
  themeToggle: document.getElementById("themeToggle"),
  themeIcon: document.getElementById("themeIcon"),
  themeText: document.getElementById("themeText"),
  mediaFile: document.getElementById("mediaFile"),
  fileInfo: document.getElementById("fileInfo"),
  previewWrap: document.getElementById("previewWrap"),
  segmentGrid: document.getElementById("segmentGrid"),
  selectedSegmentLabel: document.getElementById("selectedSegmentLabel"),
  durationLabel: document.getElementById("durationLabel"),
  cutButton: document.getElementById("cutButton"),
  statusText: document.getElementById("statusText"),
  progressText: document.getElementById("progressText"),
  progressFill: document.getElementById("progressFill"),
  resultsList: document.getElementById("resultsList"),
};

let selectedFile = null;
let selectedSegmentSeconds = 5;
let detectedDuration = 0;
let ffmpegLoaded = false;
let resultUrls = [];
let currentSessionCuts = [];

const DB_NAME = "cutflow-db";
const STORE_NAME = "saved-cuts";
const META_KEY = "cutflow-last-session";

function setStatus(text, percent = null) {
  dom.statusText.textContent = text;

  if (percent !== null) {
    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    dom.progressText.textContent = `${safePercent}%`;
    dom.progressFill.style.width = `${safePercent}%`;
  }
}

function formatSeconds(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getExtension(filename) {
  const parts = filename.split(".");
  if (parts.length < 2) return "";
  return parts.pop().toLowerCase();
}

function clearPreview() {
  dom.previewWrap.innerHTML = "";
}

function revokeAllUrls() {
  for (const url of resultUrls) {
    URL.revokeObjectURL(url);
  }
  resultUrls = [];
}

function clearResults() {
  revokeAllUrls();
  currentSessionCuts = [];
  dom.resultsList.innerHTML = `<div class="empty-state">Les segments apparaîtront ici après la découpe.</div>`;
}

function renderFileInfo(file) {
  const typeLabel = file.type.startsWith("audio/")
    ? "Audio"
    : file.type.startsWith("video/")
    ? "Vidéo"
    : "Fichier";

  dom.fileInfo.innerHTML = `
    <div class="file-pill">${typeLabel} : ${file.name}</div>
  `;
}

function renderPreview(file) {
  clearPreview();
  const url = URL.createObjectURL(file);

  if (file.type.startsWith("video/")) {
    dom.previewWrap.innerHTML = `<video controls playsinline preload="metadata" src="${url}"></video>`;
  } else if (file.type.startsWith("audio/")) {
    dom.previewWrap.innerHTML = `<audio controls preload="metadata" src="${url}"></audio>`;
  }
}

function renderDuration(duration) {
  detectedDuration = duration || 0;
  dom.durationLabel.textContent = detectedDuration > 0 ? formatSeconds(detectedDuration) : "-";
}

function updateSelectedSegmentLabel() {
  dom.selectedSegmentLabel.textContent = `${selectedSegmentSeconds} secondes`;
}

function getTheme() {
  return localStorage.getItem("cutflow-theme") || "dark";
}

function applyTheme(theme) {
  dom.body.setAttribute("data-theme", theme);

  if (theme === "light") {
    dom.themeIcon.textContent = "☀️";
    dom.themeText.textContent = "Clair";
  } else {
    dom.themeIcon.textContent = "🌙";
    dom.themeText.textContent = "Sombre";
  }

  localStorage.setItem("cutflow-theme", theme);
}

function toggleTheme() {
  const current = dom.body.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
}

function setupTheme() {
  applyTheme(getTheme());
  dom.themeToggle.addEventListener("click", toggleTheme);
}

function setupSegmentButtons() {
  const buttons = dom.segmentGrid.querySelectorAll(".segment-btn");

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      buttons.forEach((btn) => btn.classList.remove("active"));
      button.classList.add("active");
      selectedSegmentSeconds = Number(button.dataset.seconds);
      updateSelectedSegmentLabel();
      clearResults();
      renderSavedActionsIfNeeded();
    });
  });

  updateSelectedSegmentLabel();
}

function setupParallax() {
  let ticking = false;

  function update() {
    const scrollY = window.scrollY || 0;
    const offsetY = scrollY * 0.12;
    dom.bgLayer.style.transform = `translate3d(0, ${-offsetY}px, 0) scale(1.08)`;
    ticking = false;
  }

  window.addEventListener(
    "scroll",
    () => {
      if (!ticking) {
        window.requestAnimationFrame(update);
        ticking = true;
      }
    },
    { passive: true }
  );
}

function getMediaDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const isVideo = file.type.startsWith("video/");
    const media = document.createElement(isVideo ? "video" : "audio");

    media.preload = "metadata";
    media.src = url;

    media.onloadedmetadata = () => {
      const duration = Number.isFinite(media.duration) ? media.duration : 0;
      URL.revokeObjectURL(url);
      resolve(duration);
    };

    media.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
  });
}

function isSupportedFile(file) {
  return file.type.startsWith("video/") || file.type.startsWith("audio/");
}

function enableCutButtonIfReady() {
  dom.cutButton.disabled = !(selectedFile && detectedDuration > 0);
}

function setupFileInput() {
  dom.mediaFile.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];

    clearResults();
    clearPreview();

    if (!file) {
      selectedFile = null;
      renderDuration(0);
      dom.fileInfo.innerHTML = `<div class="file-pill">Aucun fichier sélectionné</div>`;
      setStatus("En attente d’un fichier", 0);
      enableCutButtonIfReady();
      renderSavedActionsIfNeeded();
      return;
    }

    if (!isSupportedFile(file)) {
      selectedFile = null;
      renderDuration(0);
      dom.fileInfo.innerHTML = `<div class="file-pill">Format non pris en charge</div>`;
      setStatus("Choisis un fichier audio ou vidéo valide", 0);
      enableCutButtonIfReady();
      renderSavedActionsIfNeeded();
      return;
    }

    selectedFile = file;
    renderFileInfo(file);
    renderPreview(file);

    setStatus("Analyse du fichier...", 10);

    const duration = await getMediaDuration(file);
    renderDuration(duration);

    if (!duration || duration <= 0) {
      setStatus("Impossible de lire la durée du fichier", 0);
      enableCutButtonIfReady();
      renderSavedActionsIfNeeded();
      return;
    }

    setStatus("Fichier prêt pour la découpe", 0);
    enableCutButtonIfReady();
    renderSavedActionsIfNeeded();
  });
}

async function loadFFmpegIfNeeded() {
  if (ffmpegLoaded) return;

  setStatus("Chargement du moteur vidéo...", 5);

  const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";

  ffmpeg.on("log", ({ message }) => {
    console.log(message);
  });

  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
  });

  ffmpegLoaded = true;
}

function buildSegmentTimes(duration, segmentSize) {
  const list = [];
  let start = 0;
  let index = 1;

  while (start < duration) {
    const end = Math.min(start + segmentSize, duration);
    list.push({
      index,
      start,
      end,
      length: end - start,
    });
    start += segmentSize;
    index += 1;
  }

  return list;
}

function interleaveAudioBuffer(audioBuffer, startSample, endSample) {
  const channels = audioBuffer.numberOfChannels;
  const length = endSample - startSample;
  const result = new Float32Array(length * channels);

  let offset = 0;

  for (let i = 0; i < length; i += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const data = audioBuffer.getChannelData(channel);
      result[offset] = data[startSample + i] || 0;
      offset += 1;
    }
  }

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

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i += 1) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  let offset = 0;

  writeString(offset, "RIFF");
  offset += 4;
  view.setUint32(offset, 36 + interleaved.length * bytesPerSample, true);
  offset += 4;
  writeString(offset, "WAVE");
  offset += 4;
  writeString(offset, "fmt ");
  offset += 4;
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, channels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * blockAlign, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, 16, true);
  offset += 2;
  writeString(offset, "data");
  offset += 4;
  view.setUint32(offset, interleaved.length * bytesPerSample, true);
  offset += 4;

  let index = 0;
  while (index < interleaved.length) {
    let sample = Math.max(-1, Math.min(1, interleaved[index]));
    sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(offset, sample, true);
    offset += 2;
    index += 1;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function clearSavedCutsFromDB() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const clearRequest = store.clear();

    clearRequest.onsuccess = () => resolve();
    clearRequest.onerror = () => reject(clearRequest.error);
  });
}

async function saveCutsToDB(cuts) {
  const db = await openDatabase();
  await clearSavedCutsFromDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    cuts.forEach((cut) => {
      store.put(cut);
    });

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadCutsFromDB() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function saveSessionMeta(meta) {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

function getSessionMeta() {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || "null");
  } catch {
    return null;
  }
}

function createFileFromBlob(blob, fileName, mimeType) {
  return new File([blob], fileName, {
    type: mimeType || blob.type || "application/octet-stream",
    lastModified: Date.now(),
  });
}

function directDownload(blobUrl, fileName) {
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = fileName;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function shareOrSaveCut(blob, fileName, mimeType, blobUrl) {
  const file = createFileFromBlob(blob, fileName, mimeType);

  try {
    if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      await navigator.share({
        files: [file],
        title: fileName,
        text: "CutFlow - fichier découpé",
      });
      setStatus(`${fileName} prêt à enregistrer ou partager`, 100);
      return;
    }
  } catch (error) {
    console.warn("Partage Android indisponible ou annulé :", error);
  }

  try {
    directDownload(blobUrl, fileName);
    setStatus(`Téléchargement de ${fileName} lancé`, 100);
  } catch (error) {
    console.error(error);
    setStatus("Téléchargement bloqué. Appuie sur Ouvrir puis menu ⋮ pour enregistrer.", 0);
  }
}

function openCut(blobUrl) {
  window.open(blobUrl, "_blank");
}

function createPlayerPreview(blobUrl, mimeType) {
  if (mimeType.startsWith("audio/")) {
    return `<audio controls preload="metadata" src="${blobUrl}" style="width:100%; border-radius:14px;"></audio>`;
  }

  if (mimeType.startsWith("video/")) {
    return `<video controls playsinline preload="metadata" src="${blobUrl}" style="width:100%; border-radius:14px;"></video>`;
  }

  return "";
}

function createResultCard({ index, start, end, blob, fileName, extension, mimeType }) {
  const blobUrl = URL.createObjectURL(blob);
  resultUrls.push(blobUrl);

  const wrapper = document.createElement("article");
  wrapper.className = "result-card";

  const title = `Cut ${index}`;
  const range = `${formatSeconds(start)} à ${formatSeconds(end)}`;
  const sizeLabel = `${Math.round(end - start)}s`;
  const formatLabel = extension.toUpperCase();

  wrapper.innerHTML = `
    <div class="result-top">
      <div>
        <h4 class="result-title">${title}</h4>
        <div class="result-time">${range}</div>
      </div>
    </div>

    <div class="result-badges">
      <span class="badge">${sizeLabel}</span>
      <span class="badge">${formatLabel}</span>
    </div>

    ${createPlayerPreview(blobUrl, mimeType)}

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
      <button class="download-btn open-btn" type="button">Ouvrir</button>
      <button class="download-btn share-btn" type="button">Partager / enregistrer</button>
    </div>

    <button class="download-btn save-btn" type="button" style="background:linear-gradient(135deg,#3f7dff,#7a7cff);">
      Télécharger classique
    </button>
  `;

  const openBtn = wrapper.querySelector(".open-btn");
  const shareBtn = wrapper.querySelector(".share-btn");
  const saveBtn = wrapper.querySelector(".save-btn");

  openBtn.addEventListener("click", () => {
    openCut(blobUrl);
  });

  shareBtn.addEventListener("click", async () => {
    await shareOrSaveCut(blob, fileName, mimeType, blobUrl);
  });

  saveBtn.addEventListener("click", () => {
    try {
      directDownload(blobUrl, fileName);
      setStatus(`Téléchargement classique de ${fileName} lancé`, 100);
    } catch (error) {
      console.error(error);
      setStatus("Téléchargement bloqué. Essaie Partager / enregistrer.", 0);
    }
  });

  return {
    element: wrapper,
    cutData: {
      id: fileName,
      index,
      start,
      end,
      fileName,
      extension,
      mimeType,
      blob,
    },
  };
}

async function persistCurrentCuts() {
  if (!currentSessionCuts.length) return;

  try {
    await saveCutsToDB(currentSessionCuts);
    saveSessionMeta({
      savedAt: new Date().toISOString(),
      count: currentSessionCuts.length,
    });
    setStatus("Découpe terminée et cuts sauvegardés", 100);
  } catch (error) {
    console.error(error);
    setStatus("Découpe terminée, mais sauvegarde locale impossible", 100);
  }
}

function renderSavedActionsIfNeeded() {
  const oldBox = document.getElementById("savedCutsBox");
  if (oldBox) oldBox.remove();

  const meta = getSessionMeta();
  if (!meta || !meta.count) return;

  const box = document.createElement("div");
  box.className = "result-card";
  box.id = "savedCutsBox";
  box.innerHTML = `
    <h4 class="result-title">Cuts sauvegardés</h4>
    <div class="result-time">${meta.count} cut(s) enregistrés localement</div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px;">
      <button class="download-btn" id="reloadSavedCutsBtn" type="button">Recharger</button>
      <button class="download-btn" id="deleteSavedCutsBtn" type="button">Tout effacer</button>
    </div>
  `;

  dom.resultsList.prepend(box);

  box.querySelector("#reloadSavedCutsBtn").addEventListener("click", async () => {
    await restoreSavedCuts();
  });

  box.querySelector("#deleteSavedCutsBtn").addEventListener("click", async () => {
    const ok = window.confirm("Supprimer tous les cuts sauvegardés ?");
    if (!ok) return;

    await clearSavedCutsFromDB();
    localStorage.removeItem(META_KEY);
    setStatus("Sauvegarde locale effacée", 0);
    clearResults();
  });
}

async function restoreSavedCuts() {
  try {
    revokeAllUrls();
    dom.resultsList.innerHTML = "";

    const cuts = await loadCutsFromDB();

    if (!cuts.length) {
      dom.resultsList.innerHTML = `<div class="empty-state">Aucun cut sauvegardé.</div>`;
      return;
    }

    currentSessionCuts = cuts;
    cuts.sort((a, b) => a.index - b.index);

    for (const cut of cuts) {
      const { element } = createResultCard({
        index: cut.index,
        start: cut.start,
        end: cut.end,
        blob: cut.blob,
        fileName: cut.fileName,
        extension: cut.extension,
        mimeType: cut.mimeType,
      });

      dom.resultsList.appendChild(element);
    }

    renderSavedActionsIfNeeded();
    setStatus("Cuts sauvegardés rechargés", 100);
  } catch (error) {
    console.error(error);
    setStatus("Impossible de recharger les cuts sauvegardés", 0);
  }
}

async function cutAudioNative(file) {
  setStatus("Chargement audio...", 5);

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextClass();

  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  const duration = audioBuffer.duration;
  const segments = buildSegmentTimes(duration, selectedSegmentSeconds);

  dom.resultsList.innerHTML = "";
  currentSessionCuts = [];

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];

    setStatus(
      `Découpe audio ${segment.index} sur ${segments.length}...`,
      ((i + 0.2) / segments.length) * 100
    );

    const blob = encodeWavFromAudioBuffer(audioBuffer, segment.start, segment.end);
    const fileName = `cut_${segment.index}.wav`;

    const { element, cutData } = createResultCard({
      index: segment.index,
      start: segment.start,
      end: segment.end,
      blob,
      fileName,
      extension: "wav",
      mimeType: "audio/wav",
    });

    currentSessionCuts.push(cutData);
    dom.resultsList.appendChild(element);

    setStatus(
      `Cut audio ${segment.index} prêt`,
      ((i + 1) / segments.length) * 100
    );
  }

  if (audioContext.state !== "closed") {
    await audioContext.close();
  }

  await persistCurrentCuts();
  renderSavedActionsIfNeeded();
}

async function cutVideoWithFFmpeg(file) {
  await loadFFmpegIfNeeded();

  const ext = getExtension(file.name) || "mp4";
  const inputName = `input.${ext}`;
  const outputExt = ext === "webm" ? "webm" : "mp4";

  await ffmpeg.writeFile(inputName, await fetchFile(file));

  const segments = buildSegmentTimes(detectedDuration, selectedSegmentSeconds);
  dom.resultsList.innerHTML = "";
  currentSessionCuts = [];

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const outputName = `cut_${segment.index}.${outputExt}`;

    setStatus(
      `Découpe vidéo ${segment.index} sur ${segments.length}...`,
      ((i + 0.2) / segments.length) * 100
    );

    if (outputExt === "webm") {
      await ffmpeg.exec([
        "-ss",
        String(segment.start),
        "-t",
        String(segment.length),
        "-i",
        inputName,
        "-c:v",
        "libvpx",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-c:a",
        "libvorbis",
        outputName,
      ]);
    } else {
      await ffmpeg.exec([
        "-ss",
        String(segment.start),
        "-t",
        String(segment.length),
        "-i",
        inputName,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputName,
      ]);
    }

    const data = await ffmpeg.readFile(outputName);
    const mimeType = outputExt === "webm" ? "video/webm" : "video/mp4";
    const blob = new Blob([data.buffer], { type: mimeType });

    const { element, cutData } = createResultCard({
      index: segment.index,
      start: segment.start,
      end: segment.end,
      blob,
      fileName: outputName,
      extension: outputExt,
      mimeType,
    });

    currentSessionCuts.push(cutData);
    dom.resultsList.appendChild(element);

    try {
      await ffmpeg.deleteFile(outputName);
    } catch (error) {
      console.warn("Suppression segment impossible :", error);
    }

    setStatus(
      `Cut vidéo ${segment.index} prêt`,
      ((i + 1) / segments.length) * 100
    );
  }

  try {
    await ffmpeg.deleteFile(inputName);
  } catch (error) {
    console.warn("Suppression source impossible :", error);
  }

  await persistCurrentCuts();
  renderSavedActionsIfNeeded();
}

async function startCutting() {
  if (!selectedFile || !detectedDuration) return;

  dom.cutButton.disabled = true;
  clearResults();
  setStatus("Préparation...", 2);

  try {
    if (selectedFile.type.startsWith("audio/")) {
      await cutAudioNative(selectedFile);
    } else if (selectedFile.type.startsWith("video/")) {
      await cutVideoWithFFmpeg(selectedFile);
    } else {
      throw new Error("Type de fichier non pris en charge");
    }
  } catch (error) {
    console.error(error);
    setStatus("Erreur pendant la découpe. Teste d’abord un MP3 ou MP4 léger.", 0);
  } finally {
    dom.cutButton.disabled = false;
  }
}

function setupCutButton() {
  dom.cutButton.addEventListener("click", startCutting);
}

async function initSavedCutsOnStart() {
  const meta = getSessionMeta();
  if (!meta || !meta.count) return;
  renderSavedActionsIfNeeded();
}

function init() {
  setupTheme();
  setupSegmentButtons();
  setupParallax();
  setupFileInput();
  setupCutButton();
  initSavedCutsOnStart();
  setStatus("En attente d’un fichier", 0);
}

init();
