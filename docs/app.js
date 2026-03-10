const mediaUrlInput = document.getElementById("mediaUrl");
const convertBtn = document.getElementById("convertBtn");
const statusBox = document.getElementById("status");

const API_BASE = "https://YOUR-RENDER-URL.onrender.com";

function setStatus(message, type = "") {
  statusBox.className = `status ${type}`.trim();
  statusBox.textContent = message;
}

async function convertMedia() {
  const url = mediaUrlInput.value.trim();

  if (!url) {
    setStatus("Please paste a media link.", "error");
    return;
  }

  convertBtn.disabled = true;
  setStatus("Downloading approved media and creating MP3...", "working");

  try {
    const response = await fetch(`${API_BASE}/api/convert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
    });

    if (!response.ok) {
      let message = "Conversion failed.";
      try {
        const data = await response.json();
        message = data.error || message;
      } catch {}
      throw new Error(message);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = "audio.mp3";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);

    setStatus("MP3 created. Your download should begin automatically.", "success");
  } catch (error) {
    setStatus(error.message || "Something went wrong.", "error");
  } finally {
    convertBtn.disabled = false;
  }
}

convertBtn.addEventListener("click", convertMedia);
