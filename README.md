# 🎨 Claude Photo Studio — In-Chat Photo Editor

Edit photos by **chatting**. Describe what you want in plain language and the app edits the actual pixels for you:

- **Harmonize collages into one scene** — drop several photos, get a single realistic image with matching lighting, shadows, color temperature, and grain.
- **Relight & color grade** — golden hour, cinematic grade, moody, etc.
- **Inpaint** — brush over an area and say *"remove this"* / *"put a hat here."*
- **Outpaint** — extend the background beyond the original borders.

It runs as a plain static web page. There's no server and nothing to install — the app talks **directly** to Google's Gemini image model from your browser, using **your own free API key** which is stored only in your browser (`localStorage`).

> **A note on "Claude":** Claude (the language model) can *see* and *reason about* images, but it can't render or edit pixels. Generative editing — inpaint, outpaint, relighting, harmonizing — needs a dedicated image model. This app uses Google **Gemini 2.5 Flash Image** ("nano banana"), which is free to use and excellent at exactly these tasks.

---

## Quick start

1. **Get a free API key** (no credit card):
   - Go to **https://aistudio.google.com/apikey**
   - Sign in with a Google account → **Create API key** → copy it.
2. **Open the app** — just open `index.html` in a browser, or serve the folder:
   ```bash
   # any static server works, e.g.
   python3 -m http.server 8000
   # then visit http://localhost:8000
   ```
3. Click **⚙ Settings**, paste your key, **Save**.
4. **Drop a photo** (or several), type an instruction, hit **Edit →**.

---

## How to use it

| Goal | What to do |
|------|-----------|
| Blend multiple photos into one scene | Add all the photos, keep them all toggled **on** in *"Photos in this edit"*, then click **✨ Harmonize into one scene** (or describe it). |
| Retouch just one region | Click **🖌️ Mark area**, brush over the spot, then type e.g. *"remove this"* or *"change to red"*. |
| Extend the background | Click **↔️ Extend / outpaint**. |
| Keep iterating | Each result becomes a new **version** in the History strip. Follow-up edits build on the latest version; click any version to go back. |
| Save | **⬇ Download** grabs the current image as a PNG. |

**Tips**
- After your first edit, source photos are auto-excluded so follow-ups refine the *result*. Re-toggle a source in the tray to bring it back in.
- You can **paste** an image (⌘/Ctrl + V) or **drag & drop** onto the canvas.

---

## Files

```
index.html   — markup / layout
styles.css   — styling (dark UI)
app.js       — all logic: uploads, chat, mask brush, Gemini calls, history
```

No build step, no dependencies.

---

## Configuration

Settings (⚙) let you change the **model**. Default is `gemini-2.5-flash-image`. If your account can't access it, try `gemini-2.0-flash-preview-image-generation`.

---

## Privacy

- Your API key never leaves your browser except in requests **to Google's API**.
- Images are sent to Google's Gemini API to perform the edits (that's where the editing happens). Nothing is sent anywhere else, and there is no backend of our own.

---

## Deploy (optional)

Because it's fully static, you can host it for free on GitHub Pages, Netlify, Vercel, or Cloudflare Pages — just publish the folder. Each visitor uses their own key.
