export const FILE_SERVER = "http://localhost:8081";

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // must match MAX_BYTES in UploadServer.java
export const DOC_ACCEPT = ".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt";
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";


export async function uploadFile(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error("That file is over 10 MB.");
  let res;
  try {
    res = await fetch(`${FILE_SERVER}/upload`, {
      method: "POST",
      headers: { "X-File-Name": encodeURIComponent(file.name) },
      body: file,
    });
  } catch (err) {
    throw new Error("Can't reach the file server — start server/UploadServer.java and try again.");
  }
  if (!res.ok) throw new Error((await res.text()) || `Upload failed (${res.status}).`);
  const data = await res.json();
  return { fileName: data.storedName, fileOriginalName: data.originalName, fileSize: data.size };
}

export function fileUrl(storedName, originalName) {
  const q = originalName ? `?name=${encodeURIComponent(originalName)}` : "";
  return `${FILE_SERVER}/files/${encodeURIComponent(storedName)}${q}`;
}

export const isImageFile = (storedName) => /\.(png|jpe?g|gif|webp)$/i.test(storedName || "");

function esc(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function formatSize(bytes) {
  if (!bytes) return "";
  return bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// HTML for an info item that has an uploaded file: a picture shows inline, anything else is a download link.
export function fileBodyHtml(item) {
  const url = fileUrl(item.fileName, item.fileOriginalName);
  const name = esc(item.fileOriginalName || "Open file");
  if (isImageFile(item.fileName)) {
    return `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${name}" loading="lazy"
              style="max-width:100%; max-height:280px; border-radius:6px; margin-top:4px;" /></a>`;
  }
  return `<p><a href="${url}" target="_blank" rel="noopener">${name}</a> <span class="small-muted">${formatSize(item.fileSize)}</span></p>`;
}
