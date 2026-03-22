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

function clearResults() {
  for (const url of resultUrls) {
    URL.revokeObjectURL(url);
  }
  resultUrls = [];
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
      return;
    }

    if (!isSupportedFile(file)) {
      selectedFile = null;
      renderDuration(0);
      dom.fileInfo.innerHTML = `<div class="file-pill">Format non pris en charge</div>`;
      setStatus("Choisis un fichier audio ou vidéo valide", 0);
      enableCutButtonIfReady();
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
      return;
    }

    setStatus("Fichier prêt pour la découpe", 0);
    enableCutButtonIfReady();
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

function createResultCard({ index, start, end, blobUrl, fileName, extension }) {
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

    <button class="download-btn" type="button">Télécharger ${title}</button>
  `;

  const button = wrapper.querySelector(".download-btn");
  button.addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  return wrapper;
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

async function cutAudioNative(file) {
  setStatus("Chargement audio...", 5);

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextClass();

  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  const duration = audioBuffer.duration;
  const segments = buildSegmentTimes(duration, selectedSegmentSeconds);

  dom.resultsList.innerHTML = "";

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];

    setStatus(
      `Découpe audio ${segment.index} sur ${segments.length}...`,
      ((i + 0.2) / segments.length) * 100
    );

    const blob = encodeWavFromAudioBuffer(audioBuffer, segment.start, segment.end);
    const blobUrl = URL.createObjectURL(blob);
    resultUrls.push(blobUrl);

    const fileName = `cut_${segment.index}.wav`;

    const card = createResultCard({
      index: segment.index,
      start: segment.start,
      end: segment.end,
      blobUrl,
      fileName,
      extension: "wav",
    });

    dom.resultsList.appendChild(card);

    setStatus(
      `Cut audio ${segment.index} prêt`,
      ((i + 1) / segments.length) * 100
    );
  }

  if (audioContext.state !== "closed") {
    await audioContext.close();
  }

  setStatus("Découpe audio terminée", 100);
}

async function cutVideoWithFFmpeg(file) {
  await loadFFmpegIfNeeded();

  const ext = getExtension(file.name) || "mp4";
  const inputName = `input.${ext}`;
  const outputExt = ext === "webm" ? "webm" : "mp4";

  await ffmpeg.writeFile(inputName, await fetchFile(file));

  const segments = buildSegmentTimes(detectedDuration, selectedSegmentSeconds);
  dom.resultsList.innerHTML = "";

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
    const blobUrl = URL.createObjectURL(blob);
    resultUrls.push(blobUrl);

    const card = createResultCard({
      index: segment.index,
      start: segment.start,
      end: segment.end,
      blobUrl,
      fileName: outputName,
      extension: outputExt,
    });

    dom.resultsList.appendChild(card);

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

  setStatus("Découpe vidéo terminée", 100);
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

function init() {
  setupTheme();
  setupSegmentButtons();
  setupParallax();
  setupFileInput();
  setupCutButton();
  setStatus("En attente d’un fichier", 0);
}

init();
